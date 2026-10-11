/**
 * 覆盖账本（M2，设计 03 §6 材料账本 + 检查账本；A08/K06）
 *
 * - 材料账本：每份文档版本都有 read/partially-read/unread 状态与原因；"未识别"不从分母消失
 * - 检查账本：每个计划检查（规则×目标）都有 CheckResult；缺失记 not-executed
 * - "全部符合"结论仅当：无未读材料 且 计划检查全部执行 且 无 awaiting
 */

import type { CheckResult, DocumentVersion, RuleSpec } from '@profer/shared'

export interface DocumentLedgerEntry {
  documentVersionId: string
  fileName: string
  status: DocumentVersion['usage']
  reason?: string
}

/** 材料账本：解析失败的旧材料即使残留 usage=read，也不能当作读过原件。 */
export function buildDocumentLedger(documents: DocumentVersion[]): DocumentLedgerEntry[] {
  return documents.map((doc) => {
    const parseFailed = doc.parseStatus === 'failed'
    if (doc.manualReadReceipt) {
      return {
        documentVersionId: doc.versionId,
        fileName: doc.fileName,
        status: 'read',
        reason: `审核员已核对原件：${doc.manualReadReceipt.reason}`,
      }
    }
    return {
      documentVersionId: doc.versionId,
      fileName: doc.fileName,
      status: parseFailed ? 'unread' : doc.usage,
      reason: parseFailed
        ? `自动解析失败；空占位块不代表读过原件。${doc.parseError ? `解析原因：${doc.parseError}` : '请重新解析或打开原件核验。'}`
        : doc.unusedReason,
    }
  })
}

export interface CheckLedgerEntry {
  ruleId: string
  targetKey: string
  status: CheckResult['status'] | 'not-executed'
  reason?: string
}

/**
 * 检查账本：以「计划检查」为分母核对执行结果。
 * 计划 = 规则 × 其目标分组键的笛卡尔：subject 规则按主体展开；group 规则按组值逐组展开
 * （G12/误判 5：组规则不再折叠成一个聚合 key——每组一条账目，缺组即 not-executed）。
 */
export function buildCheckLedger(
  plannedRules: RuleSpec[],
  subjectIds: string[],
  results: CheckResult[],
  groupValues?: Record<string, string[]>,
  sectionSubjectIds?: Record<string, string[]>,
): CheckLedgerEntry[] {
  const subjectIds0 = [...subjectIds]
  const byRuleTarget = new Map<string, CheckResult>()
  for (const result of results) {
    // 真实模型返回的 check 可能缺 target（确定性引擎总会带）：缺省按 case 级归位，逐案规则由下方回退匹配消费
    const scope = result.target?.scope ?? 'case'
    const subjectIds = result.target?.subjectIds ?? subjectIds0
    const key = `${result.ruleId}::${scope}::${[...subjectIds].sort().join(',')}`
    byRuleTarget.set(key, result)
    if (scope === 'group' && result.target?.groupKey) byRuleTarget.set(`${result.ruleId}::group-key::${result.target.groupKey}`, result)
  }
  const ledger: CheckLedgerEntry[] = []
  for (const rule of plannedRules) {
    const ruleSubjectIds = rule.sectionId ? sectionSubjectIds?.[rule.sectionId] ?? [] : subjectIds
    if (rule.targetScope === 'subject') {
      for (const subjectId of ruleSubjectIds) {
        const hit = byRuleTarget.get(`${rule.id}::subject::${subjectId}`) ?? byRuleTarget.get(`${rule.id}::case::${subjectIds0.sort().join(',')}`)
        ledger.push(
          hit
            ? { ruleId: rule.id, targetKey: subjectId, status: hit.status }
            : { ruleId: rule.id, targetKey: subjectId, status: 'not-executed', reason: '计划检查未产生结果记录' },
        )
      }
    } else if (rule.targetScope === 'group') {
      // A group rule with no groupBy is one aggregate check for the rule's full section/case scope.
      // Older runs omitted an explicit groupValues list and produced precisely this aggregate target.
      const groups = groupValues?.[rule.id] ?? (rule.groupBy?.length ? [] : ['group'])
      if (groups.length === 0) {
        ledger.push({ ruleId: rule.id, targetKey: 'group', status: 'not-executed', reason: '组规则未提供组值，无法展开' })
        continue
      }
      for (const groupValue of groups) {
        const aggregateKey = `${rule.id}::group::${[...ruleSubjectIds].sort().join(',')}`
        const hit = byRuleTarget.get(`${rule.id}::group-key::${groupValue}`)
          ?? (groupValue === 'group' ? byRuleTarget.get(aggregateKey) : undefined)
          ?? byRuleTarget.get(`${rule.id}::group::${groupValue}`)
        ledger.push(
          hit
            ? { ruleId: rule.id, targetKey: groupValue, status: hit.status }
            : { ruleId: rule.id, targetKey: groupValue, status: 'not-executed', reason: '组内计划检查未产生结果记录' },
        )
      }
    } else {
      const key = `${rule.id}::${rule.targetScope}::${[...ruleSubjectIds].sort().join(',')}`
      const hit = byRuleTarget.get(key)
      ledger.push(
        hit
          ? { ruleId: rule.id, targetKey: rule.targetScope, status: hit.status }
          : { ruleId: rule.id, targetKey: rule.targetScope, status: 'not-executed', reason: '计划检查未产生结果记录' },
      )
    }
  }
  return ledger
}

export interface CoverageSummary {
  documents: Array<{ documentVersionId: string; status: DocumentVersion['usage']; reason?: string }>
  plannedChecks: number
  completedChecks: number
  effectiveVerdicts: number
  pendingChecks: number
  /** "全部符合"是否成立（未读材料/未执行/待确认任一存在即不成立） */
  allClearVerdictAllowed: boolean
  blockers: string[]
}

/** 组合双账本 → ReviewRunV2.coverage + 全部符合判定（A08） */
export function combineCoverage(
  documents: DocumentVersion[],
  plannedRules: RuleSpec[],
  subjectIds: string[],
  results: CheckResult[],
  groupValues?: Record<string, string[]>,
  sectionSubjectIds?: Record<string, string[]>,
): CoverageSummary {
  const documentLedger = buildDocumentLedger(documents)
  const checkLedger = buildCheckLedger(plannedRules, subjectIds, results, groupValues, sectionSubjectIds)
  const unread = documentLedger.filter((entry) => entry.status !== 'read')
  const notExecuted = checkLedger.filter((entry) => entry.status === 'not-executed' || entry.status === 'execution-failed')
  const awaiting = checkLedger.filter((entry) => entry.status === 'awaiting-confirmation' || entry.status === 'awaiting-supplement')
  const violations = checkLedger.filter((entry) => entry.status === 'non-compliant')
  const blockers: string[] = []
  if (checkLedger.length === 0) blockers.push('没有有效检查计划，不能宣称全部符合')
  else if (checkLedger.every((entry) => entry.status === 'not-applicable')) blockers.push('本次没有适用检查，不能宣称全部符合')
  for (const entry of unread) blockers.push(`材料「${entry.fileName}」未完整读取${entry.reason ? `（${entry.reason}）` : ''}`)
  if (notExecuted.length > 0) blockers.push(`${notExecuted.length} 项计划检查未执行`)
  if (awaiting.length > 0) blockers.push(`${awaiting.length} 项检查待确认/待补件`)
  if (violations.length > 0) blockers.push(`${violations.length} 项检查不符合`)
  return {
    documents: documentLedger,
    plannedChecks: checkLedger.length,
    completedChecks: checkLedger.filter((entry) => entry.status !== 'not-executed' && entry.status !== 'execution-failed').length,
    effectiveVerdicts: checkLedger.filter((entry) => entry.status === 'compliant' || entry.status === 'non-compliant').length,
    pendingChecks: awaiting.length + notExecuted.length,
    allClearVerdictAllowed: blockers.length === 0,
    blockers,
  }
}
