/** Main-authorized wrapper around the existing V2 Aggregate/CAS/Receipt writer.
 * Does not create a CaseV3 store. Renderer cannot call this without Main IPC.
 */
import {
  assertC0CaseAuthorization, type AuthorizedCaseCommand,
  type Principal, type Actor,
} from '@profer/shared'
import { payloadHash, readAggregate, CommandValidationError } from './case-store-v2'
import {
  createCaseFromTemplate, updateFields, correctObservation, setEvidenceLink,
  type CreateCasePayload, type UpdateFieldsPayload,
  type CorrectObservationPayload, type SetEvidenceLinkPayload,
} from './application-service'

function actorOf(principal: Principal): Actor {
  return { actorId: principal.principalId, actorSource: 'local', role: 'reviewer' }
}

export async function createCaseC0(
  command: AuthorizedCaseCommand<CreateCasePayload>,
  templateId: string, version: number,
) {
  assertC0CaseAuthorization(command, 'CREATE_CASE_V2')
  if (command.expectedRevision !== 0 || command.requestId !== `create-${command.caseId}`) {
    throw new CommandValidationError('VALIDATION_FAILED', 'Legacy create identity/revision mismatch')
  }
  if (payloadHash('CreateCaseFromTemplate', command.payload) !== command.payloadHash) {
    throw new CommandValidationError('VALIDATION_FAILED', 'Create payload hash mismatch')
  }
  const replayOrReject = (prior: NonNullable<ReturnType<typeof readAggregate>>) => {
    const receipt = prior.receiptLog.find((r) => r.requestId === command.requestId)
    // The historical V2 receipt hashes only the payload, not the template
    // binding. Enforce both dimensions here: never replay onto another template.
    if (prior.caseV2.templateId === templateId &&
      prior.caseV2.templateVersion === version &&
      receipt?.type === 'CreateCaseFromTemplate' &&
      receipt.payloadHash === command.payloadHash) {
      return { ok: true as const, receipt, aggregate: prior, entity: prior.caseV2 }
    }
    throw new CommandValidationError('REQUEST_ID_COLLISION',
      'REQUEST_ID_COLLISION: case or template already exists with a different create request')
  }
  const prior = readAggregate(command.caseId)
  if (prior) return replayOrReject(prior)
  try {
    return await createCaseFromTemplate(templateId, version, command.payload, actorOf(command.principal), command.caseId)
  } catch (error) {
    // A second identical concurrent create may have passed the first read and
    // lost V2's per-case createAggregate lock. Replay only the *exact* winner;
    // all other failures retain their original fail-closed behavior.
    if (error instanceof CommandValidationError && error.code === 'INVALID_TRANSITION') {
      const winner = readAggregate(command.caseId)
      if (winner) return replayOrReject(winner)
    }
    throw error
  }
}

export function updateFieldsC0(command: AuthorizedCaseCommand<UpdateFieldsPayload>) {
  assertC0CaseAuthorization(command, 'UPDATE_FIELDS_V2')
  return updateFields(command.caseId, {
    requestId: command.requestId, expectedRevision: command.expectedRevision,
    payload: command.payload, actor: actorOf(command.principal),
  })
}
export function correctObservationC0(command: AuthorizedCaseCommand<CorrectObservationPayload>) {
  assertC0CaseAuthorization(command, 'CORRECT_OBSERVATION_V2')
  return correctObservation(command.caseId, {
    requestId: command.requestId, expectedRevision: command.expectedRevision,
    payload: command.payload, actor: actorOf(command.principal),
  })
}
export function setEvidenceLinkC0(command: AuthorizedCaseCommand<SetEvidenceLinkPayload>) {
  assertC0CaseAuthorization(command, 'SET_EVIDENCE_LINK_V2')
  return setEvidenceLink(command.caseId, {
    requestId: command.requestId, expectedRevision: command.expectedRevision,
    payload: command.payload, actor: actorOf(command.principal),
  })
}
