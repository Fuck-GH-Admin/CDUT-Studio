import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  executeParseDocumentTool,
  buildAttachedDocumentsContext,
  executeReadDocumentArtifact,
  extractAndNamespaceAnchors,
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

/**
 * 手工构造文档索引（无需真实解析引擎，聚焦验证 resolveDocumentAnchor 反查算法本体）。
 * 返回哑源文件绝对路径（仅要求存在，resolveDocumentAnchor 不读取其内容）。
 */
function writeHandmadeIndex(
  dir: string,
  stem: string,
  payload: {
    fileId?: string
    sourceName: string
    format: string
    blocks: Record<string, { pageNumber: number; bbox: [number, number, number, number]; loc: string; cellRef?: string }>
    pages?: Array<Record<string, unknown>>
  },
): string {
  const artifactsDir = join(dir, '.context', 'artifacts')
  mkdirSync(artifactsDir, { recursive: true })
  const sourcePath = join(dir, payload.sourceName)
  writeFileSync(sourcePath, 'dummy', 'utf-8')
  const blocks: Record<string, unknown> = {}
  for (const [blockId, meta] of Object.entries(payload.blocks)) {
    blocks[blockId] = { blockId, scopedId: `${payload.fileId ?? ''}:${blockId}`, ...meta }
  }
  writeFileSync(
    join(artifactsDir, `${stem}.index.json`),
    JSON.stringify({
      ...(payload.fileId ? { fileId: payload.fileId } : {}),
      artifactId: stem,
      sourcePath,
      sourceName: payload.sourceName,
      revision: 'rev-test',
      format: payload.format,
      pageCount: 2,
      totalChars: 64,
      blocks,
      ...(payload.pages ? { pages: payload.pages } : {}),
    }),
    'utf-8',
  )
  return sourcePath
}

describe('双轨定位反查算法（resolveDocumentAnchor 抗劫持与扩展锚点）', () => {
  test('Given 显式块号 p2-b3 有效命中 When label 带业务关键词且同页首块正文恰含该关键词 Then 严格保留 p2-b3 不被模糊扫描劫持', () => {
    const dir = join(root, 'b1-hijack')
    writeHandmadeIndex(dir, 'thesis', {
      fileId: 'f1',
      sourceName: 'thesis.pdf',
      format: 'pdf',
      blocks: {
        'p2-b1': { pageNumber: 2, bbox: [0.1, 0.1, 0.9, 0.2], loc: '第2页·左栏' },
        'p2-b3': { pageNumber: 2, bbox: [0.1, 0.5, 0.9, 0.7], loc: '第2页·右栏' },
      },
      pages: [
        {
          pageNumber: 2,
          columnCount: 2,
          blockCount: 3,
          charCount: 64,
          firstBlockId: 'f1:p2-b1',
          lastBlockId: 'f1:p2-b3',
          isFigureHeavy: false,
          headings: [],
          anchoredText:
            '<!-- anchor: p2-b1 [0.1,0.1,0.9,0.2] loc="第2页·左栏" -->\n实验原理是本实验的理论基础\n<!-- anchor: p2-b3 [0.1,0.5,0.9,0.7] loc="第2页·右栏" -->\n数据分析详见本段',
          cleanText: '实验原理是本实验的理论基础\n数据分析详见本段',
        },
      ],
    })

    const resolved = resolveDocumentAnchor('#f1:p2-b3', { candidateDirs: [dir], label: '第2页·实验原理' })
    expect(resolved?.blockId).toBe('p2-b3')
    expect(resolved?.bbox).toEqual([0.1, 0.5, 0.9, 0.7])
  })

  test('Given label 指明表格而显式块为插图 When 同页存在表格块 Then 互斥版面类型校正到同页表格块', () => {
    const dir = join(root, 'b1-type-fix')
    writeHandmadeIndex(dir, 'report', {
      fileId: 'f1',
      sourceName: 'report.pdf',
      format: 'pdf',
      blocks: {
        'p1-b1': { pageNumber: 1, bbox: [0.1, 0.1, 0.9, 0.3], loc: '第1页·插图' },
        'p1-b2': { pageNumber: 1, bbox: [0.1, 0.4, 0.9, 0.6], loc: '第1页·表格' },
      },
    })

    const resolved = resolveDocumentAnchor('#f1:p1-b1', { candidateDirs: [dir], label: '第1页·性能表格' })
    expect(resolved?.blockId).toBe('p1-b2')
  })

  test('Given PDF 引擎发射的表格块锚点 When 反查 #f1:p1-tbl1 Then 命中 p1-tbl1 而非坍缩为段落块', () => {
    const dir = join(root, 'b3-tbl')
    writeHandmadeIndex(dir, 'paper', {
      fileId: 'f1',
      sourceName: 'paper.pdf',
      format: 'pdf',
      blocks: {
        'p1-b1': { pageNumber: 1, bbox: [0.1, 0.1, 0.9, 0.2], loc: '第1页·通栏' },
        'p1-tbl1': { pageNumber: 1, bbox: [0.2, 0.3, 0.8, 0.5], loc: '第1页·表格' },
      },
    })

    const resolved = resolveDocumentAnchor('#f1:p1-tbl1', { candidateDirs: [dir], label: '第1页·表格' })
    expect(resolved?.blockId).toBe('p1-tbl1')
    expect(resolved?.bbox).toEqual([0.2, 0.3, 0.8, 0.5])
  })

  test('Given 含 tbl 扩展锚点的引擎 Markdown When extractAndNamespaceAnchors Then 表格块入字典且 span/注释均冠以命名空间', () => {
    const md = [
      '<span id="p1-tbl1" data-loc="第1页·表格"></span>',
      '<!-- anchor: p1-tbl1 [0.2,0.3,0.8,0.5] loc="第1页·表格" -->',
      '| 列A | 列B |',
    ].join('\n')

    const { namespacedMarkdown, blocks } = extractAndNamespaceAnchors(md, 'f9')
    expect(blocks['p1-tbl1']?.bbox).toEqual([0.2, 0.3, 0.8, 0.5])
    expect(namespacedMarkdown).toContain('<span id="f9:p1-tbl1"')
    expect(namespacedMarkdown).toContain('<!-- anchor: f9:p1-tbl1 [')
  })

  test('Given 大模型输出的无 c 前缀单元格范围锚点 When 反查 #f3:p1-B4:E10 Then 解析出 cellRef B4:E10', () => {
    const dir = join(root, 'b4-range')
    writeHandmadeIndex(dir, 'grades', {
      fileId: 'f3',
      sourceName: 'grades.xlsx',
      format: 'xlsx',
      blocks: {
        'p1-b1': { pageNumber: 1, bbox: [0, 0, 1, 1], loc: 'Sheet1·A1:F22', cellRef: 'A1:F22' },
      },
    })

    const resolved = resolveDocumentAnchor('#f3:p1-B4:E10', { candidateDirs: [dir], label: '第1页·成绩区间' })
    expect(resolved?.cellRef).toBe('B4:E10')
  })

  test('Given label 携带单单元格引用 B10 When XLSX 行列收敛 Then 保留 B10 不放大为整行', () => {
    const dir = join(root, 'b4-single-cell')
    writeHandmadeIndex(dir, 'dorm', {
      fileId: 'f1',
      sourceName: 'dorm.xlsx',
      format: 'xlsx',
      blocks: {
        'p1-b1': { pageNumber: 1, bbox: [0, 0, 1, 1], loc: 'Sheet1·A1:B22', cellRef: 'A1:B22' },
      },
    })

    const resolved = resolveDocumentAnchor('#f1:p1-b1', { candidateDirs: [dir], label: 'Sheet1·B10 寝室' })
    expect(resolved?.cellRef).toBe('B10')
  })

  test('Given registry.json 已记录确定性映射 When 反查无 fileId 的旧索引 Then 严格遵循 registry 而非遍历顺序', () => {
    const dir = join(root, 'b2-registry')
    const alphaPath = writeHandmadeIndex(dir, 'alpha', {
      sourceName: 'alpha.pdf',
      format: 'pdf',
      blocks: { 'p1-b0': { pageNumber: 1, bbox: [0, 0, 1, 0.5], loc: '第1页·通栏' } },
    })
    const betaPath = writeHandmadeIndex(dir, 'beta', {
      sourceName: 'beta.pdf',
      format: 'pdf',
      blocks: { 'p1-b0': { pageNumber: 1, bbox: [0, 0.5, 1, 1], loc: '第1页·通栏' } },
    })
    // 故意令 registry 分配与字母序相反：alpha → f2、beta → f1，
    // 若实现退回「排序后按下标分配」则 f1 会错误落至 alpha，测试即刻暴露。
    const artifactsDir = join(dir, '.context', 'artifacts')
    writeFileSync(
      join(artifactsDir, 'registry.json'),
      JSON.stringify({
        f2: {
          fileId: 'f2',
          artifactId: 'alpha',
          sourcePath: alphaPath,
          sourceName: 'alpha.pdf',
          indexJsonPath: join(artifactsDir, 'alpha.index.json'),
          updatedAt: 1,
        },
        f1: {
          fileId: 'f1',
          artifactId: 'beta',
          sourcePath: betaPath,
          sourceName: 'beta.pdf',
          indexJsonPath: join(artifactsDir, 'beta.index.json'),
          updatedAt: 2,
        },
      }),
      'utf-8',
    )

    const resolvedF1 = resolveDocumentAnchor('#f1:p1-b0', { candidateDirs: [dir] })
    expect(resolvedF1?.filePath).toBe(betaPath)
    const resolvedF2 = resolveDocumentAnchor('#f2:p1-b0', { candidateDirs: [dir] })
    expect(resolvedF2?.filePath).toBe(alphaPath)
  })
})


