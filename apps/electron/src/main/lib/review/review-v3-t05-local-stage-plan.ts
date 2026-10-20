/**
 * T05: local-business stage action proposal for the existing CaseAggregateV2.
 *
 * This is a pure domain function: it does not write a Case, mint an Actor,
 * inspect a renderer-supplied role, or select a Run from arbitrary user text.
 * Main must supply the authenticated LOCAL actor, frozen published template,
 * and current/verified Run information inside its authoritative transaction.
 */
import type { Actor, CaseAggregateV2, TemplateVersion } from '@profer/shared'

export type T05LocalStageAction =
  | 'stage-pass'
  | 'return-for-supplement'
  | 'return-to-previous-stage'
  | 'final-reject'

export interface T05VerifiedRun {
  id: string
  caseId: string
  status: 'completed' | 'partially-completed'
  /** Main confirmed input hash, policy/material revisions and source versions. */
  current: boolean
}

export interface T05StagePlanningInput {
  aggregate: CaseAggregateV2
  template: TemplateVersion
  /** Derived by trusted Main from the active local/mock/school identity. */
  actor: Actor
  /** Main must explicitly distinguish a local business case from technical-only. */
  businessMode: 'local-business' | 'technical-pre-review'
  taskId: string
  action: T05LocalStageAction
  reason: string
  requiredElements?: string[]
  supplementReason?: string
  verifiedRun?: T05VerifiedRun
}

export interface T05StageProposal {
  taskId: string
  stageId: string
  action: T05LocalStageAction
  reason: string
  /**
   * No invented run@rev placeholder. Only Main's verified real ReviewRun id.
   * Returning for supplement before a first Run is valid but creates a request,
   * NOT a BusinessDecision.
   */
  basedOnRunId?: string
  basedOnRevision: number
  decisionFinality?: 'stage' | 'final'
  nextStageId?: string
  nextAssigneeRole?: Actor['role']
  returnToStageId?: string
  supplement?: { requiredElements: string[]; publicReason: string }
}

const unresolved = new Set(['open', 'responded', 'insufficient'])

export function planT05LocalStageAction(input: T05StagePlanningInput): T05StageProposal {
  const { aggregate, template, actor, businessMode, action } = input
  if (businessMode !== 'local-business' || aggregate.d2RuntimePlan) {
    throw Error('T05_TECHNICAL_PREVIEW_NOT_BUSINESS_DECISION')
  }
  if (!['local', 'mock', 'school'].includes(actor.actorSource)) {
    throw Error('T05_TRUSTED_HUMAN_ACTOR_REQUIRED')
  }
  if (aggregate.caseV2.templateId !== template.templateId ||
      aggregate.caseV2.templateVersion !== template.version ||
      template.status !== 'published') {
    throw Error('T05_PUBLISHED_TEMPLATE_REVISION_REQUIRED')
  }
  if (!['submitted', 'reviewing', 'awaiting-review'].includes(aggregate.caseV2.stage)) {
    throw Error('T05_CASE_NOT_IN_REVIEW')
  }
  const task = aggregate.tasks.find(t => t.id === input.taskId && t.status === 'open')
  if (!task) throw Error('T05_OPEN_TASK_REQUIRED')
  const stage = template.stages.find(s => s.id === task.stageId)
  if (!stage || stage.executorRole !== task.assigneeRole || actor.role !== task.assigneeRole ||
      (task.assigneeActorId && task.assigneeActorId !== actor.actorId)) {
    throw Error('T05_ACTOR_NOT_ASSIGNED_TO_STAGE')
  }
  if (aggregate.supplements.some(s => unresolved.has(s.status))) {
    throw Error('T05_UNRESOLVED_SUPPLEMENTS')
  }
  if (!input.reason.trim()) throw Error('T05_DECISION_REASON_REQUIRED')
  if (aggregate.decisions.some(d => d.taskId === task.id)) throw Error('T05_TASK_ALREADY_DECIDED')

  const proposal: T05StageProposal = {
    taskId: task.id, stageId: task.stageId, action, reason: input.reason.trim(),
    basedOnRevision: aggregate.caseV2.revision,
  }

  if (action === 'return-for-supplement') {
    const requiredElements = [...new Set((input.requiredElements ?? []).map(s => s.trim()).filter(Boolean))]
    if (!requiredElements.length || !input.supplementReason?.trim()) {
      throw Error('T05_SUPPLEMENT_REQUIREMENTS_REQUIRED')
    }
    // Do not invent a BusinessDecision / Run if required material is not yet present.
    return { ...proposal, supplement: { requiredElements, publicReason: input.supplementReason.trim() } }
  }

  if (!input.verifiedRun || !input.verifiedRun.current ||
      input.verifiedRun.caseId !== aggregate.caseV2.id ||
      !['completed', 'partially-completed'].includes(input.verifiedRun.status)) {
    throw Error('T05_CURRENT_REAL_RUN_REQUIRED')
  }
  proposal.basedOnRunId = input.verifiedRun.id

  if (action === 'stage-pass') {
    if (stage.nextStageId) {
      const next = template.stages.find(candidate => candidate.id === stage.nextStageId)
      if (!next) throw Error('T05_NEXT_STAGE_NOT_FOUND')
      proposal.decisionFinality = 'stage'
      proposal.nextStageId = next.id
      proposal.nextAssigneeRole = next.executorRole
    } else {
      proposal.decisionFinality = 'final'
    }
  } else if (action === 'return-to-previous-stage') {
    if (!stage.returnToStageId) throw Error('T05_PREVIOUS_STAGE_NOT_CONFIGURED')
    const previous = template.stages.find(candidate => candidate.id === stage.returnToStageId)
    if (!previous) throw Error('T05_PREVIOUS_STAGE_NOT_FOUND')
    proposal.decisionFinality = 'stage'
    proposal.returnToStageId = previous.id
    proposal.nextAssigneeRole = previous.executorRole
  } else if (action === 'final-reject') {
    proposal.decisionFinality = 'final'
  }
  return proposal
}

/** Reopen a stage only when all live supplement requests are resolved.
 * "responded" is not "satisfied"; the operator must record an explicit decision.
 */
export function planT05SupplementReentry(
  aggregate: CaseAggregateV2,
  supplementId: string,
  outcome: 'satisfied' | 'insufficient' | 'cancelled',
): { canResume: boolean; restoreStageId?: string; restoreRole?: Actor['role'] } {
  const target = aggregate.supplements.find(s => s.id === supplementId)
  if (!target || !['open', 'responded', 'insufficient'].includes(target.status)) {
    throw Error('T05_SUPPLEMENT_NOT_ACTIONABLE')
  }
  if (outcome === 'satisfied' && target.status !== 'responded') {
    throw Error('T05_REPLY_REQUIRED_BEFORE_SATISFIED')
  }
  if (outcome === 'insufficient' && target.status !== 'responded') {
    throw Error('T05_REPLY_REQUIRED_BEFORE_INSUFFICIENT')
  }
  const canResume = outcome !== 'insufficient' &&
    !aggregate.supplements.some(s => s.id !== supplementId && unresolved.has(s.status))
  if (!canResume) return { canResume: false }
  const origin = target.originTaskId ? aggregate.tasks.find(t => t.id === target.originTaskId) : undefined
  return {
    canResume: true,
    ...(target.originStageId ? { restoreStageId: target.originStageId } : {}),
    ...(origin ? { restoreRole: origin.assigneeRole } : {}),
  }
}
