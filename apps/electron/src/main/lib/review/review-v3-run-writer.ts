/**
 * Dev-C C2-R01 — the FIRST Case-authoritative, immutable V3 ReviewRun result.
 *
 * Exact trust scope: a C Main-only closure verifier must independently attest
 * Owner generation/session, complete Host receipt registry and frozen input
 * manifest at the serialized CAS commit. No Renderer IPC or A/I writer exists.
 * This publishes an evidence-bearing Run record for human review, never an
 * approved CheckResult, grading decision, school ACK or completed workflow.
 *
 * V2 runs-v2 files remain legacy; this is one CaseAggregate CAS+Receipt and
 * does not create a shadow run JSON or a second transactional authority.
 */
import {
  REVIEW_V3_RUN_SCHEMA,
  type Actor, type CaseAggregateV2, type ReviewCommandResult,
  type ReviewRunRecordV3, type RunEvidenceIdentity, type V3RunBoundCheck,
  type V3RunReadEvidence, type V3ExecutionProposal,
} from '@profer/shared'
import { CommandValidationError, readAggregate, submitCommand } from './case-store-v2'
import {
  assertV3TechnicalJournalIntegrity, digestV3TechnicalEventChain,
} from './review-v3-technical-ledger'
import { currentSourceValidityBlockers } from './source-current-validity-v3'

export type VerifyV3RunClosureAtCommit = (
  aggregate: CaseAggregateV2,
  run: RunEvidenceIdentity,
  events: readonly V3ExecutionProposal[],
) => void

export interface C2SealRunPayload {
  runId: string
  terminalEventId: string
}

const bindKey = (entry: {checkKey:string;targetKey:string;objectKey:string;subjectId:string}): string =>
  JSON.stringify([entry.checkKey, entry.targetKey, entry.objectKey, entry.subjectId])

/** Read-only authorized Main projection. Does not infer any V2 school status. */
export function getV3ReviewRunRecord(caseId: string): ReviewRunRecordV3 | undefined {
  const aggregate = readAggregate(caseId)
  const record = aggregate?.v3ReviewRun
  if (!record || record.schemaVersion !== REVIEW_V3_RUN_SCHEMA ||
      record.run.caseId !== caseId) return undefined
  return structuredClone(record)
}

/** Seal all verified technical evidence into ONE new, immutable business Run
 * snapshot, with exact input binding and distinct human decision responsibility.
 */
export function sealV3ReviewRun(
  caseId: string,
  command: {
    requestId: string
    expectedRevision: number
    actor: Actor
    payload: C2SealRunPayload
  },
  attestAtCommit: VerifyV3RunClosureAtCommit,
): Promise<ReviewCommandResult<ReviewRunRecordV3>> {
  if (typeof attestAtCommit !== 'function') {
    throw new Error('C2_MAIN_RUN_CLOSURE_ATTESTATION_REQUIRED')
  }
  return submitCommand<C2SealRunPayload, ReviewRunRecordV3>(
    caseId, {...command, type: 'SealV3ReviewRun'}, (aggregate, payload) => {
      if (aggregate.v3ReviewRun) {
        throw new CommandValidationError('INVALID_TRANSITION',
          '本案已拥有封存的 V3 Run，不能直接覆盖或复用同一事务')
      }
      if (aggregate.caseV2.stage !== 'reviewing') {
        throw new CommandValidationError('INVALID_TRANSITION',
          '只有处于 reviewing 状态的案卷才可封存正式运行证据')
      }
      const journal = assertV3TechnicalJournalIntegrity(aggregate)
      const plan = aggregate.canonicalPlan!
      if (!payload || payload.runId !== journal.run.runId ||
          !payload.terminalEventId || journal.events.length === 0) {
        throw new CommandValidationError('STALE_INPUT', '终态指定的 Run/事件身份缺失或不一致')
      }
      const terminalItem = journal.events[journal.events.length - 1]!
      if (terminalItem.proposal.kind !== 'terminal' ||
          terminalItem.eventId !== payload.terminalEventId ||
          terminalItem.proposal.terminal.status !== journal.terminalStatus) {
        throw new CommandValidationError('INVALID_TRANSITION',
          '没有具有真实 Host 事件与 CAS 回执的末尾技术终态')
      }
      if (aggregate.receiptLog.some(receipt =>
        receipt.revision > journal.admittedAtRevision &&
        receipt.type !== 'RecordV3TechnicalProposal')) {
        throw new CommandValidationError('STALE_INPUT', '执行期间存在非 Run 业务改动')
      }
      if (currentSourceValidityBlockers(aggregate).length > 0) {
        throw new CommandValidationError('STALE_INPUT', '现有已确认来源包含失效原件')
      }
      const activeDocs = new Map(aggregate.caseV2.documents
        .filter(doc => doc.active !== false).map(doc => [doc.versionId, doc]))
      for (const versionId of journal.run.sourceVersionIds) {
        const doc = activeDocs.get(versionId)
        if (!doc || !doc.byteHash || !/^[a-f0-9]{64}$/i.test(doc.byteHash)) {
          throw new CommandValidationError('STALE_INPUT',
            'Run 所需原件缺少 C Main 可核实的 raw SHA256')
        }
      }
      // The Plan remains the exact Case-selected immutable target manifest;
      // do not let an execution result create or change policy applicability.
      const bindings = new Map<string, V3RunBoundCheck>()
      for (const binding of plan.bindings) {
        const key = bindKey(binding)
        if (bindings.has(key)) {
          throw new CommandValidationError('INVALID_TRANSITION',
            'CanonicalPlan 含重复完整 Check×target×object×subject 绑定')
        }
        bindings.set(key, {binding: structuredClone(binding),
          technicalStatus: null, decisionEligible: false})
      }
      if (!bindings.size) {
        throw new CommandValidationError('DEPENDENCY_UNRESOLVED',
          '空 Plan 无法提供完整 Run 检查分母')
      }
      const readEvidence: V3RunReadEvidence[] = []
      const readVersions = new Set<string>()
      const allEvents = journal.events.map(entry => entry.proposal)
      for (const event of allEvents) {
        if (event.kind === 'read') {
          const doc = activeDocs.get(event.read.source.documentVersionId)
          if (!doc || doc.byteHash !== event.read.source.rawSha256 ||
              event.read.source.caseId !== caseId ||
              !journal.run.sourceVersionIds.includes(event.read.source.documentVersionId)) {
            throw new CommandValidationError('STALE_INPUT',
              '物理读取身份与冻结 Run 原件集合不一致')
          }
          readVersions.add(event.read.source.documentVersionId)
          readEvidence.push({
            eventId: event.eventId, hostReceiptId: event.hostReceiptId,
            sequence: event.sequence, source: structuredClone(event.read.source),
            extent: event.read.extent,
          })
        } else if (event.kind === 'check') {
          const key = bindKey(event.check)
          const candidate = bindings.get(key)
          if (!candidate || candidate.eventId) {
            throw new CommandValidationError('INVALID_TRANSITION',
              'Host 结果不存在相应唯一 Plan 绑定，或重复观察同一检查')
          }
          // A CheckResult without actual prior physical read(s) is untrusted;
          // 'unknown' may still be recorded as an explicitly unknown outcome.
          if (event.check.status !== 'unknown' &&
              candidate.binding.sourceVersionIds.some(id => !readVersions.has(id))) {
            throw new CommandValidationError('DEPENDENCY_UNRESOLVED',
              '检查结果缺少在先的真实 Host 原件读取回执')
          }
          candidate.technicalStatus = event.check.status
          candidate.eventId = event.eventId
          candidate.hostReceiptId = event.hostReceiptId
          candidate.sequence = event.sequence
        }
      }
      const boundChecks = [...bindings.values()]
      const observedBindings = boundChecks.filter(entry => entry.eventId !== undefined).length
      const terminal = terminalItem.proposal.terminal.status
      const state: ReviewRunRecordV3['state'] =
        terminal === 'completed-technical'
          ? (observedBindings === boundChecks.length ? 'requires-human-review' : 'incomplete')
          : terminal === 'partial' || terminal === 'needs-resume'
            ? 'incomplete' : 'interrupted'

      // Main has the last word on current Owner/Host; no fake Principal may be
      // constructed from a renderer/payload inside this function.
      attestAtCommit(aggregate, journal.run, allEvents)
      const sealedAt = new Date().toISOString()
      const record: ReviewRunRecordV3 = {
        schemaVersion: REVIEW_V3_RUN_SCHEMA,
        run: structuredClone(journal.run),
        plan: structuredClone(plan),
        inputDigest: journal.frozenInputDigest,
        eventChainDigest: digestV3TechnicalEventChain(aggregate),
        terminalEventId: terminalItem.eventId,
        terminal,
        state,
        boundChecks,
        readEvidence,
        coverage: {
          totalBindings: boundChecks.length,
          observedBindings,
          unobservedBindings: boundChecks.length - observedBindings,
          blockedApplicability: boundChecks.filter(entry =>
            entry.binding.applicability !== 'applicable').length,
        },
        sealedAt,
        sealedByActorId: command.actor.actorId,
      }
      return {
        summary: `封存 V3 Run ${record.run.runId}：${state}；未产生业务审批与评分结论`,
        mutate: draft => {
          draft.v3ReviewRun = structuredClone(record)
          return draft.v3ReviewRun
        },
      }
    },
  )
}
