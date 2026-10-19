import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Actor } from '@profer/shared'
import { createNativeWorkspaceCaseV3, updateNativeWorkspaceSettingsV3,
  registerNativeWorkspaceMaterialV3, removeNativeWorkspaceDocumentsV3,
  nativeWorkspaceProjectionV3 } from './native-workspace-case-v3'
import { listAggregatesV2, readAggregate } from './case-store-v2'
import { getCase, getReviewCasesDir, listCases, saveCase } from './case-store'
import { buildDemoCase } from './demo-fixtures/demo-case-fixture'

const root = join(import.meta.dir, '../../../../../../work/tmp', `native-workspace-c1-${Date.now()}`)
process.env.PROFER_CONFIG_DIR = root
mkdirSync(root, { recursive: true })
afterAll(() => rmSync(root, { force: true, recursive: true }))

const actor: Actor = { actorId: 'local-reviewer', actorSource: 'local', role: 'reviewer' }
const input = { title: 'Native-first authoritative case', type: '综合测评' as const,
  applicant: 'Original applicant', academicYear: '2026' }

describe('C1 native-first single Case writer and V1 read-only compatibility', () => {
  test('writes V2 aggregate + receipt only; reopens after cold read without V1 shadow', async () => {
    const result = await createNativeWorkspaceCaseV3(input, actor)
    const id = result.view.id
    expect(result.aggregate.receiptLog.map(r => r.type)).toEqual(['CreateNativeWorkspaceCaseV3'])
    expect(result.aggregate.caseV2.stage).toBe('draft')
    expect(readAggregate(id)?.caseV2.id).toBe(id)
    expect(getCase(id)).toMatchObject({ id, applicant: 'Original applicant' })
    expect(listCases().some(c => c.id === id)).toBe(true)
    expect(existsSync(join(getReviewCasesDir(), id, 'case.json'))).toBe(false)
    expect(existsSync(join(getReviewCasesDir(), id, 'case.v2.json'))).toBe(false)
    const data = readAggregate(id)!
    expect(nativeWorkspaceProjectionV3(data)?.title).toBe(input.title)
    expect(() => saveCase({ ...buildDemoCase(), id, title: 'Renderer old overwrite' }))
      .toThrow('原生审核案卷禁止')
    expect(JSON.stringify(readAggregate(id))).toBe(JSON.stringify(data))
  })

  test('Main revoked immediately before native create commit leaves no current Case', async () => {
    const before = listAggregatesV2().map(c => c.caseId)
    await expect(createNativeWorkspaceCaseV3(input, actor, () => {
      throw new Error('MAIN_REVOKED_BEFORE_CREATE_COMMIT')
    })).rejects.toThrow('MAIN_REVOKED_BEFORE_CREATE_COMMIT')
    expect(listAggregatesV2().map(c => c.caseId)).toEqual(before)
  })

  test('settings and physical material fail closed on revoked Main at durable CAS', async () => {
    const created = await createNativeWorkspaceCaseV3(input, actor)
    const id = created.view.id
    const initial = JSON.stringify(readAggregate(id))
    await expect(updateNativeWorkspaceSettingsV3(id, { caseId: id, title: 'Forged after await' },
      actor, () => { throw new Error('MAIN_REVOKED_AT_SETTINGS_COMMIT') }))
      .rejects.toThrow('MAIN_REVOKED_AT_SETTINGS_COMMIT')
    expect(JSON.stringify(readAggregate(id))).toBe(initial)

    const source = join(root, 'proof.txt')
    writeFileSync(source, 'Independent physical source with exact bytes', 'utf8')
    await expect(registerNativeWorkspaceMaterialV3(id, source, 'evidence', actor,
      () => { throw new Error('MAIN_REVOKED_AT_MATERIAL_COMMIT') }))
      .rejects.toThrow('MAIN_REVOKED_AT_MATERIAL_COMMIT')
    expect(JSON.stringify(readAggregate(id))).toBe(initial)
    const stored = await registerNativeWorkspaceMaterialV3(id, source, 'evidence', actor)
    expect(getCase(id)?.documents.map(d => d.id)).toContain(stored.id)
    const beforeRemove = JSON.stringify(readAggregate(id))
    await expect(removeNativeWorkspaceDocumentsV3(id, 'evidence', [stored.id], actor,
      () => { throw new Error('MAIN_REVOKED_AT_REMOVE_COMMIT') }))
      .rejects.toThrow('MAIN_REVOKED_AT_REMOVE_COMMIT')
    expect(JSON.stringify(readAggregate(id))).toBe(beforeRemove)
    const retired = await removeNativeWorkspaceDocumentsV3(id, 'evidence', [stored.id], actor)
    expect(retired.documents).toHaveLength(0)
    const after = readAggregate(id)!
    expect(after.sourceValidityRevocations?.some(x => x.documentVersionId ===
      after.caseV2.documents[0]?.versionId)).toBe(true)
    expect(existsSync(join(getReviewCasesDir(), id, 'case.json'))).toBe(false)
  })

  test('a candidate or custom template is never secretly published as official policy', async () => {
    const created = await createNativeWorkspaceCaseV3({
      ...input, type: '自定义审核', domainPackId: 'custom',
    }, actor)
    expect(created.aggregate.caseV2.templateId).toBe('pending-template-v3')
    expect(created.aggregate.caseV2.templateVersion).toBe(0)
    expect(created.aggregate.canonicalPlan).toBeUndefined()
    expect(created.view.reviewTemplate).toBeUndefined()
    expect(created.view.type).toBe('自定义审核')
  })
})
