/**
 * 内容审核专区 - IPC 处理器注册
 *
 * 对应共享通道常量：packages/shared/src/types/review.ts 的 REVIEW_IPC_CHANNELS。
 * preload 侧桥接：apps/electron/src/preload/index.ts 的 reviewAPI。
 *
 * 设计决策（docs/plans/2026-10-02-content-review-demo-implementation.md D2）：
 * 独立注册函数 registerReviewIpc()，由 main/ipc.ts 的 registerIpcHandlers() 调用一次，
 * 避免向 7700+ 行的 ipc.ts 继续追加业务逻辑。
 */

import { ipcMain } from 'electron'
import {
  REVIEW_IPC_CHANNELS,
  type AssistantChatRequest,
  type ExportReportResult,
  type GenerateRuleOutlineRequest,
  type ReviewCase,
  type ReviewCaseType,
  type ReviewItem,
  type ReviewModelGatewayStatus,
  type ReviewRun,
  type RuleOutlineItem,
  type SourceDocument,
  type UpdateCaseSettingsRequest,
} from '@profer/shared'
import {
  deleteCase,
  getCase,
  listCases,
  loadDemoCase,
  saveCase,
  updateCase,
} from './case-store'
import { parseFileIntoSourceDocument } from './document-service'
import {
  extractItems,
  generateRuleOutline,
  reviewAssistantChat,
  runAiReview,
} from './ai-review-service'
import { startReviewRun } from './run-service'
import { exportReport } from './report-service'
import { getReviewModelGatewayStatus } from './review-model-gateway'
import { createEmptyCase } from './case-creation'
import { importDocumentIntoCase } from './case-import'

/** 来源角色枚举（IMPORT_DOCUMENT 入参白名单） */
const SOURCE_ROLES: ReadonlySet<string> = new Set(['rule', 'application', 'evidence'])

/** 审核类型枚举（CREATE_CASE 入参白名单） */
const CASE_TYPES: ReadonlySet<string> = new Set(['综合测评', '活动申请', '自定义审核'])

/** 可续跑的运行状态（未终态：崩溃中断 / 运行中 / 等待人工输入） */
const RESUMABLE_RUN_STATUSES: ReadonlySet<string> = new Set(['failed', 'running', 'awaiting-input'])

/** 收窄字符串入参（非字符串 → 中文错误，IPC 边界上类型注解不生效） */
function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`参数 ${name} 缺失或类型非法`)
  }
  return value
}

/**
 * 注册内容审核专区全部 IPC 处理器。
 *
 * 由 registerIpcHandlers() 在应用启动时调用一次（幂等由外层守卫保证）。
 */
export function registerReviewIpc(): void {
  // 启动恢复：上次进程退出时仍在 running 的运行不可能自行推进，先标记为中断（可续跑）
  try {
    const { recoverInterruptedRuns } = require('./run-store-v2') as typeof import('./run-store-v2')
    recoverInterruptedRuns()
  } catch (error) {
    console.warn('[审核专区] 中断运行恢复失败（不阻断处理器注册）', error)
  }

  // ===== 案卷管理 =====

  /** 载入演示案卷（首次复制进配置目录，之后读存储） */
  ipcMain.handle(REVIEW_IPC_CHANNELS.LOAD_DEMO_CASE, (): ReviewCase => {
    return loadDemoCase()
  })

  /** 列出已存储案卷（摘要） */
  ipcMain.handle(REVIEW_IPC_CHANNELS.LIST_CASES, () => {
    return listCases()
  })

  /** 读取单个案卷 */
  ipcMain.handle(REVIEW_IPC_CHANNELS.GET_CASE, (_event, caseId: string): ReviewCase | undefined => {
    return getCase(caseId)
  })

  /** 创建空案卷 */
  ipcMain.handle(
    REVIEW_IPC_CHANNELS.CREATE_CASE,
    (
      _event,
      input: {
        title: string
        type: ReviewCaseType
        applicant: string
        academicYear: string
        domainPackId?: string
      },
    ): ReviewCase => {
      if (!input || typeof input !== 'object') throw new Error('参数 input 缺失或类型非法')
      if (!CASE_TYPES.has(input.type)) throw new Error(`参数 type 非法：${String(input.type)}`)
      // 领域包 ID 只做存在性判断：未知 ID 回落缺省包由 resolveDomainPack 负责，不因拼错而拒绝建卷
      if (input.domainPackId !== undefined && typeof input.domainPackId !== 'string') {
        throw new Error('参数 domainPackId 类型非法')
      }
      return createEmptyCase({
        title: requireString(input.title, 'title'),
        type: input.type,
        applicant: requireString(input.applicant, 'applicant'),
        academicYear: requireString(input.academicYear, 'academicYear'),
        ...(input.domainPackId ? { domainPackId: input.domainPackId } : {}),
      })
    },
  )

  /** 更新案卷设置（领域包 / 标题 / 类型 / 待审主体文档） */
  ipcMain.handle(
    REVIEW_IPC_CHANNELS.UPDATE_CASE_SETTINGS,
    async (_event, input: UpdateCaseSettingsRequest): Promise<ReviewCase> => {
      if (!input || typeof input !== 'object') throw new Error('参数 input 缺失或类型非法')
      const caseId = requireString(input.caseId, 'caseId')
      const reviewCase = getCase(caseId)
      if (!reviewCase) throw new Error(`案卷不存在: ${caseId}`)
      if (input.type !== undefined && !CASE_TYPES.has(input.type)) {
        throw new Error(`参数 type 非法：${String(input.type)}`)
      }
      if (input.domainPackId !== undefined && typeof input.domainPackId !== 'string') {
        throw new Error('参数 domainPackId 类型非法')
      }
      if (input.title !== undefined && typeof input.title !== 'string') {
        throw new Error('参数 title 类型非法')
      }
      // 待审主体文档：逐个校验是否属于本卷，防止悬空 ID 让三栏联动指向不存在的文档
      let subjectDocumentIds: string[] | undefined
      if (input.subjectDocumentIds !== undefined) {
        if (!Array.isArray(input.subjectDocumentIds) || input.subjectDocumentIds.some((id) => typeof id !== 'string')) {
          throw new Error('参数 subjectDocumentIds 类型非法')
        }
        const known = new Set(reviewCase.documents.map((doc) => doc.id))
        subjectDocumentIds = input.subjectDocumentIds.filter((id) => known.has(id))
        if (subjectDocumentIds.length !== input.subjectDocumentIds.length) {
          throw new Error('待审主体文档包含不属于本案卷的文档 ID')
        }
      }
      // M0/H05：设置变更走逐案串行写队列（读最新 → 定向 patch → revision+1），
      // 避免校验期间的其他写回（导入/大纲/识别）被整案快照覆盖
      const updated = await updateCase(
        caseId,
        (fresh) => ({
          ...fresh,
          ...(input.title !== undefined ? { title: input.title.trim() || fresh.title } : {}),
          ...(input.type !== undefined ? { type: input.type } : {}),
          ...(input.domainPackId !== undefined ? { domainPackId: input.domainPackId } : {}),
          ...(subjectDocumentIds !== undefined ? { subjectDocumentIds } : {}),
        }),
        { reason: `更新案卷设置${input.domainPackId ? `（领域包 ${input.domainPackId}）` : ''}` },
      )
      return updated
    },
  )

  /** 导入文件到案卷（系统选择框 → 解析为 SourceDocument 并写回案卷） */
  ipcMain.handle(
    REVIEW_IPC_CHANNELS.IMPORT_DOCUMENT,
    (_event, input: { caseId: string; fileName: string; role: SourceDocument['role'] }): Promise<SourceDocument> => {
      if (!input || typeof input !== 'object') throw new Error('参数 input 缺失或类型非法')
      if (!SOURCE_ROLES.has(input.role)) throw new Error(`参数 role 非法：${String(input.role)}`)
      return importDocumentIntoCase({
        caseId: requireString(input.caseId, 'caseId'),
        fileName: requireString(input.fileName, 'fileName'),
        role: input.role,
      })
    },
  )

  /** 查询最近一次运行及输入有效性（M0/H09：恢复 + 过期标记） */
  ipcMain.handle(REVIEW_IPC_CHANNELS.LATEST_RUN, (_event, caseId: string) => {
    if (typeof caseId !== 'string' || caseId.length === 0) throw new Error('参数 caseId 非法')
    // 惰性引入避免与 run-service 的模块初始化顺序耦合（与 GET_RUN 同款做法）
    const { getLatestRunStatus } = require('./run-service') as typeof import('./run-service')
    return getLatestRunStatus(caseId)
  })

  // ===== V2 通道（M5：全部薄委托，服务层见 review-v2 系列文件） =====
  ipcMain.handle(REVIEW_IPC_CHANNELS.LIST_TEMPLATES_V2, () => {
    const { listTemplates } = require('./template-store') as typeof import('./template-store')
    return listTemplates()
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.GET_TEMPLATE_V2, (_e, templateId: string, version?: number) => {
    if (typeof templateId !== 'string' || !templateId) throw new Error('参数 templateId 非法')
    const { getTemplate } = require('./template-store') as typeof import('./template-store')
    return getTemplate(templateId, version)
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.PUBLISH_TEMPLATE_V2, (_e, templateId: string, version: number) => {
    if (typeof templateId !== 'string' || !templateId || !Number.isFinite(version)) throw new Error('参数非法')
    const { publishTemplate } = require('./template-store') as typeof import('./template-store')
    return publishTemplate(templateId, version)
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.LIST_RUNS_V2, (_e, caseId: string) => {
    if (typeof caseId !== 'string' || !caseId) throw new Error('参数 caseId 非法')
    const { listRunsV2 } = require('./run-store-v2') as typeof import('./run-store-v2')
    return listRunsV2(caseId)
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.GET_RUN_V2, (_e, input: { caseId: string; runId: string }) => {
    if (!input?.caseId || !input?.runId) throw new Error('参数非法')
    const { getRunV2 } = require('./run-store-v2') as typeof import('./run-store-v2')
    return getRunV2(input.caseId, input.runId)
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.CANCEL_RUN_V2, (_e, runId: string) => {
    if (typeof runId !== 'string' || !runId) throw new Error('参数 runId 非法')
    const { cancelRunV2 } = require('./run-service-v2') as typeof import('./run-service-v2')
    cancelRunV2(runId)
    return true
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.MIGRATE_CASE_V2, (_e, caseId: string) => {
    if (typeof caseId !== 'string' || !caseId) throw new Error('参数 caseId 非法')
    const { getCase } = require('./case-store') as typeof import('./case-store')
    const { migrateCaseToV2 } = require('./migration') as typeof import('./migration')
    const v1 = getCase(caseId)
    if (!v1) throw new Error(`案卷不存在: ${caseId}`)
    return migrateCaseToV2(v1)
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.BOOT_CHECK_V2, () => {
    const { runBootCheckV2 } = require('./boot-check') as typeof import('./boot-check')
    return runBootCheckV2()
  })

  // ===== N1d：V2 应用命令（薄委托 application-service / fixture） =====
  ipcMain.handle(REVIEW_IPC_CHANNELS.SEED_FIXTURE_V2, () => {
    const { seedComprehensiveFixture, publishComprehensiveFixture } = require('./fixtures/comprehensive-fixture') as typeof import('./fixtures/comprehensive-fixture')
    const { getTemplate, saveDraft, publishTemplate } = require('./template-store') as typeof import('./template-store')
    seedComprehensiveFixture({ getTemplate, saveDraft })
    publishComprehensiveFixture({ getTemplate, saveDraft, publish: publishTemplate })
    return true
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.CREATE_CASE_V2, (_e, input: { caseId: string; templateId: string; version: number; payload: unknown; actor: import('@profer/shared').Actor }) => {
    if (!input?.caseId || !input?.templateId) throw new Error('参数非法')
    const { createCaseFromTemplate } = require('./application-service') as typeof import('./application-service')
    return createCaseFromTemplate(input.templateId, input.version, input.payload as never, input.actor, input.caseId)
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.GET_AGGREGATE_V2, (_e, caseId: string) => {
    if (typeof caseId !== 'string' || !caseId) throw new Error('参数 caseId 非法')
    const { getCaseV2Aggregate } = require('./application-service') as typeof import('./application-service')
    return getCaseV2Aggregate(caseId)
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.UPDATE_FIELDS_V2, (_e, input: { caseId: string; command: import('@profer/shared').ReviewCommandV2<unknown> }) => {
    const { updateFields } = require('./application-service') as typeof import('./application-service')
    const command = input.command as unknown as { requestId: string; actor: import('@profer/shared').Actor; expectedRevision: number; payload: unknown }
    return updateFields(input.caseId, command as unknown as Parameters<typeof updateFields>[1])
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.CORRECT_OBSERVATION_V2, (_e, input: { caseId: string; command: import('@profer/shared').ReviewCommandV2<unknown> }) => {
    const { correctObservation } = require('./application-service') as typeof import('./application-service')
    const command = input.command as unknown as { requestId: string; actor: import('@profer/shared').Actor; expectedRevision: number; payload: unknown }
    return correctObservation(input.caseId, command as unknown as Parameters<typeof correctObservation>[1])
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.SET_EVIDENCE_LINK_V2, (_e, input: { caseId: string; command: import('@profer/shared').ReviewCommandV2<unknown> }) => {
    const { setEvidenceLink } = require('./application-service') as typeof import('./application-service')
    const command = input.command as unknown as { requestId: string; actor: import('@profer/shared').Actor; expectedRevision: number; payload: unknown }
    return setEvidenceLink(input.caseId, command as unknown as Parameters<typeof setEvidenceLink>[1])
  })

  // ===== N3b：业务闭环命令（薄委托 stage-workflow） =====
  ipcMain.handle(REVIEW_IPC_CHANNELS.RECORD_STAGE_DECISION_V2, (_e, input: { caseId: string; command: Record<string, unknown>; templateId: string; version: number }) => {
    const { recordStageDecision } = require('./stage-workflow') as typeof import('./stage-workflow')
    const { getTemplate } = require('./template-store') as typeof import('./template-store')
    const template = getTemplate(input.templateId, input.version)
    if (!template) throw new Error(`模板不存在: ${input.templateId}@${input.version}`)
    return recordStageDecision(input.caseId, input.command as unknown as Parameters<typeof recordStageDecision>[1], template)
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.RESOLVE_SUPPLEMENT_V2, (_e, input: { caseId: string; command: Record<string, unknown> }) => {
    const { resolveSupplementV2 } = require('./stage-workflow') as typeof import('./stage-workflow')
    return resolveSupplementV2(input.caseId, input.command as unknown as Parameters<typeof resolveSupplementV2>[1])
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.RESPOND_SUPPLEMENT_V2, (_e, input: { caseId: string; command: Record<string, unknown> }) => {
    const { respondSupplementV2 } = require('./stage-workflow') as typeof import('./stage-workflow')
    return respondSupplementV2(input.caseId, input.command as unknown as Parameters<typeof respondSupplementV2>[1])
  })
  // ===== G02：V2 真实运行（网关客户端 → 真实执行器 → 运行图管线；未配置渠道时明确报错不冒充审核） =====
  ipcMain.handle(REVIEW_IPC_CHANNELS.RUN_BATCH_V2, async (_e, batchId: string) => {
    if (typeof batchId !== 'string' || !batchId) throw new Error('参数 batchId 非法')
    const { runBatchQueue } = require('./batch-store') as typeof import('./batch-store')
    const { getCaseV2Aggregate } = require('./application-service') as typeof import('./application-service')
    const { getTemplate } = require('./template-store') as typeof import('./template-store')
    const { runReviewCaseV2 } = require('./run-service-v2') as typeof import('./run-service-v2')
    const { resolveReviewGatewayChannel, chatCompletion, REVIEW_RUN_TIMEOUT_MS } = require('./review-model-gateway') as typeof import('./review-model-gateway')
    const { assembleV2Executors } = require('./v2-executor-factory') as typeof import('./v2-executor-factory')
    const { listRunsV2 } = require('./run-store-v2') as typeof import('./run-store-v2')
    const resolved = resolveReviewGatewayChannel()
    if (!resolved) throw new Error('未配置可用模型渠道，无法执行批次审核')
    const client = {
      protocol: (resolved.channel as { protocol?: string }).protocol ?? 'openai-chat',
      complete: async (input: { prompt: string; system: string; signal?: AbortSignal }) => ({
        content: await chatCompletion(resolved.channel, [{ role: 'system', content: input.system }, { role: 'user', content: input.prompt }], { timeoutMs: REVIEW_RUN_TIMEOUT_MS }),
      }),
    }
    return runBatchQueue(batchId, {
      runCase: async (caseId: string) => {
        const aggregate = getCaseV2Aggregate(caseId)
        if (!aggregate) throw new Error(`案卷聚合不存在: ${caseId}`)
        const template = getTemplate(aggregate.caseV2.templateId, aggregate.caseV2.templateVersion)
        if (!template) throw new Error(`模板不存在: ${aggregate.caseV2.templateId}`)
        const resumable = listRunsV2(caseId).find((candidate) => RESUMABLE_RUN_STATUSES.has(candidate.status))
        const run = await runReviewCaseV2(aggregate.caseV2, template, assembleV2Executors(aggregate, template, { client }), resumable ? { resumeRunId: resumable.id } : {})
        return { status: run.status }
      },
    })
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.RUN_REVIEW_V2, async (_e, caseId: string) => {
    if (typeof caseId !== 'string' || !caseId) throw new Error('参数 caseId 非法')
    const { getCaseV2Aggregate } = require('./application-service') as typeof import('./application-service')
    const { getTemplate } = require('./template-store') as typeof import('./template-store')
    const { runReviewCaseV2 } = require('./run-service-v2') as typeof import('./run-service-v2')
    const { resolveReviewGatewayChannel, chatCompletion, REVIEW_RUN_TIMEOUT_MS } = require('./review-model-gateway') as typeof import('./review-model-gateway')
    const { assembleV2Executors } = require('./v2-executor-factory') as typeof import('./v2-executor-factory')
    const aggregate = getCaseV2Aggregate(caseId)
    if (!aggregate) throw new Error(`案卷聚合不存在: ${caseId}`)
    const template = getTemplate(aggregate.caseV2.templateId, aggregate.caseV2.templateVersion)
    if (!template) throw new Error(`模板不存在: ${aggregate.caseV2.templateId}@${aggregate.caseV2.templateVersion}`)
    const resolved = resolveReviewGatewayChannel()
    if (!resolved) throw new Error('未配置可用模型渠道，无法执行真实审核（请在设置中配置渠道）')
    const client = {
      protocol: (resolved.channel as { protocol?: string }).protocol ?? 'openai-chat',
      complete: async (input: { prompt: string; system: string; signal?: AbortSignal }) => ({
        content: await chatCompletion(resolved.channel, [
          { role: 'system', content: input.system },
          { role: 'user', content: input.prompt },
        ], { timeoutMs: REVIEW_RUN_TIMEOUT_MS }),
      }),
    }
    const executors = assembleV2Executors(aggregate, template, { client })
    return runReviewCaseV2(aggregate.caseV2, template, executors, {})
  })
  /** 续跑：沿用既有运行检查点，生成新运行（旧运行文件不动） */
  ipcMain.handle(REVIEW_IPC_CHANNELS.RESUME_RUN_V2, async (_e, input: { caseId: string; runId?: string }) => {
    if (!input || typeof input !== 'object') throw new Error('参数 input 缺失或类型非法')
    const caseId = requireString(input.caseId, 'caseId')
    if (input.runId !== undefined && typeof input.runId !== 'string') throw new Error('参数 runId 类型非法')
    const { getCaseV2Aggregate } = require('./application-service') as typeof import('./application-service')
    const { getTemplate } = require('./template-store') as typeof import('./template-store')
    const { runReviewCaseV2 } = require('./run-service-v2') as typeof import('./run-service-v2')
    const { resolveReviewGatewayChannel, chatCompletion, REVIEW_RUN_TIMEOUT_MS } = require('./review-model-gateway') as typeof import('./review-model-gateway')
    const { assembleV2Executors } = require('./v2-executor-factory') as typeof import('./v2-executor-factory')
    const aggregate = getCaseV2Aggregate(caseId)
    if (!aggregate) throw new Error(`案卷聚合不存在: ${caseId}`)
    const template = getTemplate(aggregate.caseV2.templateId, aggregate.caseV2.templateVersion)
    if (!template) throw new Error(`模板不存在: ${aggregate.caseV2.templateId}@${aggregate.caseV2.templateVersion}`)
    // 未指定目标运行：取最近一条未终态运行（崩溃中断 / 等待输入）
    const targetRunId = input.runId ?? findResumableRunId(caseId)
    if (!targetRunId) throw new Error('没有可续跑的运行')
    const resolved = resolveReviewGatewayChannel()
    if (!resolved) throw new Error('未配置可用模型渠道，无法执行真实审核（请在设置中配置渠道）')
    const client = {
      protocol: (resolved.channel as { protocol?: string }).protocol ?? 'openai-chat',
      complete: async (request: { prompt: string; system: string; signal?: AbortSignal }) => ({
        content: await chatCompletion(resolved.channel, [
          { role: 'system', content: request.system },
          { role: 'user', content: request.prompt },
        ], { timeoutMs: REVIEW_RUN_TIMEOUT_MS }),
      }),
    }
    return runReviewCaseV2(aggregate.caseV2, template, assembleV2Executors(aggregate, template, { client }), { resumeRunId: targetRunId })
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.CAST_RATING_V2, (_e, input: { caseId: string; command: Record<string, unknown> }) => {
    const { castRating } = require('./rating-service') as typeof import('./rating-service')
    return castRating(input.caseId, input.command as unknown as Parameters<typeof castRating>[1])
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.RESOLVE_APPEAL_V2, (_e, input: { caseId: string; command: Record<string, unknown> }) => {
    const { resolveAppealV2 } = require('./stage-workflow') as typeof import('./stage-workflow')
    return resolveAppealV2(input.caseId, input.command as unknown as Parameters<typeof resolveAppealV2>[1])
  })

  // ===== N4b：模板向导（无代码创建：政策先行 → 模板草稿 → 发布走 PUBLISH_TEMPLATE_V2） =====
  ipcMain.handle(REVIEW_IPC_CHANNELS.CREATE_POLICY_V2, (_e, input: { policyId: string; title: string; content: string; enteredBy: string }) => {
    if (!input?.policyId || !input?.content) throw new Error('参数非法')
    const { canonicalContentHash, compileOwnerRules, publishPolicy, savePolicyDraft } = require('./policy-store') as typeof import('./policy-store')
    const record = {
      policyId: input.policyId, version: 1, title: input.title, contentHash: canonicalContentHash(input.content), content: input.content,
      compiledRules: compileOwnerRules(input.content, input.policyId, 1),
      origin: { kind: 'owner-statement' as const, text: '向导录入', enteredBy: String(input.enteredBy ?? 'local-user'), enteredAt: new Date().toISOString() },
      status: 'draft' as const,
      confirmations: [{ actorId: String(input.enteredBy ?? 'local-user'), role: 'template-owner' as const, at: new Date().toISOString(), note: '向导录入确认' }],
    }
    savePolicyDraft(record)
    publishPolicy(input.policyId, 1)
    return { policyId: input.policyId, version: 1, contentHash: record.contentHash }
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.SAVE_TEMPLATE_DRAFT_V2, (_e, template: import('@profer/shared').TemplateVersion) => {
    if (!template?.templateId) throw new Error('参数非法')
    const { saveDraft } = require('./template-store') as typeof import('./template-store')
    return saveDraft(template)
  })

  // ===== N5b：批次管理（薄委托 batch-store） =====
  ipcMain.handle(REVIEW_IPC_CHANNELS.CREATE_BATCH_V2, (_e, input: { batch: import('@profer/shared').ReviewBatch }) => {
    const { createBatchV2 } = require('./batch-store') as typeof import('./batch-store')
    return createBatchV2(input.batch)
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.GET_BATCH_V2, (_e, batchId: string) => {
    const { readBatchStateV2 } = require('./batch-store') as typeof import('./batch-store')
    return readBatchStateV2(batchId)
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.BATCH_ACTION_V2, (_e, input: { action: 'finalize' | 'reopen'; batchId: string; newBatchId?: string; reason?: string; snapshot?: Record<string, unknown> }) => {
    const { finalizeBatch, reopenBatch } = require('./batch-store') as typeof import('./batch-store')
    if (input.action === 'finalize') return finalizeBatch(input.batchId, input.snapshot ?? {})
    return reopenBatch(input.batchId, input.newBatchId ?? `${input.batchId}-r${Date.now().toString(36)}`, input.reason ?? '人工重开')
  })

  ipcMain.handle(REVIEW_IPC_CHANNELS.LIST_CASES_V2, () => {
    const { listAggregatesV2 } = require('./case-store-v2') as typeof import('./case-store-v2')
    return listAggregatesV2()
  })

  // ===== G01：材料登记与提交 =====
  ipcMain.handle(REVIEW_IPC_CHANNELS.PICK_REGISTER_MATERIAL_V2, async (_e, input: { caseId: string; role: 'application' | 'evidence' | 'rule' | 'attachment'; materialSlotId?: string }) => {
    if (!input?.caseId) throw new Error('参数 caseId 非法')
        const { BrowserWindow, dialog } = require('electron') as typeof import('electron')
    const { getCaseV2Aggregate } = require('./application-service') as typeof import('./application-service')
    const aggregate = getCaseV2Aggregate(input.caseId)
    if (!aggregate) throw new Error(`案卷不存在: ${input.caseId}`)
    // 逐文件读取聚合 revision 串行登记（事务天然串行；对话框一次性返回多选）
    const actor = { actorId: 'local-user', actorSource: 'local' as const, role: 'reviewer' as const }
    const { registerMaterial } = require('./material-service') as typeof import('./material-service')
    const options = { properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'> }
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled) return []
    const versionIds: string[] = []
    for (const sourcePath of result.filePaths) {
      const fresh = getCaseV2Aggregate(input.caseId)!
      const outcome = (await registerMaterial(input.caseId, {
        requestId: `reg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        actor,
        expectedRevision: fresh.caseV2.revision,
        payload: { sourcePath, role: input.role, materialSlotId: input.materialSlotId },
      })) as { ok: boolean; message?: string }
      if (!outcome.ok) throw new Error(outcome.message ?? '登记失败')
      const updated = getCaseV2Aggregate(input.caseId)!
      versionIds.push(updated.caseV2.documents[updated.caseV2.documents.length - 1]!.versionId)
    }
    return versionIds
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.SUBMIT_CASE_V2, (_e, caseId: string) => {
    if (typeof caseId !== 'string' || !caseId) throw new Error('参数 caseId 非法')
    const { submitCaseV2 } = require('./stage-workflow') as typeof import('./stage-workflow')
    return submitCaseV2(caseId)
  })

  /** 删除案卷 */
  ipcMain.handle(REVIEW_IPC_CHANNELS.DELETE_CASE, (_event, caseId: string): void => {
    deleteCase(caseId)
  })

  // ===== AI 生成（左/中栏）=====

  /** 生成规则大纲（左栏；无出口时降级返回 fixture 大纲） */
  ipcMain.handle(
    REVIEW_IPC_CHANNELS.GENERATE_RULE_OUTLINE,
    (_event, request: GenerateRuleOutlineRequest): Promise<RuleOutlineItem[]> => {
      return generateRuleOutline(request)
    },
  )

  /** 识别可审核条目（中栏；无出口时降级返回已有条目） */
  ipcMain.handle(REVIEW_IPC_CHANNELS.EXTRACT_ITEMS, (_event, caseId: string): Promise<ReviewItem[]> => {
    return extractItems(caseId)
  })

  // ===== 审核运行（右栏）=====

  /**
   * 执行审核运行。
   *
   * 引擎选择：网关可用 → 'ai'（内部失败仍会降级 mock）；
   * 网关不可用 → 直接走确定性模拟引擎（决策 D6，保证离线可演示）。
   */
  ipcMain.handle(REVIEW_IPC_CHANNELS.RUN_REVIEW, (_event, caseId: string): Promise<ReviewRun> => {
    const engine = getReviewModelGatewayStatus().available ? 'ai' : 'mock-engine'
    return startReviewRun(caseId, engine)
  })

  /** 查询单次运行状态 */
  ipcMain.handle(
    REVIEW_IPC_CHANNELS.GET_RUN,
    (_event, input: { caseId: string; runId: string }): ReviewRun | undefined => {
      return startReviewRunLookup(input)
    },
  )

  // ===== 审核助手 =====

  /** 助手对话（无出口时降级静态解答 degraded:true） */
  ipcMain.handle(
    REVIEW_IPC_CHANNELS.ASSISTANT_CHAT,
    (_event, request: AssistantChatRequest): Promise<{ content: string; references: string[]; degraded: boolean }> => {
      if (!request || typeof request !== 'object') throw new Error('参数 request 缺失或类型非法')
      if (!Array.isArray(request.history)) throw new Error('参数 history 必须是消息数组')
      // 只允许 user/assistant 角色（阻断渲染层伪造 system 消息的提示词注入面）
      const history = request.history.filter(
        (message) => !!message && (message.role === 'user' || message.role === 'assistant'),
      )
      return reviewAssistantChat({ ...request, history })
    },
  )

  // ===== 报告与网关自检 =====

  /** 导出预审报告（JSON + Markdown） */
  ipcMain.handle(REVIEW_IPC_CHANNELS.EXPORT_REPORT, (_event, caseId: string): Promise<ExportReportResult> => {
    return exportReport(caseId)
  })

  /** 查询当前可用模型出口（白名单自检） */
  ipcMain.handle(REVIEW_IPC_CHANNELS.GET_MODEL_GATEWAY_STATUS, (): ReviewModelGatewayStatus => {
    return getReviewModelGatewayStatus()
  })

  console.log('[审核专区] IPC 处理器注册完成')
}

/** 最近一条可续跑运行（failed/running/awaiting-input）的 ID；无则 undefined */
function findResumableRunId(caseId: string): string | undefined {
  const { listRunsV2 } = require('./run-store-v2') as typeof import('./run-store-v2')
  return listRunsV2(caseId).find((run) => RESUMABLE_RUN_STATUSES.has(run.status))?.id
}

/** GET_RUN 的实现（独立函数，避免 handler 内联依赖） */
function startReviewRunLookup(input: { caseId: string; runId: string }): ReviewRun | undefined {
  // 延迟 import 避免与 startReviewRun 的命名耦合；直接复用 run-service 查询
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- 主进程内同步查询，无需动态加载
  const { getRun } = require('./run-service') as typeof import('./run-service')
  return getRun(input.caseId, input.runId)
}

// saveCase 供后续"案卷修正写回"迭代使用；runAiReview 由 run-service 调用，此处不直接使用
void saveCase
void runAiReview
