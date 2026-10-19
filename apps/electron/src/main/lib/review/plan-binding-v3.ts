/**
 * C1 immutable Plan binding. Only Dev-C's Main business service may call this
 * with a verified Dev-B artifact verifier; not exposed as Renderer IPC.
 * It does not confer template publication or school policy authority.
 */
import {
  assertC0CanonicalPlan, type Actor, type CanonicalPlan, type CaseAggregateV2,
  type ReviewCommandResult,
} from '@profer/shared'
import { CommandValidationError, submitCommand } from './case-store-v2'

export type VerifyPublishedCanonicalPlan = (plan: CanonicalPlan) => void

function checkPlan(caseRecord: CaseAggregateV2, plan: CanonicalPlan, verify: VerifyPublishedCanonicalPlan): void {
  assertC0CanonicalPlan(plan)
  // The external trust adapter MUST verify the published artifact provenance,
  // source module digests and fingerprint; caller-supplied DTOs are insufficient.
  verify(plan)
  if (plan.templateId !== caseRecord.caseV2.templateId ||
      plan.templateVersion !== String(caseRecord.caseV2.templateVersion)) {
    throw new CommandValidationError('VALIDATION_FAILED', 'Plan template/version is not the bound Case template')
  }
  const activeVersions = new Set(caseRecord.caseV2.documents.filter((doc) => doc.active !== false).map((doc) => doc.versionId))
  const keys = new Set<string>()
  for (const binding of plan.bindings) {
    const key = JSON.stringify([binding.checkKey, binding.targetKey, binding.objectKey])
    if (keys.has(key)) throw new CommandValidationError('VALIDATION_FAILED', 'Plan contains repeated Check×target×object')
    keys.add(key)
    if (binding.sourceVersionIds.some((id) => !activeVersions.has(id))) {
      throw new CommandValidationError('STALE_INPUT', 'Plan references an unavailable or archived material version')
    }
    // Case-level targets are owned by the canonical producer. For subject
    // targets, require a real Case Subject; never synthesize a V1 target.
    if (binding.targetKey.startsWith('subject:') &&
      !caseRecord.caseV2.subjects.some((subject) => subject.id === binding.subjectId)) {
      throw new CommandValidationError('VALIDATION_FAILED', 'Plan target Subject does not exist')
    }
  }
}

/** First bind: only one immutable published Plan, never a silent overwrite. */
export function bindCanonicalPlanV3(
  caseId: string,
  command: { requestId: string; actor: Actor; expectedRevision: number; payload: CanonicalPlan },
  verify: VerifyPublishedCanonicalPlan,
): Promise<ReviewCommandResult<CanonicalPlan>> {
  return submitCommand<CanonicalPlan, CanonicalPlan>(caseId, { ...command, type: 'BindCanonicalPlan' }, (aggregate, plan) => {
    checkPlan(aggregate, plan, verify)
    if (aggregate.canonicalPlan) throw new CommandValidationError('INVALID_TRANSITION', 'Plan already bound; explicit upgrade ACK required')
    return {
      summary: `绑定不可变 Plan ${plan.planId}@${plan.fingerprint}`,
      mutate: (draft) => {
        draft.canonicalPlan = structuredClone(plan)
        return draft.canonicalPlan
      },
    }
  })
}

/** Explicit operator ACK; no legacy projection / hot reload may call this. */
export function upgradeCanonicalPlanV3(
  caseId: string,
  command: { requestId: string; actor: Actor; expectedRevision: number;
    payload: { plan: CanonicalPlan; previousFingerprint: string; acknowledgement: string } },
  verify: VerifyPublishedCanonicalPlan,
): Promise<ReviewCommandResult<CanonicalPlan>> {
  return submitCommand<{ plan: CanonicalPlan; previousFingerprint: string; acknowledgement: string }, CanonicalPlan>(caseId, { ...command, type: 'UpgradeCanonicalPlan' }, (aggregate, payload) => {
    const previous = aggregate.canonicalPlan
    if (!previous || previous.fingerprint !== payload.previousFingerprint) {
      throw new CommandValidationError('STALE_INPUT', 'Plan upgrade ACK does not identify the installed Plan')
    }
    if (!payload.acknowledgement.trim()) throw new CommandValidationError('VALIDATION_FAILED', 'Plan upgrade requires an explicit reason/ACK')
    checkPlan(aggregate, payload.plan, verify)
    if (previous.fingerprint === payload.plan.fingerprint || previous.planId === payload.plan.planId) {
      throw new CommandValidationError('INVALID_TRANSITION', 'A new immutable Plan identity is required')
    }
    return {
      summary: `确认升级 Plan ${previous.planId} → ${payload.plan.planId}：${payload.acknowledgement.trim()}`,
      mutate: (draft) => {
        draft.canonicalPlanHistory = [...(draft.canonicalPlanHistory ?? []), structuredClone(previous)]
        draft.canonicalPlan = structuredClone(payload.plan)
        return draft.canonicalPlan
      },
    }
  })
}
