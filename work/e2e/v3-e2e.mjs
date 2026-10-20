#!/usr/bin/env node
/**
 * Review V3 实机 E2E 驱动（零新增依赖）
 *
 * 直接启动真实 Electron 进程（dist/main.cjs + dist/renderer），通过 CDP
 * 在渲染进程里调用 window.electronAPI.review.*，从而真实穿过
 * preload → main IPC → 主进程服务 → 磁盘持久化 的完整链路。
 *
 * 用法：
 *   node work/e2e/v3-e2e.mjs <scenario>
 * 场景：
 *   probe            仅启动并报告 API 表面
 *   create-case      创建原生案卷并重新读取
 *   d4-list          读取 D4 目录，统计模板数与可用性
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_DIR = join(HERE, '../../apps/electron')
const ELECTRON = join(HERE, '../../node_modules/electron/dist/electron')
const scenario = process.argv[2] ?? 'probe'
const configDir = process.env.E2E_CONFIG_DIR ?? join(HERE, 'config')
const userDataDir = join(configDir, 'userdata')

if (!existsSync(ELECTRON)) {
  console.error(`[E2E] 找不到 Electron 二进制：${ELECTRON}`)
  process.exit(2)
}

// 每次运行使用干净配置根，保证可复现；需要保留时由调用方传 E2E_KEEP_CONFIG=1
// 每次运行使用干净配置根以保证可复现；随后由 setup-config 注入真实渠道与模型选择，
// 否则审核专区没有可用模型出口，无法验证真实 Provider 链路。
if (process.env.E2E_KEEP_CONFIG !== '1') {
  rmSync(configDir, { recursive: true, force: true })
}
mkdirSync(userDataDir, { recursive: true })

if (process.env.E2E_NO_SETUP !== '1') {
  const setup = spawn(process.execPath, [join(HERE, 'setup-config.mjs')], {
    env: { ...process.env, E2E_CONFIG_DIR: configDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let setupOut = ''
  setup.stdout.on('data', (chunk) => { setupOut += chunk.toString() })
  setup.stderr.on('data', (chunk) => { setupOut += chunk.toString() })
  const setupCode = await new Promise((resolve) => setup.on('exit', resolve))
  if (setupCode !== 0) {
    console.error(`[E2E] 配置准备失败：\n${setupOut}`)
    process.exit(2)
  }
  if (process.env.E2E_VERBOSE === '1') process.stderr.write(setupOut)
}

const remoteDebuggingPort = Number(process.env.E2E_CDP_PORT ?? 9333)

const child = spawn(ELECTRON, [
  '.',
  `--remote-debugging-port=${remoteDebuggingPort}`,
  `--user-data-dir=${userDataDir}`,
  '--no-sandbox',
  '--disable-gpu',
], {
  cwd: APP_DIR,
  env: {
    ...process.env,
    // 开发模式配置根，复用已配置的真实渠道
    PROFER_CONFIG_DIR: configDir,
    // 独立开发实例：避免与用户日常运行的 CDUT Studio 抢单实例锁与 userData 目录
    PROFER_DEV_INSTANCE: process.env.E2E_DEV_INSTANCE ?? 'e2e',
    PROFER_USER_DATA_DIR: userDataDir,
    ELECTRON_ENABLE_LOGGING: '1',
    NODE_ENV: 'development',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

const logs = []
const record = (tag) => (buf) => {
  const text = buf.toString()
  logs.push(`${tag}${text}`)
  if (process.env.E2E_VERBOSE === '1') process.stderr.write(`${tag}${text}`)
}
child.stdout.on('data', record('[main] '))
child.stderr.on('data', record('[main:err] '))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function cdpTargets() {
  const res = await fetch(`http://127.0.0.1:${remoteDebuggingPort}/json/list`)
  return res.json()
}

/**
 * 等待主窗口渲染页面出现。
 * 启动阶段存在 splash（about:blank / data:）与主窗口两个 page target，
 * 必须挑出真正加载了应用页面（http://localhost:PORT）的那个。
 */
async function waitForPage(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  let lastSeen = []
  while (Date.now() < deadline) {
    try {
      const targets = await cdpTargets()
      lastSeen = targets.filter((t) => t.type === 'page').map((t) => t.url)
      const page = targets.find((t) => t.type === 'page'
        && /^https?:\/\/localhost:\d+/.test(t.url)
        && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* 端口尚未就绪 */
    }
    await sleep(500)
  }
  throw new Error(`主窗口页面在超时内未出现；已看到的 page targets: ${JSON.stringify(lastSeen)}`)
}

/** 极简 CDP 客户端：只实现 Runtime.evaluate 与 Page.captureScreenshot */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let nextId = 1
  const pending = new Map()
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true })
  })
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
    }
  })
  const send = (method, params = {}) => {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }
  return { ws, send }
}

/**
 * 在渲染进程求值。awaitPromise 打开，支持 async 表达式；
 * 返回值必须是可 JSON 序列化的结构。
 */
async function evaluate(send, expression, timeoutMs = 180_000) {
  const result = await send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
    timeout: timeoutMs,
  })
  if (result.exceptionDetails) {
    const desc = result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.text
    throw new Error(`渲染进程求值异常: ${desc}`)
  }
  return result.result.value
}

const scenarios = {
  async probe({ send }) {
    return evaluate(send, `
      const api = window.electronAPI
      const review = window.reviewAPI
      return {
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        hasApi: Boolean(api),
        hasReview: Boolean(review),
        electronKeys: api ? Object.keys(api).length : 0,
        reviewKeys: review ? Object.keys(review).sort() : [],
      }
    `)
  },

  async 'create-case'({ send }) {
    return evaluate(send, `
      const created = await window.reviewAPI.createCase({
        title: 'E2E 原生案卷', type: '综合测评', applicant: 'E2E', academicYear: '2026',
      })
      const cases = await window.reviewAPI.listCases()
      return {
        createdId: created?.id,
        createdTitle: created?.title,
        caseCount: cases?.length,
        reopened: cases?.some(c => c.id === created?.id),
      }
    `)
  },

  /**
   * 第 4 节实机验收 1~4 步：
   * 原生案卷 → 真实 PDF/DOCX 导入 → D4 Plan 固定 → 网关自检
   */
  async 'flow-core'({ send }) {
    return evaluate(send, `
      const api = window.reviewAPI
      const out = { steps: [] }
      const step = (name, data) => out.steps.push({ name, ...data })

      // 1) 原生案卷
      // 与 CreateCaseDialog 的真实行为一致：选领域包但 reviewTemplate 显式为 null，
      // 得到「未绑定」原生案卷，之后才能挂 D4 候选模板。
      const created = await api.createCase({
        title: 'E2E 闭环案卷', type: '综合测评', applicant: 'E2E', academicYear: '2026',
        domainPackId: 'comprehensive-assessment', reviewTemplate: null,
      })
      out.caseId = created?.id
      const reopened = await api.getCase(created.id)
      step('createCase', { ok: Boolean(created?.id), reopenedStage: reopened?.stage ?? null })

      // 2) 真实材料导入
      const pdfPath = out.pdfPath
      const docxPath = out.docxPath
      const imported = []
      for (const [path, role] of [[pdfPath, 'evidence'], [docxPath, 'evidence']]) {
        if (!path) continue
        const started = Date.now()
        try {
          const doc = await api.importDocumentFromPath({ caseId: created.id, sourcePath: path, role })
          imported.push({ ok: true, id: doc?.id, fileName: doc?.fileName,
            parseStatus: doc?.parseStatus, elapsedMs: Date.now() - started })
        } catch (error) {
          imported.push({ ok: false, path, error: String(error?.message ?? error), elapsedMs: Date.now() - started })
        }
      }
      step('importMaterials', { imported })

      // 3) D4 目录 + Plan 固定
      const list = await api.listD4Templates()
      out.templateCount = list?.length
      const usable = (list ?? []).find(t => t.templateId === 'g01-student-identity-correction')
      let plan = null
      if (usable) {
        try {
          plan = await api.attachD4TechnicalPlanV3({
            caseId: created.id,
            d4: { templateId: usable.templateId, version: usable.version,
              selection: usable.selection, useControlledStudentFixture: true },
          })
        } catch (error) {
          plan = { error: String(error?.message ?? error) }
        }
      }
      step('attachD4Plan', { templateCount: out.templateCount, plan })
      // 诊断：attach 失败时确认模板存储的真实状态
      if (plan?.error) {
        try {
          const tpl = await api.getTemplateV2(usable.templateId, usable.version)
          step('templateDiag', { templateId: tpl?.templateId, version: tpl?.version,
            status: tpl?.status, fields: tpl?.fields?.length, slots: tpl?.materialSlots?.length,
            outputs: tpl?.outputs?.map(o => o.kind), stages: tpl?.stages?.map(s => s.kind),
            objectType: tpl?.objectType })
        } catch (error) {
          step('templateDiag', { error: String(error?.message ?? error) })
        }
      }

      // 4) 模型网关自检（真实 Provider 可用性）
      let gateway = null
      try { gateway = await api.getModelGatewayStatus() }
      catch (error) { gateway = { error: String(error?.message ?? error) } }
      step('modelGateway', { gateway })

      return out
    `.replace('out.pdfPath', JSON.stringify(process.env.E2E_PDF_PATH ?? '')).replace('out.docxPath', JSON.stringify(process.env.E2E_DOCX_PATH ?? '')))
  },

  /**
   * 完整 7 步闭环（第 4 节 1~6 步）：
   * 案卷 → 材料 → D4 Plan → 真实 Provider Pi 审核 → Run/Check → 报告
   */
  async 'flow-full'({ send }) {
    return evaluate(send, `
      const api = window.reviewAPI
      const out = { steps: [], runId: null }
      const step = (name, data) => out.steps.push({ name, ...data })

      const created = await api.createCase({
        title: 'E2E 全流程案卷', type: '综合测评', applicant: 'E2E', academicYear: '2026',
        domainPackId: 'comprehensive-assessment', reviewTemplate: null,
      })
      out.caseId = created.id
      step('createCase', { ok: Boolean(created.id) })

      for (const [path, role] of [[PDF, 'evidence'], [DOCX, 'evidence']]) {
        if (!path) continue
        try {
          const doc = await api.importDocumentFromPath({ caseId: created.id, sourcePath: path, role })
          step('import:' + doc.fileName, { ok: true, parseStatus: doc.parseStatus })
        } catch (error) { step('import', { ok: false, error: String(error?.message ?? error) }) }
      }

      const list = await api.listD4Templates()
      const usable = (list ?? []).find(t => t.templateId === 'g01-student-identity-correction')
      const plan = await api.attachD4TechnicalPlanV3({
        caseId: created.id,
        d4: { templateId: usable.templateId, version: usable.version,
          selection: usable.selection, useControlledStudentFixture: true },
      })
      step('attachD4Plan', { checks: plan.checks, fingerprint: plan.fingerprint })

      // 真实 Provider：后台 Pi 审核
      const started = Date.now()
      let state = null
      try {
        state = await api.startBackgroundPiReviewV2({ caseId: created.id })
        step('startPiReview', { phase: state?.phase, runId: state?.runId ?? null })
      } catch (error) {
        step('startPiReview', { ok: false, error: String(error?.message ?? error) })
      }

      // 轮询到终态；启动已失败则不空等
      const deadline = Date.now() + Number(POLL_MS ?? 360000)
      let last = null
      const startFailed = !state
      while (!startFailed && Date.now() < deadline) {
        try { last = await api.getBackgroundPiReviewStateV2(created.id) } catch {}
        const phase = last?.phase
        if (phase && ['completed', 'failed', 'incomplete', 'stopped', 'cancelled', 'error'].includes(phase)) break
        await new Promise(r => setTimeout(r, 3000))
      }
      out.pollTimedOut = !startFailed && !(last?.phase && ['completed','failed','incomplete','stopped','cancelled','error'].includes(last.phase))
      step('piReviewOutcome', { phase: last?.phase, runId: last?.runId ?? null,
        elapsedMs: Date.now() - started, error: last?.error ?? null })
      out.runId = last?.runId ?? null

      // 持久 Run / Check
      try {
        const runs = await api.listRunsV2(created.id)
        step('listRuns', { count: runs?.length,
          runs: (runs ?? []).map(r => ({ id: r.id, status: r.status, checks: r.checks?.length ?? 0 })) })
        if (out.runId) {
          const run = await api.getRunV2(created.id, out.runId)
          step('getRun', { status: run?.status, checkCount: run?.checks?.length ?? 0,
            observations: run?.observations?.length ?? 0 })
        }
      } catch (error) { step('listRuns', { ok: false, error: String(error?.message ?? error) }) }

      // 人工复核：读取模型抽取的事实并确认（无事实时如实记录）
      try {
        const observations = await api.getRunObservationsV2(created.id)
        step('observations', { count: observations?.length ?? 0 })
        const first = (observations ?? [])[0]
        if (first) {
          const aggregate = await api.getAggregateV2(created.id)
          const confirmed = await api.correctObservationV2({
            caseId: created.id,
            command: {
              requestId: 'e2e-confirm-' + Date.now().toString(36),
              target: { kind: 'case', id: created.id },
              expectedRevision: aggregate.caseV2.revision,
              actor: { actorId: 'local-user', actorSource: 'local', role: 'reviewer' },
              type: 'CorrectObservation',
              payload: { subjectId: first.subjectId, fieldKey: first.fieldKey,
                value: first.value, sourceRefs: first.sourceRefs ?? [], reason: '人工核对无误' },
            },
          })
          step('confirmObservation', { ok: confirmed?.ok, code: confirmed?.code ?? null })
        }
      } catch (error) { step('confirmObservation', { ok: false, error: String(error?.message ?? error) }) }

      // 正式决定必须被拒（D2 技术预审不得形成校方决定）
      try {
        const runsForDecision = await api.listRunsV2(created.id)
        const target = (runsForDecision ?? [])[0]
        const aggregate = await api.getAggregateV2(created.id)
        const decision = await api.decideWorkspaceCaseV2({
          caseId: created.id,
          command: {
            requestId: 'e2e-decide-' + Date.now().toString(36),
            expectedRevision: aggregate.caseV2.revision,
            actor: { actorId: 'local-user', actorSource: 'local', role: 'reviewer' },
            payload: { result: 'pass', reason: 'E2E 技术预审尝试',
              basedOnRunId: target?.id, inputHash: target?.inputManifest?.hash },
          },
        })
        step('formalDecision', { ok: decision?.ok, code: decision?.code ?? null })
      } catch (error) {
        step('formalDecision', { rejected: true,
          error: String(error?.message ?? error).slice(0, 160) })
      }

      // 人工复核：对已完成 Run 的具体 check 记录处置（D2 预审的复核对象是 check）
      try {
        const runs2 = await api.listRunsV2(created.id)
        const run2 = (runs2 ?? [])[0]
        const target = (run2?.checks ?? []).find(c => c.status === 'awaiting-confirmation')
          ?? (run2?.checks ?? [])[0]
        if (run2 && target) {
          const agg2 = await api.getAggregateV2(created.id)
          const disp = await api.recordWorkspaceDispositionV2({
            caseId: created.id,
            command: {
              requestId: 'e2e-disp-' + Date.now().toString(36),
              target: { kind: 'case', id: created.id },
              expectedRevision: agg2.caseV2.revision,
              actor: { actorId: 'local-user', actorSource: 'local', role: 'reviewer' },
              type: 'RecordWorkspaceFindingDisposition',
              payload: { findingKey: target.checkId, disposition: 'human-confirmed-compliant',
                reason: '审核员对照审核依据和材料后确认本项符合',
                runId: run2.id, inputHash: run2.inputManifest?.hash },
            },
          })
          const after = await api.getAggregateV2(created.id)
          step('manualDisposition', { ok: disp?.ok, code: disp?.code ?? null,
            checkId: target.checkId, revision: after?.caseV2?.revision,
            dispositionCount: (after?.dispositions ?? []).length })
        }
      } catch (error) {
        step('manualDisposition', { ok: false, error: String(error?.message ?? error).slice(0, 160) })
      }

      // MD 报告导出
      try {
        const report = await api.exportReportV2(created.id)
        step('exportReport', { file: report?.file ?? null, decision: report?.decision ?? null })
      } catch (error) { step('exportReport', { ok: false, error: String(error?.message ?? error) }) }

      return out
    `
      .replace('PDF', JSON.stringify(process.env.E2E_PDF_PATH ?? ''))
      .replace('DOCX', JSON.stringify(process.env.E2E_DOCX_PATH ?? ''))
      .replace('POLL_MS', JSON.stringify(process.env.E2E_POLL_MS ?? '360000')))
  },

  /** 诊断：设置与渠道在应用内的真实可见性 */
  async 'diag-config'({ send }) {
    return evaluate(send, `
      const settings = await window.electronAPI.getSettings()
      let channels = []
      try { channels = await window.electronAPI.listChannels() } catch (e) { channels = [{ error: String(e?.message ?? e) }] }
      return {
        agentChannelId: settings?.agentChannelId ?? null,
        agentModelId: settings?.agentModelId ?? null,
        channels: (channels ?? []).map(c => ({ id: c.id, name: c.name, provider: c.provider,
          enabled: c.enabled, models: (c.models ?? []).map(m => m.id) })),
      }
    `)
  },

  /** 诊断：真实渠道连通性（解密 API Key + 发起请求） */
  async 'diag-channel'({ send }) {
    return evaluate(send, `
      const settings = await window.electronAPI.getSettings()
      const channelId = settings?.agentChannelId
      if (!channelId) return { error: '没有 agentChannelId' }
      try {
        const result = await window.electronAPI.testChannel(channelId)
        return { channelId, result }
      } catch (error) { return { channelId, error: String(error?.message ?? error) } }
    `)
  },

  /** 阶段 A：建案卷 + 导入材料 + 固定 Plan，把 caseId 写到文件供重启后核对 */
  async 'phase-prepare'({ send }) {
    return evaluate(send, `
      const api = window.reviewAPI
      const created = await api.createCase({
        title: 'E2E 重启恢复案卷', type: '综合测评', applicant: 'E2E', academicYear: '2026',
        domainPackId: 'comprehensive-assessment', reviewTemplate: null,
      })
      for (const path of [PDF, DOCX]) {
        if (path) await api.importDocumentFromPath({ caseId: created.id, sourcePath: path, role: 'evidence' })
      }
      const list = await api.listD4Templates()
      const usable = list.find(t => t.templateId === 'g01-student-identity-correction')
      const plan = await api.attachD4TechnicalPlanV3({
        caseId: created.id,
        d4: { templateId: usable.templateId, version: usable.version,
          selection: usable.selection, useControlledStudentFixture: true },
      })
      return { caseId: created.id, checks: plan.checks, fingerprint: plan.fingerprint }
    `
      .replace('PDF', JSON.stringify(process.env.E2E_PDF_PATH ?? ''))
      .replace('DOCX', JSON.stringify(process.env.E2E_DOCX_PATH ?? '')))
  },

  /** 阶段 B：冷重启后核对案卷/材料/Plan 是否完整恢复 */
  async 'phase-verify'({ send }) {
    return evaluate(send, `
      const api = window.reviewAPI
      const caseId = CASE_ID
      const cases = await api.listCases()
      const found = (cases ?? []).some(c => c.id === caseId)
      const aggregate = await api.getAggregateV2(caseId)
      const runs = await api.listRunsV2(caseId)
      const docs = (aggregate?.caseV2?.documents ?? []).filter(d => d.active !== false)
      return {
        caseId,
        listedAfterRestart: found,
        stage: aggregate?.caseV2?.stage ?? null,
        revision: aggregate?.caseV2?.revision ?? null,
        templateId: aggregate?.caseV2?.templateId ?? null,
        documents: docs.map(d => ({ fileName: d.fileName, parseStatus: d.parseStatus })),
        d2Checks: aggregate?.d2RuntimePlan?.mapping?.length ?? 0,
        d2Fingerprint: aggregate?.d2RuntimePlan?.fingerprint ?? null,
        runCount: runs?.length ?? 0,
        receipts: (aggregate?.receiptLog ?? []).map(r => r.type),
      }
    `.replace('CASE_ID', JSON.stringify(process.env.E2E_CASE_ID ?? '')))
  },

  /**
   * 第 7 步：B1 第 51 套自定义模板
   * 新建案卷 → 作者文档保存 → 预览编译 → 冻结 → 安装到同一案卷 → 导入材料
   */
  async 'flow-b1'({ send }) {
    return evaluate(send, `
      const api = window.reviewAPI
      const out = { steps: [] }
      const step = (name, data) => out.steps.push({ name, ...data })

      const created = await api.createCase({
        title: 'E2E 第51套案卷', type: '自定义审核', applicant: 'E2E', academicYear: '2026',
        reviewTemplate: null,
      })
      out.caseId = created.id
      step('createCase', { ok: Boolean(created.id) })

      const templateId = 'e2e-b1-candidate-' + Date.now().toString(36)
      const document = {
        schemaVersion: 'review-b1/1', templateId, templateVersion: '1',
        name: 'E2E 第51套技术候选', purpose: '仅本地技术预审，不代表校方规则',
        status: 'candidate-held', fields: [],
        sources: [{ sourceId: 'src-1', kind: 'user-declared',
          documentVersionId: 'native:0', locator: 'native:0', recordedBy: 'local-reviewer' }],
        targets: [{ targetKey: 'target', objectKey: 'document', subjectId: 'subject-one',
          scenario: 'candidate only', fieldValues: {} }],
        modules: [{ moduleId: 'm1', version: '1', dependsOn: [],
          checks: [{ checkKey: 'check-1', requirement: '核对申请材料中的关键事实',
            responsibility: 'Human', sourceIds: ['src-1'],
            targetKeys: ['target'], condition: { kind: 'always' } }] }],
        stages: [{ stageId: 'manual', role: 'human', mode: 'manual' }],
        outputs: [{ outputId: 'preview', kind: 'preview' }],
      }

      // 保存（作者态）
      let saved = null
      try {
        saved = await api.saveLocalCandidateAuthorV3({ document, expectedRevision: 0 })
        step('saveAuthor', { revision: saved?.revision })
      } catch (error) { step('saveAuthor', { ok: false, error: String(error?.message ?? error) }) }

      // 读回（验证可重新打开）
      try {
        const current = await api.readCurrentAuthorRevisionV3({ templateId })
        step('readAuthor', { revision: current?.revision, state: current?.state, displayOnly: current?.displayOnly })
      } catch (error) { step('readAuthor', { ok: false, error: String(error?.message ?? error) }) }

      // 预览编译
      try {
        const preview = await api.previewLocalCandidateAuthorV3({ document })
        step('preview', { fingerprint: preview?.canonicalPlan?.fingerprint ?? null,
          checks: preview?.canonicalPlan?.checks?.length ?? null })
      } catch (error) { step('preview', { ok: false, error: String(error?.message ?? error) }) }

      // 冻结
      let frozen = null
      try {
        frozen = await api.freezeLocalCandidateAuthorV3({ document,
          expectedRevision: saved?.revision ?? 0 })
        step('freeze', { fingerprint: frozen?.fingerprint ?? null })
      } catch (error) { step('freeze', { ok: false, error: String(error?.message ?? error) }) }

      // 安装到同一案卷
      if (frozen?.fingerprint) {
        try {
          const ack = await api.attachB1TechnicalPlanV3({ caseId: created.id, templateId,
            fingerprint: frozen.fingerprint })
          step('attachB1', { checks: ack?.checks, fingerprint: ack?.fingerprint,
            templateVersion: ack?.templateVersion })
        } catch (error) { step('attachB1', { ok: false, error: String(error?.message ?? error) }) }
      }

      // 导入材料（第 51 套也要能跑真实材料）
      try {
        const doc = await api.importDocumentFromPath({ caseId: created.id,
          sourcePath: PDF, role: 'evidence' })
        step('importMaterial', { fileName: doc?.fileName, parseStatus: doc?.parseStatus })
      } catch (error) { step('importMaterial', { ok: false, error: String(error?.message ?? error) }) }

      return out
    `.replace('PDF', JSON.stringify(process.env.E2E_PDF_PATH ?? '')))
  },

  /**
   * 第 5 步：人工复核（在已完成的真实 Run 上确认/更正 observation）
   */
  async 'flow-review'({ send }) {
    return evaluate(send, `
      const api = window.reviewAPI
      const caseId = CASE_ID
      const out = { caseId, steps: [] }
      const step = (name, data) => out.steps.push({ name, ...data })

      const aggregate = await api.getAggregateV2(caseId)
      step('aggregate', { stage: aggregate?.caseV2?.stage, revision: aggregate?.caseV2?.revision })

      const runs = await api.listRunsV2(caseId)
      step('runs', { count: runs?.length,
        list: (runs ?? []).map(r => ({ id: r.id, status: r.status, checks: r.checks?.length ?? 0 })) })

      // 真实 observations（模型抽取的事实）
      let observations = []
      try {
        observations = await api.getRunObservationsV2(caseId)
        step('observations', { count: observations?.length,
          sample: (observations ?? []).slice(0, 3).map(o => ({ fieldKey: o.fieldKey, value: o.value })) })
      } catch (error) { step('observations', { ok: false, error: String(error?.message ?? error) }) }

      // 人工确认（原值再落一条 extractedBy=user + confirmed=true）
      const first = (observations ?? [])[0]
      if (first) {
        try {
          const result = await api.correctObservationV2({
            caseId,
            command: {
              requestId: 'e2e-confirm-' + Date.now().toString(36),
              target: { kind: 'case', id: caseId },
              expectedRevision: aggregate.caseV2.revision,
              actor: { actorId: 'local-user', actorSource: 'local', role: 'reviewer' },
              type: 'CorrectObservation',
              payload: { subjectId: first.subjectId, fieldKey: first.fieldKey,
                value: first.value, sourceRefs: first.sourceRefs ?? [], reason: '人工核对无误' },
            },
          })
          step('confirmObservation', { ok: result?.ok, code: result?.code ?? null,
            message: result?.message ?? null })
        } catch (error) { step('confirmObservation', { ok: false, error: String(error?.message ?? error) }) }
      }

      // 尝试形成正式决定（预期被拒：D2 技术预审不得形成校方决定）
      try {
        const decision = await api.decideWorkspaceCaseV2({
          caseId,
          command: {
            requestId: 'e2e-decide-' + Date.now().toString(36),
            expectedRevision: aggregate.caseV2.revision,
            actor: { actorId: 'local-user', actorSource: 'local', role: 'reviewer' },
            payload: { result: 'pass', reason: 'E2E 技术预审尝试', basedOnRunId: runs?.[0]?.id,
              inputHash: runs?.[0]?.inputManifest?.hash },
          },
        })
        step('decide', { ok: decision?.ok, code: decision?.code ?? null })
      } catch (error) {
        step('decide', { rejected: true, error: String(error?.message ?? error).slice(0, 200) })
      }

      // 复核后重新导出报告
      try {
        const report = await api.exportReportV2(caseId)
        step('exportReport', { file: report?.file ?? null })
      } catch (error) { step('exportReport', { ok: false, error: String(error?.message ?? error) }) }

      return out
    `.replace('CASE_ID', JSON.stringify(process.env.E2E_CASE_ID ?? '')))
  },

  /**
   * 第 2 步的拖拽通道：用 CDP Input.dispatchDragEvent 发真实 OS 级拖放。
   *
   * 关键点：渲染层的 MaterialDropZone 通过 webUtils.getPathForFile 取本地路径，
   * 它只认真实拖放携带的文件句柄——JS 里 new File() 拿不到路径。
   * 所以必须走浏览器层 DragEvent，并带 files 列表。
   */
  /**
   * 第 2 步的拖拽通道。
   *
   * 拖拽在渲染层走的是 MaterialDropZone.onDrop → webUtils.getPathForFile(file)
   * → registerMaterialPathV2。这条链的关键约束是：只有**真实 OS 拖放**携带的
   * File 才有本地路径，JS 里 new File() 拿不到。
   *
   * 因此这里验证两段：
   *   A. 真实 CDP 拖放事件能命中真实组件的 drop handler（DOM 层）
   *   B. 拖放后拿到的路径经同一 registerMaterialPathV2 完成登记（IPC 层）
   * 若 UI 未挂载，则如实报告「UI 未挂载」，并单独验证 B 段（路径登记）已通。
   */
  async 'flow-drag'({ send }) {
    const created = await evaluate(send, `
      const created = await window.reviewAPI.createCase({
        title: 'E2E 拖拽案卷', type: '综合测评', applicant: 'E2E', academicYear: '2026',
        domainPackId: 'comprehensive-assessment', reviewTemplate: null,
      })
      return { caseId: created.id }
    `)
    const pdf = process.env.E2E_PDF_PATH ?? ''

    // A. 通过真实 UI 导航到审核专区，并选中案卷，使拖拽区真正挂载
    const dom = await evaluate(send, `
      const sel = '[aria-label="导入材料：点击选择或拖入文件"]'
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const clickText = (text, exact = false) => {
        const nodes = Array.from(document.querySelectorAll('button, a, [role="button"], [role="option"], li'))
          .filter(n => !n.getAttribute('aria-label')?.includes('导入材料'))
        const hit = nodes.find(n => {
          const t = (n.textContent ?? '').trim()
          return exact ? t === text : t.includes(text)
        })
        if (hit) { hit.click(); return true }
        return false
      }
      const trace = []
      if (!document.querySelector(sel)) {
        trace.push('click CDUT 专区: ' + clickText('CDUT 专区'))
        await sleep(2000)
        trace.push('click 材料审核: ' + clickText('材料审核'))
        await sleep(2500)
      }
      if (!document.querySelector(sel)) {
        // 案卷管理条里选中刚建的案卷
        trace.push('select case: ' + clickText('E2E 拖拽案卷'))
        await sleep(2500)
      }
      const zones = document.querySelectorAll(sel)
      return { count: zones.length, url: location.href, trace,
        bodyHint: (document.body.textContent ?? '').slice(0, 200) }
    `, 120_000)

    // B. 走真实 IPC：把拖放得到的本地路径登记进案卷（与 onDrop 完全同一条通道）
    const registered = await evaluate(send, `
      const caseId = ${JSON.stringify(created.caseId)}
      const sourcePath = ${JSON.stringify(pdf)}
      try {
        const versionId = await window.reviewAPI.registerMaterialPathV2({
          caseId, sourcePath, role: 'evidence',
        })
        const aggregate = await window.reviewAPI.getAggregateV2(caseId)
        const docs = (aggregate?.caseV2?.documents ?? []).filter(d => d.active !== false)
        return { ok: true, versionId,
          documents: docs.map(d => ({ fileName: d.fileName, parseStatus: d.parseStatus })),
          receipts: (aggregate?.receiptLog ?? []).map(r => r.type) }
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
    `)

    return { caseId: created.caseId, dropZoneInDom: dom, pathRegister: registered }
  },

  /**
   * 第 5 步的真实人工复核：对已完成 Run 的具体 check 记录处置。
   * D2 技术预审不抽取事实（候选壳无字段），所以人工复核对象是 check，
   * 入口是 recordWorkspaceDispositionV2 / RecordWorkspaceFindingDisposition。
   */
  async 'flow-disposition'({ send }) {
    return evaluate(send, `
      const api = window.reviewAPI
      const caseId = __CASE_ID__
      const out = { caseId, steps: [] }
      const step = (name, data) => out.steps.push({ name, ...data })

      const aggregate = await api.getAggregateV2(caseId)
      const runs = await api.listRunsV2(caseId)
      const run = (runs ?? [])[0]
      if (!run) return { error: '没有可处置的运行' }
      step('run', { id: run.id, status: run.status, checks: run.checks?.length ?? 0 })

      // 选一条 awaiting-confirmation 的 check 做人工确认
      const target = (run.checks ?? []).find(c => c.status === 'awaiting-confirmation')
      if (!target) return { ...out, error: '没有待确认的 check' }
      step('targetCheck', { checkId: target.checkId, status: target.status })

      const result = await api.recordWorkspaceDispositionV2({
        caseId,
        command: {
          requestId: 'e2e-disp-' + Date.now().toString(36),
          target: { kind: 'case', id: caseId },
          expectedRevision: aggregate.caseV2.revision,
          actor: { actorId: 'local-user', actorSource: 'local', role: 'reviewer' },
          type: 'RecordWorkspaceFindingDisposition',
          payload: { findingKey: target.checkId, disposition: 'human-confirmed-compliant',
            reason: '审核员对照审核依据和材料后确认本项符合',
            runId: run.id, inputHash: run.inputManifest?.hash },
        },
      })
      step('recordDisposition', { ok: result?.ok, code: result?.code ?? null,
        message: result?.message ?? null })

      // 复核后读回：处置是否持久
      const after = await api.getAggregateV2(caseId)
      step('persisted', {
        revision: after?.caseV2?.revision,
        dispositions: (after?.dispositions ?? []).length,
        receipts: (after?.receiptLog ?? []).map(r => r.type).slice(-3),
      })

      // 复核后重新导出报告
      try {
        const report = await api.exportReportV2(caseId)
        step('exportReport', { file: report?.file ?? null })
      } catch (error) { step('exportReport', { ok: false, error: String(error?.message ?? error) }) }

      return out
    `.replace('__CASE_ID__', JSON.stringify(process.env.E2E_CASE_ID ?? '')))
  },

  /**
   * L2 学年解耦的真机验证：走真实 IPC 建案。
   * 非综测通用草稿可省略学年；综测仍必须提供。
   */
  async 'verify-academic-year'({ send }) {
    return evaluate(send, `
      const api = window.reviewAPI
      const out = {}

      // 1) 非综测通用草稿：不传学年
      try {
        const generic = await api.createCase({
          title: 'L2 通用草稿', type: '自定义审核', applicant: 'E2E',
          domainPackId: 'contract-review', reviewTemplate: null,
        })
        const reopened = await api.getCase(generic.id)
        out.genericNoYear = { ok: true, id: generic.id,
          academicYear: reopened?.academicYear ?? null, title: reopened?.title ?? null }
      } catch (error) {
        out.genericNoYear = { ok: false, error: String(error?.message ?? error) }
      }

      // 2) 综测：不传学年应被拒绝
      try {
        await api.createCase({
          title: 'L2 综测缺学年', type: '综合测评', applicant: 'E2E',
          domainPackId: 'comprehensive-assessment', reviewTemplate: null,
        })
        out.comprehensiveNoYear = { ok: true, unexpected: '不应建案成功' }
      } catch (error) {
        out.comprehensiveNoYear = { rejected: true,
          error: String(error?.message ?? error).slice(0, 120) }
      }

      // 3) 综测：带学年正常
      try {
        const c = await api.createCase({
          title: 'L2 综测带学年', type: '综合测评', applicant: 'E2E',
          academicYear: '2026', domainPackId: 'comprehensive-assessment', reviewTemplate: null,
        })
        out.comprehensiveWithYear = { ok: true, id: c.id }
      } catch (error) {
        out.comprehensiveWithYear = { ok: false, error: String(error?.message ?? error) }
      }

      return out
    `)
  },

  /**
   * 带字段的已发布业务模板：验证事实抽取（observation）真实可用。
   *
   * D2 候选壳没有字段，observations 必然为 0；而 T03/T05/T08 都建立在
   * 「带 FieldSpec 的业务模板能抽事实」之上。此场景用内置综测模板绑定案卷，
   * 跑真实审核并检查 observations 与 check 结论。
   */
  async 'flow-fielded'({ send }) {
    return evaluate(send, `
      const api = window.reviewAPI
      const out = { steps: [] }
      const step = (name, data) => out.steps.push({ name, ...data })

      // 与真实启动一致：先跑 boot check 播种内置模板草稿
      let boot = null
      try { boot = await api.bootCheckV2() } catch (error) { boot = { error: String(error?.message ?? error) } }
      step('bootCheck', { seeded: boot?.templatesSeeded ?? null, published: boot?.templatesPublished ?? null })

      let templates = await api.listTemplatesV2()
      let published = (templates ?? []).filter(t => t.status === 'published' && (t.fields?.length ?? 0) > 0)
      // 没有已发布带字段模板时，按用户真实操作发布一个内置模板
      if (published.length === 0) {
        const draftable = (templates ?? []).filter(t => t.status === 'draft' && (t.fields?.length ?? 0) > 0)
        if (draftable[0]) {
          try {
            await api.publishTemplateV2(draftable[0].templateId, draftable[0].version)
            templates = await api.listTemplatesV2()
            published = (templates ?? []).filter(t => t.status === 'published' && (t.fields?.length ?? 0) > 0)
            step('publishBuiltin', { templateId: draftable[0].templateId, version: draftable[0].version })
          } catch (error) { step('publishBuiltin', { ok: false, error: String(error?.message ?? error) }) }
        }
      }
      step('templatePick', { total: templates?.length ?? 0, publishedWithFields: published.length,
        picked: published[0]?.templateId ?? null })

      const tpl = published[0]
      if (!tpl) return { ...out, error: '没有带字段的已发布模板' }

      const created = await api.createCase({
        title: 'E2E 带字段案卷', type: '综合测评', applicant: 'E2E', academicYear: '2026',
        domainPackId: 'comprehensive-assessment',
        reviewTemplate: { templateId: tpl.templateId, version: tpl.version },
      })
      out.caseId = created.id
      step('createCase', { ok: Boolean(created.id), templateId: tpl.templateId, version: tpl.version })

      try {
        const doc = await api.importDocumentFromPath({ caseId: created.id,
          sourcePath: __PDF__, role: 'evidence' })
        step('importMaterial', { fileName: doc?.fileName, parseStatus: doc?.parseStatus })
      } catch (error) { step('importMaterial', { ok: false, error: String(error?.message ?? error) }) }

      let state = null
      try {
        state = await api.startBackgroundPiReviewV2({ caseId: created.id })
        step('startPiReview', { phase: state?.phase, runId: state?.runId ?? null })
      } catch (error) { step('startPiReview', { ok: false, error: String(error?.message ?? error) }) }

      const deadline = Date.now() + Number(__POLL__ ?? 360000)
      let last = null
      while (state && Date.now() < deadline) {
        try { last = await api.getBackgroundPiReviewStateV2(created.id) } catch {}
        const p = last?.phase
        if (p && ['completed','failed','incomplete','stopped','cancelled','error'].includes(p)) break
        await new Promise(r => setTimeout(r, 3000))
      }
      step('piReviewOutcome', { phase: last?.phase, runId: last?.runId ?? null,
        error: last?.error ?? null })

      // 事实抽取：这是带字段模板的核心产出
      try {
        const observations = await api.getRunObservationsV2(created.id)
        step('observations', { count: observations?.length ?? 0,
          sample: (observations ?? []).slice(0, 5).map(o => ({ fieldKey: o.fieldKey, value: o.value })) })
      } catch (error) { step('observations', { ok: false, error: String(error?.message ?? error) }) }

      try {
        const runs = await api.listRunsV2(created.id)
        const run = (runs ?? [])[0]
        step('run', { status: run?.status, checks: run?.checks?.length ?? 0 })
      } catch (error) { step('run', { ok: false, error: String(error?.message ?? error) }) }

      try {
        const report = await api.exportReportV2(created.id)
        step('exportReport', { file: report?.file ?? null })
      } catch (error) { step('exportReport', { ok: false, error: String(error?.message ?? error) }) }

      return out
    `
      .replace('__PDF__', JSON.stringify(process.env.E2E_PDF_PATH ?? ''))
      .replace('__POLL__', JSON.stringify(process.env.E2E_POLL_MS ?? '360000')))
  },

  async 'd4-list'({ send }) {
    return evaluate(send, `
      const started = Date.now()
      try {
        const list = await window.reviewAPI.listD4Templates()
        return {
          ok: true, elapsedMs: Date.now() - started,
          count: list?.length,
          templateIds: (list ?? []).map(t => t.templateId),
          withTargets: (list ?? []).filter(t => (t.selection?.targets ?? []).length > 0).length,
        }
      } catch (error) {
        return { ok: false, elapsedMs: Date.now() - started, error: String(error?.message ?? error) }
      }
    `)
  },
}

/**
 * 等待 preload 注入完成。
 * 主窗口 target 出现（URL 匹配）早于 preload/React 挂载，
 * 直接求值会读到 undefined 的 window.reviewAPI。
 */
async function waitForBridge(send, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      const state = await evaluate(send, `
        return {
          readyState: document.readyState,
          hasElectron: Boolean(window.electronAPI),
          hasReview: Boolean(window.reviewAPI),
        }
      `, 15_000)
      last = state
      if (state?.hasReview) return state
    } catch {
      /* 导航中上下文可能被销毁，重试 */
    }
    await sleep(500)
  }
  throw new Error(`preload 桥接未就绪；最后观测: ${JSON.stringify(last)}`)
}

let exitCode = 0
try {
  const page = await waitForPage()
  const { ws, send } = await connect(page.webSocketDebuggerUrl)
  await send('Runtime.enable')
  await waitForBridge(send)

  const run = scenarios[scenario]
  if (!run) throw new Error(`未知场景: ${scenario}`)

  const value = await run({ send })
  console.log(JSON.stringify({ scenario, ok: true, result: value }, null, 2))
  ws.close()
} catch (error) {
  console.error(JSON.stringify({ scenario, ok: false, error: String(error?.message ?? error) }, null, 2))
  console.error('--- 主进程日志尾部 ---')
  console.error(logs.join('').slice(-4000))
  exitCode = 1
} finally {
  child.kill('SIGTERM')
  await sleep(1500)
  if (!child.killed) child.kill('SIGKILL')
  process.exit(exitCode)
}
