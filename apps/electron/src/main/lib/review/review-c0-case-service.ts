/** Main-authorized wrapper around the existing V2 Aggregate/CAS/Receipt writer.
 * Does not create a CaseV3 store. Renderer cannot call this without Main IPC.
 */
import {
  assertC0CaseAuthorization, type AuthorizedCaseCommand,
  type Principal, type Actor,
  REVIEW_C0_SCHEMA_VERSION,
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
  // V2 create receipt is deterministic. Same request + same payload is replay-safe;
  // a different payload must not overwrite the existing aggregate.
  const prior = readAggregate(command.caseId)
  if (prior) {
    const receipt = prior.receiptLog.find((r) => r.requestId === command.requestId)
    if (receipt && receipt.type === 'CreateCaseFromTemplate' && receipt.payloadHash === command.payloadHash) {
      return { ok: true as const, receipt, aggregate: prior, entity: prior.caseV2 }
    }
    throw new CommandValidationError('REQUEST_ID_COLLISION', 'Case already exists with different create request')
  }
  if (command.expectedRevision !== 0 || command.requestId !== `create-${command.caseId}`) {
    throw new CommandValidationError('VALIDATION_FAILED', 'Legacy create identity/revision mismatch')
  }
  if (payloadHash('CreateCaseFromTemplate', command.payload) !== command.payloadHash) {
    throw new CommandValidationError('VALIDATION_FAILED', 'Create payload hash mismatch')
  }
  return createCaseFromTemplate(templateId, version, command.payload, actorOf(command.principal), command.caseId)
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
