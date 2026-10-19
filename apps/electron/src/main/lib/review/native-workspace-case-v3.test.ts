import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Actor } from '@profer/shared'
import { createNativeWorkspaceCaseV3, updateNativeWorkspaceSettingsV3,
  registerNativeWorkspaceMaterialV3, removeNativeWorkspaceDocumentsV3,
  nativeWorkspaceProjectionV3, updateNativeWorkspaceReviewItemV3 } from './native-workspace-case-v3'
import { listAggregatesV2, readAggregate, writeAggregate } from './case-store-v2'
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
  test('manual rules and subject document IDs remain durable DRAFTS pinned to physical source versions', async () => {
    const created = await createNativeWorkspaceCaseV3(input, actor)
    const id = created.view.id
    const applicationPath = join(root, `application-${id}.txt`)
    writeFileSync(applicationPath, '申报人自己提交的待审文本，非校方政策', 'utf8')
    const source = await registerNativeWorkspaceMaterialV3(id, applicationPath, 'application', actor)
    const rules = [{ id: 'user-draft-01', title: '人工核对提醒', requirement: '比对已提交原件；不是校方已发布制度' }]
    const edit = await updateNativeWorkspaceSettingsV3(id, {
      caseId: id, manualRules: rules, subjectDocumentIds: [source.id],
    }, actor)
    const stored = readAggregate(id)!
    expect(edit.manualRules).toEqual(rules)
    expect(edit.subjectDocumentIds).toEqual([source.id])
    expect(stored.caseV2.nativeWorkspaceDraft?.manualRules).toEqual(rules)
    expect(stored.caseV2.nativeWorkspaceDraft?.subjectDocumentVersionIds)
      .toEqual([stored.caseV2.documents[0]?.versionId])
    expect(stored.caseV2.reviewRules).toBeUndefined()
    expect(stored.canonicalPlan).toBeUndefined()
    expect(stored.receiptLog.map(r => r.type)).toEqual([
      'CreateNativeWorkspaceCaseV3', 'RegisterMaterial', 'UpdateNativeWorkspaceSettingsV3',
    ])
    expect(getCase(id)?.manualRules).toEqual(rules)
    expect(existsSync(join(getReviewCasesDir(), id, 'case.json'))).toBe(false)
    await expect(updateNativeWorkspaceSettingsV3(id, {
      caseId: id, subjectDocumentIds: [source.id, source.id],
    }, actor)).rejects.toThrow('重复')
    await expect(updateNativeWorkspaceSettingsV3(id, {
      caseId: id, manualRules: [...rules, { ...rules[0], requirement: '重复 ID' }],
    }, actor)).rejects.toThrow('无效')
    await expect(updateNativeWorkspaceSettingsV3(id, {
      caseId: id, subjectDocumentIds: ['cross-case-document'],
    }, actor)).rejects.toThrow('待审主体材料')
    expect(readAggregate(id)?.caseV2.revision).toBe(2)
    await removeNativeWorkspaceDocumentsV3(id, 'application', [source.id], actor)
    // Previously selected version is retired: projection must NOT remap to a
    // new version with the same logical documentId.
    expect(getCase(id)?.subjectDocumentIds).toEqual([])
    expect(readAggregate(id)?.caseV2.nativeWorkspaceDraft?.subjectDocumentVersionIds)
      .toEqual(stored.caseV2.nativeWorkspaceDraft?.subjectDocumentVersionIds)
  })

  test('an existing anchored V2 item is corrected by native CAS without forging OCR/score policy', async () => {
    const created = await createNativeWorkspaceCaseV3(input, actor)
    const id = created.view.id
    const sourcePath = join(root, `subject-${id}.txt`)
    writeFileSync(sourcePath, 'An authentic application paragraph, user-asserted score', 'utf8')
    const source = await registerNativeWorkspaceMaterialV3(id, sourcePath, 'application', actor)
    // Synthetic fixture injected into isolated V2 aggregate ONLY for
    // exercising an existing subject; not evidence that extraction is ready.
    const aggregate = readAggregate(id)!
    const document = aggregate.caseV2.documents.find(doc => doc.documentId === source.id)!
    aggregate.caseV2.subjects = [{
      id: 'real-source-subject', type: 'item', title: 'Initial claimed item',
      status: 'identified', correction: 'ai-extracted',
      fields: { category: { kind: 'text', value: '科研' },
        declaredScore: { kind: 'number', value: 3 } },
      sourceRefs: [{ caseId: id, documentVersionId: document.versionId,
        parseRevision: document.parseRevision,
        location: { kind: 'paragraph', index: 0 } }],
    }]
    writeAggregate(aggregate)
    expect(getCase(id)?.items.map(item => item.id)).toEqual(['real-source-subject'])
    const corrected = await updateNativeWorkspaceReviewItemV3(id, {
      caseId: id, itemId: 'real-source-subject', title: 'Applicant corrected title',
      category: '科研', declaredScore: 4, level: '省级',
    }, actor)
    expect(corrected.items[0]).toMatchObject({
      title: 'Applicant corrected title', declaredScore: 4,
      status: 'confirmed', identifiedBy: 'manual',
    })
    expect(corrected.items[0]?.anchor.documentId).toBe(document.documentId)
    expect(readAggregate(id)?.caseV2.subjects[0]?.fields.declaredScore)
      .toEqual({ kind: 'number', value: 4 })
    expect(readAggregate(id)?.receiptLog.at(-1)?.type).toBe('CorrectNativeWorkspaceReviewItemV3')
    const before = JSON.stringify(readAggregate(id))
    await expect(updateNativeWorkspaceReviewItemV3(id, {
      caseId: id, itemId: 'real-source-subject', title: 'Invalid',
      category: '科研', declaredScore: 5,
    }, actor, () => { throw new Error('MAIN_REVOKED_ON_ITEM') })).rejects.toThrow('MAIN_REVOKED_ON_ITEM')
    expect(JSON.stringify(readAggregate(id))).toBe(before)
    const invalid = readAggregate(id)!
    invalid.caseV2.subjects[0]!.sourceRefs = [{ caseId: 'wrong-case',
      documentVersionId: document.versionId, parseRevision: document.parseRevision,
      location: { kind: 'file' } }]
    writeAggregate(invalid)
    expect(getCase(id)?.items).toEqual([])
    await expect(updateNativeWorkspaceReviewItemV3(id, {
      caseId: id, itemId: 'real-source-subject', title: 'Tampered',
      category: '科研', declaredScore: 10,
    }, actor)).rejects.toThrow('未绑定当前可追溯原件')
  })

})
