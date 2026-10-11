/**
 * D2 作者态条件/业务对象 → 现有 Pi RuleSpec 的技术预审运行契约。
 * 仅证明执行范围与出处；不构成学校制度授权或最终审批。
 */
import type { ReviewSubject, RuleSpec } from './review-v2'

export type D2TargetKind = 'campus-card' | 'archive-item' | 'archive-operation'

/** 同一档案件每个操作必须拥有独立 objectKey/subjectId。 */
export interface D2TargetBinding {
  objectKey: string
  subjectId: string
  title: string
  kind: D2TargetKind
  scenario?: string
  itemId?: string
  operation?: 'read' | 'copy' | 'excerpt' | 'borrow'
}
export interface D2ScenarioSelection {
  templateId: string
  version: number
  /** 有情景的模板必须显式选择，不得把未知默认为 false。 */
  scenario?: string
  /** 仅供校园卡等「模块实例无 objectKey」的分支对象绑定。 */
  scenarioObjectKey?: string
  targets: D2TargetBinding[]
}
export interface D2RuleBinding {
  checkId: string
  ruleId: string
  objectKey?: string
  subjectId?: string
  sourceIds: string[]
  /** 记录制度候选/跨校参考尚未获本案授权；Pi 只能返回待确认。 */
  authority: 'request-scope' | 'unverified-policy'
}
export interface D2RuntimePlan {
  schemaVersion: 1
  mode: 'technical-pre-review'
  publicationAllowed: false
  workspaceId: string
  revision: number
  templateId: string
  templateVersion: number
  scenario?: string
  authoringDigest: string
  previewFingerprint: string
  targets: D2TargetBinding[]
  subjects: ReviewSubject[]
  rules: RuleSpec[]
  mapping: D2RuleBinding[]
  /** 覆盖作者态、选择的情景、对象边界、RuleSpec 内容及来源绑定。 */
  fingerprint: string
}
