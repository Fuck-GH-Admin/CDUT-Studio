/**
 * CSLab 实验规程与批次（Protocol / Run）
 *
 * 存储契约：
 * - SQLite 为唯一规范源（protocols / runs 表 + entities 实体索引）；
 * - `vault/notes/protocols|runs/*.md` 是单向人类可读镜像，方便 Obsidian 浏览；
 * - 批次号 `r-YYYYMMDD-nn` 的“查询最大号 + 插入”必须在同一事务内完成。
 */

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  CsLabCreateProtocolInput,
  CsLabCreateRunInput,
  CsLabProtocol,
  CsLabProtocolParamDef,
  CsLabProtocolStep,
  CsLabRun,
  CsLabRunLink,
  CsLabRunLinkInput,
  CsLabRunParam,
  CsLabRunStatus,
  CsLabUpdateProtocolInput,
  CsLabUpdateRunInput,
} from '@profer/shared'
import { writeTextAtomic } from './cslab-atomic'
import {
  decodeRunLinks,
  deleteEdge,
  findMaxRunBatchNo,
  getCsLabDatabase,
  getEntityByUri,
  getProtocolRecord,
  getRunRecord,
  insertEdge,
  listProtocolRecords,
  listRunRecords,
  nextLabRevision,
  upsertEntity,
  upsertProtocol,
  upsertRun,
  withTransaction,
  type CsLabDatabase,
  type CsLabProtocolRecord,
  type CsLabRunRecord,
} from './cslab-db'
import {
  assertLabId,
  resolveLabDir,
  resolveLabRelativePath,
} from './cslab-paths'
import { buildCsLabUri } from './cslab-uri'

const MAX_STEPS = 50
const MAX_PARAMS = 50

function labDb(labId: string): CsLabDatabase {
  return getCsLabDatabase(join(resolveLabDir(labId), 'db', 'central_meta.sqlite'))
}

function clampText(value: unknown, max = 240): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function normalizeSteps(input: unknown): CsLabProtocolStep[] {
  if (!Array.isArray(input)) return []
  const result: CsLabProtocolStep[] = []
  input.slice(0, MAX_STEPS).forEach((item, index) => {
    const record = (item ?? {}) as Record<string, unknown>
    const title = clampText(record.title, 120)
    if (!title) return
    const step: CsLabProtocolStep = {
      id: clampText(record.id, 64) || `step-${index + 1}`,
      title,
    }
    const detail = clampText(record.detail, 600)
    if (detail) step.detail = detail
    const duration = Number(record.durationMin)
    if (Number.isFinite(duration) && duration >= 0) step.durationMin = duration
    result.push(step)
  })
  return result
}

function normalizeParamDefs(input: unknown): CsLabProtocolParamDef[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const result: CsLabProtocolParamDef[] = []
  for (const item of input.slice(0, MAX_PARAMS)) {
    const record = (item ?? {}) as Record<string, unknown>
    const key = clampText(record.key, 64)
    const label = clampText(record.label, 120) || key
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push({
      key,
      label,
      unit: clampText(record.unit, 32) || undefined,
      defaultValue: clampText(record.defaultValue, 200) || undefined,
    })
  }
  return result
}

function normalizeRunParams(input: unknown): CsLabRunParam[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const result: CsLabRunParam[] = []
  for (const item of input.slice(0, MAX_PARAMS)) {
    const record = (item ?? {}) as Record<string, unknown>
    const key = clampText(record.key, 64)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push({
      key,
      label: clampText(record.label, 120) || key,
      value: clampText(record.value, 400),
      unit: clampText(record.unit, 32) || undefined,
    })
  }
  return result
}

function parseJsonArray<T>(text: string): T[] {
  try {
    const parsed = JSON.parse(text) as unknown
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function protocolToShared(record: CsLabProtocolRecord): CsLabProtocol {
  return {
    uri: record.uri,
    labId: record.labId,
    title: record.title,
    method: record.method,
    version: record.version,
    steps: parseJsonArray<CsLabProtocolStep>(record.stepsJson),
    parameters: parseJsonArray<CsLabProtocolParamDef>(record.parametersJson),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function runToShared(record: CsLabRunRecord): CsLabRun {
  return {
    uri: record.uri,
    labId: record.labId,
    protocolUri: record.protocolUri,
    protocolTitle: record.protocolTitle,
    protocolVersion: record.protocolVersion,
    title: record.title,
    batchNo: record.batchNo,
    status: record.status,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    operator: record.operator,
    parameters: parseJsonArray<CsLabRunParam>(record.parametersJson),
    observations: record.observations,
    outcome: record.outcome,
    linkedAssets: decodeRunLinks(record),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function protocolRelPath(protocol: CsLabProtocol): string {
  const suffix = protocol.uri.split('/').pop() ?? 'protocol'
  return `vault/notes/protocols/${suffix}.md`
}

function runRelPath(run: CsLabRun): string {
  return `vault/notes/runs/${run.batchNo}.md`
}

function renderProtocolMarkdown(protocol: CsLabProtocol): string {
  const lines = [
    '---',
    `cdut_uri: ${protocol.uri}`,
    'kind: protocol',
    `title: ${JSON.stringify(protocol.title)}`,
    `method: ${JSON.stringify(protocol.method)}`,
    `version: ${protocol.version}`,
    `updated_at: ${new Date(protocol.updatedAt).toISOString()}`,
    '---',
    '',
    `# ${protocol.title}`,
    '',
    '## 方法',
    protocol.method || '（未填写）',
    '',
    '## 步骤',
    protocol.steps.length === 0
      ? '（暂无步骤）'
      : protocol.steps
          .map(
            (step, index) =>
              `${index + 1}. **${step.title}**${step.durationMin ? ` · ${step.durationMin} min` : ''}${
                step.detail ? `\n   ${step.detail}` : ''
              }`,
          )
          .join('\n'),
    '',
    '## 参数定义',
    protocol.parameters.length === 0
      ? '（暂无参数）'
      : [
          '| 参数 | 标签 | 单位 | 默认值 |',
          '| --- | --- | --- | --- |',
          ...protocol.parameters.map(
            (param) =>
              `| ${param.key} | ${param.label} | ${param.unit ?? '-'} | ${param.defaultValue ?? '-'} |`,
          ),
        ].join('\n'),
    '',
  ]
  return lines.join('\n')
}

function renderRunMarkdown(run: CsLabRun): string {
  const lines = [
    '---',
    `cdut_uri: ${run.uri}`,
    'kind: run',
    `batch: ${run.batchNo}`,
    `status: ${run.status}`,
    `protocol: ${JSON.stringify(run.protocolTitle ?? '-')}`,
    `operator: ${JSON.stringify(run.operator ?? '-')}`,
    `started_at: ${run.startedAt ? new Date(run.startedAt).toISOString() : '-'}`,
    `ended_at: ${run.endedAt ? new Date(run.endedAt).toISOString() : '-'}`,
    `updated_at: ${new Date(run.updatedAt).toISOString()}`,
    '---',
    '',
    `# ${run.title}`,
    '',
    `> 批次 ${run.batchNo} · ${run.status}`,
    '',
    '## 参数',
    run.parameters.length === 0
      ? '（未记录参数）'
      : [
          '| 参数 | 值 | 单位 |',
          '| --- | --- | --- |',
          ...run.parameters.map(
            (param) => `| ${param.label} | ${param.value || '-'} | ${param.unit ?? '-'} |`,
          ),
        ].join('\n'),
    '',
    '## 观察现象',
    run.observations || '（未填写）',
    '',
    '## 结果',
    run.outcome || '（未填写）',
    '',
    '## 关联资产',
    run.linkedAssets.length === 0
      ? '（暂无关联）'
      : run.linkedAssets
          .map((link) => `- [[${link.title}]] · ${link.relation === 'consumes' ? '消耗' : '产出'}`)
          .join('\n'),
    '',
  ]
  return lines.join('\n')
}

async function writeProtocolMirror(labId: string, protocol: CsLabProtocol): Promise<void> {
  const relPath = protocolRelPath(protocol)
  try {
    const absolute = resolveLabRelativePath(labId, relPath)
    await fs.mkdir(dirname(absolute), { recursive: true })
    await writeTextAtomic(absolute, renderProtocolMarkdown(protocol), {
      allowInPlaceFallback: false,
    })
  } catch (error) {
    console.warn(`[CSLab] 规程 Markdown 镜像写入失败（不影响 SQLite 主记录）: ${relPath}`, error)
  }
}

async function writeRunMirror(labId: string, run: CsLabRun): Promise<void> {
  const relPath = runRelPath(run)
  try {
    const absolute = resolveLabRelativePath(labId, relPath)
    await fs.mkdir(dirname(absolute), { recursive: true })
    await writeTextAtomic(absolute, renderRunMarkdown(run), {
      allowInPlaceFallback: false,
    })
  } catch (error) {
    console.warn(`[CSLab] 批次 Markdown 镜像写入失败（不影响 SQLite 主记录）: ${relPath}`, error)
  }
}

function nextBatchNo(db: CsLabDatabase, labId: string, now: Date): string {
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const prefix = `r-${yyyy}${mm}${dd}-`
  const max = findMaxRunBatchNo(db, labId, prefix)
  const lastSeq = max ? Number(max.slice(prefix.length)) : 0
  const seq = Number.isFinite(lastSeq) && lastSeq > 0 ? lastSeq + 1 : 1
  return `${prefix}${String(seq).padStart(2, '0')}`
}

// ===== 规程 =====

export function listProtocols(labIdInput: string): CsLabProtocol[] {
  const labId = assertLabId(labIdInput)
  return listProtocolRecords(labDb(labId), labId).map(protocolToShared)
}

export async function createProtocol(input: CsLabCreateProtocolInput): Promise<CsLabProtocol> {
  const labId = assertLabId(input.labId)
  const title = clampText(input.title, 120)
  if (!title) throw new Error('规程标题不能为空')

  const steps = normalizeSteps(input.steps)
  const parameters = normalizeParamDefs(input.parameters)
  const uuid = `proto-${randomUUID().slice(0, 8)}`
  const now = Date.now()
  const db = labDb(labId)
  const protocol: CsLabProtocol = {
    uri: buildCsLabUri(labId, 'proto', uuid),
    labId,
    title,
    method: clampText(input.method, 2000),
    version: 1,
    steps,
    parameters,
    createdAt: now,
    updatedAt: now,
  }
  const relPath = protocolRelPath(protocol)

  withTransaction(db, () => {
    const revision = nextLabRevision(db)
    upsertProtocol(db, {
      uri: protocol.uri,
      labId,
      title: protocol.title,
      method: protocol.method,
      version: protocol.version,
      stepsJson: JSON.stringify(steps),
      parametersJson: JSON.stringify(parameters),
      createdAt: now,
      updatedAt: now,
    })
    upsertEntity(db, {
      uri: protocol.uri,
      labId,
      layerType: 'proto',
      entityUuid: uuid,
      title: protocol.title,
      format: 'cslab-protocol',
      relPath,
      revision,
      locked: false,
      createdAt: now,
      updatedAt: now,
    })
  })

  await writeProtocolMirror(labId, protocol)
  return protocol
}

export async function updateProtocol(input: CsLabUpdateProtocolInput): Promise<CsLabProtocol> {
  const labId = assertLabId(input.labId)
  const db = labDb(labId)
  const existing = getProtocolRecord(db, input.uri)
  if (!existing) throw new Error('规程不存在')

  const title = clampText(input.title, 120) || existing.title
  const method = clampText(input.method, 2000)
  const steps = normalizeSteps(input.steps)
  const parameters = normalizeParamDefs(input.parameters)
  const now = Date.now()
  const updated: CsLabProtocol = {
    ...protocolToShared(existing),
    title,
    method,
    version: existing.version + 1,
    steps,
    parameters,
    updatedAt: now,
  }
  const relPath = protocolRelPath(updated)

  withTransaction(db, () => {
    const revision = nextLabRevision(db)
    upsertProtocol(db, {
      uri: updated.uri,
      labId,
      title: updated.title,
      method: updated.method,
      version: updated.version,
      stepsJson: JSON.stringify(steps),
      parametersJson: JSON.stringify(parameters),
      createdAt: existing.createdAt,
      updatedAt: now,
    })
    const entity = getEntityByUri(db, updated.uri)
    if (entity) {
      upsertEntity(db, { ...entity, title, relPath, revision, updatedAt: now })
    }
  })

  await writeProtocolMirror(labId, updated)
  return updated
}

// ===== 批次 =====

export function listRuns(labIdInput: string, protocolUri?: string): CsLabRun[] {
  const labId = assertLabId(labIdInput)
  return listRunRecords(labDb(labId), labId, protocolUri).map(runToShared)
}

export async function createRun(input: CsLabCreateRunInput): Promise<CsLabRun> {
  const labId = assertLabId(input.labId)
  const db = labDb(labId)
  const protocol = input.protocolUri ? getProtocolRecord(db, input.protocolUri) : null
  if (input.protocolUri && !protocol) throw new Error('关联的规程不存在')

  const protocolShared = protocol ? protocolToShared(protocol) : null
  const title =
    clampText(input.title, 120) || `${protocolShared?.title ?? '未命名实验'} · 新批次`
  const providedParams = normalizeRunParams(input.parameters)
  const fallbackParams: CsLabRunParam[] = protocolShared
    ? protocolShared.parameters.map((param) => ({
        key: param.key,
        label: param.label,
        value: param.defaultValue ?? '',
        unit: param.unit,
      }))
    : []
  const parameters = providedParams.length > 0 ? providedParams : fallbackParams
  const now = Date.now()

  const created = withTransaction(db, () => {
    // 审计要求：查询最大批次号与插入必须同事务，避免并发重复。
    const batchNo = nextBatchNo(db, labId, new Date(now))
    const uri = buildCsLabUri(labId, 'run', batchNo)
    const record: CsLabRunRecord = {
      uri,
      labId,
      protocolUri: protocolShared?.uri,
      protocolTitle: protocolShared?.title,
      protocolVersion: protocolShared?.version,
      title,
      batchNo,
      status: 'running',
      startedAt: now,
      operator: clampText(input.operator, 80) || undefined,
      parametersJson: JSON.stringify(parameters),
      observations: '',
      linksJson: '[]',
      createdAt: now,
      updatedAt: now,
    }
    const revision = nextLabRevision(db)
    upsertRun(db, record)
    upsertEntity(db, {
      uri,
      labId,
      layerType: 'run',
      entityUuid: batchNo,
      title,
      format: 'cslab-run',
      relPath: runRelPath(runToShared(record)),
      revision,
      locked: false,
      createdAt: now,
      updatedAt: now,
    })
    return record
  })

  const run = runToShared(created)
  await writeRunMirror(labId, run)
  return run
}

export async function updateRun(input: CsLabUpdateRunInput): Promise<CsLabRun> {
  const labId = assertLabId(input.labId)
  const db = labDb(labId)
  const existing = getRunRecord(db, input.uri)
  if (!existing) throw new Error('实验批次不存在')

  const status: CsLabRunStatus = input.status ?? existing.status
  const now = Date.now()
  const endedAt =
    status === 'succeeded' || status === 'failed' || status === 'aborted'
      ? existing.endedAt ?? now
      : undefined

  const updatedRecord: CsLabRunRecord = {
    ...existing,
    title: clampText(input.title, 120) || existing.title,
    status,
    endedAt,
    operator:
      input.operator === undefined ? existing.operator : clampText(input.operator, 80) || undefined,
    parametersJson:
      input.parameters === undefined
        ? existing.parametersJson
        : JSON.stringify(normalizeRunParams(input.parameters)),
    observations:
      input.observations === undefined
        ? existing.observations
        : clampText(input.observations, 8000),
    outcome: input.outcome === undefined ? existing.outcome : clampText(input.outcome, 4000) || undefined,
    updatedAt: now,
  }

  withTransaction(db, () => {
    const revision = nextLabRevision(db)
    upsertRun(db, updatedRecord)
    const entity = getEntityByUri(db, existing.uri)
    if (entity) {
      upsertEntity(db, {
        ...entity,
        title: updatedRecord.title,
        relPath: runRelPath(runToShared(updatedRecord)),
        revision,
        updatedAt: now,
      })
    }
  })

  const run = runToShared(updatedRecord)
  await writeRunMirror(labId, run)
  return run
}

export async function linkRunAsset(input: CsLabRunLinkInput): Promise<CsLabRun> {
  const labId = assertLabId(input.labId)
  const db = labDb(labId)
  const run = getRunRecord(db, input.runUri)
  if (!run) throw new Error('实验批次不存在')
  const asset = getEntityByUri(db, input.assetUri)
  if (!asset || asset.labId !== labId) throw new Error('目标资产不存在或不属于当前实验室')
  if (!['raw', 'table', 'fig', 'mol'].includes(asset.layerType)) {
    throw new Error('仅支持关联原始数据、数据表、图表或结构模型')
  }
  if (input.relation !== 'consumes' && input.relation !== 'produces') {
    throw new Error('关联关系无效')
  }

  const links = decodeRunLinks(run)
  const already = links.find((link) => link.uri === asset.uri && link.relation === input.relation)
  if (already) return runToShared(run)

  const nextLinks: CsLabRunLink[] = [...links, { uri: asset.uri, title: asset.title, relation: input.relation }]
  const now = Date.now()
  const updated: CsLabRunRecord = { ...run, linksJson: JSON.stringify(nextLinks), updatedAt: now }

  withTransaction(db, () => {
    const revision = nextLabRevision(db)
    upsertRun(db, updated)
    const entity = getEntityByUri(db, run.uri)
    if (entity) upsertEntity(db, { ...entity, revision, updatedAt: now })
    insertEdge(db, labId, run.uri, asset.uri, input.relation, { run: run.batchNo })
  })

  const shared = runToShared(updated)
  await writeRunMirror(labId, shared)
  return shared
}

export async function unlinkRunAsset(input: CsLabRunLinkInput): Promise<CsLabRun> {
  const labId = assertLabId(input.labId)
  const db = labDb(labId)
  const run = getRunRecord(db, input.runUri)
  if (!run) throw new Error('实验批次不存在')

  const nextLinks = decodeRunLinks(run).filter(
    (link) => !(link.uri === input.assetUri && link.relation === input.relation),
  )
  const now = Date.now()
  const updated: CsLabRunRecord = { ...run, linksJson: JSON.stringify(nextLinks), updatedAt: now }

  withTransaction(db, () => {
    const revision = nextLabRevision(db)
    upsertRun(db, updated)
    const entity = getEntityByUri(db, run.uri)
    if (entity) upsertEntity(db, { ...entity, revision, updatedAt: now })
    deleteEdge(db, run.uri, input.assetUri, input.relation)
  })

  const shared = runToShared(updated)
  await writeRunMirror(labId, shared)
  return shared
}
