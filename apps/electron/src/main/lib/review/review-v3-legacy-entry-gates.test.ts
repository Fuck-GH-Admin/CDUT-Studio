/**
 * C1 legacy compatibility boundary: the existing Renderer contract survives,
 * but never supplies authority to overwrite a native V2 Case or frozen Plan.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REVIEW_IPC_CHANNELS } from '@profer/shared'
import { setMainWindow } from '../main-window-state'
import { registerReviewIpc } from './review-ipc'
import { buildDemoCase } from './demo-fixtures/demo-case-fixture'
import { deleteCase, getCase, getReviewCasesDir, listCases, saveCase, updateCase } from './case-store'
import { createAggregate, listAggregatesV2, readAggregate, writeAggregate } from './case-store-v2'
import { ensureWorkspaceAggregateV2 } from './workspace-service-v2'
import { restoreReviewCaseV3 } from './case-lifecycle-v3'

const root = join(import.meta.dir, '../../../../../../work/tmp', `v3-c1-legacy-guard-${Date.now()}`)
process.env.PROFER_CONFIG_DIR = root
const handlers = (globalThis.__proferElectronTestHooks as typeof globalThis.__proferElectronTestHooks & {
  ipcMainHandlers: Map<string, (...args: unknown[]) => unknown>
}).ipcMainHandlers
const frame = { id: 1 }
const sender = { id: 207, mainFrame: frame, isDestroyed: () => false }
const event = { sender, senderFrame: frame }
const invoke = (channel: string, input: unknown, ev: unknown = event): unknown => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`Missing handler ${channel}`)
  return handler(ev, input)
}
const legacy = (id: string) => ({ ...buildDemoCase(), id, title: 'Legacy original' })
afterAll(() => { setMainWindow(null); rmSync(root, { recursive: true, force: true }) })

describe('C1 legacy Main command isolation and compatibility', () => {
  test('legacy CREATE_CASE rejects forged window and subframe without V1/V2 write', async () => {
    handlers.clear()
    setMainWindow({ isDestroyed: () => false, webContents: sender } as never)
    registerReviewIpc()
    const input = { title: 'Trusted new', type: '综合测评', applicant: 'Applicant', academicYear: '2026' }
    const before = getReviewCasesDir()
    await expect(Promise.resolve(invoke(REVIEW_IPC_CHANNELS.CREATE_CASE, input,
      { sender: { ...sender }, senderFrame: frame }))).rejects.toThrow('SENDER_UNTRUSTED')
    await expect(Promise.resolve(invoke(REVIEW_IPC_CHANNELS.CREATE_CASE, input,
      { sender, senderFrame: { id: 2 } }))).rejects.toThrow('SENDER_UNTRUSTED')
    const { readdirSync } = await import('node:fs')
    expect(readdirSync(before).filter(n => n.startsWith('case-'))).toEqual([])
  })

  test('valid legacy CREATE_CASE keeps its UI return contract and migrates under the same id', async () => {
    const input = { title: 'Legal application', type: '综合测评', applicant: 'Applicant', academicYear: '2026' }
    const result = await Promise.resolve(invoke(REVIEW_IPC_CHANNELS.CREATE_CASE, input)) as { id: string; title: string }
    expect(result.title).toBe('Legal application')
    expect(getCase(result.id)?.id).toBe(result.id)
    expect(readAggregate(result.id)?.caseV2.id).toBe(result.id)
    expect(readAggregate(result.id)?.receiptLog.some(r => r.type === 'EnsureReviewWorkspaceAggregate')).toBe(true)
  })

  test('native V2 colliding with a legacy shadow is immutable through low-level V1 updateCase', async () => {
    const id = 'v3-c1-native-legacy-shadow'
    saveCase(legacy(id))
    const origin = await ensureWorkspaceAggregateV2(id)
    const nativeId = 'v3-c1-native-shadow-collision'
    saveCase(legacy(nativeId))
    await createAggregate(nativeId, { ...origin.caseV2, id: nativeId, title: 'Authoritative V2', revision: 0 }, {
      requestId: `create-${nativeId}`, type: 'CreateCaseFromTemplate',
      payloadHash: 'a'.repeat(64), revision: 0, at: new Date().toISOString(),
      summary: 'Native origin', actor: { actorId: 'local-reviewer', actorSource: 'local', role: 'reviewer' },
    })
    const shadowPath = join(getReviewCasesDir(), nativeId, 'case.json')
    const beforeV1 = readFileSync(shadowPath, 'utf8')
    const beforeV2 = JSON.stringify(readAggregate(nativeId))
    // Legacy list/read paths must not surface the stale same-ID shadow as a
    // separate current Case; native V2 list still exposes the actual Case.
    expect(getCase(nativeId)).toBeUndefined()
    expect(listCases().some(c => c.id === nativeId)).toBe(false)
    expect(listAggregatesV2().some(c => c.caseId === nativeId)).toBe(true)
    expect(invoke(REVIEW_IPC_CHANNELS.GET_CASE, nativeId)).toBeUndefined()
    expect((invoke(REVIEW_IPC_CHANNELS.LIST_CASES, undefined) as Array<{ id: string }>)
      .some(c => c.id === nativeId)).toBe(false)
    expect((invoke(REVIEW_IPC_CHANNELS.LIST_CASES_V2, undefined) as Array<{ caseId: string }>)
      .some(c => c.caseId === nativeId)).toBe(true)
    expect(() => saveCase({ ...legacy(nativeId), title: 'Direct V1 shadow overwrite' }))
      .toThrow('原生审核案卷禁止')
    expect(readFileSync(shadowPath, 'utf8')).toBe(beforeV1)
    await expect(updateCase(nativeId, current => ({ ...current, title: 'Attempted rewrite' })))
      .rejects.toThrow('原生审核案卷禁止')
    expect(readFileSync(shadowPath, 'utf8')).toBe(beforeV1)
    expect(JSON.stringify(readAggregate(nativeId))).toBe(beforeV2)

    await expect(Promise.resolve(invoke(REVIEW_IPC_CHANNELS.UPDATE_CASE_SETTINGS, {
      caseId: nativeId, title: 'IPC bypass attempt',
    }))).rejects.toThrow('原生审核案卷禁止')
    expect(readFileSync(shadowPath, 'utf8')).toBe(beforeV1)
    expect(JSON.stringify(readAggregate(nativeId))).toBe(beforeV2)
  })

  test('corrupt native aggregate does not silently fall back to writable legacy case.json', async () => {
    const id = 'v3-c1-corrupt-native'
    saveCase(legacy(id))
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(getReviewCasesDir(), id), { recursive: true })
    writeFileSync(join(getReviewCasesDir(), id, 'state.v2.json'), '{invalid-json', 'utf8')
    const shadowPath = join(getReviewCasesDir(), id, 'case.json')
    const before = readFileSync(shadowPath, 'utf8')
    expect(getCase(id)).toBeUndefined()
    expect(listCases().some(c => c.id === id)).toBe(false)
    expect(() => saveCase({ ...legacy(id), title: 'corrupt state overwritten' }))
      .toThrow('原生审核案卷禁止')
    await expect(updateCase(id, original => ({ ...original, title: 'silent downgrade' })))
      .rejects.toThrow('原生审核案卷禁止')
    expect(readFileSync(shadowPath, 'utf8')).toBe(before)
  })

  test('old DELETE_CASE soft-archives native and migrated V2 without destroying historical receipts', async () => {
    const nativeId = 'v3-c1-native-archive-from-old-ui'
    const seedId = 'v3-c1-migrated-archive-from-old-ui'
    saveCase(legacy(seedId))
    const initial = await ensureWorkspaceAggregateV2(seedId)
    await createAggregate(nativeId, {
      ...initial.caseV2, id: nativeId, title: 'Native protected from physical delete', revision: 0,
    }, {
      requestId: `create-${nativeId}`, type: 'CreateCaseFromTemplate',
      payloadHash: 'a'.repeat(64), revision: 0, at: new Date().toISOString(),
      summary: 'Durable native receipt', actor: { actorId: 'local-reviewer', actorSource: 'local', role: 'reviewer' },
    })
    const nativeBefore = readAggregate(nativeId)!
    await Promise.resolve(invoke(REVIEW_IPC_CHANNELS.DELETE_CASE, nativeId))
    const nativeAfter = readAggregate(nativeId)!
    expect(nativeAfter.caseV2.stage).toBe('archived')
    expect(nativeAfter.caseArchive?.previousStage).toBe(nativeBefore.caseV2.stage)
    expect(nativeAfter.receiptLog).toHaveLength(nativeBefore.receiptLog.length + 1)
    expect(nativeAfter.receiptLog.at(-1)?.type).toBe('ArchiveReviewCaseV3')
    expect(listAggregatesV2().some(c => c.caseId === nativeId && c.stage === 'archived')).toBe(true)
    expect(getCase(nativeId)).toBeUndefined()
    // Durable archive replays without incrementing revision or receipt count.
    const snapshot = JSON.stringify(nativeAfter)
    await Promise.resolve(invoke(REVIEW_IPC_CHANNELS.DELETE_CASE, nativeId))
    expect(JSON.stringify(readAggregate(nativeId))).toBe(snapshot)
    expect(() => deleteCase(nativeId)).toThrow('禁止通过旧版删除入口')

    const migratedBefore = readAggregate(seedId)!
    await Promise.resolve(invoke(REVIEW_IPC_CHANNELS.DELETE_CASE, seedId))
    const migratedAfter = readAggregate(seedId)!
    expect(migratedAfter.caseV2.stage).toBe('archived')
    expect(migratedAfter.receiptLog.length).toBe(migratedBefore.receiptLog.length + 1)
    expect(getCase(seedId)).toBeUndefined()
    expect(listCases().some(c => c.id === seedId)).toBe(false)
    expect(() => deleteCase(seedId)).toThrow('禁止通过旧版删除入口')

    await expect(Promise.resolve(invoke(REVIEW_IPC_CHANNELS.DELETE_CASE, nativeId,
      { sender, senderFrame: { id: 9 } }))).rejects.toThrow('SENDER_UNTRUSTED')
    expect(JSON.stringify(readAggregate(nativeId))).toBe(snapshot)
  })

  test('pure V1-only draft can still be deleted through its existing UI command', async () => {
    const id = 'v3-c1-pure-v1-removable'
    saveCase(legacy(id))
    expect(getCase(id)).toBeDefined()
    expect(readAggregate(id)).toBeUndefined()
    await Promise.resolve(invoke(REVIEW_IPC_CHANNELS.DELETE_CASE, id))
    expect(getCase(id)).toBeUndefined()
    expect(readAggregate(id)).toBeUndefined()
  })

  test('valid JSON missing V2 shape cannot expose V1 shadow, archive or remove files', async () => {
    const id = 'v3-c1-malformed-native-json'
    saveCase(legacy(id))
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(getReviewCasesDir(), id), { recursive: true })
    const state = join(getReviewCasesDir(), id, 'state.v2.json')
    const shadow = join(getReviewCasesDir(), id, 'case.json')
    writeFileSync(state, '{}', 'utf8')
    const oldShadow = readFileSync(shadow, 'utf8')
    expect(getCase(id)).toBeUndefined()
    expect(listCases().some(x => x.id === id)).toBe(false)
    await expect(Promise.resolve(invoke(REVIEW_IPC_CHANNELS.DELETE_CASE, id)))
      .rejects.toThrow('V2 状态损坏')
    expect(readFileSync(shadow, 'utf8')).toBe(oldShadow)
    expect(readFileSync(state, 'utf8')).toBe('{}')
  })

  test('frozen CanonicalPlan forbids legacy settings upgrade before either file changes', async () => {
    const id = 'v3-c1-plan-frozen-legacy'
    saveCase(legacy(id))
    const original = await ensureWorkspaceAggregateV2(id)
    writeAggregate({
      ...original, canonicalPlan: {
        schemaVersion: 'review-c0/1', planId: 'frozen-plan', fingerprint: 'frozen-fingerprint',
        templateId: original.caseV2.templateId, templateVersion: String(original.caseV2.templateVersion),
        moduleDigests: [], bindings: [],
      },
    })
    const beforeV1 = JSON.stringify(getCase(id))
    const beforeV2 = JSON.stringify(readAggregate(id))
    await expect(Promise.resolve(invoke(REVIEW_IPC_CHANNELS.UPDATE_CASE_SETTINGS, {
      caseId: id, manualRules: [{ id: 'rule-1', title: 'Silent override', requirement: 'skip frozen check' }],
    }))).rejects.toThrow('审核计划已冻结')
    expect(JSON.stringify(getCase(id))).toBe(beforeV1)
    expect(JSON.stringify(readAggregate(id))).toBe(beforeV2)
  })

  test('existing migrated legacy case can still edit ordinary title and project it to V2', async () => {
    const id = 'v3-c1-legacy-title-update'
    saveCase(legacy(id))
    const first = await ensureWorkspaceAggregateV2(id)
    expect(() => saveCase({ ...legacy(id), title: 'Direct legacy edit allowed' })).not.toThrow()
    const updated = await Promise.resolve(invoke(REVIEW_IPC_CHANNELS.UPDATE_CASE_SETTINGS, {
      caseId: id, title: 'User revised title',
    })) as { title: string }
    expect(updated.title).toBe('User revised title')
    const after = readAggregate(id)!
    expect(after.caseV2.title).toBe('User revised title')
    expect(after.caseV2.revision).toBeGreaterThan(first.caseV2.revision)
  })

  test('legacy DELETE_CASE replays only within one archive cycle; restore enables a fresh archive', async () => {
    const id = 'v3-c1-legacy-delete-two-cycles'
    saveCase(legacy(id))
    const initial = await ensureWorkspaceAggregateV2(id)
    const createRevision = initial.caseV2.revision

    await Promise.resolve(invoke(REVIEW_IPC_CHANNELS.DELETE_CASE, id))
    const first = readAggregate(id)!
    expect(first.caseV2.stage).toBe('archived')
    const firstReceipt = first.receiptLog.at(-1)!
    expect(firstReceipt.type).toBe('ArchiveReviewCaseV3')
    await Promise.resolve(invoke(REVIEW_IPC_CHANNELS.DELETE_CASE, id))
    expect(JSON.stringify(readAggregate(id))).toBe(JSON.stringify(first))

    const trustedActor = { actorId: 'local-reviewer', actorSource: 'local' as const, role: 'reviewer' as const }
    const restored = await restoreReviewCaseV3(id, {
      requestId: 'explicit-restore-after-old-remove-1',
      expectedRevision: first.caseV2.revision,
      actor: trustedActor,
      payload: { reason: '用户确认恢复后重新审核' },
    })
    expect(restored.ok).toBe(true)
    expect(readAggregate(id)?.caseV2.stage).toBe('draft')

    // A forged Renderer frame must not consume the new cycle's request or
    // advance its revision before a legitimate Main-frame removal.
    const beforeSpoof = JSON.stringify(readAggregate(id))
    await expect(Promise.resolve(invoke(REVIEW_IPC_CHANNELS.DELETE_CASE, id,
      { sender, senderFrame: { id: 99 } }))).rejects.toThrow('SENDER_UNTRUSTED')
    expect(JSON.stringify(readAggregate(id))).toBe(beforeSpoof)

    await Promise.resolve(invoke(REVIEW_IPC_CHANNELS.DELETE_CASE, id))
    const second = readAggregate(id)!
    expect(second.caseV2.stage).toBe('archived')
    expect(second.caseV2.revision).toBe(createRevision + 3)
    expect(second.receiptLog.filter(r => r.type === 'ArchiveReviewCaseV3')).toHaveLength(2)
    const secondReceipt = second.receiptLog.at(-1)!
    expect(secondReceipt.requestId).not.toBe(firstReceipt.requestId)
    expect(secondReceipt.revision).toBe(firstReceipt.revision + 2)
    expect(second.caseArchiveHistory).toHaveLength(1)
    const afterSecond = JSON.stringify(second)
    await Promise.resolve(invoke(REVIEW_IPC_CHANNELS.DELETE_CASE, id))
    expect(JSON.stringify(readAggregate(id))).toBe(afterSecond)

    const secondRestore = await restoreReviewCaseV3(id, {
      requestId: 'explicit-restore-after-old-remove-2',
      expectedRevision: second.caseV2.revision,
      actor: trustedActor,
      payload: { reason: '用户再次确认恢复重审' },
    })
    expect(secondRestore.ok).toBe(true)
    await Promise.resolve(invoke(REVIEW_IPC_CHANNELS.DELETE_CASE, id))
    const third = readAggregate(id)!
    expect(third.caseV2.stage).toBe('archived')
    expect(third.caseV2.revision).toBe(createRevision + 5)
    expect(third.receiptLog.filter(r => r.type === 'ArchiveReviewCaseV3')).toHaveLength(3)
    expect(new Set(third.receiptLog.filter(r => r.type === 'ArchiveReviewCaseV3')
      .map(r => r.requestId)).size).toBe(3)
    expect(third.caseArchiveHistory).toHaveLength(2)
  })


  test('RESTORE_CASE_V3 derives Main Actor and receipt; stale, forged and cross-cycle requests fail closed', async () => {
    const id = 'v3-c1-main-trusted-restore'
    saveCase(legacy(id))
    const initial = await ensureWorkspaceAggregateV2(id)
    writeAggregate({ ...initial, caseV2: { ...initial.caseV2, stage: 'decided' } })
    await Promise.resolve(invoke(REVIEW_IPC_CHANNELS.DELETE_CASE, id))
    const archived = readAggregate(id)!
    const input = {
      caseId: id, expectedRevision: archived.caseV2.revision,
      reason: '用户明确要求恢复案卷并重新审核',
    }
    const bytes = JSON.stringify(archived)
    await expect(Promise.resolve(invoke(REVIEW_IPC_CHANNELS.RESTORE_CASE_V3, {
      ...input, expectedRevision: initial.caseV2.revision,
    }))).rejects.toThrow('VERSION_CONFLICT')
    await expect(Promise.resolve(invoke(REVIEW_IPC_CHANNELS.RESTORE_CASE_V3, {
      ...input, actor: { actorId: 'fake-school', actorSource: 'school', role: 'teacher' },
    }))).rejects.toThrow('ACTOR_UNTRUSTED')
    await expect(Promise.resolve(invoke(REVIEW_IPC_CHANNELS.RESTORE_CASE_V3, {
      ...input, requestId: 'renderer-controls-replay',
    }))).rejects.toThrow('ACTOR_UNTRUSTED')
    await expect(Promise.resolve(invoke(REVIEW_IPC_CHANNELS.RESTORE_CASE_V3, input,
      { sender, senderFrame: { id: 11 } }))).rejects.toThrow('SENDER_UNTRUSTED')
    expect(JSON.stringify(readAggregate(id))).toBe(bytes)

    const restored = await Promise.resolve(invoke(REVIEW_IPC_CHANNELS.RESTORE_CASE_V3, input)) as {
      ok: boolean; receipt: { type: string; requestId: string; actor: { actorId: string } }
    }
    expect(restored.ok).toBe(true)
    expect(restored.receipt.type).toBe('RestoreReviewCaseV3')
    expect(restored.receipt.actor.actorId).toBe('local-reviewer')
    const after = readAggregate(id)!
    expect(after.caseV2.stage).toBe('draft')
    expect(after.caseArchive?.previousStage).toBe('decided')
    expect(after.caseV2.revision).toBe(archived.caseV2.revision + 1)
    await Promise.resolve(invoke(REVIEW_IPC_CHANNELS.RESTORE_CASE_V3, input))
    expect(JSON.stringify(readAggregate(id))).toBe(JSON.stringify(after))

    await Promise.resolve(invoke(REVIEW_IPC_CHANNELS.DELETE_CASE, id))
    const secondArchive = readAggregate(id)!
    const second = await Promise.resolve(invoke(REVIEW_IPC_CHANNELS.RESTORE_CASE_V3, {
      ...input, expectedRevision: secondArchive.caseV2.revision,
    })) as { ok: boolean; receipt: { requestId: string } }
    expect(second.ok).toBe(true)
    expect(second.receipt.requestId).not.toBe(restored.receipt.requestId)
    expect(readAggregate(id)?.receiptLog.filter(r => r.type === 'RestoreReviewCaseV3')).toHaveLength(2)
    expect(readAggregate(id)?.caseV2.stage).toBe('draft')
  })

})
