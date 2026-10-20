import { afterAll, describe, expect, test } from 'bun:test'
import JSZip from 'jszip'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OcrPort } from './ocr-port'
import { extractT02PptxImages } from './review-v3-t02-pptx-visual-assets'
import { parseFileIntoSourceDocument } from './document-service'
import { parseT02VisualMaterialWithOcr } from './review-v3-t02-visual-ocr'

const root = mkdtempSync(join(tmpdir(), 'review-t02-real-visual-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64',
)

async function examplePptx(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('ppt/presentation.xml',
    '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<p:sldIdLst><p:sldId id="256" r:id="rId8"/><p:sldId id="257" r:id="rId7"/></p:sldIdLst></p:presentation>')
  zip.file('ppt/_rels/presentation.xml.rels',
    '<Relationships><Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>' +
    '<Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>')
  for (let slide = 1; slide <= 2; slide++) {
    zip.file('ppt/slides/slide' + slide + '.xml',
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:pic>' +
      '<p:blipFill><a:blip r:embed="rId1"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>')
    zip.file('ppt/slides/_rels/slide' + slide + '.xml.rels',
      '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" ' +
      'Target="../media/pic' + slide + '.png"/></Relationships>')
    zip.file('ppt/media/pic' + slide + '.png', PNG)
  }
  return zip.generateAsync({ type: 'nodebuffer' })
}

describe('T02 physically grounded PPTX image coverage', () => {
  test('uses presentation slide order and saves real media for later Vision inspection', async () => {
    const original = join(root, '申请说明.pptx')
    writeFileSync(original, await examplePptx())
    const out = await extractT02PptxImages(original, {
      directory: root, relativeOriginalPath: 'source-docs/申请说明.pptx',
    })
    expect(out.slideCount).toBe(2)
    expect(out.warnings).toEqual([])
    expect(out.images.map(img => img.page)).toEqual([1, 2])
    expect(out.images).toHaveLength(2)
    expect(out.images[0]?.imageAssetPath).toContain('t02-ppt-slide-1')
    for (const img of out.images) {
      expect(img.contentType).toBe('image/png')
      expect(readFileSync(join(root, img.imageAssetPath!.split('/').at(-1)!))).toEqual(PNG)
    }
  })

  test('real image-only deck exposes image source blocks rather than falsely claiming parsed text', async () => {
    const original = join(root, '图像简报.pptx')
    writeFileSync(original, await examplePptx())
    const source = await parseFileIntoSourceDocument(
      original, '图像简报.pptx', 'evidence', 'source-docs/图像简报.pptx', root,
    )
    expect(source.parseStatus).toBe('partial')
    expect(source.blocks.filter(b => b.kind === 'image' && b.imageAssetPath).length).toBeGreaterThanOrEqual(2)
    expect(source.blocks.some(b => b.text === '图片内容已经自动识别')).toBeFalse()
  })
})

describe('T02 actual OCR port reuse, never fabricated verdicts', () => {
  test('an image OCR result becomes page-anchored hypothesis blocks with confidence', async () => {
    const original = join(root, '证明.png')
    writeFileSync(original, PNG)
    const ocr: OcrPort = {
      available: true,
      async recognize(req) {
        expect(req.pageAssetPath).toBe(original)
        return {
          engine: 'test-ocr-port', engineVersion: 'test',
          imageWidth: 100, imageHeight: 80,
          blocks: [{ text: '实验室使用许可', confidence: 0.91,
            rect: { x: 10, y: 10, w: 50, h: 20 } }],
        }
      },
    }
    const result = await parseT02VisualMaterialWithOcr({
      filePath: original, fileName: '证明.png', role: 'evidence', ocr,
      assetRelativePath: 'source-docs/证明.png', assetDirectory: root,
    })
    expect(result.source.parseStatus).toBe('partial')
    expect(result.source.blocks.some(b => b.kind === 'image')).toBeTrue()
    expect(result.ocrBlocks).toBe(1)
    const hypothesis = result.source.blocks.find(b => b.text === '实验室使用许可')
    expect(hypothesis?.page).toBe(1)
    expect(hypothesis?.confidence).toBeCloseTo(0.91)
    expect(hypothesis?.id).toContain('-ocr-001')
    expect(result.source.parseError).toContain('待人工确认')
  })
  test('unavailable OCR leaves the original readable only as an image, not as text', async () => {
    const original = join(root, '未识别.png')
    writeFileSync(original, PNG)
    const ocr: OcrPort = {
      available: false, unavailableReason: '识别引擎未安装',
      async recognize() { throw new Error('should not call') },
    }
    const result = await parseT02VisualMaterialWithOcr({
      filePath: original, fileName: '未识别.png', role: 'evidence', ocr,
    })
    expect(result.ocrBlocks).toBe(0)
    expect(result.imagesAwaitingInspection).toBe(1)
    expect(result.source.blocks.every(b => !b.text)).toBeTrue()
    expect(result.warnings.join('；')).toContain('未安装')
  })
})
