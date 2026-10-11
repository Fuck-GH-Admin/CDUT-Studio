import { describe, expect, test } from 'bun:test'
import { parsePdfDocument } from '../pdf-engine'

/**
 * 现场构造一份合法的单页 PDF 字节流（ASCII，便于按字节计算 xref 偏移）。
 * 不依赖外部样例文件，保证测试可复现。
 */
function buildPdfWithText(text: string): Uint8Array {
  const escaped = text.replace(/[()\\]/g, (match) => `\\${match}`)
  const content = `BT\n/F1 24 Tf\n72 700 Td\n(${escaped}) Tj\nET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]

  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, index) => {
    offsets.push(out.length)
    out += `${index + 1} 0 obj\n${body}\nendobj\n`
  })

  const xrefStart = out.length
  out += `xref\n0 ${objects.length + 1}\n`
  out += '0000000000 65535 f \n'
  for (const offset of offsets) {
    out += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`

  return new TextEncoder().encode(out)
}

describe('PDF Engine 端到端流水线', () => {
  test('输入真实 PDF 字节，输出结构完整的 DocumentLayoutAST', async () => {
    const buffer = buildPdfWithText('Hello PDF Engine')

    const ast = await parsePdfDocument(buffer, { fileName: 'sample.pdf' })

    expect(ast.fileName).toBe('sample.pdf')
    expect(ast.pageCount).toBe(1)
    expect(ast.pages).toHaveLength(1)
    expect(ast.pages[0]?.width).toBeCloseTo(612, 0)
    expect(ast.pages[0]?.height).toBeCloseTo(792, 0)

    expect(ast.readingOrderedBlocks.length).toBeGreaterThan(0)
    expect(ast.readingOrderedBlocks[0]?.pageNumber).toBe(1)
    expect(ast.readingOrderedBlocks[0]?.bbox).toHaveLength(4)
    expect(ast.markdown).toContain('Hello')

    // 指标计时正常
    expect(ast.metrics.totalExtractionMs).toBeGreaterThanOrEqual(0)
    expect(ast.metrics.alignmentMs).toBeGreaterThanOrEqual(0)
    expect(ast.metrics.maxRegretSortMs).toBeGreaterThanOrEqual(0)
    expect(typeof ast.metrics.trapDocFilteredCount).toBe('number')
  })
})
