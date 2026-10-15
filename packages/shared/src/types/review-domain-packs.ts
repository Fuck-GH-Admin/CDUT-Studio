/**
 * 内容审核专区 - 领域包（P1/D14）
 *
 * 背景：原先「规则类别」「问题类型」「prompt 角色」三处写死在综测场景，
 * 换个审批领域（合同/报销/自定义）模型输出就被六类框住。
 *
 * 领域包把这三样抽成数据：
 * - ruleCategories：AI 提取规则大纲时的建议类别
 * - findingKinds：问题类型表（含展示标签与默认严重度）
 * - prompts：角色设定与领域审查视角
 *
 * 结构化的指令（JSON 字段要求、锚点回引规则）仍留在服务层代码里——那部分是引擎契约，
 * 不属于领域知识，避免每个包各写一份导致漂移。
 *
 * 未知类型回落策略（D15）：findingKind 不在包内时，标签按原字符串展示，严重度回落 yellow。
 */

import type { FindingSeverity, RuleConstraint } from './review'

/** 领域包 ID（内置四包 + 自定义字符串） */
export type ReviewDomainPackId = string

/** 内置领域包 ID */
export const BUILTIN_DOMAIN_PACK_IDS = {
  /** 学生综合素质测评（原 demo 场景） */
  comprehensiveAssessment: 'comprehensive-assessment',
  /** 合同/协议审批 */
  contractReview: 'contract-review',
  /** 费用报销审批 */
  expenseReimbursement: 'expense-reimbursement',
  /** 自定义（用户自填类别与类型） */
  custom: 'custom',
} as const

/** 缺省领域包（兼容未标注 domainPackId 的历史案卷） */
export const DEFAULT_DOMAIN_PACK_ID = BUILTIN_DOMAIN_PACK_IDS.comprehensiveAssessment

/** 领域包内的一种问题类型 */
export interface ReviewFindingKindSpec {
  /** 类型 ID（写入 ReviewFinding.kind） */
  id: string
  /** 展示标签（问题卡上显示的中文名） */
  label: string
  /** 默认严重度（模型未给或给了非法值时使用） */
  defaultSeverity: FindingSeverity
  /** 判定口径提示（注入 prompt，帮助模型对齐语义） */
  hint?: string
}

/** 领域包 prompt 片段（结构化指令由服务层拼接，此处只放领域知识） */
export interface ReviewDomainPrompts {
  /** 角色设定，如 "你是学生综合素质测评审核助手" */
  role: string
  /** 领域审查视角补充（可缺省），如合同的"重点关注权责对等与违约责任" */
  guideline?: string
}

/** 领域包 */
export interface ReviewDomainPack {
  id: ReviewDomainPackId
  /** 展示名 */
  name: string
  /** 一句话说明（UI 下拉里展示） */
  description: string
  /** 规则大纲的建议类别（AI 提取时注入） */
  ruleCategories: string[]
  /** 问题类型表 */
  findingKinds: ReviewFindingKindSpec[]
  /** 该领域可用的规则约束类型（供 mock 引擎与约束校验参考） */
  constraintKinds: Array<RuleConstraint['kind']>
  prompts: ReviewDomainPrompts
  /** 是否内置（false = 用户自定义包） */
  builtin: boolean
}

/** 通用兜底类型：任何领域包都应包含，未知类型最终回落于此 */
export const FALLBACK_FINDING_KIND = 'other'

/** 综测领域包（与既有 demo 行为完全一致，保证不回归） */
const COMPREHENSIVE_ASSESSMENT: ReviewDomainPack = {
  id: BUILTIN_DOMAIN_PACK_IDS.comprehensiveAssessment,
  name: '学生综合素质测评',
  description: '综测加分审核：等级分值、材料要求、计分上限与互斥',
  ruleCategories: ['准入条件', '指标分类', '等级分值', '材料要求', '时间范围', '上限', '互斥', '例外'],
  findingKinds: [
    { id: 'level-conflict', label: '等级冲突', defaultSeverity: 'red', hint: 'The declared level does not match the level in the supporting material.' },
    { id: 'missing-evidence', label: '缺证明', defaultSeverity: 'red', hint: 'The declared item is not linked to any supporting material.' },
    { id: 'score-over-limit', label: '超上限', defaultSeverity: 'red', hint: 'The counted score exceeds the per-academic-year cap defined by the rules.' },
    { id: 'mutual-exclusion', label: '互斥重复计分', defaultSeverity: 'red', hint: 'Multiple items in the same mutual-exclusion group are scored at the same time.' },
    { id: 'date-out-of-range', label: '日期越界', defaultSeverity: 'red', hint: 'The activity/award date falls outside the recognized period.' },
    { id: 'unclear-evidence', label: '证明看不清', defaultSeverity: 'yellow', hint: 'Evidence elements are missing or illegible; manual re-check required.' },
    { id: 'info-incomplete', label: '信息不全', defaultSeverity: 'yellow', hint: 'Declared elements (level/date/organization) are missing.' },
    { id: 'rule-unmatched', label: '规则未覆盖', defaultSeverity: 'yellow', hint: 'No scoring rule matches the declared category.' },
    { id: 'cross-document-mismatch', label: '材料互相矛盾', defaultSeverity: 'red', hint: 'Information is inconsistent across multiple documents under review.' },
    { id: FALLBACK_FINDING_KIND, label: '其他问题', defaultSeverity: 'yellow', hint: 'Other issues that do not fall into the types above.' },
  ],
  constraintKinds: ['max-score', 'score-value', 'mutual-exclusion', 'date-range', 'required-evidence', 'level-mapping'],
  prompts: {
    role: 'You are the 学生综合素质测评 (student comprehensive assessment) review assistant.',
    guideline: 'Review perspective: check whether the declared level matches the supporting evidence, whether materials are complete, whether dates fall within the recognized academic year, and whether mutual-exclusion or score-cap rules are triggered.',
  },
  builtin: true,
}

/** 合同审批领域包 */
const CONTRACT_REVIEW: ReviewDomainPack = {
  id: BUILTIN_DOMAIN_PACK_IDS.contractReview,
  name: '合同/协议审批',
  description: '合同条款审核：必备条款、权责对等、付款与违约约定',
  ruleCategories: ['主体资格', '标的与范围', '付款条件', '交付与验收', '违约责任', '保密与知识产权', '争议解决', '变更与终止', '生效条件'],
  findingKinds: [
    { id: 'missing-clause', label: '必备条款缺失', defaultSeverity: 'red', hint: 'A clause required by the 依据方 (basis party) is absent from the contract under review.' },
    { id: 'clause-conflict', label: '条款冲突', defaultSeverity: 'red', hint: 'Two clauses within the same contract contradict each other.' },
    { id: 'cross-document-mismatch', label: '文件间不一致', defaultSeverity: 'red', hint: 'Information is inconsistent between the contract main text and the annexes/another version.' },
    { id: 'unclear-liability', label: '违约责任不明', defaultSeverity: 'red', hint: 'Liability for breach is not stipulated, or the stipulation cannot be enforced.' },
    { id: 'unbalanced-obligation', label: '权责不对等', defaultSeverity: 'yellow', hint: 'One party\'s obligations are clearly heavier than the other party\'s; reciprocal terms are missing.' },
    { id: 'unclear-payment', label: '付款条件不明', defaultSeverity: 'yellow', hint: 'Payment milestones, amounts, or methods are unclear.' },
    { id: 'missing-deadline', label: '期限缺失', defaultSeverity: 'yellow', hint: 'Delivery/acceptance/effectiveness deadlines are not stipulated.' },
    { id: 'invalid-reference', label: '引用错误', defaultSeverity: 'yellow', hint: 'The referenced annex, clause number, or regulation does not exist or is misaligned.' },
    { id: 'unfavorable-term', label: '不利条款', defaultSeverity: 'yellow', hint: 'An obviously unfavorable risk clause exists; negotiate an amendment.' },
    { id: FALLBACK_FINDING_KIND, label: '其他问题', defaultSeverity: 'yellow', hint: 'Other issues that do not fall into the types above.' },
  ],
  constraintKinds: ['required-clause', 'date-range', 'required-evidence', 'amount-limit', 'max-score'],
  prompts: {
    role: 'You are the 合同条款 (contract clause) review assistant.',
    guideline: 'Review perspective: check the contract under review item by item against the review points given by the 依据方 (basis party); focus on whether required clauses are present, whether rights and obligations are balanced, whether payment and 违约责任 (liability for breach) terms are clear, and whether the main text is consistent with the annexes. Suggestions should point out the specific clause location and explain the risk.',
  },
  builtin: true,
}

/** 费用报销审批领域包 */
const EXPENSE_REIMBURSEMENT: ReviewDomainPack = {
  id: BUILTIN_DOMAIN_PACK_IDS.expenseReimbursement,
  name: '费用报销审批',
  description: '报销单审核：范围、票据合规、标准限额与时限',
  ruleCategories: ['报销范围', '票据要求', '标准限额', '审批权限', '时间限制', '不予报销项', '例外情形'],
  findingKinds: [
    { id: 'over-standard', label: '超标准', defaultSeverity: 'red', hint: 'The amount or standard exceeds the limit defined by the policy.' },
    { id: 'invalid-invoice', label: '票据不合规', defaultSeverity: 'red', hint: 'Receipt elements are missing, the title is wrong, or the type does not meet requirements.' },
    { id: 'missing-invoice', label: '缺少票据', defaultSeverity: 'red', hint: 'The reimbursement item has no corresponding receipt attached.' },
    { id: 'duplicate-claim', label: '重复报销', defaultSeverity: 'red', hint: 'The same receipt or the same item is claimed multiple times.' },
    { id: 'cross-document-mismatch', label: '单据间不一致', defaultSeverity: 'red', hint: 'Amounts or reasons are inconsistent between the reimbursement form and the receipts/approval forms.' },
    { id: 'deadline-exceeded', label: '超时限', defaultSeverity: 'yellow', hint: 'The reimbursement application exceeds the prescribed time limit.' },
    { id: 'unclear-purpose', label: '事由不明', defaultSeverity: 'yellow', hint: 'The expense reason is described unclearly, so business authenticity cannot be judged.' },
    { id: 'wrong-category', label: '科目错误', defaultSeverity: 'yellow', hint: 'The expense is booked under a category inconsistent with the policy definition.' },
    { id: 'out-of-scope', label: '超出报销范围', defaultSeverity: 'red', hint: 'The expense is outside the reimbursable scope allowed by the policy.' },
    { id: FALLBACK_FINDING_KIND, label: '其他问题', defaultSeverity: 'yellow', hint: 'Other issues that do not fall into the types above.' },
  ],
  constraintKinds: ['amount-limit', 'max-score', 'date-range', 'required-evidence', 'mutual-exclusion'],
  prompts: {
    role: 'You are the 费用报销 (expense reimbursement) review assistant.',
    guideline: 'Review perspective: check each reimbursement item against its receipts; focus on whether the expense is within the reimbursable scope, whether receipts are compliant, whether amounts exceed the standard, whether time limits are exceeded, and whether duplicate claiming exists. Amount-related conclusions must state the calculation basis.',
  },
  builtin: true,
}

/**
 * 自定义领域包。
 *
 * 结构与内置包一致，但类别/类型为通用集合；调用方可基于它构造用户自定义包
 * （替换 name/ruleCategories/findingKinds/prompts 即可）。
 */
const CUSTOM: ReviewDomainPack = {
  id: BUILTIN_DOMAIN_PACK_IDS.custom,
  name: '自定义审核',
  description: '通用文件审批：按依据文件自行判定，不预设领域规则',
  ruleCategories: ['依据条款', '适用条件', '限制与禁止', '材料要求', '时间范围', '例外情形', '其他'],
  findingKinds: [
    { id: 'non-compliant', label: '不符合要求', defaultSeverity: 'red', hint: 'The content of the document under review does not meet the requirements of the 依据条款 (basis clauses).' },
    { id: 'missing-material', label: '材料缺失', defaultSeverity: 'red', hint: 'Material required by the 依据文件 (basis document) was not provided.' },
    { id: 'clause-conflict', label: '条款冲突', defaultSeverity: 'red', hint: 'Clauses contradict each other within a document or across documents.' },
    { id: 'cross-document-mismatch', label: '文件间不一致', defaultSeverity: 'red', hint: 'Information is inconsistent across multiple documents under review.' },
    { id: 'info-incomplete', label: '信息不全', defaultSeverity: 'yellow', hint: 'Key elements are missing, so no determination can be made.' },
    { id: 'unclear-content', label: '内容不清', defaultSeverity: 'yellow', hint: 'Content is vague or illegible; manual confirmation required.' },
    { id: 'rule-unmatched', label: '规则未覆盖', defaultSeverity: 'yellow', hint: 'No corresponding clause can be found in the 依据文件 (basis document).' },
    { id: FALLBACK_FINDING_KIND, label: '其他问题', defaultSeverity: 'yellow', hint: 'Other issues that do not fall into the types above.' },
  ],
  constraintKinds: ['max-score', 'score-value', 'mutual-exclusion', 'date-range', 'required-evidence', 'level-mapping'],
  prompts: {
    role: 'You are the document review assistant.',
    guideline: 'Review perspective: strictly check the documents under review item by item against the given 依据文件 (basis document); do not speculate about matters the basis document does not cover — mark them as 规则未覆盖 (rule-unmatched). Every conclusion must be traceable to the original text of the basis document or of the document under review.',
  },
  builtin: true,
}

/** 内置领域包清单（顺序即 UI 下拉顺序） */
export const BUILTIN_DOMAIN_PACKS: ReviewDomainPack[] = [
  COMPREHENSIVE_ASSESSMENT,
  CONTRACT_REVIEW,
  EXPENSE_REIMBURSEMENT,
  CUSTOM,
]

/**
 * 解析领域包：ID 未提供或未命中时回落缺省包（综测），保证历史案卷行为不变。
 *
 * @param packId 领域包 ID（可缺省）
 */
/** 显式声明的领域包 ID 是否为已知内置包（M0/H14：未知 ID 阻止默默按综测执行，K14） */
export function isKnownDomainPack(packId?: string): boolean {
  if (!packId) return true // 未声明 = 使用缺省包，属于显式语义
  return BUILTIN_DOMAIN_PACKS.some((pack) => pack.id === packId)
}

export function resolveDomainPack(packId?: string): ReviewDomainPack {
  if (!packId) return COMPREHENSIVE_ASSESSMENT
  return BUILTIN_DOMAIN_PACKS.find((pack) => pack.id === packId) ?? COMPREHENSIVE_ASSESSMENT
}

/**
 * 取问题类型的展示标签；未知类型回落为原字符串（D15 宽进严出）。
 *
 * @param pack 领域包
 * @param kind 问题类型 ID
 */
export function findingKindLabel(pack: ReviewDomainPack, kind: string): string {
  return pack.findingKinds.find((spec) => spec.id === kind)?.label ?? kind
}

/**
 * 取问题类型的默认严重度；未知类型回落 yellow。
 *
 * @param pack 领域包
 * @param kind 问题类型 ID
 */
export function findingKindSeverity(pack: ReviewDomainPack, kind: string): FindingSeverity {
  return pack.findingKinds.find((spec) => spec.id === kind)?.defaultSeverity ?? 'yellow'
}

/**
 * 判断类型是否属于该领域包（用于把模型输出的未知类型收敛到兜底类型）。
 *
 * @param pack 领域包
 * @param kind 问题类型 ID
 */
export function isKnownFindingKind(pack: ReviewDomainPack, kind: string): boolean {
  return pack.findingKinds.some((spec) => spec.id === kind)
}
