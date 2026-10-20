/**
 * CSLab Word OOXML 无损引擎测试
 */

import { describe, expect, test } from 'bun:test'
import JSZip from 'jszip'
import {
  exportManuscriptToDocx,
  importDocx,
  inspectDocx,
  syncCapsulesToDocx,
} from './cslab-ooxml'

const CAPSULE = {
  id: 'cap-1',
  label: 'Yield',
  unit: '%',
  value: '72.5',
}

const EXPORT_INPUT = {
  title: '测试论文',
  docJson: {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 1 },
        content: [{ type: 'text', text: '测试论文' }],
      },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: '转化率 ', marks: [{ type: 'bold' }] },
          {
            type: 'scienceCapsule',
            attrs: {
              capsuleId: 'cap-1',
              label: 'Yield',
              value: '72.5',
              unit: '%',
              tableUri: 'cdut://lab-1/table/t-1',
              column: 'y1',
              rowIndex: 0,
              revisionAtBind: 1,
              status: 'fresh',
            },
          },
          { type: 'text', text: ' 达到峰值。' },
        ],
      },
    ],
  },
  capsules: [CAPSULE],
}

async function buildMinimalDocx(options: {
  customXml: string
  documentXml: string
  partName?: string
}): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>')
  zip.file('word/document.xml', options.documentXml)
  zip.file(options.partName ?? 'customXml/item2.xml', options.customXml)
  return (await zip.generateAsync({ type: 'uint8array' })) as Uint8Array
}

describe('OOXML 导出骨架', () => {
  test('从 docJson 生成合法 docx 骨架、格式与数据绑定', async () => {
    const buffer = await exportManuscriptToDocx(EXPORT_INPUT)
    const zip = await JSZip.loadAsync(buffer)

    expect(zip.file('[Content_Types].xml')).toBeTruthy()
    expect(zip.file('_rels/.rels')).toBeTruthy()
    expect(zip.file('word/document.xml')).toBeTruthy()
    expect(zip.file('word/_rels/document.xml.rels')).toBeTruthy()
    expect(zip.file('customXml/item1.xml')).toBeTruthy()
    expect(zip.file('customXml/_rels/item1.xml.rels')).toBeTruthy()
    expect(zip.file('customXml/itemProps1.xml')).toBeTruthy()

    const documentXml = await zip.file('word/document.xml')!.async('string')
    expect(documentXml).toContain('<w:sdt>')
    expect(documentXml).toContain('<w:dataBinding')
    expect(documentXml).toContain('urn:cdut:science:capsules')
    expect(documentXml).toContain('<w:b/>')
    expect(documentXml).toContain('转化率')

    const rootRels = await zip.file('_rels/.rels')!.async('string')
    expect(rootRels).not.toContain('customXml')
    const documentRels = await zip.file('word/_rels/document.xml.rels')!.async('string')
    expect(documentRels).toContain('customXml/item1.xml')

    const inspected = await inspectDocx(buffer)
    expect(inspected.capsuleIds).toEqual(['cap-1'])
    expect(inspected.hasDataBinding).toBe(true)
  })
})

describe('OOXML 外科手术同步', () => {
  test('仅更新 customXml，document.xml 解压字节完全一致', async () => {
    const original = await exportManuscriptToDocx(EXPORT_INPUT)
    const originalZip = await JSZip.loadAsync(original)
    const documentBefore = await originalZip.file('word/document.xml')!.async('uint8array')

    const synced = await syncCapsulesToDocx(original, [{ id: 'cap-1', value: '80.0' }])
    expect(synced.updatedCapsuleIds).toEqual(['cap-1'])
    expect(synced.documentXmlUnchanged).toBe(true)
    expect(synced.addedCapsuleIds).toEqual([])
    expect(synced.removedCapsuleIds).toEqual([])
    expect(synced.missingDataBindingIds).toEqual([])

    const syncedZip = await JSZip.loadAsync(synced.buffer)
    const documentAfter = await syncedZip.file('word/document.xml')!.async('uint8array')
    expect(Buffer.from(documentAfter).equals(Buffer.from(documentBefore))).toBe(true)

    const customXml = await syncedZip.file('customXml/item1.xml')!.async('string')
    expect(customXml).toContain('80.0')
    expect(customXml).not.toContain('72.5')
  })

  test('新增与删除胶囊被正确统计，缺失绑定的新增胶囊被标记', async () => {
    const original = await exportManuscriptToDocx(EXPORT_INPUT)

    const added = await syncCapsulesToDocx(original, [
      { id: 'cap-1', value: '80.0' },
      { id: 'cap-2', value: '1.0' },
    ])
    expect(added.addedCapsuleIds).toEqual(['cap-2'])
    expect(added.updatedCapsuleIds).toEqual(['cap-1'])
    expect(added.missingDataBindingIds).toEqual(['cap-2'])

    const removed = await syncCapsulesToDocx(added.buffer, [{ id: 'cap-2', value: '1.0' }])
    expect(removed.removedCapsuleIds).toEqual(['cap-1'])
    expect(removed.missingDataBindingIds).toEqual(['cap-2'])
  })

  test('更新 customXml/itemN.xml 中非 item1 的 CSLab 部件', async () => {
    const buffer = await buildMinimalDocx({
      partName: 'customXml/item2.xml',
      customXml: `<?xml version="1.0" encoding="UTF-8"?>
<cs:capsules xmlns:cs="urn:cdut:science:capsules"><cs:capsule id="cap-1">1.0</cs:capsule></cs:capsules>`,
      documentXml: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:sdt><w:sdtPr><w:dataBinding w:xpath="cs:capsules/cs:capsule[@id='cap-1']" w:storeItemID="{X}"/></w:sdtPr><w:sdtContent><w:r><w:t>1.0</w:t></w:r></w:sdtContent></w:sdt></w:p></w:body></w:document>`,
    })

    const synced = await syncCapsulesToDocx(buffer, [{ id: 'cap-1', value: '9.9' }])
    const zip = await JSZip.loadAsync(synced.buffer)
    const part = await zip.file('customXml/item2.xml')!.async('string')
    expect(part).toContain('9.9')
    expect(synced.updatedCapsuleIds).toEqual(['cap-1'])
  })

  test('缺少 CSLab customXml 的 docx 明确报错而非静默写入', async () => {
    const zip = new JSZip()
    zip.file('word/document.xml', '<w:document/>')
    const buffer = (await zip.generateAsync({ type: 'uint8array' })) as Uint8Array
    await expect(syncCapsulesToDocx(buffer, [])).rejects.toThrow('CSLab customXml')
  })
})

describe('OOXML 导入', () => {
  test('保留胶囊在正文中的位置且不重复文本', async () => {
    const original = await exportManuscriptToDocx(EXPORT_INPUT)
    const imported = await importDocx(original)

    expect(imported.capsules[0]?.id).toBe('cap-1')
    expect(imported.capsules[0]?.value).toBe('72.5')
    expect(imported.unreferencedCapsuleIds).toEqual([])

    const paragraph = imported.blocks[1]
    expect(paragraph?.type).toBe('paragraph')
    expect(paragraph?.inlines.map((inline) => inline.kind)).toEqual(['text', 'capsule', 'text'])
    const capsuleInline = paragraph?.inlines[1]
    expect(capsuleInline?.kind).toBe('capsule')
    if (capsuleInline?.kind === 'capsule') expect(capsuleInline.capsuleId).toBe('cap-1')

    // sdt 内部值不应作为普通文本再次出现。
    const textInlines = paragraph?.inlines.filter((inline) => inline.kind === 'text') ?? []
    expect(textInlines.map((inline) => (inline.kind === 'text' ? inline.text : '')).join('')).toBe(
      '转化率  达到峰值。',
    )
  })

  test('未被正文引用的 customXml 胶囊进入 orphan 段落', async () => {
    const buffer = await buildMinimalDocx({
      customXml: `<?xml version="1.0" encoding="UTF-8"?>
<cs:capsules xmlns:cs="urn:cdut:science:capsules">
  <cs:capsule id="cap-bound">1</cs:capsule>
  <cs:capsule id="cap-orphan" label="Yield">2</cs:capsule>
</cs:capsules>`,
      documentXml: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:sdt><w:sdtPr><w:dataBinding w:xpath="cs:capsules/cs:capsule[@id='cap-bound']" w:storeItemID="{X}"/></w:sdtPr><w:sdtContent><w:r><w:t>1</w:t></w:r></w:sdtContent></w:sdt></w:p></w:body></w:document>`,
    })

    const imported = await importDocx(buffer)
    expect(imported.unreferencedCapsuleIds).toEqual(['cap-orphan'])
    const lastBlock = imported.blocks[imported.blocks.length - 1]
    expect(lastBlock?.inlines.some((inline) => inline.kind === 'capsule' && inline.capsuleId === 'cap-orphan')).toBe(true)
  })
})
