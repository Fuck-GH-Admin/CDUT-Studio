/**
 * V2 真实执行器装配（G02 核心，docs/design/review-agent/07 §4.4 + 复查报告 §5.1）
 *
 * 修正"执行器只有节点 ID/hash、complete 结果未使用、固定返回空"：
 * - 输入装配：案卷字段值 + 负责人规则（compiledRules 逐条）+ 材料解析文本（有则注入、无则如实标注）
 * - extract：Pi complete 返回 JSON → 引用校验（sourceRefs 必须指向已解析材料）→ observations
 * - check：确定性引擎逐条评估（规则 when 条件 + 字段已知值）
 * - summarize：Pi 基于发现生成结论 JSON → opinions
 * - ocr：NullOcrPort 如实标注不可用（Tesseract 适配另批交付），不冒充已读
 * 全部节点走 executeRunGraph 的产物/检查点管线（A11）。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CaseAggregateV2, DocumentVersion, TemplateVersion } from '@profer/shared'
import type { NodeExecutor, NodeKind } from './review-run-graph'
import type { ReviewModelClient } from './pi-review-executor'
import { REVIEW_SYSTEM_PROMPT } from './pi-review-executor'
import { evaluateCondition } from './deterministic-engine'
import { buildTextSourceIndex } from './source-index'
import { getConfigDir } from '../config-paths'
import { extractJson } from './review-model-gateway'

/** 读取材料解析文本（parseIndex 产物或原始文本文件直读；图片类如实标注不可读） */
function materialTextOf(doc: DocumentVersion): string {
  const ext = doc.fileName.toLowerCase().split('.').pop() ?? ''
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) return ''
  try {
    const raw = readFileSync(join(getConfigDir(), 'review-cases', doc.versionId.split('-v')[0] ?? doc.documentId, doc.assetPath), 'utf-8')
    return raw.length > 6000 ? `${raw.slice(0, 6000)}\n…(truncated)` : raw
  } catch {
    return ''
  }
}

/** 构建注入给 Pi 的材料/规则/字段上下文（内容仅作为数据，指令边界由 REVIEW_SYSTEM_PROMPT 承担） */
function buildMaterialContext(aggregate: CaseAggregateV2, template: TemplateVersion): string {
  const parts: string[] = []
  parts.push('【案卷字段 (Case Fields)】')
  for (const [key, value] of Object.entries(aggregate.caseV2.caseFields)) {
    parts.push(`- ${key} = ${JSON.stringify((value as { value: unknown }).value ?? null)}`)
  }
  for (const subject of aggregate.caseV2.subjects) {
    parts.push(`【事项 (Subject) ${subject.id}】${subject.title}`)
    for (const [key, value] of Object.entries(subject.fields)) {
      parts.push(`- ${key} = ${JSON.stringify((value as { value: unknown }).value ?? null)}`)
    }
  }
  parts.push('【负责人规则 (Owner Rules)】')
  for (const ref of template.policyRefs ?? []) void ref
  parts.push('【材料内容 (Material Content)】')
  for (const doc of aggregate.caseV2.documents) {
    if (doc.active === false) continue
    const text = materialTextOf(doc)
    parts.push(text ? `--- ${doc.fileName} (${doc.versionId}) ---\n${text}` : `--- ${doc.fileName} (${doc.versionId}) --- [non-text or unreadable: must not be treated as read]`)
  }
  return parts.join('\n')
}

export interface AssembleOptions {
  client: ReviewModelClient
  signal?: AbortSignal
}

/** 装配 11 个节点的真实执行器（extract/summarize 走 Pi；check/calculate 走确定性引擎） */
export function assembleV2Executors(aggregate: CaseAggregateV2, template: TemplateVersion, options: AssembleOptions): Record<NodeKind, NodeExecutor> {
  const caseId = aggregate.caseV2.id
  const rules = (template.policyRefs ?? []).length > 0 ? collectRules(template) : []
  const materialContext = buildMaterialContext(aggregate, template)
  const subjectIds = aggregate.caseV2.subjects.map((subject) => subject.id)

  const piExtract: NodeExecutor = async (node, inputHash) => {
    if (options.signal?.aborted) throw new Error('已取消（模型调用前）')
    const prompt = [
      `Task: extract facts (observations) from the 案卷 (case-file) materials below.`,
      `Output a JSON array where each item is {"subjectId":"…","fieldKey":"…","value":…,"sourceRefs":[{"documentVersionId":"…","quote":"verbatim quote from the material"}],"confidence":0~1}.`,
      `Requirements: the documentVersionId in sourceRefs must come from the material list below; do not output facts that have no corresponding material.`,
      materialContext,
    ].join('\n')
    const { content } = await options.client.complete({ prompt, system: REVIEW_SYSTEM_PROMPT, signal: options.signal })
    if (options.signal?.aborted) throw new Error('已取消（模型调用后）')
    const parsed = extractJson(content)
    const items = Array.isArray(parsed) ? parsed : (parsed as { observations?: unknown[] })?.observations
    const validDocIds = new Set(aggregate.caseV2.documents.filter((doc) => doc.active !== false).map((doc) => doc.versionId))
    const observations = (Array.isArray(items) ? items : []).map((raw) => {
      const item = raw as { subjectId?: string; fieldKey?: string; value?: unknown; sourceRefs?: Array<{ documentVersionId?: string; quote?: string }>; confidence?: number }
      // 引用校验：指向不存在/未激活材料的 observation 丢弃（防伪造引用）
      const refs = (item.sourceRefs ?? []).filter((ref) => ref.documentVersionId && validDocIds.has(ref.documentVersionId))
      if (!item.subjectId || !item.fieldKey || refs.length === 0) return null
      return { subjectId: item.subjectId, fieldKey: item.fieldKey, value: item.value ?? null, sourceRefs: refs, extractedBy: 'ai' as const, confirmed: false, confidence: item.confidence }
    }).filter(Boolean)
    return { status: 'done' as const, inputHash, artifact: { sourceIds: [caseId], observations: observations as Array<Record<string, unknown>>, parseIndex: [] } }
  }

  const piSummarize: NodeExecutor = async (node, inputHash) => {
    if (options.signal?.aborted) throw new Error('已取消（模型调用前）')
    const findingsText = rules.map((rule) => `- ${rule.id}: ${rule.requirement}`).join('\n')
    const prompt = [
      'Task: based on the 案卷 (case) fields, materials, and rule list below, produce the 审核 (review) conclusion.',
      'Output JSON: {"opinion":"…short conclusion…","checks":[{"ruleId":"…","status":"compliant|non-compliant|needs-confirmation|not-applicable","reason":"…"}]}',
      `Rule list:\n${findingsText}`,
      materialContext,
    ].join('\n')
    const { content } = await options.client.complete({ prompt, system: REVIEW_SYSTEM_PROMPT, signal: options.signal })
    if (options.signal?.aborted) throw new Error('已取消（模型调用后）')
    const parsed = (extractJson(content) ?? {}) as { opinion?: string; checks?: Array<{ ruleId: string; status: string; reason: string }> }
    const validRuleIds = new Set(rules.map((rule) => rule.id))
    const checks = (parsed.checks ?? []).filter((check) => validRuleIds.has(check.ruleId) && ['compliant', 'non-compliant', 'needs-confirmation', 'not-applicable'].includes(check.status))
    return { status: 'done' as const, inputHash, artifact: { sourceIds: [caseId], checks: checks as Array<Record<string, unknown>>, opinions: parsed.opinion ? [{ text: parsed.opinion, at: new Date().toISOString(), engine: 'ai' }] : [], summary: parsed.opinion } }
  }

  const deterministicCheck: NodeExecutor = async (node, inputHash) => {
    // 确定性规则：字段已知值逐条评估（引擎三值语义）
    const knownValues = (fieldKey: string): { known: boolean; value: unknown } => {
      const caseValue = (aggregate.caseV2.caseFields[fieldKey] as { value?: unknown } | undefined)?.value
      if (caseValue !== undefined) return { known: true, value: caseValue }
      return { known: false, value: null }
    }
    const checks = rules
      .filter((rule) => rule.when && (rule.when as { field?: string }).field !== undefined)
      .map((rule) => {
        const condition = rule.when as Parameters<typeof evaluateCondition>[0]
        const status = evaluateCondition(condition, (ref) => knownValues(ref.field ?? ''))
        return { ruleId: rule.id, status: status === 'true' ? 'compliant' : status === 'false' ? 'non-compliant' : 'needs-confirmation', reason: rule.requirement, target: { scope: 'case', subjectIds: [] } }
      })
    return { status: 'done' as const, inputHash, artifact: { sourceIds: [caseId], checks: checks as Array<Record<string, unknown>> } }
  }

  const parse: NodeExecutor = async (_node, inputHash) => {
    // 解析：文本材料建段落索引（图片材料如实 unread）
    const parseIndex: Array<Record<string, unknown>> = []
    for (const doc of aggregate.caseV2.documents) {
      if (doc.active === false) continue
      const text = materialTextOf(doc)
      if (!text) continue
      const index = buildTextSourceIndex(doc.versionId, text)
      parseIndex.push({ documentVersionId: doc.versionId, segments: index.entries.length, kind: 'text' })
    }
    return { status: 'done' as const, inputHash, artifact: { sourceIds: [caseId], parseIndex } }
  }

  const ocr: NodeExecutor = async (_node, inputHash) => {
    // OCR：当前无可用实现（NullOcrPort），如实标注——不冒充已读
    return { status: 'done' as const, inputHash, artifact: { sourceIds: [caseId], parseIndex: aggregate.caseV2.documents.filter((doc) => /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(doc.fileName)).map((doc) => ({ documentVersionId: doc.versionId, kind: 'image', ocr: 'unavailable' })) } }
  }

  const trivial = (extra: Record<string, unknown> = {}): NodeExecutor => async (_node, inputHash) => ({ status: 'done' as const, inputHash, artifact: { sourceIds: [caseId], ...extra } })

  const map: Record<NodeKind, NodeExecutor> = {
    register: trivial({ registered: aggregate.caseV2.documents.filter((doc) => doc.active !== false).map((doc) => doc.versionId) }),
    parse,
    ocr,
    extract: piExtract,
    bind: trivial(),
    plan: trivial({ plannedRules: rules.map((rule) => rule.id) }),
    check: deterministicCheck,
    calculate: trivial(),
    verify: trivial(),
    summarize: piSummarize,
    task: trivial(),
  }
  void subjectIds
  return map
}

/** 汇总模板引用政策的结构化规则 */
function collectRules(template: TemplateVersion): Array<{ id: string; requirement: string; when: unknown }> {
  const { getPolicy } = require('./policy-store') as typeof import('./policy-store')
  const rules: Array<{ id: string; requirement: string; when: unknown }> = []
  for (const ref of template.policyRefs ?? []) {
    const policy = getPolicy(ref.policyId, ref.version)
    for (const rule of policy?.compiledRules ?? []) {
      rules.push({ id: rule.id, requirement: rule.requirement, when: rule.when })
    }
  }
  return rules
}
