/**
 * T08 read-only reporting and source projection.
 * Never writes Case/Run/Decision; historical runs are rendered from their own manifest,
 * not reinterpreted as the current input. Export is a local copy, not an approval.
 */
import type { CaseAggregateV2, DocumentVersion, ReviewRunV2, SourceRef, TemplateVersion } from '@profer/shared'

export type T08Audience = 'student' | 'reviewer' | 'organizer'
export interface T08ResolvedSource {
  ref: SourceRef
  document: DocumentVersion | null
  state: 'located' | 'file-only' | 'version-unavailable' | 'parse-revision-mismatch' | 'foreign-case'
  label: string
  excerpt: string | null
  blockId?: string
}
export interface T08Report {
  audience: T08Audience
  runId: string
  caseId: string
  status: string
  stale: boolean
  markdown: string
  json: string
  rows: Array<{ kind: string; id: string; status: string; detail: string; source: string }>
}

function locationLabel(ref: SourceRef): string {
  const location = ref.location
  switch (location.kind) {
    case 'pdf-rect': return '第 ' + location.page + ' 页'
    case 'paragraph': return '段落 ' + (location.index + 1)
    case 'sheet-cell': return location.sheet + '!' + location.column + location.row
    case 'text-range': return '字符 ' + location.start + '–' + location.end
    case 'file': return '文件级引用（未提供具体位置）'
  }
}

/** Exact case/version/parse matching; never promote an invented block into a verified source. */
export function resolveT08Source(ref: SourceRef, aggregate: CaseAggregateV2): T08ResolvedSource {
  const prefix = { ref, document: null, label: ref.documentVersionId + ' · ' + locationLabel(ref), excerpt: null }
  if (ref.caseId !== aggregate.caseV2.id) return { ...prefix, state: 'foreign-case' }
  const doc = aggregate.caseV2.documents.find((item) => item.versionId === ref.documentVersionId)
  if (!doc) return { ...prefix, state: 'version-unavailable' }
  const current = { ...prefix, document: doc, label: doc.fileName + ' · ' + locationLabel(ref) }
  if (doc.parseRevision !== ref.parseRevision) return { ...current, state: 'parse-revision-mismatch' }
  const match = doc.blocks.find((block, index) => {
    if (ref.location.kind === 'file') return false
    if (ref.location.kind === 'paragraph') return index === ref.location.index
    if (ref.location.kind === 'pdf-rect') return block.location?.kind === 'pdf-rect' && block.location.page === ref.location.page
    if (ref.location.kind === 'sheet-cell') {
      return block.location?.kind === 'sheet-cell' && block.location.sheet === ref.location.sheet &&
        block.location.row === ref.location.row && block.location.column === ref.location.column
    }
    if (ref.location.kind === 'text-range') {
      const start = doc.blocks.slice(0, index).reduce((sum, part) => sum + part.text.length + 1, 0)
      return start < ref.location.end && start + block.text.length > ref.location.start
    }
    return false
  })
  if (!match) return { ...current, state: 'file-only', excerpt: ref.quote ?? null }
  const supportsQuote = !ref.quote || match.text.includes(ref.quote)
  if (!supportsQuote) return { ...current, state: 'file-only', excerpt: ref.quote ?? null }
  return { ...current, state: 'located', excerpt: match.text || ref.quote || null, blockId: match.blockId }
}

function printable(value: unknown): string {
  if (value === undefined || value === null) return '未填写'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function fieldText(field: unknown): string {
  if (!field || typeof field !== 'object') return printable(field)
  if ('documentVersionId' in field) return '附件 ' + printable(field.documentVersionId)
  return 'value' in field ? printable(field.value) : printable(field)
}

function escaped(value: unknown): string {
  return String(value ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
}

function sourceSummary(refs: SourceRef[], aggregate: CaseAggregateV2): string {
  return refs.map((ref) => {
    const source = resolveT08Source(ref, aggregate)
    return source.label + (source.state === 'located' ? '' : '〔' + source.state + '，未验证精确落点〕')
  }).join('；') || '无可核查引用'
}

export function makeT08CaseReport(input: {
  aggregate: CaseAggregateV2
  run: ReviewRunV2
  template?: TemplateVersion | null
  audience: T08Audience
  stale: boolean
}): T08Report {
  const { aggregate, run, template, audience, stale } = input
  if (run.caseId !== aggregate.caseV2.id) throw new Error('所选运行不属于当前案卷')
  const manifest = run.inputManifest
  const visibility = new Map((template?.fields ?? []).map((field) => [field.key, field.visibility]))
  const publicFields = (fields: Record<string, unknown>): Record<string, string> => Object.fromEntries(
    Object.entries(fields).filter(([key]) => audience !== 'student' || visibility.get(key) === 'public')
      .map(([key, field]) => [key, fieldText(field)]),
  )
  const historical = stale || aggregate.caseV2.documents.some((d) =>
    manifest.documentVersions.some((v) => v.documentId === d.documentId && v.versionId !== d.versionId && d.active !== false),
  )
  const decision = [...aggregate.decisions].reverse().find((item) => item.basedOnRunId === run.id) ?? null
  const runDispositions = aggregate.dispositions.filter((item) => item.runId === run.id && item.inputHash === manifest.hash)
  const docs = manifest.documentVersions.map((v) => {
    const original = aggregate.caseV2.documents.find((d) => d.versionId === v.versionId)
    return { versionId: v.versionId, name: original?.fileName ?? '历史原件（本地版本不可用）', contentHash: v.contentHash }
  })
  const lines = [
    '# 审核结果 · ' + (audience === 'student' ? '申请人版' : audience === 'reviewer' ? '审核人版' : '组织者版'),
    '',
    '- 案卷 ID：' + aggregate.caseV2.id,
    '- 运行 ID：' + run.id,
    '- 模板：' + run.templateId + '@' + run.templateVersion,
    '- 输入快照：' + manifest.hash,
    '- 执行状态：' + run.status,
    '- 有效判断：' + run.coverage.effectiveVerdicts + ' / ' + run.coverage.plannedChecks,
    '- 待处理检查：' + run.coverage.pendingChecks,
    '- 快照提示：' + (historical ? '历史或非当前输入；不使用当前案卷字段重建历史结果' : '以所选运行输入快照为准'),
    '',
    '## 本次运行包含的原件版本',
    ...docs.map((d) => '- ' + d.name + '（' + d.versionId + '，' + d.contentHash + '）'),
    '',
    '## 检查与来源',
  ]
  const rows: T08Report['rows'] = []
  for (const check of run.checks) {
    const source = sourceSummary(check.sourceRefs, aggregate)
    lines.push('- ' + check.checkId + ' / ' + check.ruleId + '：' + check.status + '；' + check.reason)
    lines.push('  - 来源：' + source)
    if (audience !== 'student' && check.calculation?.detailLines?.length) {
      lines.push(...check.calculation.detailLines.map((line) => '  - 计算：' + line))
    }
    rows.push({ kind: 'check', id: check.checkId, status: check.status, detail: check.reason, source })
  }
  lines.push('', '## 补件与业务结论')
  if (historical) {
    lines.push('- 历史输入的补件和当前事项字段未冻结在本次 Run 中，不混入本报告。')
  } else {
    for (const request of aggregate.supplements) {
      lines.push('- 补件：' + request.reason + '；状态：' + request.status + '；要求：' + request.requiredElements.join('、'))
    }
    for (const subject of aggregate.caseV2.subjects) {
      lines.push('- 事项：' + subject.title + '；字段：' + escaped(publicFields(subject.fields)))
    }
  }
  if (decision) {
    lines.push('- 已记录的业务决定：' + decision.result + '；' + decision.reason + '（' + decision.at + '）')
    lines.push('- 决定主体：' + decision.actor.actorSource + ' / ' + decision.actor.role + '（不等于校方认证授权）')
  } else lines.push('- 未发现基于所选运行作出的业务决定；技术检查不能代替正式决定。')
  if (audience !== 'student') {
    lines.push('', '## 内部核对与模型建议（不等于业务决定）')
    for (const opinion of run.opinions) {
      const source = sourceSummary(opinion.sourceRefs, aggregate)
      lines.push('- ' + opinion.title + '：' + opinion.detail + '；建议：' + opinion.suggestionText)
      lines.push('  - 核验状态：' + opinion.verification + '；来源：' + source)
      rows.push({ kind: 'opinion', id: opinion.id, status: opinion.verification, detail: opinion.detail, source })
    }
    for (const disposition of runDispositions) {
      lines.push('- 人工处置：' + disposition.findingKey + ' / ' + disposition.disposition + '；' + disposition.reason)
    }
    if (run.error) lines.push('- 执行错误：' + run.error)
  }
  const data = {
    schema: 'review-v3-t08-report/1',
    audience,
    caseId: aggregate.caseV2.id,
    run: { id: run.id, status: run.status, templateId: run.templateId, templateVersion: run.templateVersion, inputManifest: manifest, coverage: run.coverage },
    historical,
    sources: docs,
    checks: run.checks.map((c) => ({
      checkId: c.checkId, ruleId: c.ruleId, status: c.status, reason: c.reason,
      references: c.sourceRefs.map((ref) => ({ ...ref, resolution: resolveT08Source(ref, aggregate).state })),
      ...(audience === 'student' ? {} : { calculation: c.calculation, executedBy: c.executedBy }),
    })),
    decision: decision ? { result: decision.result, reason: decision.reason, at: decision.at, actorSource: decision.actor.actorSource } : null,
    ...(historical ? {} : {
      supplements: aggregate.supplements.map((s) => ({ reason: s.reason, requiredElements: s.requiredElements, status: s.status })),
      subjects: aggregate.caseV2.subjects.map((s) => ({ title: s.title, fields: publicFields(s.fields) })),
    }),
    ...(audience === 'student' ? {} : { opinions: run.opinions, dispositions: runDispositions, diagnostics: run.diagnostics, error: run.error }),
  }
  return { audience, runId: run.id, caseId: run.caseId, status: run.status, stale: historical, markdown: lines.join('\n'), json: JSON.stringify(data, null, 2), rows }
}

/** UTF-8 spreadsheet input; actual XLSX serialization is delegated to the owning UI. */
export function t08ReportTable(report: T08Report): Array<Array<string>> {
  return [['类型', '编号', '状态', '说明', '来源'], ...report.rows.map((r) => [r.kind, r.id, r.status, r.detail, r.source])]
}
