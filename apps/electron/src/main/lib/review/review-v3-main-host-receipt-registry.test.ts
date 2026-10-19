import { describe, expect, test } from 'bun:test'
import {
  REVIEW_C0_SCHEMA_VERSION, type RunEvidenceIdentity,
  type SourceIdentity,
} from '@profer/shared'
import type {
  C2MainHostWitness, C2MainOwnerWitness,
} from './review-v3-main-trust-port'
import { C2MainPhysicalHostReceiptRegistry } from './review-v3-main-host-receipt-registry'

let serial = 0
function fixture() {
  const id = 'c2-registry-' + ++serial
  const run: RunEvidenceIdentity = {
    schemaVersion: REVIEW_C0_SCHEMA_VERSION, caseId: id,
    runId: 'run-' + id, attemptId: 'attempt-1', caseRevision: 1,
    planFingerprint: 'a'.repeat(64), templateVersion: '1',
    inputManifestHash: 'b'.repeat(64), ownerGeneration: 4,
    sourceVersionIds: ['v1'], checkKeys: ['c1'],
  }
  const source: SourceIdentity = {
    schemaVersion: REVIEW_C0_SCHEMA_VERSION, caseId: id,
    materialId: 'doc1', documentVersionId: 'v1',
    rawSha256: 'c'.repeat(64), parseRevision: 'p1',
    blockId: 'block-1', location: { kind: 'paragraph', locator: 'p1' },
  }
  const host: C2MainHostWitness = {
    run, permissionGrantId: 'main-grant-4',
    hostReceiptId: 'host-physical-' + id,
    verified: {
      permissionGrantId: 'main-grant-4', kind: 'read',
      source, extent: 'block',
    },
  }
  const observed = new Map<string, C2MainHostWitness>()
  let active = true
  let grant = 'main-grant-4'
  let manifest = run.inputManifestHash
  const registry = new C2MainPhysicalHostReceiptRegistry({
    getObservedPhysicalReceipt: id => observed.get(id),
    getCurrentOwner: identity => active ? {
      run: identity, permissionGrantId: grant,
      ownerGeneration: 4, inputManifestHash: manifest, active,
    } satisfies C2MainOwnerWitness : undefined,
  })
  return {
    run, host, registry, observed,
    observe: () => observed.set(host.hostReceiptId, structuredClone(host)),
    revoke: () => { active = false },
    rotate: () => { grant = 'rotated-grant-5' },
    changeManifest: () => { manifest = 'd'.repeat(64) },
  }
}

describe('C2-R03 Main physical Host receipt registry', () => {
  test('no Main observer means no registry and no self-certified DTO ingestion', () => {
    expect(() => new C2MainPhysicalHostReceiptRegistry({} as never)).toThrow()
    const f = fixture()
    expect(f.registry.getPhysicalHostReceipt(f.host.hostReceiptId)).toBeUndefined()
    expect(() => f.registry.rememberObservedReceipt(f.host.hostReceiptId))
      .toThrow('independently')
  })

  test('accepts physical observer exactly once, clones result, and fails when source disappears', () => {
    const f = fixture()
    f.observe()
    f.registry.rememberObservedReceipt(f.host.hostReceiptId)
    f.registry.rememberObservedReceipt(f.host.hostReceiptId)
    const value = f.registry.getPhysicalHostReceipt(f.host.hostReceiptId)
    expect(value?.verified.kind).toBe('read')
    if (!value) throw Error('missing observed evidence')
    value.permissionGrantId = 'forged-copy'
    expect(f.registry.getPhysicalHostReceipt(f.host.hostReceiptId)?.permissionGrantId)
      .toBe('main-grant-4')
    f.observed.delete(f.host.hostReceiptId)
    expect(f.registry.getPhysicalHostReceipt(f.host.hostReceiptId)).toBeUndefined()
  })

  test('revoked Owner, rotated grant and changed manifest invalidate read-back', () => {
    const f = fixture()
    f.observe()
    f.registry.rememberObservedReceipt(f.host.hostReceiptId)
    f.revoke()
    expect(f.registry.getPhysicalHostReceipt(f.host.hostReceiptId)).toBeUndefined()
    const g = fixture()
    g.observe()
    g.registry.rememberObservedReceipt(g.host.hostReceiptId)
    g.rotate()
    expect(g.registry.getPhysicalHostReceipt(g.host.hostReceiptId)).toBeUndefined()
    const h = fixture()
    h.observe()
    h.registry.rememberObservedReceipt(h.host.hostReceiptId)
    h.changeManifest()
    expect(h.registry.getPhysicalHostReceipt(h.host.hostReceiptId)).toBeUndefined()
  })

  test('cross-Run physical evidence is not attachable to a different owner', () => {
    const f = fixture()
    f.observe()
    const other = { ...f.host, run: { ...f.run, attemptId: 'different' } }
    f.observed.set(f.host.hostReceiptId, other)
    // Main sees a different Run from the one the caller would propose;
    // C2's trusted port compares the exact immutable Run again at commit.
    f.registry.rememberObservedReceipt(f.host.hostReceiptId)
    expect(f.registry.getPhysicalHostReceipt(f.host.hostReceiptId)?.run.attemptId)
      .toBe('different')
    f.observed.set(f.host.hostReceiptId, f.host)
    expect(f.registry.getPhysicalHostReceipt(f.host.hostReceiptId)).toBeUndefined()
  })

  test('source version mismatch and rebound physical ID are rejected', () => {
    const f = fixture()
    f.observed.set(f.host.hostReceiptId, {
      ...f.host, verified: { ...f.host.verified, source: {
        ...f.host.verified.source!, documentVersionId: 'not-in-run',
      } },
    })
    expect(() => f.registry.rememberObservedReceipt(f.host.hostReceiptId))
      .toThrow('manifest')
    f.observe()
    f.registry.rememberObservedReceipt(f.host.hostReceiptId)
    f.observed.set(f.host.hostReceiptId, {
      ...f.host, verified: { ...f.host.verified, extent: 'full-document' },
    })
    expect(() => f.registry.rememberObservedReceipt(f.host.hostReceiptId))
      .toThrow('rebound')
    expect(f.registry.getPhysicalHostReceipt(f.host.hostReceiptId)).toBeUndefined()
  })

  test('invalidateRun and close cannot resurrect a previously observed ID', () => {
    const f = fixture()
    f.observe()
    f.registry.rememberObservedReceipt(f.host.hostReceiptId)
    f.registry.invalidateRun(f.run)
    expect(f.registry.getPhysicalHostReceipt(f.host.hostReceiptId)).toBeUndefined()
    expect(() => f.registry.rememberObservedReceipt(f.host.hostReceiptId))
      .toThrow('Recycled')
    const g = fixture()
    g.observe()
    g.registry.rememberObservedReceipt(g.host.hostReceiptId)
    g.registry.close()
    expect(g.registry.getPhysicalHostReceipt(g.host.hostReceiptId)).toBeUndefined()
    expect(() => g.registry.rememberObservedReceipt(g.host.hostReceiptId))
      .toThrow('closed')
    const cold = fixture()
    expect(cold.registry.getPhysicalHostReceipt(g.host.hostReceiptId)).toBeUndefined()
  })
})
