import { describe, expect, test } from 'bun:test'
import { REVIEW_C0_SCHEMA_VERSION as v, assertC0CanonicalPlan, assertC0SourceIdentity,
  assertC0RunEvidenceIdentity, assertC0ExecutionEvent, assertC0BatchBinding,
  assertC0ImportBatch, assertC0ReviewBatchAttempt, assertC0OutboxReceipt } from '@profer/shared'
const h = 'a'.repeat(64)
const entry = { schemaVersion: v, batchAttemptId: 'ba', caseId: 'c', entryRunId: 'r',
  inputHash: h, planFingerprint: h, templateVersion: '1', revision: 2,
  decisionId: 'd', decisionBasedOnRunId: 'r' }
describe('C0 schema runtime validation: no silent downgrade', () => {
  test('multi-target unknown is not pass; version and condition mandatory', () => {
    const plan = { schemaVersion: v, planId: 'p', fingerprint: h, templateId: 't',
      templateVersion: '1', moduleDigests: [h], bindings: ['x','y'].map((targetKey) => ({
        checkKey: 'c', targetKey, objectKey: 'o', subjectId: 's',
        applicability: 'unknown', sourceVersionIds: ['dv'], conditionFingerprint: h })) }
    expect(() => assertC0CanonicalPlan(plan)).not.toThrow()
    expect(plan.bindings.map(x => x.applicability)).toEqual(['unknown','unknown'])
    expect(() => assertC0CanonicalPlan({ ...plan, bindings: [{ ...plan.bindings[0], applicability: 'pass' }] })).toThrow()
    expect(() => assertC0CanonicalPlan({ ...plan, bindings: [{ ...plan.bindings[0], conditionFingerprint: '' }] })).toThrow()
    expect(() => assertC0CanonicalPlan({ ...plan, schemaVersion: 'review-c0/999' })).toThrow()
  })
  test('Source requires raw and version and locator', () => {
    const src = { schemaVersion: v, caseId: 'c', materialId: 'm', documentVersionId: 'dv',
      rawSha256: h, parseRevision: '1', blockId: 'b', location: { kind: 'file', locator: '/' } }
    expect(() => assertC0SourceIdentity(src)).not.toThrow()
    expect(() => assertC0SourceIdentity({ ...src, documentVersionId: '' })).toThrow()
    expect(() => assertC0SourceIdentity({ ...src, location: {} })).toThrow()
  })
  test('Run and execution proposal require identity and receipt shape', () => {
    const run = { schemaVersion: v, runId: 'r', caseId: 'c', caseRevision: 1,
      planFingerprint: h, templateVersion: '1', inputManifestHash: h, sourceVersionIds: ['dv'],
      checkKeys: ['c'], attemptId: 'at', ownerGeneration: 1 }
    expect(() => assertC0RunEvidenceIdentity(run)).not.toThrow()
    expect(() => assertC0RunEvidenceIdentity({ ...run, attemptId: '' })).toThrow()
    const evt = { schemaVersion: v, attemptId: 'at', generation: 1, sequence: 0,
      eventKind: 'read-receipt-proposal', toolReceipt: { receiptId: 'tr', permissionGrantId: 'pg' },
      manifestHash: h }
    expect(() => assertC0ExecutionEvent(evt)).not.toThrow()
    expect(() => assertC0ExecutionEvent({ ...evt, manifestHash: '' })).toThrow()
  })
  test('ImportBatch cannot be ReviewBatchAttempt; wrong or missing Run rejected', () => {
    const review = { schemaVersion: v, kind: 'review', batchAttemptId: 'ba', entries: [entry], status: 'queued' }
    const imported = { schemaVersion: v, kind: 'import', importBatchId: 'ib', materialIds: ['m'],
      inputManifestHash: h, status: 'staged' }
    expect(() => assertC0ReviewBatchAttempt(review)).not.toThrow()
    expect(() => assertC0ImportBatch(imported)).not.toThrow()
    expect(() => assertC0ReviewBatchAttempt(imported)).toThrow()
    expect(() => assertC0ImportBatch(review)).toThrow()
    expect(() => assertC0BatchBinding({ ...entry, entryRunId: '' })).toThrow()
    expect(() => assertC0BatchBinding({ ...entry, decisionBasedOnRunId: 'other' })).toThrow()
  })
  test('mock never proves external acknowledgement', () => {
    const r = { schemaVersion: v, intentId: 'i', idempotencyKey: 'k', at: '2026-10-19',
      trustTier: 'mock-accepted' }
    expect(() => assertC0OutboxReceipt(r)).not.toThrow()
    expect(() => assertC0OutboxReceipt({ ...r, trustTier: 'externally-acknowledged' })).toThrow()
    expect(() => assertC0OutboxReceipt({ ...r, trustTier: 'externally-acknowledged', externalReference: 'ack' })).not.toThrow()
  })
})
