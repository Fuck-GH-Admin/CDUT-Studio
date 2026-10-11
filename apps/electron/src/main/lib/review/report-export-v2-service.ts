/**
 * V2 报告导出服务（08 设计 §4：从 EXPORT_REPORT_V2 handler 抽出，IPC 与 Agent 工具薄委托）
 *
 * 公开反馈投影（字段可见性按模板默认 public）+ 真实检查结果摘要 → MD 落盘
 * 到案卷受控目录 reports/（不覆盖任意宿主路径）。
 */

import { assertSafeReviewStorageId } from './review-storage-id'

export interface ExportReportResultV2 {
  file: string
  decision: { result: string; reason: string; at: string } | null
}

export function exportCaseReport(caseId: string): ExportReportResultV2 {
  assertSafeReviewStorageId(caseId, 'caseId')
  const { getCaseV2Aggregate } = require('./application-service') as typeof import('./application-service')
  const { buildCaseFeedback } = require('./report-service-v2') as typeof import('./report-service-v2')
  const { listRunsV2 } = require('./run-store-v2') as typeof import('./run-store-v2')
  const { reconcilePiReviewRunsWithReadReceipts } = require('./pi-case-review-service') as typeof import('./pi-case-review-service')
  const { getTemplate } = require('./template-store') as typeof import('./template-store')
  const { resolveEffectiveRules } = require('./effective-rules') as typeof import('./effective-rules')
  const aggregate = getCaseV2Aggregate(caseId)
  if (!aggregate) throw new Error(`案卷聚合不存在: ${caseId}`)
  const feedback = buildCaseFeedback(aggregate.caseV2, aggregate.decisions, aggregate.supplements, {})
  const runs = reconcilePiReviewRunsWithReadReceipts(caseId, listRunsV2(caseId)).filter((run) => run.status === 'completed' || run.status === 'partially-completed')
  const finalDecision = aggregate.decisions.at(-1)
  const lastRun = (finalDecision ? runs.find((run) => run.id === finalDecision.basedOnRunId) : undefined) ?? runs[0]
  const template = getTemplate(aggregate.caseV2.templateId, aggregate.caseV2.templateVersion)
  const effectiveRules = template ? resolveEffectiveRules(aggregate, template) : []
  const lines: string[] = [`# 审核报告：${aggregate.caseV2.title}`, '', `- 案卷：${caseId}`, `- 阶段：${aggregate.caseV2.stage}（revision ${aggregate.caseV2.revision}）`, '']
  if (feedback.decision) lines.push(`## 决定`, `- 结果：${feedback.decision.result}`, `- 理由：${feedback.decision.reason}`, `- 时间：${feedback.decision.at}`, '')
  if (lastRun) {
    lines.push(`## 审核依据（运行 ${lastRun.id}）`)
    lines.push(`- 有效规则集哈希：${lastRun.inputManifest.effectiveRuleSetHash ?? '旧运行未记录'}`)
    for (const { rule, origin } of effectiveRules) {
      const sectionName = rule.sectionId ? template?.sections?.find((section) => section.id === rule.sectionId)?.name : undefined
      const source = origin.kind === 'policy' ? `政策 ${origin.policyId}@${origin.version}` : origin.kind === 'template' ? `模板 ${origin.templateId}@${origin.version}` : '案卷规则'
      lines.push(`- ${sectionName ? `【${sectionName}】` : ''}${rule.title}（${rule.id}；${rule.execution}；${source}）`)
    }
    lines.push('', `## 检查结果（运行 ${lastRun.id}）`)
    for (const check of lastRun.checks) {
      const item = check as { ruleId: string; status: string; reason?: string }
      lines.push(`- ${item.ruleId}：${item.status}${item.reason ? `——${item.reason}` : ''}`)
    }
    lines.push('')
    const waived = aggregate.dispositions.filter((entry) => entry.runId === lastRun.id && entry.inputHash === lastRun.inputManifest.hash && entry.disposition === 'waived')
    if (waived.length) {
      lines.push('## 人工豁免（不代表规则符合）')
      for (const entry of waived) lines.push(`- ${entry.findingKey}：人工豁免；${entry.reason}`)
      lines.push('')
    }
  }
  if (feedback.supplements.length > 0) {
    lines.push('## 补件')
    for (const supplement of feedback.supplements) lines.push(`- ${supplement.reason}（${supplement.status}，要素：${supplement.requiredElements.join('、') || '—'}）`)
    lines.push('')
  }
  lines.push('## 事项字段')
  for (const item of feedback.items) lines.push(`- ${item.title}：${JSON.stringify(item.publicFields)}`)
  const adjudications = aggregate.adjudications ?? []
  const superseded = new Set(adjudications.flatMap((record) => record.supersedesAdjudicationId ? [record.supersedesAdjudicationId] : []))
  const currentAdjudications = adjudications.filter((record) => !superseded.has(record.id) && (!finalDecision || (record.basedOnRunId === finalDecision.basedOnRunId && record.inputHash === lastRun?.inputManifest.hash)))
  if (currentAdjudications.length) {
    lines.push('', '## 事项最终认定')
    for (const subject of aggregate.caseV2.subjects) {
      const adjudication = currentAdjudications.find((record) => record.subjectId === subject.id)
      if (!adjudication) continue
      const outcome = adjudication.outcome === 'accepted' ? '认可' : adjudication.outcome === 'modified' ? '修改认定' : '不予认定'
      const finalFields = adjudication.finalFields ?? (adjudication.outcome === 'rejected' ? {} : subject.fields)
      const scoreField = finalFields.declaredScore ?? finalFields.score
      const score = adjudication.outcome === 'rejected' ? '0' : scoreField?.kind === 'number' ? String(scoreField.value) : '未记录'
      lines.push(`- ${subject.title}：${outcome}；最终分值 ${score}；认定内容 ${JSON.stringify(finalFields)}；理由：${adjudication.reason}`)
    }
  }
  if (finalDecision?.finalScores?.length) {
    lines.push('', '## 最终分数')
    for (const score of finalDecision.finalScores) {
      const subject = aggregate.caseV2.subjects.find((candidate) => candidate.id === score.subjectId)
      lines.push(`- ${subject?.title ?? score.subjectId}：${score.value}`)
    }
  }
  const { writeFileSync, mkdirSync } = require('node:fs') as typeof import('node:fs')
  const { join } = require('node:path') as typeof import('node:path')
  const { getConfigDir } = require('../config-paths') as typeof import('../config-paths')
  const dir = join(getConfigDir(), 'review-cases', caseId, 'reports')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `report-${Date.now().toString(36)}.md`)
  writeFileSync(file, lines.join('\n'), 'utf-8')
  return { file, decision: feedback.decision }
}
