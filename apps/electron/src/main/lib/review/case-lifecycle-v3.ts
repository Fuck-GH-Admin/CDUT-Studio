/**
 * C-owned reversible CurrentCase archive / restore.
 *
 * The existing state.v2.json remains the only business writer. Archive and
 * receipt commit in one CAS transaction; V1 case.json is never removed or
 * treated as a second authoritative Case. Real Main callers must derive Actor
 * from the live Main sender, never from a renderer JSON payload.
 */
import type { Actor, ReviewCommandResult } from '@profer/shared'
import { CommandValidationError, submitCommand } from './case-store-v2'
import { assertSafeReviewStorageId } from './review-storage-id'

interface CaseLifecycleCommand {
  requestId: string
  expectedRevision: number
  actor: Actor
  payload: { reason: string }
}
const check = (caseId: string, command: CaseLifecycleCommand): void => {
  assertSafeReviewStorageId(caseId, 'caseId')
  if (!command || typeof command.requestId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(command.requestId) ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0 ||
      !command.actor || command.actor.actorSource !== 'local' ||
      command.actor.role !== 'reviewer' ||
      !command.actor.actorId || !command.payload ||
      typeof command.payload.reason !== 'string' ||
      command.payload.reason.trim().length < 2 ||
      command.payload.reason.length > 1000) {
    throw new CommandValidationError('VALIDATION_FAILED', '案卷归档/恢复命令缺少可信人员、修订号或有效理由')
  }
}

/** Performs non-destructive archive; original documents, receipts, runs stay. */
export async function archiveReviewCaseV3(
  caseId: string, command: CaseLifecycleCommand,
): Promise<ReviewCommandResult> {
  check(caseId, command)
  return submitCommand(caseId, { ...command, type: 'ArchiveReviewCaseV3' }, (snapshot) => {
    if (snapshot.caseV2.stage === 'archived') {
      throw new CommandValidationError('INVALID_TRANSITION', '案卷已经归档')
    }
    if (snapshot.caseArchive) {
      throw new CommandValidationError('INVALID_TRANSITION', '案卷归档账与业务状态矛盾，禁止覆盖')
    }
    return {
      summary: '案卷软归档（保留原件、历史运行与所有业务回执）',
      mutate: draft => {
        draft.caseArchive = {
          previousStage: snapshot.caseV2.stage,
          archivedAt: new Date().toISOString(),
          archivedBy: command.actor.actorId,
          reason: command.payload.reason.trim(),
        }
        draft.caseV2.stage = 'archived'
      },
    }
  })
}

/** Explicit restore; never implied by a read or a V1 renderer projection. */
export async function restoreReviewCaseV3(
  caseId: string, command: CaseLifecycleCommand,
): Promise<ReviewCommandResult> {
  check(caseId, command)
  return submitCommand(caseId, { ...command, type: 'RestoreReviewCaseV3' }, (snapshot) => {
    if (snapshot.caseV2.stage !== 'archived' || !snapshot.caseArchive ||
      snapshot.caseArchive.previousStage === 'archived') {
      throw new CommandValidationError('INVALID_TRANSITION', '案卷没有可恢复的有效归档检查点')
    }
    return {
      summary: '案卷恢复为归档前阶段（保留归档回执及历史）',
      mutate: draft => {
        draft.caseV2.stage = snapshot.caseArchive!.previousStage
        delete draft.caseArchive
      },
    }
  })
}
