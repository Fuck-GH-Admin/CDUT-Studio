import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  executeParseDocumentTool,
  buildAttachedDocumentsContext,
  executeReadDocumentArtifact,
  redirectBinaryDocumentRead,
  resolveDocumentAnchor,
} from './document-parse-tools'

/** 现场构造合法单页 PDF（ASCII，便于按字节计算 xref 偏移） */
function buildPdfWithText(text: string): Buffer {
  const content = `BT\n/F1 24 Tf\n72 700 Td\n(${text}) Tj\nET`
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
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefOffset = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'doc-parse-tools-'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('文档内容解析服务（内核双态物化）', () => {
  test('Given 授权目录内的文本文件 When 解析 Then 返回全文与格式标签', async () => {
    const filePath = join(root, 'notes.txt')
    writeFileSync(filePath, '常驻解析引擎 hello', 'utf-8')

    const result = await executeParseDocumentTool({ filePath }, { agentCwd: root, allowedRoots: [] })

    expect(result.format).toBe('txt')
    expect(result.text).toContain('hello')
    expect(result.truncated).toBe(false)
  })

  test('Given 授权目录内的 PDF When 解析 Then 自动在工作区双态落盘无锚点纯净版与带锚点制品', async () => {
    const filePath = join(root, 'sample.pdf')
    writeFileSync(filePath, buildPdfWithText('Engine Check'))

    const result = await executeParseDocumentTool(
      { filePath },
      { agentCwd: root, allowedRoots: [] },
    )

    expect(result.format).toBe('pdf')
    expect(result.pageCount).toBe(1)
    expect(result.text).toContain('Engine')
    expect(result.materialized?.fileId).toBe('f1')
    expect(result.materialized?.cleanMarkdownPath).toBe(join(root, 'sample.md'))
    expect(result.materialized?.anchoredMarkdownPath).toBe(join(root, '.context', 'artifacts', 'sample.anchored.md'))
    expect(existsSync(result.materialized!.cleanMarkdownPath)).toBe(true)
    expect(existsSync(result.materialized!.anchoredMarkdownPath)).toBe(true)

    const cleanContent = readFileSync(result.materialized!.cleanMarkdownPath, 'utf-8')
    expect(cleanContent).not.toContain('<!-- anchor:')
    expect(cleanContent).not.toContain('<span id=')

    const anchoredContent = readFileSync(result.materialized!.anchoredMarkdownPath, 'utf-8')
    expect(anchoredContent).toContain('id="f1:p1-b0"')
  })

  test('Given 未授权的工作区外路径 When 解析 Then 抛错拒绝', async () => {
    const outside = join(tmpdir(), `outside-${Date.now()}.txt`)
    writeFileSync(outside, 'secret', 'utf-8')
    try {
      await expect(
        executeParseDocumentTool({ filePath: outside }, { agentCwd: root, allowedRoots: [] }),
      ).rejects.toThrow()
    } finally {
      rmSync(outside, { force: true })
    }
  })
})

describe('内核前置摄入：零 Token 膨胀引用句柄与锚点切片读取', () => {
  test('Given 会话携带 PDF 附件 When 构建摄入上下文 Then 产出轻量句柄并支持锚点切片与检索', async () => {
    const filePath = join(root, 'attached.pdf')
    writeFileSync(filePath, buildPdfWithText('PreIngest Check'))

    const block = await buildAttachedDocumentsContext({
      filePaths: [filePath],
      context: { agentCwd: root, allowedRoots: [] },
    })

    expect(block).toContain('<attached_documents>')
    expect(block).toContain('file_id="f2"')
    expect(block).toContain('name="attached.pdf"')
    expect(block).toContain('pages="1"')
    expect(block).toContain('clean_markdown_path=')
    expect(block).toContain('证据互信')
    expect(block).toContain('</attached_documents>')

    const slice = await executeReadDocumentArtifact(
      { file: 'f2', pages: '1-1' },
      { agentCwd: root, allowedRoots: [] },
    )
    expect(slice.fileId).toBe('f2')
    expect(slice.totalPages).toBe(1)
    expect(slice.content).toContain('PreIngest')

    const queried = await executeReadDocumentArtifact(
      { file: 'attached.pdf', query: 'PreIngest' },
      { agentCwd: root, allowedRoots: [] },
    )
    expect(queried.content).toContain('PreIngest')
  })

  test('Given 会话工作区存在多份 PDF When 调用 resolveDocumentAnchor Then 支持带 fileId 与不带 fileId 精准反查目标 PDF 与 BBox 坐标', async () => {
    const resolvedF1 = resolveDocumentAnchor('#f1:p1-b0', {
      candidateDirs: [root],
      label: '第1页·左栏',
    })
    expect(resolvedF1).not.toBeNull()
    expect(resolvedF1?.fileId).toBe('f1')
    expect(resolvedF1?.filePath).toBe(join(root, 'sample.pdf'))
    expect(resolvedF1?.pageNumber).toBe(1)
    expect(resolvedF1?.blockId).toBe('p1-b0')
    expect(resolvedF1?.bbox?.length).toBe(4)

    const resolvedF2 = resolveDocumentAnchor('#f2:p1-b0', {
      candidateDirs: [root],
    })
    expect(resolvedF2).not.toBeNull()
    expect(resolvedF2?.fileId).toBe('f2')
    expect(resolvedF2?.filePath).toBe(join(root, 'attached.pdf'))
    expect(resolvedF2?.bbox?.length).toBe(4)

    const resolvedUnscoped = resolveDocumentAnchor('#p1-b0', {
      candidateDirs: [root],
    })
    expect(resolvedUnscoped).not.toBeNull()
    expect(resolvedUnscoped?.pageNumber).toBe(1)
    expect(resolvedUnscoped?.bbox?.length).toBe(4)
  })

  test('Given 附件均为文本类文件 When 构建摄入上下文 Then 不注入任何内容（文本交由模型按需读取）', async () => {
    const mdPath = join(root, 'notes.md')
    writeFileSync(mdPath, '# 笔记', 'utf-8')

    const block = await buildAttachedDocumentsContext({
      filePaths: [mdPath, root],
      context: { agentCwd: root, allowedRoots: [] },
    })

    expect(block).toBe('')
  })

  test('Given 模型对 PDF 误调 Read When 走 redirectBinaryDocumentRead Then 透明重定向至内核解析产物', async () => {
    const pdfPath = join(root, 'attached.pdf')
    const redirected = await redirectBinaryDocumentRead(pdfPath, { agentCwd: root, allowedRoots: [] })
    expect(redirected).toContain('[内核透明重定向]')
    expect(redirected).toContain('PreIngest')
  })
})


