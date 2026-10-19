/**
 * C1 legacy compatibility boundary: the existing Renderer contract survives,
 * but never supplies authority to overwrite a native V2 Case or frozen Plan.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REVIEW_IPC_CHANNELS } from '@profer/shared'
import { setMainWindow } from '../main-window-state'
import { registerReviewIpc } from './review-ipc'
import { buildDemoCase } from './demo-fixtures/demo-case-fixture'
import { getCase, getReviewCasesDir, saveCase, updateCase } from './case-store'
import { createAggregate, readAggregate, writeAggregate } from './case-store-v2'
import { ensureWorkspaceAggregateV2 } from './workspace-service-v2'

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
    const beforeV1 = JSON.stringify(getCase(nativeId))
    const beforeV2 = JSON.stringify(readAggregate(nativeId))
    expect(() => saveCase({ ...legacy(nativeId), title: 'Direct V1 shadow overwrite' }))
      .toThrow('原生审核案卷禁止')
    expect(JSON.stringify(getCase(nativeId))).toBe(beforeV1)
    await expect(updateCase(nativeId, current => ({ ...current, title: 'Attempted rewrite' })))
      .rejects.toThrow('原生审核案卷禁止')
    expect(JSON.stringify(getCase(nativeId))).toBe(beforeV1)
    expect(JSON.stringify(readAggregate(nativeId))).toBe(beforeV2)

    await expect(Promise.resolve(invoke(REVIEW_IPC_CHANNELS.UPDATE_CASE_SETTINGS, {
      caseId: nativeId, title: 'IPC bypass attempt',
    }))).rejects.toThrow('原生审核案卷禁止')
    expect(JSON.stringify(getCase(nativeId))).toBe(beforeV1)
    expect(JSON.stringify(readAggregate(nativeId))).toBe(beforeV2)
  })

  test('corrupt native aggregate does not silently fall back to writable legacy case.json', async () => {
    const id = 'v3-c1-corrupt-native'
    saveCase(legacy(id))
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(getReviewCasesDir(), id), { recursive: true })
    writeFileSync(join(getReviewCasesDir(), id, 'state.v2.json'), '{invalid-json', 'utf8')
    const before = JSON.stringify(getCase(id))
    expect(() => saveCase({ ...legacy(id), title: 'corrupt state overwritten' }))
      .toThrow('原生审核案卷禁止')
    await expect(updateCase(id, original => ({ ...original, title: 'silent downgrade' })))
      .rejects.toThrow('原生审核案卷禁止')
    expect(JSON.stringify(getCase(id))).toBe(before)
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
})
