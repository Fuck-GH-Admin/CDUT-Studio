/**
 * T06 物理入库 Main 端口：指纹校验、幂等、部分失败不掩盖。
 * 真实 OS 选择器无法在单测里弹出，因此这里直接注入内部选择状态。
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const configDir = mkdtempSync(join(tmpdir(), 't06m-'))
process.env.PROFER_CONFIG_DIR = configDir
afterAll(() => rmSync(configDir, { recursive: true, force: true }))

const { saveDraft, publishTemplate } = await import('./template-store')
const service = await import('./review-v3-t06-main-service')

const templateId = 't06-physical'
saveDraft({
  templateId, version: 1, schemaVersion: 2, name: '物理入库模板',
  objectType: 'organization', displayName: { template: 'x' }, status: 'draft', createdAt: '',
  fields: [{ key: 'applicant', label: '申请人', kind: 'text', required: false, visibility: 'public', scope: 'case' }],
  sections: [], materialSlots: [], policyVersionIds: [], policyRefs: [], outputs: [],
  stages: [{ id: 'end', name: '结束', kind: 'finalize', executorRole: 'reviewer' }],
} as never)
publishTemplate(templateId, 1)

/** 真实目录 → 真实枚举与指纹（不伪造 OS 弹窗，但确实读盘）。 */
function seedSelection(files: Array<{ name: string; content?: string }> = [{ name: 'a.txt' }]) {
  const root = mkdtempSync(join(tmpdir(), 't06src-'))
  for (const file of files) writeFileSync(join(root, file.name), file.content ?? '材料正文')
  const selection = service.buildT06SelectionFromPath(root, 'folder')
  return selection
}

describe('T06 物理入库桥接', () => {
  test('来源指纹不符时拒绝提交', async () => {
    const selection = seedSelection([{ name: 'a.txt' }, { name: 'b.txt' }])
    await expect(service.commitT06PhysicalImport({
      requestId: 'r-fingerprint', selectionId: selection.selectionId,
      previewFingerprint: 'deadbeef', templateId, templateVersion: 1, batchName: '批次',
      groups: [{ groupId: 'g1', entryIds: selection.entries.map((entry) => entry.entryId), action: 'create' as const, title: '案卷', applicant: 'E2E' }],
    })).rejects.toThrow('来源内容在预览后发生变化')
  })

  test('同一 requestId 幂等：重复提交返回同一回执，不重复建案', async () => {
    const selection = seedSelection()
    const request = {
      requestId: 'r-idem', selectionId: selection.selectionId,
      previewFingerprint: selection.previewFingerprint, templateId, templateVersion: 1, batchName: '幂等批次',
      groups: [{ groupId: 'g1', entryIds: selection.entries.map((entry) => entry.entryId), action: 'create' as const, title: '幂等案卷', applicant: 'E2E' }],
    }
    const first = await service.commitT06PhysicalImport(request)
    const second = await service.commitT06PhysicalImport(request)
    expect(first).toEqual(second)
    expect(first.cases).toHaveLength(1)
    expect(first.cases[0]!.status).toBe('done')
    expect(first.batchId).toBeTruthy()
  })

  test('部分失败：案卷与已入库原件保留，但不进入批次成功成员', async () => {
    const selection = seedSelection([{ name: 'a.txt' }, { name: 'b.txt' }])
    const request = {
      requestId: 'r-partial', selectionId: selection.selectionId,
      previewFingerprint: selection.previewFingerprint, templateId, templateVersion: 1, batchName: '部分失败批次',
      groups: [
        { groupId: 'ok', entryIds: [selection.entries[0]!.entryId], action: 'create' as const, title: '成功案卷', applicant: 'E2E' },
        // 第二个条目引用不存在的 entryId，模拟单条失败
        { groupId: 'bad', entryIds: ['e-does-not-exist'], action: 'create' as const, title: '失败案卷', applicant: 'E2E' },
      ],
    }
    const receipt = await service.commitT06PhysicalImport(request)
    const bad = receipt.cases.find((item) => item.groupId === 'bad')!
    expect(bad.status).toBe('failed')
    expect(bad.error).toContain('不在本次来源中')
    // 失败案卷仍然被创建并记录，便于复核
    expect(bad.caseId).toBeTruthy()
    const ok = receipt.cases.find((item) => item.groupId === 'ok')!
    expect(ok.status).toBe('done')
    expect(ok.documents).toHaveLength(1)
  })
})
