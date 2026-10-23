/**
 * 文档内核预处理与双态落盘服务（Artifact-by-Reference 零中继架构）
 *
 * 核心原则：「意图由 LLM 裁决，数据由内核直流（Zero-Token Data Plane）」
 *
 * 1. 双态直写落盘（Dual-State Disk Materialization）：
 *    - Clean 交付版（`<agentCwd>/<同名>.md`）：剥离一切 HTML 锚点与注释，生成 100% 纯净的出版级
 *      Markdown 直接写入会话工作目录。用户要求“把 PDF 转成 Markdown 放到工作目录”时，0 秒即达，
 *      彻底根除逼迫 LLM 用 Write/Edit 分块充当打字机搬运工的反模式。
 *    - Anchored 索引版（`<agentCwd>/.context/artifacts/<同名>.anchored.md` + `.index.json`）：
 *      保留双平行拓扑锚点（`[第X页·位置](#blockId)`）与逐页结构索引，供 Agent 按页/按关键词秒级检阅。
 *
 * 2. 轻量句柄指针（Artifact Pointer）：
 *    - 向 Prompt 注入的 `<attached_document>` 仅包含落盘路径、页数、字符数、逐页章节大纲（含大幅图表页标注）
 *      及前 600 字摘要预览（单篇仅占 ~300 Tokens），绝不将数万字原文全量灌入上下文。
 *
 * 3. 按需切片检阅与 Read 透明重定向：
 *    - 提供 `executeReadDocumentArtifact`（支持按页码范围 `pages: "1-3"` 或关键词 `query` 检索带锚点原文）。
 *    - 当模型对 `.pdf/.docx` 等直接调用内置 `read` 工具时，自动透明重定向至已落盘产物，绝不吐出二进制乱码。
 */

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { extname, basename, dirname, join, resolve, isAbsolute } from 'node:path'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { isAgentWorkspaceSandbox } from './pi-file-checkpoint'
import {
  OoxmlZipReader,
  inferOfficeFormatFromExtension,
  parseOfficeBuffer,
  serializeOfficePageToMarkdown,
} from '@profer/core/office-engine'
import { resolveAuthorizedFile, type PreviewInspectionContext } from './preview-inspection-service'

/** Office 双态索引 Schema 版本号：当 DOCX 分页或 XLSX 行坐标格式升级时自动触发旧索引静默重建 */
export const OFFICE_INDEX_SCHEMA_VERSION = 'v2'

/** 单次返回给模型的文本上限（字符），超出截断并显式标注，避免上下文爆炸。 */
export const MAX_DOCUMENT_CHARS = 160_000

/** 单次切片读取（文档透明重定向内部使用）返回的最大字符数。 */
export const MAX_ARTIFACT_SLICE_CHARS = 16_000

/** 轻量句柄中内联预览的最大字符数。 */
const ARTIFACT_PREVIEW_CHARS = 600

/**
 * 需要内核前置摄入与二进制重定向的文档扩展名。
 */
export const PREINGEST_DOCUMENT_EXTENSIONS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.docm',
  '.dotx',
  '.dotm',
  '.xls',
  '.xlsx',
  '.xlsm',
  '.xltx',
  '.xltm',
  '.ppt',
  '.pptx',
  '.pptm',
  '.potx',
  '.potm',
  '.ppsx',
  '.ppsm',
  '.rtf',
])

export function isPreingestDocumentPath(filePath: string): boolean {
  return PREINGEST_DOCUMENT_EXTENSIONS.has(extname(filePath).toLowerCase())
}

export interface DocumentAnchorBlockMeta {
  /** 原始块 ID（如 "p1-b11"） */
  blockId: string
  /** 带会话文件命名空间的完整锚点 ID（如 "f1:p1-b11"） */
  scopedId: string
  /** 页码（1-indexed） */
  pageNumber: number
  /** 归一化页面坐标 [x0, y0, x1, y1]（左上角原点，0..1） */
  bbox: [number, number, number, number]
  /** 人类可读位置标签（如 "第1页·左栏"） */
  loc: string
  /** XLSX 专属：所属工作表名称 */
  sheetName?: string
  /** XLSX 专属：目标单元格/区域引用（如 "B4" 或 "A1:F12"） */
  cellRef?: string
}

export interface SessionDocumentRegistryEntry {
  fileId: string
  artifactId: string
  sourcePath: string
  sourceName: string
  indexJsonPath: string
  updatedAt: number
}

export interface ResolvedDocumentAnchor {
  fileId: string
  filePath: string
  fileName: string
  pageNumber: number
  blockId: string
  bbox?: [number, number, number, number]
  label?: string
  /** 目标文档格式（PDF / Word / PPT / Excel），用于聚光灯高亮分发到对应渲染器 */
  format?: 'pdf' | 'docx' | 'pptx' | 'xlsx'
  /** XLSX 专属：所属工作表名称 */
  sheetName?: string
  /** XLSX 专属：目标单元格/区域引用（如 "B4" 或 "A1:F12"） */
  cellRef?: string
}

/** 归一化文档格式标识（兼容扩展名与 index.format 字段）。 */
function normalizeDocumentFormat(value: string | undefined): 'pdf' | 'docx' | 'pptx' | 'xlsx' {
  const v = (value ?? '').toLowerCase().replace(/^\./, '')
  if (v === 'docx' || v === 'docm' || v === 'dotx' || v === 'dotm' || v === 'doc' || v.endsWith('.docx')) return 'docx'
  if (
    v === 'pptx' ||
    v === 'pptm' ||
    v === 'potx' ||
    v === 'potm' ||
    v === 'ppsx' ||
    v === 'ppsm' ||
    v === 'ppt' ||
    v.endsWith('.pptx')
  ) {
    return 'pptx'
  }
  if (
    v === 'xlsx' ||
    v === 'xlsm' ||
    v === 'xltx' ||
    v === 'xltm' ||
    v === 'xls' ||
    v.endsWith('.xlsx')
  ) {
    return 'xlsx'
  }
  return 'pdf'
}

export interface DocumentPageSlice {
  pageNumber: number
  columnCount: number
  blockCount: number
  charCount: number
  firstBlockId?: string
  lastBlockId?: string
  /** 当页面正文块极少（≤3）且存在插图/图注或页面大面积留白时标记为大幅图表页 */
  isFigureHeavy: boolean
  headings: string[]
  anchoredText: string
  cleanText: string
}

export interface MaterializedDocumentIndex {
  /** 会话工作区内的唯一文件 ID（如 "f1", "f2"），用于消除多文档锚点歧义 */
  fileId: string
  artifactId: string
  sourcePath: string
  sourceName: string
  revision: string
  format: string
  pageCount: number
  totalChars: number
  cleanMarkdownPath: string
  anchoredMarkdownPath: string
  outline: Array<{ title: string; level: number; page: number; blockId?: string }>
  pages: DocumentPageSlice[]
  /** 块级拓扑坐标字典：键为裸 blockId（如 "p1-b11"），值为归一化 BBox 与位置元数据 */
  blocks?: Record<string, DocumentAnchorBlockMeta>
}

export interface ParseDocumentResult {
  file: { name: string; size: number; modifiedAt: string; revision: string }
  /** 归一化后的格式标签，如 pdf / docx / xlsx / text */
  format: string
  /** 解析出的全文（PDF 为带双平行锚点的高保真学术 Markdown） */
  text: string
  /** 剥离 HTML 定位锚点后的纯净 Markdown 全文（用于直接落盘交付给用户工作目录） */
  cleanText: string
  truncated: boolean
  /** 以下字段仅 PDF / 分页文档提供 */
  pageCount?: number
  columnCounts?: number[]
  outline?: Array<{ title: string; level: number; page: number; blockId?: string }>
  metrics?: Record<string, number>
  pages?: DocumentPageSlice[]
  materialized?: MaterializedDocumentIndex
}

/** 超长文本截断（保留前 MAX_DOCUMENT_CHARS 字符并标注） */
function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_DOCUMENT_CHARS) return { text, truncated: false }
  return {
    text: `${text.slice(0, MAX_DOCUMENT_CHARS)}\n\n…（内容过长，已截断；完整纯净内容已落盘于 clean_markdown_path，可直接 Read）`,
    truncated: true,
  }
}

/** 块 ID 后缀片段（b/tbl/r/c 形态），供锚点注释提取与命名空间替换共用；页码捕获组由各使用方显式补齐 */
const BLOCK_SUFFIX_SRC = String.raw`(?:b\d+|tbl\d+|r\d+|c[a-zA-Z]+\d+(?::[a-zA-Z]+\d+)?)`

/**
 * 从带拓扑锚点的 Markdown 中提取所有块的 BBox 坐标，并将锚点统一冠以 `fileId:` 命名空间前缀。
 */
export function extractAndNamespaceAnchors(
  markdown: string,
  fileId: string,
): { namespacedMarkdown: string; blocks: Record<string, DocumentAnchorBlockMeta> } {
  const blocks: Record<string, DocumentAnchorBlockMeta> = {}
  // 扩展锚点形态：除 pX-bY 外同时吸收 PDF 引擎发射的表格块 pX-tblY（见 native-segmenter）及 r/c 扩展块，
  // 捕获组：1 = fileId、2 = 完整块 ID、3 = 页码、4 = BBox 坐标串、5 = 属性尾
  const anchorCommentRe = new RegExp(
    String.raw`<!--\s*anchor:\s*(?:([a-zA-Z]+\d+):)?(p(\d+)-${BLOCK_SUFFIX_SRC})\s*\[([^\]]+)\]([^>]*)-->`,
    'g',
  )

  let match: RegExpExecArray | null
  while ((match = anchorCommentRe.exec(markdown)) !== null) {
    const rawBlockId = match[2]!
    const pageNum = parseInt(match[3]!, 10) || 1
    const coords = match[4]!
      .split(',')
      .map((s) => parseFloat(s.trim()))
      .filter((n) => Number.isFinite(n))
    const bbox: [number, number, number, number] =
      coords.length >= 4
        ? [coords[0]!, coords[1]!, coords[2]!, coords[3]!]
        : [0, 0, 1, 1]
    const attrTail = match[5] ?? ''
    const locMatch = /loc="([^"]*)"/.exec(attrTail)
    const sheetMatch = /sheet="([^"]*)"/.exec(attrTail)
    const cellMatch = /cell="([^"]*)"/.exec(attrTail)
    const loc = locMatch?.[1] ?? `第${pageNum}页`
    const sheetName = sheetMatch?.[1] || undefined
    const cellRef = cellMatch?.[1] || undefined

    blocks[rawBlockId] = {
      blockId: rawBlockId,
      scopedId: `${fileId}:${rawBlockId}`,
      pageNumber: pageNum,
      bbox,
      loc,
      ...(sheetName ? { sheetName } : {}),
      ...(cellRef ? { cellRef } : {}),
    }
  }

  const namespacedMarkdown = markdown
    .replace(
      new RegExp(String.raw`<span id="(?:[a-zA-Z]+\d+:)?(p\d+-${BLOCK_SUFFIX_SRC})"([^>]*)></span>`, 'g'),
      `<span id="${fileId}:$1"$2></span>`,
    )
    .replace(
      new RegExp(String.raw`<!--\s*anchor:\s*(?:[a-zA-Z]+\d+:)?(p\d+-${BLOCK_SUFFIX_SRC})\s*\[([^\]]+)\]([^>]*)-->`, 'g'),
      `<!-- anchor: ${fileId}:$1 [$2]$3-->`,
    )

  return { namespacedMarkdown, blocks }
}

/** 将非分页文档（DOCX/XLSX/PPTX 等）按逻辑页（约 3000 字符）切分，以便统一支持按页检阅 */
function buildVirtualPagesFromText(rawText: string): DocumentPageSlice[] {
  const trimmed = rawText.trim()
  if (!trimmed) return []
  const paragraphs = trimmed.split(/\n{2,}/)
  const pages: DocumentPageSlice[] = []
  let currentParts: string[] = []
  let currentLen = 0
  let pageNum = 1

  const flushPage = () => {
    if (currentParts.length === 0) return
    const cleanText = currentParts.join('\n\n')
    const headings = currentParts
      .filter((p) => /^#{1,6}\s+/.test(p.trim()))
      .map((p) => p.trim().replace(/^#{1,6}\s+/, '').slice(0, 80))
    const blockId = `p${pageNum}-b1`
    const anchoredText = `<span id="${blockId}" data-loc="第${pageNum}页"></span>\n<!-- anchor: ${blockId} [0.000,0.000,1.000,1.000] loc="第${pageNum}页" -->\n${cleanText}`
    pages.push({
      pageNumber: pageNum,
      columnCount: 1,
      blockCount: currentParts.length,
      charCount: cleanText.length,
      firstBlockId: blockId,
      lastBlockId: `p${pageNum}-b${currentParts.length}`,
      isFigureHeavy: false,
      headings,
      anchoredText,
      cleanText,
    })
    pageNum++
    currentParts = []
    currentLen = 0
  }

  for (const para of paragraphs) {
    if (currentLen + para.length > 3200 && currentParts.length > 0) {
      flushPage()
    }
    currentParts.push(para)
    currentLen += para.length
  }
  flushPage()
  return pages
}

/**
 * 为当前会话工作区内的文档分配确定性的唯一 `fileId`（如 "f1", "f2"...）。
 */
function allocateSessionFileId(
  artifactsDir: string,
  stem: string,
  resolvedSourcePath: string,
  manifest: Record<string, { fileId?: string; sourcePath: string; revision: string; cleanPath: string }>,
): string {
  const existing = manifest[stem]
  if (existing?.fileId && /^f\d+$/i.test(existing.fileId)) {
    return existing.fileId.toLowerCase()
  }

  // 检查是否已有相同 sourcePath 的记录
  for (const entry of Object.values(manifest)) {
    if (entry.sourcePath === resolvedSourcePath && entry.fileId && /^f\d+$/i.test(entry.fileId)) {
      return entry.fileId.toLowerCase()
    }
  }

  let maxNum = 0
  for (const entry of Object.values(manifest)) {
    const m = /^f(\d+)$/i.exec(entry.fileId ?? '')
    if (m) maxNum = Math.max(maxNum, parseInt(m[1]!, 10))
  }

  const registryPath = join(artifactsDir, 'registry.json')
  if (existsSync(registryPath)) {
    try {
      const reg = JSON.parse(readFileSync(registryPath, 'utf-8')) as Record<string, SessionDocumentRegistryEntry>
      for (const item of Object.values(reg)) {
        if (item.sourcePath === resolvedSourcePath && item.fileId) return item.fileId
        const m = /^f(\d+)$/i.exec(item.fileId ?? '')
        if (m) maxNum = Math.max(maxNum, parseInt(m[1]!, 10))
      }
    } catch {
      // ignore
    }
  }

  return `f${maxNum + 1}`
}

/**
 * 将解析结果双态落盘至会话工作目录：
 * 1. `<agentCwd>/<stem>.md`：纯净无 HTML 锚点污染的交付版 Markdown
 * 2. `<agentCwd>/.context/artifacts/<stem>.anchored.md` 与 `.index.json`：带会话唯一 `fileId` 与双平行拓扑锚点的结构化索引版
 */
export function materializeToWorkspace(
  resolvedSourcePath: string,
  agentCwd: string,
  parsed: Omit<ParseDocumentResult, 'materialized'>,
  preferredFileId?: string,
): MaterializedDocumentIndex | undefined {
  if (!agentCwd || !existsSync(agentCwd) || !isAgentWorkspaceSandbox(agentCwd)) {
    console.warn(`[文档解析] 拒绝写入非沙箱目录: ${agentCwd}`)
    return undefined
  }
  try {
    const ext = extname(resolvedSourcePath)
    const stem = basename(resolvedSourcePath, ext).trim() || 'document'
    const artifactsDir = join(agentCwd, '.context', 'artifacts')
    mkdirSync(artifactsDir, { recursive: true })

    const manifestPath = join(artifactsDir, 'manifest.json')
    let manifest: Record<string, { fileId?: string; sourcePath: string; revision: string; cleanPath: string }> = {}
    if (existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
      } catch {
        manifest = {}
      }
    }

    const fileId =
      preferredFileId && /^f\d+$/i.test(preferredFileId)
        ? preferredFileId.toLowerCase()
        : allocateSessionFileId(artifactsDir, stem, resolvedSourcePath, manifest)

    // 决定 Clean Markdown 的目标路径：优先使用工作目录根下的 `<stem>.md`；
    // 若该文件已存在且并非由内核生成（避免覆盖用户手写笔记），则回退至 `<stem>.parsed.md`
    const primaryCleanPath = join(agentCwd, `${stem}.md`)
    const fallbackCleanPath = join(agentCwd, `${stem}.parsed.md`)
    const existingRecord = manifest[stem]
    let cleanMarkdownPath = primaryCleanPath
    if (
      existsSync(primaryCleanPath) &&
      (!existingRecord || existingRecord.cleanPath !== primaryCleanPath)
    ) {
      cleanMarkdownPath = fallbackCleanPath
    }

    const anchoredMarkdownPath = join(artifactsDir, `${stem}.anchored.md`)
    const indexJsonPath = join(artifactsDir, `${stem}.index.json`)

    // 若版本未变化且双态文件均在磁盘上（且索引已包含 fileId 与 blocks），直接复用
    if (
      existingRecord &&
      existingRecord.revision === parsed.file.revision &&
      (!preferredFileId || existingRecord.fileId === fileId) &&
      existsSync(cleanMarkdownPath) &&
      existsSync(anchoredMarkdownPath) &&
      existsSync(indexJsonPath)
    ) {
      try {
        const cachedIndex = JSON.parse(readFileSync(indexJsonPath, 'utf-8')) as MaterializedDocumentIndex
        if (cachedIndex.fileId && cachedIndex.blocks) {
          return cachedIndex
        }
      } catch {
        // 索引损坏或版本升级则重新落盘
      }
    }

    const { namespacedMarkdown, blocks } = extractAndNamespaceAnchors(parsed.text, fileId)

    writeFileSync(cleanMarkdownPath, parsed.cleanText, 'utf-8')
    writeFileSync(anchoredMarkdownPath, namespacedMarkdown, 'utf-8')

    const rawPages = parsed.pages ?? buildVirtualPagesFromText(parsed.cleanText)
    const pages: DocumentPageSlice[] = rawPages.map((p) => {
      const { namespacedMarkdown: pageAnchored, blocks: pageBlocks } = extractAndNamespaceAnchors(
        p.anchoredText,
        fileId,
      )
      Object.assign(blocks, pageBlocks)
      const prefixId = (id?: string) =>
        id ? (id.startsWith(`${fileId}:`) ? id : `${fileId}:${id.replace(/^[a-zA-Z]+\d+:/, '')}`) : undefined
      return {
        ...p,
        firstBlockId: prefixId(p.firstBlockId),
        lastBlockId: prefixId(p.lastBlockId),
        anchoredText: pageAnchored,
      }
    })

    const indexData: MaterializedDocumentIndex = {
      fileId,
      artifactId: stem,
      sourcePath: resolvedSourcePath,
      sourceName: parsed.file.name,
      revision: parsed.file.revision,
      format: parsed.format,
      pageCount: parsed.pageCount ?? pages.length,
      totalChars: parsed.cleanText.length,
      cleanMarkdownPath,
      anchoredMarkdownPath,
      outline: (parsed.outline ?? []).map((item) => ({
        ...item,
        blockId: item.blockId
          ? item.blockId.startsWith(`${fileId}:`)
            ? item.blockId
            : `${fileId}:${item.blockId}`
          : undefined,
      })),
      pages,
      blocks,
    }

    writeFileSync(indexJsonPath, JSON.stringify(indexData, null, 2), 'utf-8')
    manifest[stem] = {
      fileId,
      sourcePath: resolvedSourcePath,
      revision: parsed.file.revision,
      cleanPath: cleanMarkdownPath,
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')

    // 同步维护会话级文件 ID 注册表 registry.json，实现 O(1) fileId -> 文档定位
    const registryPath = join(artifactsDir, 'registry.json')
    let registry: Record<string, SessionDocumentRegistryEntry> = {}
    if (existsSync(registryPath)) {
      try {
        registry = JSON.parse(readFileSync(registryPath, 'utf-8'))
      } catch {
        registry = {}
      }
    }
    registry[fileId] = {
      fileId,
      artifactId: stem,
      sourcePath: resolvedSourcePath,
      sourceName: parsed.file.name,
      indexJsonPath,
      updatedAt: Date.now(),
    }
    writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf-8')

    return indexData
  } catch (error) {
    console.warn(`[内核摄入] 双态落盘写入失败 (${basename(resolvedSourcePath)}):`, error)
    return undefined
  }
}

/**
 * 执行文档内容解析（含双态落盘）。
 *
 * @throws 路径未授权、文件不存在、格式不支持或解析失败时抛错
 */
export async function executeParseDocumentTool(
  input: { filePath: string },
  context: PreviewInspectionContext,
): Promise<ParseDocumentResult> {
  const requested = typeof input.filePath === 'string' ? input.filePath.trim() : ''
  if (!requested) throw new Error('filePath 必须是非空字符串')

  const resolved = await resolveAuthorizedFile(requested, context)
  if (typeof resolved !== 'string') throw new Error(resolved.error.message)

  const buffer = await readFile(resolved)
  const metadata = await stat(resolved)
  const revision = `sha256:${OFFICE_INDEX_SCHEMA_VERSION}:${createHash('sha256').update(buffer).digest('hex')}`
  const file = {
    name: basename(resolved),
    size: metadata.size,
    modifiedAt: metadata.mtime.toISOString(),
    revision,
  }

  const ext = extname(resolved).toLowerCase()

  // PDF：唯一路径 = 高精解析引擎
  if (ext === '.pdf') {
    const {
      parsePdfDocument,
      serializeLayoutToMarkdown,
      stripDocumentTopologyAnchors,
    } = await import('@profer/core/pdf-engine')
    const ast = await parsePdfDocument(new Uint8Array(buffer), { fileName: basename(resolved) })
    const { text, truncated } = truncate(ast.markdown)
    const cleanFull = stripDocumentTopologyAnchors(ast.markdown)
    const { text: cleanText } = truncate(cleanFull)

    // 按页汇总切片索引，供按页读取与大纲诊断使用
    const pages: DocumentPageSlice[] = ast.pages.map((page) => {
      const orderedOnPage = ast.readingOrderedBlocks.filter(
        (b) => b.pageNumber === page.pageNumber && b.readingStreamId >= 0 && b.kind !== 'header' && b.kind !== 'footer',
      )
      const anchoredPageText = serializeLayoutToMarkdown(orderedOnPage, { includeAnchors: true })
      const cleanPageText = serializeLayoutToMarkdown(orderedOnPage, { includeAnchors: false })
      const headings = orderedOnPage
        .filter((b) => b.kind === 'title' || b.kind === 'section-heading')
        .map((b) => b.text.trim())
        .filter(Boolean)
      const hasFigureCaption = orderedOnPage.some(
        (b) => b.kind === 'figure' || /^(?:fig(?:ure)?\.?|图|表|scheme|table)\s*\d+/i.test(b.text.trim()),
      )
      const isFigureHeavy = orderedOnPage.length <= 4 && (hasFigureCaption || cleanPageText.length < 1800)

      return {
        pageNumber: page.pageNumber,
        columnCount: page.columnCount,
        blockCount: orderedOnPage.length,
        charCount: cleanPageText.length,
        firstBlockId: orderedOnPage[0]?.id,
        lastBlockId: orderedOnPage[orderedOnPage.length - 1]?.id,
        isFigureHeavy,
        headings,
        anchoredText: anchoredPageText,
        cleanText: cleanPageText,
      }
    })

    const baseResult: ParseDocumentResult = {
      file,
      format: 'pdf',
      text,
      cleanText,
      truncated,
      pageCount: ast.pageCount,
      columnCounts: ast.pages.map((page) => page.columnCount),
      outline: ast.outline,
      metrics: ast.metrics,
      pages,
    }

    if (PREINGEST_DOCUMENT_EXTENSIONS.has('.pdf') && context.agentCwd) {
      baseResult.materialized = materializeToWorkspace(resolved, context.agentCwd, baseResult)
    }

    return baseResult
  }

  // OOXML Office 文档（DOCX / PPTX / XLSX 及其宏/模板变体）：走 @profer/core/office-engine 双平面重排引擎
  const officeFormatHint = inferOfficeFormatFromExtension(ext)
  if (officeFormatHint && OoxmlZipReader.isZipBuffer(buffer)) {
    const officeResult = parseOfficeBuffer(buffer, officeFormatHint, {
      fileName: basename(resolved),
      includeAnchors: true,
    })
    const { text, truncated } = truncate(officeResult.markdown)
    const { text: cleanText } = truncate(officeResult.cleanMarkdown)

    const outline: Array<{ title: string; level: number; page: number; blockId?: string }> = []
    const pages: DocumentPageSlice[] = officeResult.ast.pages.map((page) => {
      const anchoredPageText = serializeOfficePageToMarkdown(page, { includeAnchors: true })
      const cleanPageText = serializeOfficePageToMarkdown(page, { includeAnchors: false })
      const headings: string[] = []

      for (const b of page.blocks) {
        if (b.type === 'heading' && b.text.trim()) {
          const title = b.text.trim().slice(0, 100)
          headings.push(title)
          outline.push({
            title,
            level: b.headingLevel ?? 1,
            page: page.pageNumber,
            blockId: b.id,
          })
        }
      }
      if (headings.length === 0 && (page.sheetName || page.title)) {
        const fallbackTitle = (page.sheetName || page.title || '').trim()
        if (fallbackTitle) {
          headings.push(fallbackTitle)
          outline.push({
            title: fallbackTitle,
            level: 1,
            page: page.pageNumber,
            blockId: page.blocks[0]?.id,
          })
        }
      }

      const hasFigure = page.blocks.some((b) => b.type === 'figure')
      const isFigureHeavy = page.blocks.length <= 3 && hasFigure

      return {
        pageNumber: page.pageNumber,
        columnCount: 1,
        blockCount: page.blocks.length,
        charCount: cleanPageText.length,
        firstBlockId: page.blocks[0]?.id,
        lastBlockId: page.blocks[page.blocks.length - 1]?.id,
        isFigureHeavy,
        headings,
        anchoredText: anchoredPageText,
        cleanText: cleanPageText,
      }
    })

    const baseResult: ParseDocumentResult = {
      file,
      format: officeResult.format,
      text,
      cleanText,
      truncated,
      pageCount: officeResult.ast.pageCount,
      columnCounts: officeResult.ast.pages.map(() => 1),
      outline,
      pages,
    }

    if (context.agentCwd) {
      baseResult.materialized = materializeToWorkspace(resolved, context.agentCwd, baseResult)
    }

    return baseResult
  }

  // 其余文档格式：基座解析器（旧版 .doc / RTF / 文本等）
  const { extractTextFromFile } = await import('./document-parser')
  const raw = await extractTextFromFile(resolved)
  const { text, truncated } = truncate(raw)
  const format = ext.replace('.', '') || 'text'
  const isPreingestDoc = PREINGEST_DOCUMENT_EXTENSIONS.has(ext)
  const pages = isPreingestDoc ? buildVirtualPagesFromText(text) : undefined

  const baseResult: ParseDocumentResult = {
    file,
    format,
    text,
    cleanText: text,
    truncated,
    pageCount: pages?.length,
    pages,
  }

  if (isPreingestDoc && context.agentCwd) {
    baseResult.materialized = materializeToWorkspace(resolved, context.agentCwd, baseResult)
  }

  return baseResult
}

/** 解析结果缓存：键为「realpath + mtime + size」，避免每轮重复解析同一份大文档。 */
const attachedDocumentCache = new Map<string, ParseDocumentResult>()
const ATTACHED_DOCUMENT_CACHE_LIMIT = 32

/** 解析单个附件文档（带磁盘指纹缓存；失败仅告警并返回 null，绝不阻断本轮对话）。 */
export async function parseAttachedDocument(
  filePath: string,
  context: PreviewInspectionContext,
): Promise<ParseDocumentResult | null> {
  try {
    const resolved = await resolveAuthorizedFile(filePath, context)
    if (typeof resolved !== 'string') return null
    const metadata = await stat(resolved)
    const cacheKey = `${resolved}:${metadata.mtimeMs}:${metadata.size}`
    const cached = attachedDocumentCache.get(cacheKey)
    if (cached) {
      // 确保当前会话 cwd 下也已完成双态落盘并获得独立会话的 fileId
      if (context.agentCwd) {
        const expectedPrefix = resolve(context.agentCwd)
        const currentClean = cached.materialized?.cleanMarkdownPath
          ? resolve(cached.materialized.cleanMarkdownPath)
          : ''
        if (!currentClean.startsWith(expectedPrefix) || !existsSync(currentClean)) {
          const sessionMaterialized = materializeToWorkspace(resolved, context.agentCwd, cached)
          return { ...cached, materialized: sessionMaterialized }
        }
      }
      return cached
    }
    const result = await executeParseDocumentTool({ filePath: resolved }, context)
    if (attachedDocumentCache.size >= ATTACHED_DOCUMENT_CACHE_LIMIT) attachedDocumentCache.clear()
    attachedDocumentCache.set(cacheKey, result)
    return result
  } catch (error) {
    console.warn(`[内核摄入] 附件前置解析失败，已跳过 (${basename(filePath)}):`, error)
    return null
  }
}

/**
 * 为已落盘文档构造轻量级 `<attached_document>` 结构化句柄（~250-400 Tokens）。
 * 绝不将数万字正文直接塞入 Prompt，彻底根除 LLM 搬运工陷阱与上下文爆炸。
 */
export function formatDocumentArtifactHandle(result: ParseDocumentResult): string {
  const name = result.file.name.replace(/"/g, "'")
  const pageCount = result.pageCount ?? result.pages?.length ?? 1
  const fileId = result.materialized?.fileId ?? 'f1'
  const cleanPath = result.materialized?.cleanMarkdownPath ?? ''
  const anchoredPath = result.materialized?.anchoredMarkdownPath ?? ''
  const artifactId = result.materialized?.artifactId ?? basename(name, extname(name))

  const attrs = [
    `file_id="${fileId}"`,
    `name="${name}"`,
    `artifact_id="${artifactId}"`,
    `format="${result.format}"`,
    `pages="${pageCount}"`,
    `chars="${result.cleanText.length}"`,
    cleanPath ? `clean_markdown_path="${cleanPath}"` : '',
    anchoredPath ? `anchored_index_path="${anchoredPath}"` : '',
    `status="parsed_and_saved_to_workspace"`,
  ]
    .filter(Boolean)
    .join(' ')

  // 构建紧凑的逐页/章节导航大纲（优先采用 materialized.pages 以展示带 fileId 前缀的锚点）
  const pagesToRender = result.materialized?.pages ?? result.pages
  const pageLines: string[] = []
  if (pagesToRender && pagesToRender.length > 0) {
    for (const p of pagesToRender) {
      const range =
        p.firstBlockId && p.lastBlockId
          ? p.firstBlockId === p.lastBlockId
            ? p.firstBlockId
            : `${p.firstBlockId}..${p.lastBlockId}`
          : ''
      const headingSummary = p.headings.length > 0 ? ` | 章节: ${p.headings.join(' / ')}` : ''
      const figNote = p.isFigureHeavy ? ' [大幅图表页，其余版面为图像/图解，文本已100%提取]' : ''
      pageLines.push(
        `  - 第${p.pageNumber}页 (${p.blockCount}块, ${p.charCount}字${range ? `, 锚点:${range}` : ''})${headingSummary}${figNote}`,
      )
    }
  } else if (result.outline && result.outline.length > 0) {
    for (const item of result.outline) {
      pageLines.push(`  - [第${item.page}页] ${'#'.repeat(item.level)} ${item.title}`)
    }
  }

  const previewSnippet = result.cleanText.slice(0, ARTIFACT_PREVIEW_CHARS).trim()
  const previewHasMore = result.cleanText.length > ARTIFACT_PREVIEW_CHARS

  return [
    `<attached_document ${attrs}>`,
    cleanPath
      ? `[内核直写已完成] 纯净无锚点污染的完整 Markdown 已由客户端内核直接写入工作目录：${cleanPath}（文件标识 file_id="${fileId}"，共 ${result.cleanText.length} 字符）。`
      : `[内核解析已完成] 共 ${result.cleanText.length} 字符。`,
    pageLines.length > 0 ? `<page_index>\n${pageLines.join('\n')}\n</page_index>` : '',
    `<preview>\n${previewSnippet}${previewHasMore ? '\n...(后文已省略，完整纯净 Markdown 已落盘于 clean_markdown_path，可直接 Read)' : ''}\n</preview>`,
    `</attached_document>`,
  ]
    .filter(Boolean)
    .join('\n')
}

export interface AttachedDocumentsContextOptions {
  /** 候选附件绝对路径（会话级附加文件 + 附加目录中的文档文件），允许重复与目录混入 */
  filePaths: readonly string[]
  /** 可选用户消息（从中自动提取 <attached_files> 标记的附件文件） */
  userMessage?: string
  /** 授权上下文（agentCwd + allowedRoots） */
  context: PreviewInspectionContext
  /** 注入到消息上下文的总字符上限，默认 MAX_DOCUMENT_CHARS */
  maxTotalChars?: number
}

/**
 * 把随会话携带的本地文档前置解析并双态落盘，向消息上下文仅注入轻量 `<attached_documents>` 句柄指针。
 *
 * 返回空字符串表示没有可前置摄入的文档（此时不注入任何内容）。
 */
export async function buildAttachedDocumentsContext(
  options: AttachedDocumentsContextOptions,
): Promise<string> {
  const seen = new Set<string>()
  const parts: string[] = []

  const candidatePaths: string[] = [...(options.filePaths ?? [])]

  if (options.userMessage) {
    const attachedMatch = /<attached_files>([\s\S]*?)<\/attached_files>/.exec(options.userMessage)
    if (attachedMatch && attachedMatch[1]) {
      for (const line of attachedMatch[1].split('\n')) {
        const fileMatch = /^-\s*.*:\s*(.+)$/.exec(line.trim())
        if (fileMatch && fileMatch[1]) candidatePaths.push(fileMatch[1].trim())
      }
    }
  }

  for (const filePath of candidatePaths) {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) continue
    const extension = extname(filePath).toLowerCase()
    if (!PREINGEST_DOCUMENT_EXTENSIONS.has(extension)) continue
    if (seen.has(filePath)) continue
    seen.add(filePath)

    const result = await parseAttachedDocument(filePath, options.context)
    if (!result || result.text.trim().length === 0) continue

    parts.push(formatDocumentArtifactHandle(result))
  }

  if (parts.length === 0) return ''

  return [
    '<attached_documents>',
    '<!-- 【客户端内核双态落盘与句柄协议 (Artifact-by-Reference)】 -->',
    '<!-- 1. 零中继落盘已完成：客户端内核高精解析引擎已将附件文档 100% 完整解析，并直接将纯净版 Markdown 写入 clean_markdown_path！ -->',
    '<!-- 2. 严禁打字机式重写：若用户要求“将 PDF 解析/转换为 Markdown 放到工作目录”，文件已经在 clean_markdown_path 落盘完毕！请直接向用户汇报该文件路径与解析摘要，严禁调用 Write/Edit 把全文再手敲一遍！（若用户指定了特殊文件名，仅需 mv/cp 重命名该文件）。 -->',
    '<!-- 3. 证据互信：系统会在提问时自动检索并注入 <document_evidence> 相关切片（含真实锚点），请直接信任并据此作答；若需查阅完整原文，直接 Read 上方 clean_markdown_path 即可，无需任何解析工具。 -->',
    '',
    ...parts,
    '</attached_documents>',
  ].join('\n')
}

/** 解析页码范围字符串（如 "1-3", "5", "2,4,6-8"）为升序页码集合 */
export function parsePageRangeSpec(spec: string | undefined, maxPage: number): number[] {
  if (!spec || !spec.trim()) {
    const end = Math.min(maxPage, 3)
    return Array.from({ length: end }, (_, i) => i + 1)
  }
  const normalized = spec.trim().toLowerCase()
  if (normalized === 'all' || normalized === '*') {
    return Array.from({ length: maxPage }, (_, i) => i + 1)
  }
  const pages = new Set<number>()
  for (const part of normalized.split(/[,;，；\s]+/)) {
    if (!part) continue
    const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(part)
    if (rangeMatch) {
      const start = Math.max(1, parseInt(rangeMatch[1]!, 10))
      const end = Math.min(maxPage, parseInt(rangeMatch[2]!, 10))
      for (let p = start; p <= end; p++) pages.add(p)
    } else {
      const num = parseInt(part, 10)
      if (Number.isFinite(num) && num >= 1 && num <= maxPage) pages.add(num)
    }
  }
  const sorted = Array.from(pages).sort((a, b) => a - b)
  return sorted.length > 0 ? sorted : [1]
}

export interface ReadDocumentArtifactInput {
  /** 文档文件名、file_id（如 "f1"）、artifact_id 或路径（省略时自动选取当前工作区已落盘的唯一或最新文档） */
  file?: string
  /** 页码范围，如 "1-3"、"5"、"2,4,6-8"（未提供 query 时默认读取 "1-3"） */
  pages?: string
  /** 可选关键词或正则：在全文档所有页中检索匹配段落并返回带双轨锚点的上下文 */
  query?: string
  /** 是否保留双平行拓扑锚点（默认 true，便于回答时按 [第X页·位置](#f1:pX-bY) 引用） */
  includeAnchors?: boolean
}

/**
 * 从当前工作区 `.context/artifacts/` 查找或即时构建指定文档的结构化索引。
 */
async function resolveMaterializedIndex(
  fileQuery: string | undefined,
  context: PreviewInspectionContext,
): Promise<MaterializedDocumentIndex> {
  const artifactsDir = context.agentCwd ? join(context.agentCwd, '.context', 'artifacts') : ''

  // 1. 优先从已落盘的 .index.json 匹配
  if (artifactsDir && existsSync(artifactsDir)) {
    const indexFiles = readdirSync(artifactsDir).filter((f) => f.endsWith('.index.json'))
    if (indexFiles.length > 0) {
      const indices: MaterializedDocumentIndex[] = []
      for (const f of indexFiles) {
        try {
          indices.push(JSON.parse(readFileSync(join(artifactsDir, f), 'utf-8')) as MaterializedDocumentIndex)
        } catch {
          // ignore
        }
      }
      if (!fileQuery || !fileQuery.trim()) {
        if (indices.length > 0) return indices[indices.length - 1]!
      } else {
        const q = fileQuery.trim().toLowerCase()
        const qBase = basename(q).toLowerCase()
        const qStem = basename(q, extname(q)).toLowerCase()
        const matched = indices.find(
          (idx) =>
            (idx.fileId && idx.fileId.toLowerCase() === q) ||
            idx.artifactId.toLowerCase() === q ||
            idx.artifactId.toLowerCase() === qStem ||
            idx.sourceName.toLowerCase() === qBase ||
            idx.sourcePath.toLowerCase() === q ||
            idx.cleanMarkdownPath.toLowerCase() === q ||
            idx.sourceName.toLowerCase().includes(qStem),
        )
        if (matched) return matched
      }
    }
  }

  // 2. 若未命中已落盘索引，尝试在授权目录中定位源文档并即时解析落盘
  let targetPath = fileQuery?.trim()
  if (!targetPath && context.agentCwd && existsSync(context.agentCwd)) {
    const docInCwd = readdirSync(context.agentCwd).find((f) =>
      PREINGEST_DOCUMENT_EXTENSIONS.has(extname(f).toLowerCase()),
    )
    if (docInCwd) targetPath = join(context.agentCwd, docInCwd)
  }

  if (!targetPath) {
    throw new Error('当前工作区没有已预解析的文档产物，请提供明确的 file 路径参数。')
  }

  const parsed = await executeParseDocumentTool({ filePath: targetPath }, context)
  if (parsed.materialized) return parsed.materialized

  const pages = parsed.pages ?? buildVirtualPagesFromText(parsed.cleanText)
  const { blocks } = extractAndNamespaceAnchors(parsed.text, 'f1')
  return {
    fileId: 'f1',
    artifactId: basename(parsed.file.name, extname(parsed.file.name)),
    sourcePath: targetPath,
    sourceName: parsed.file.name,
    revision: parsed.file.revision,
    format: parsed.format,
    pageCount: parsed.pageCount ?? pages.length,
    totalChars: parsed.cleanText.length,
    cleanMarkdownPath: '',
    anchoredMarkdownPath: '',
    outline: parsed.outline ?? [],
    pages,
    blocks,
  }
}

/**
 * 执行按页/按关键词的文档切片读取（供二进制文档透明重定向内部调用）。
 */
export async function executeReadDocumentArtifact(
  input: ReadDocumentArtifactInput,
  context: PreviewInspectionContext,
): Promise<{
  fileId: string
  artifactId: string
  sourceName: string
  cleanMarkdownPath: string
  totalPages: number
  mode: 'pages' | 'query'
  returnedPages: number[]
  hasMorePages: boolean
  nextSuggestedPages?: string
  content: string
}> {
  const index = await resolveMaterializedIndex(input.file, context)
  const includeAnchors = input.includeAnchors !== false
  const totalPages = index.pageCount || index.pages.length
  const fileId = index.fileId || 'f1'

  // 模式 A：关键词/正则检索
  if (input.query && input.query.trim()) {
    const rawQuery = input.query.trim()
    let regex: RegExp
    try {
      regex = new RegExp(rawQuery, 'i')
    } catch {
      regex = new RegExp(rawQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    }

    const matchedSections: string[] = []
    const matchedPages: number[] = []
    let usedChars = 0

    for (const page of index.pages) {
      const sourceText = includeAnchors ? page.anchoredText : page.cleanText
      if (!regex.test(page.cleanText) && !regex.test(sourceText)) continue
      matchedPages.push(page.pageNumber)

      // 按双换行切块筛选命中块及其前后紧邻块
      const blocks = sourceText.split(/\n\n+/)
      const hitIndices = new Set<number>()
      blocks.forEach((b, idx) => {
        if (regex.test(b)) {
          if (idx > 0) hitIndices.add(idx - 1)
          hitIndices.add(idx)
          if (idx + 1 < blocks.length) hitIndices.add(idx + 1)
        }
      })

      const pageHits = Array.from(hitIndices)
        .sort((a, b) => a - b)
        .map((idx) => blocks[idx])
        .join('\n\n')

      const sectionText = `=== 第 ${page.pageNumber} / ${totalPages} 页（匹配片段 · file_id=${fileId}） ===\n${pageHits}`
      if (usedChars + sectionText.length > MAX_ARTIFACT_SLICE_CHARS && matchedSections.length > 0) {
        matchedSections.push(`\n…（更多匹配已省略，请缩小 query 范围或指定具体 pages 查看）`)
        break
      }
      matchedSections.push(sectionText)
      usedChars += sectionText.length
    }

    return {
      fileId,
      artifactId: index.artifactId,
      sourceName: index.sourceName,
      cleanMarkdownPath: index.cleanMarkdownPath,
      totalPages,
      mode: 'query',
      returnedPages: matchedPages,
      hasMorePages: false,
      content:
        matchedSections.length > 0
          ? matchedSections.join('\n\n')
          : `未在文档《${index.sourceName}》（共 ${totalPages} 页）中检索到与 "${rawQuery}" 匹配的内容。`,
    }
  }

  // 模式 B：按页码范围切片读取
  const requestedPages = parsePageRangeSpec(input.pages, totalPages)
  const sections: string[] = []
  const returnedPages: number[] = []
  let usedChars = 0
  let truncatedByBudget = false

  for (const pageNum of requestedPages) {
    const page = index.pages.find((p) => p.pageNumber === pageNum)
    if (!page) continue
    const body = includeAnchors ? page.anchoredText : page.cleanText
    const figHint = page.isFigureHeavy
      ? ' [提示：本页大部分版面为图像/图表，以下为本页全部可见文本与图注]'
      : ''
    const header = `=== 第 ${page.pageNumber} / ${totalPages} 页（${page.blockCount} 块, ${page.charCount} 字 · file_id=${fileId}）${figHint} ===`
    const fullPageSection = `${header}\n${body || '（本页为纯图像页，无文本流）'}`

    if (usedChars + fullPageSection.length > MAX_ARTIFACT_SLICE_CHARS && sections.length > 0) {
      truncatedByBudget = true
      break
    }
    sections.push(fullPageSection)
    returnedPages.push(pageNum)
    usedChars += fullPageSection.length
  }

  const lastReturned = returnedPages[returnedPages.length - 1] ?? 1
  const hasMorePages = lastReturned < totalPages || truncatedByBudget
  const nextStart = lastReturned + 1
  const nextEnd = Math.min(totalPages, nextStart + 2)
  const nextSuggestedPages =
    nextStart <= totalPages ? (nextStart === nextEnd ? `${nextStart}` : `${nextStart}-${nextEnd}`) : undefined

  if (hasMorePages && nextSuggestedPages) {
    sections.push(
      `\n[分页提示：当前已返回第 ${returnedPages.join(',')} 页（共 ${totalPages} 页）。完整纯净 Markdown 已落盘${index.cleanMarkdownPath ? `于 ${index.cleanMarkdownPath}` : ''}，可直接 Read 获取第 ${nextSuggestedPages} 页等后续内容。]`,
    )
  }

  return {
    fileId,
    artifactId: index.artifactId,
    sourceName: index.sourceName,
    cleanMarkdownPath: index.cleanMarkdownPath,
    totalPages,
    mode: 'pages',
    returnedPages,
    hasMorePages,
    nextSuggestedPages,
    content: sections.join('\n\n'),
  }
}

/**
 * 自动升级旧版 Office `.index.json`（如 v1 时期未处理 `<w:pageBreakBefore w:val="0"/>` 导致页码膨胀，
 * 或 XLSX 尚未生成行坐标列的缓存索引）。由于 `parseOfficeBuffer` 为纯同步内存计算（<5ms），
 * 可在点击溯源胶囊或 RAG 读取索引时无感完成原地升级。
 */
export function upgradeStaleOfficeIndexIfNeeded(
  idx: MaterializedDocumentIndex,
  fullIndexPath: string,
): MaterializedDocumentIndex {
  const expectedPrefix = `sha256:${OFFICE_INDEX_SCHEMA_VERSION}:`
  if (idx.revision?.startsWith(expectedPrefix)) return idx
  if (!idx.sourcePath || !existsSync(idx.sourcePath)) return idx

  const ext = extname(idx.sourcePath).toLowerCase()
  const officeFormatHint = inferOfficeFormatFromExtension(ext)
  if (!officeFormatHint) return idx

  try {
    const buffer = readFileSync(idx.sourcePath)
    if (!OoxmlZipReader.isZipBuffer(buffer)) return idx

    const metadata = statSync(idx.sourcePath)
    const revision = `${expectedPrefix}${createHash('sha256').update(buffer).digest('hex')}`
    const officeResult = parseOfficeBuffer(buffer, officeFormatHint, {
      fileName: basename(idx.sourcePath),
      includeAnchors: true,
    })
    const { text, truncated } = truncate(officeResult.markdown)
    const { text: cleanText } = truncate(officeResult.cleanMarkdown)

    const outline: Array<{ title: string; level: number; page: number; blockId?: string }> = []
    const pages: DocumentPageSlice[] = officeResult.ast.pages.map((page) => {
      const anchoredPageText = serializeOfficePageToMarkdown(page, { includeAnchors: true })
      const cleanPageText = serializeOfficePageToMarkdown(page, { includeAnchors: false })
      const headings: string[] = []
      for (const b of page.blocks) {
        if (b.type === 'heading' && b.text.trim()) {
          const title = b.text.trim().slice(0, 100)
          headings.push(title)
          outline.push({ title, level: b.headingLevel ?? 1, page: page.pageNumber, blockId: b.id })
        }
      }
      if (headings.length === 0 && (page.sheetName || page.title)) {
        const fallbackTitle = (page.sheetName || page.title || '').trim()
        if (fallbackTitle) {
          headings.push(fallbackTitle)
          outline.push({ title: fallbackTitle, level: 1, page: page.pageNumber, blockId: page.blocks[0]?.id })
        }
      }
      const hasFigure = page.blocks.some((b) => b.type === 'figure')
      return {
        pageNumber: page.pageNumber,
        columnCount: 1,
        blockCount: page.blocks.length,
        charCount: cleanPageText.length,
        firstBlockId: page.blocks[0]?.id,
        lastBlockId: page.blocks[page.blocks.length - 1]?.id,
        isFigureHeavy: page.blocks.length <= 3 && hasFigure,
        headings,
        anchoredText: anchoredPageText,
        cleanText: cleanPageText,
      }
    })

    const agentCwd = dirname(dirname(dirname(fullIndexPath)))
    const upgraded = materializeToWorkspace(
      idx.sourcePath,
      agentCwd,
      {
        file: {
          name: basename(idx.sourcePath),
          size: metadata.size,
          modifiedAt: metadata.mtime.toISOString(),
          revision,
        },
        format: officeResult.format,
        text,
        cleanText,
        truncated,
        pageCount: officeResult.ast.pageCount,
        columnCounts: officeResult.ast.pages.map(() => 1),
        outline,
        pages,
      },
      idx.fileId,
    )
    return upgraded ?? idx
  } catch {
    return idx
  }
}

/**
 * 从标签文本中提取用于匹配具体段落/表格行的有效关键词（剔除通用页码/表名装饰词）。
 */
function extractLabelKeywords(label: string | undefined, sheetName?: string): string[] {
  if (!label) return []
  let cleaned = label
    .replace(/第\s*\d+\s*[页张行]/g, ' ')
    .replace(/幻灯片\s*\d+/g, ' ')
    .replace(/[A-Za-z]{1,2}\d{1,4}(?::[A-Za-z]{1,2}\d{1,4})?/g, ' ')
    .replace(/[·•|()（）\[\]【】：:，,、]/g, ' ')
  if (sheetName) {
    cleaned = cleaned.split(sheetName).join(' ')
  }
  return cleaned
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && s !== '正文' && s !== '表格' && s !== '插图' && s !== '公式')
}

/** label 版面类型提示表：label 强烈指明某版面类型时用于互斥校正（见 correctMutuallyExclusiveBlockType） */
const LABEL_TYPE_HINTS: ReadonlyArray<{ re: RegExp; kind: string }> = [
  { re: /表格|表\s*\d+|Sheet|工作表/, kind: '表格' },
  { re: /插图|图\s*\d+|Figure/i, kind: '插图' },
  { re: /公式|Equation/i, kind: '公式' },
]

/**
 * 窄口径互斥版面类型校正：仅当 label 强烈指明类型 T（表格/插图/公式）、
 * 当前块的 loc 为完全互斥类型（如「第2页·插图」vs label 写明「表格」）、
 * 且同页存在 T 类型块时，才校正到该同页类型块；其余情况严格保留显式物理块。
 */
function correctMutuallyExclusiveBlockType(
  blockMeta: DocumentAnchorBlockMeta,
  label: string | undefined,
  pageBlocks: readonly DocumentAnchorBlockMeta[],
): DocumentAnchorBlockMeta {
  if (!label) return blockMeta
  const currentKind = /·(插图|表格|公式)$/.exec(blockMeta.loc)?.[1]
  if (!currentKind) return blockMeta
  const hinted = LABEL_TYPE_HINTS.find((h) => h.re.test(label))
  if (!hinted || hinted.kind === currentKind) return blockMeta
  const samePageTyped = pageBlocks.find(
    (b) => b.blockId !== blockMeta.blockId && b.loc.endsWith(`·${hinted.kind}`),
  )
  return samePageTyped ?? blockMeta
}

/**
 * 解析形如 `#f1:p1-b11`、`#f1-p1-b11`、`#f3:p3-cB10`、`#f3:p3-r10` 或 `#p1-b11` 的双平行拓扑定位锚点，
 * 反查目标 PDF/Office 文档的绝对路径、页码、单元格以及块级归一化 BBox 坐标 `[x0, y0, x1, y1]`。
 */
export function resolveDocumentAnchor(
  anchorInput: string,
  options: {
    candidateDirs: readonly string[]
    fallbackFiles?: readonly string[]
    label?: string
  },
): ResolvedDocumentAnchor | null {
  const cleaned = anchorInput.trim().replace(/^#/, '')
  // 捕获组：1 = fileId、2 = 页码+块后缀、3 = 页码数字、4 = b 块号、5 = tbl 块号、6 = r 行号、7 = c 单元格/范围、8 = 无 c 前缀范围
  const match =
    /^(?:([a-zA-Z]+\d+)[:\-])?(p(\d+)(?:-(?:b(\d+)|tbl(\d+)|r(\d+)|c([a-zA-Z]+\d+(?::[a-zA-Z]+\d+)?)|([a-zA-Z]+\d+:[a-zA-Z]+\d+))))?$/i.exec(
      cleaned,
    )
  if (!match) return null

  const requestedFileId = match[1]?.toLowerCase()
  const pageNumber = Math.max(1, parseInt(match[3]!, 10) || 1)
  const explicitTblNum = match[5]
  const explicitBlockNum = match[4] ?? explicitTblNum
  const explicitRowNum = match[6] ? parseInt(match[6], 10) : undefined
  const explicitCellRef = (match[7] ?? match[8])?.toUpperCase()
  // tbl 形态保留原始块 ID（pX-tblY），不再坍缩为 pX-bY——PDF 引擎以 pX-tblY 落盘表格块，
  // 坍缩会反查到错误的段落块；无 c 前缀的单格（如 p1-B4）与块号 b4 天然歧义，维持按块解释。
  const rawBlockId =
    explicitTblNum !== undefined
      ? `p${pageNumber}-tbl${parseInt(explicitTblNum, 10)}`
      : explicitBlockNum !== undefined
        ? `p${pageNumber}-b${parseInt(explicitBlockNum, 10)}`
        : `p${pageNumber}`
  const label = options.label?.trim()

  const indices: MaterializedDocumentIndex[] = []
  const seenIndexPaths = new Set<string>()

  for (const dir of options.candidateDirs) {
    if (!dir || !existsSync(dir)) continue
    const artifactsDir = join(dir, '.context', 'artifacts')
    if (!existsSync(artifactsDir)) continue

    let files: string[] = []
    try {
      files = readdirSync(artifactsDir).filter((f) => f.endsWith('.index.json'))
    } catch {
      continue
    }
    // 确定性排序兜底：即便最终退回下标分配，也不再受 readdirSync 遍历顺序影响
    files.sort()

    // registry.json / manifest.json 记录了 materializeToWorkspace 落盘时的确定性 fileId 分配；
    // 旧版索引缺失 fileId 时优先据此反查，杜绝遍历顺序不确定导致 f1/f2 随机对调。
    let registry: Record<string, SessionDocumentRegistryEntry> = {}
    let manifest: Record<string, { fileId?: string; sourcePath: string; revision: string; cleanPath: string }> = {}
    try {
      const registryPath = join(artifactsDir, 'registry.json')
      if (existsSync(registryPath)) registry = JSON.parse(readFileSync(registryPath, 'utf-8'))
    } catch {
      // ignore malformed registry
    }
    try {
      const manifestPath = join(artifactsDir, 'manifest.json')
      if (existsSync(manifestPath)) manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    } catch {
      // ignore malformed manifest
    }

    for (let idxPos = 0; idxPos < files.length; idxPos++) {
      const f = files[idxPos]!
      const fullIndexPath = resolve(artifactsDir, f)
      if (seenIndexPaths.has(fullIndexPath)) continue
      seenIndexPaths.add(fullIndexPath)

      try {
        let idx = JSON.parse(readFileSync(fullIndexPath, 'utf-8')) as MaterializedDocumentIndex
        if (!idx.fileId) {
          const stem = basename(f, '.index.json')
          const isValidFileId = (v: string | undefined): v is string => !!v && /^f\d+$/i.test(v)
          // ① registry（会话级注册表）：按索引落盘路径 / 工件名 / 源路径三重确定性匹配
          const registryHit = Object.values(registry).find(
            (entry) =>
              (entry.indexJsonPath && entry.indexJsonPath === fullIndexPath) ||
              (entry.artifactId && entry.artifactId === stem) ||
              (entry.sourcePath && idx.sourcePath && entry.sourcePath === idx.sourcePath),
          )
          // ② manifest（stem 索引）：按 stem 或源路径匹配
          const manifestHit =
            manifest[stem]?.fileId ??
            Object.values(manifest).find(
              (entry) => entry.sourcePath && idx.sourcePath && entry.sourcePath === idx.sourcePath,
            )?.fileId
          idx.fileId =
            (isValidFileId(registryHit?.fileId) ? registryHit.fileId : undefined) ??
            (isValidFileId(manifestHit) ? manifestHit.toLowerCase() : undefined) ??
            `f${idxPos + 1}`
        }
        idx = upgradeStaleOfficeIndexIfNeeded(idx, fullIndexPath)
        // 向下兼容旧版 .index.json：若尚未持久化 blocks 字典，从同目录 .anchored.md 即时提取 BBox
        if (!idx.blocks || Object.keys(idx.blocks).length === 0) {
          const anchoredPath =
            idx.anchoredMarkdownPath && existsSync(idx.anchoredMarkdownPath)
              ? idx.anchoredMarkdownPath
              : join(artifactsDir, `${idx.artifactId}.anchored.md`)
          if (existsSync(anchoredPath)) {
            const anchoredMd = readFileSync(anchoredPath, 'utf-8')
            idx.blocks = extractAndNamespaceAnchors(anchoredMd, idx.fileId).blocks
          } else if (idx.pages && idx.pages.length > 0) {
            const combined = idx.pages.map((p) => p.anchoredText).join('\n\n')
            idx.blocks = extractAndNamespaceAnchors(combined, idx.fileId).blocks
          }
        }
        indices.push(idx)
      } catch {
        // ignore malformed index
      }
    }
  }

  let selectedIndex: MaterializedDocumentIndex | undefined
  if (requestedFileId) {
    selectedIndex = indices.find(
      (idx) =>
        idx.fileId?.toLowerCase() === requestedFileId ||
        idx.artifactId.toLowerCase() === requestedFileId,
    )
  }

  if (!selectedIndex && indices.length > 0) {
    // 未指定 fileId（如旧消息 #p1-b11）：优先匹配同时包含该 blockId 且位置描述（loc）一致的文档
    if (label) {
      selectedIndex = [...indices]
        .reverse()
        .find((idx) => idx.blocks?.[rawBlockId] && label.includes(idx.blocks[rawBlockId]!.loc))
    }
    if (!selectedIndex) {
      selectedIndex = [...indices].reverse().find((idx) => Boolean(idx.blocks?.[rawBlockId]))
    }
    if (!selectedIndex) {
      selectedIndex = indices[indices.length - 1]
    }
  }

  if (selectedIndex && selectedIndex.sourcePath && existsSync(selectedIndex.sourcePath)) {
    const docFormat = normalizeDocumentFormat(selectedIndex.format ?? selectedIndex.sourceName)
    let blockMeta = selectedIndex.blocks?.[rawBlockId]
    const allBlocks = selectedIndex.blocks ? Object.values(selectedIndex.blocks) : []
    const pageBlocks = allBlocks.filter((b) => b.pageNumber === pageNumber)
    const keywords = extractLabelKeywords(label, pageBlocks[0]?.sheetName)

    // 智能匹配具体段落/形状块的分工边界（B1 评审决议）：
    // 引擎产出的 loc 纯属版面几何（如「第2页·左栏」「第3页·表格」），永不包含业务关键词，
    // 若据 loc.includes(kw) 判定失配再降级模糊扫描，必然把已精确命中的块（如 p2-b3）
    // 劫持为同页恰含该关键词的其他块。因此仅两种情况允许关键词模糊探测：
    // 1) 显式块号未命中有效块（越界/索引重建后缺失，如 #f1:p24-b1）；
    // 2) 纯页面锚点（#f1:p2，未显式指定块号），需据 label 猜测同页具体段落。
    // 显式块号命中有效块时严格信任物理块 ID，仅允许窄口径互斥类型校正。
    const hasExplicitBlock = explicitBlockNum !== undefined
    if ((!blockMeta || !hasExplicitBlock) && allBlocks.length > 0) {
      const candidatePool = pageBlocks.length > 0 ? pageBlocks : allBlocks
      let matchedByLabel: DocumentAnchorBlockMeta | undefined

      if (keywords.length > 0) {
        // 先按块级 loc 标签匹配
        matchedByLabel = candidatePool.find((b) => keywords.some((kw) => b.loc.includes(kw)))
        // 再按页面 anchoredText 中各锚点块的正文内容匹配
        if (!matchedByLabel && selectedIndex.pages) {
          const pagesToSearch =
            pageBlocks.length > 0
              ? selectedIndex.pages.filter((p) => p.pageNumber === pageNumber)
              : selectedIndex.pages
          for (const p of pagesToSearch) {
            const segments = (p.anchoredText ?? '').split(/(?=<!--\s*anchor:\s*)/g)
            for (const seg of segments) {
              if (keywords.some((kw) => seg.includes(kw))) {
                const m = /<!--\s*anchor:\s*(?:[a-zA-Z]+\d+:)?(p\d+-(?:b|tbl)\d+)/.exec(seg)
                if (m && selectedIndex.blocks?.[m[1]!]) {
                  matchedByLabel = selectedIndex.blocks[m[1]!]
                  break
                }
              }
            }
            if (matchedByLabel) break
          }
        }
      }

      if (matchedByLabel) {
        blockMeta = matchedByLabel
      } else if (!blockMeta) {
        if (pageBlocks.length > 0) {
          blockMeta = pageBlocks[0]
        } else if (pageNumber > (selectedIndex.pageCount || 1)) {
          // 兼容旧版 1 段 1 页索引留存的历史消息（如 #f1:p24-b1 -> 映射到第 24 个块）
          blockMeta = allBlocks[Math.min(allBlocks.length - 1, pageNumber)] ?? allBlocks[0]
        }
      }
    } else if (blockMeta) {
      // 显式块号 + 有效块元数据：严格遵循显式物理块，仅做互斥版面类型窄校正
      blockMeta = correctMutuallyExclusiveBlockType(blockMeta, label, pageBlocks)
    }

    // 针对 XLSX 表格：将整表范围（如 A1:B22）收敛到具体的目标行/单元格（如 A10:B10 或 B10）
    let resolvedCellRef = explicitCellRef || blockMeta?.cellRef
    if (docFormat === 'xlsx') {
      const tableRangeMatch = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i.exec(blockMeta?.cellRef ?? 'A1:B22')
      const minCol = tableRangeMatch?.[1]?.toUpperCase() ?? 'A'
      const maxCol = tableRangeMatch?.[3]?.toUpperCase() ?? 'B'

      if (explicitCellRef) {
        resolvedCellRef = explicitCellRef
      } else if (explicitRowNum && explicitRowNum >= 1) {
        resolvedCellRef = `${minCol}${explicitRowNum}:${maxCol}${explicitRowNum}`
      } else if (label) {
        // 1. 检查 label 中是否显式带有单元格或范围（排除 B1-533 这类带连字符的寝室号）
        const cellInLabel =
          /(?<![A-Za-z0-9-])([A-Za-z]{1,2}\d{1,4}(?::[A-Za-z]{1,2}\d{1,4})?)(?![A-Za-z0-9-])/.exec(label)
        const rowInLabel = /第\s*(\d+)\s*行|行\s*(\d+)/.exec(label)
        if (cellInLabel) {
          // 显式单元格引用（单格 B10 或范围 B4:E10）原样保留，绝不拉伸为整行：
          // 强扩整行会剥夺「精准定位单格」的聚光灯语义（B4 评审决议）
          resolvedCellRef = cellInLabel[1]!.toUpperCase()
        } else if (rowInLabel) {
          const rNum = parseInt(rowInLabel[1] ?? rowInLabel[2]!, 10)
          if (rNum >= 1) {
            resolvedCellRef = `${minCol}${rNum}:${maxCol}${rNum}`
          }
        } else if (keywords.length > 0 && selectedIndex.pages) {
          // 2. 在目标工作表的行文本中检索关键词（如学生姓名/学号），提取该行的精确行坐标 A10:B10
          const targetPage = selectedIndex.pages.find(
            (p) => p.pageNumber === (blockMeta?.pageNumber ?? pageNumber),
          )
          if (targetPage?.cleanText) {
            const lines = targetPage.cleanText.split(/\r?\n/)
            for (const line of lines) {
              if (!line.startsWith('|') || line.includes('---')) continue
              if (keywords.some((kw) => line.includes(kw))) {
                const rowCoordMatch = /^\|\s*([A-Z]+\d+(?::[A-Z]+\d+)?)\s*\|/i.exec(line)
                if (rowCoordMatch) {
                  resolvedCellRef = rowCoordMatch[1]!.toUpperCase()
                  break
                }
              }
            }
          }
        }
      }
    }

    const resolvedPageNumber = blockMeta?.pageNumber ?? pageNumber
    const resolvedLabel =
      label && !/^第\s*\d+\s*页$/.test(label)
        ? label
        : blockMeta?.loc || `第${resolvedPageNumber}页`

    return {
      fileId: selectedIndex.fileId || 'f1',
      filePath: selectedIndex.sourcePath,
      fileName: selectedIndex.sourceName || basename(selectedIndex.sourcePath),
      pageNumber: resolvedPageNumber,
      blockId: blockMeta?.blockId ?? rawBlockId,
      bbox: blockMeta?.bbox,
      label: resolvedLabel,
      format: docFormat,
      ...(blockMeta?.sheetName ? { sheetName: blockMeta.sheetName } : {}),
      ...(resolvedCellRef ? { cellRef: resolvedCellRef } : {}),
    }
  }

  // 保底：若工作区尚无 .index.json，回退查找候选目录或附加文件中的 PDF/DOCX/PPTX/XLSX
  for (const fb of options.fallbackFiles ?? []) {
    if (fb && PREINGEST_DOCUMENT_EXTENSIONS.has(extname(fb).toLowerCase()) && existsSync(fb)) {
      return {
        fileId: requestedFileId || 'f1',
        filePath: fb,
        fileName: basename(fb),
        pageNumber,
        blockId: rawBlockId,
        label: label || `第${pageNumber}页`,
        format: normalizeDocumentFormat(fb),
      }
    }
  }

  for (const dir of options.candidateDirs) {
    if (!dir || !existsSync(dir)) continue
    try {
      const docFile = readdirSync(dir).find((f) => PREINGEST_DOCUMENT_EXTENSIONS.has(extname(f).toLowerCase()))
      if (docFile) {
        const fullDoc = join(dir, docFile)
        return {
          fileId: requestedFileId || 'f1',
          filePath: fullDoc,
          fileName: docFile,
          pageNumber,
          blockId: rawBlockId,
          label: label || `第${pageNumber}页`,
          format: normalizeDocumentFormat(docFile),
        }
      }
    } catch {
      // ignore
    }
  }

  return null
}

/**
 * 当模型尝试对 `.pdf/.docx/.xlsx/.pptx` 直接调用内置 `read` 工具时，
 * 透明拦截二进制读取并重定向至内核高精解析产物（返回句柄摘要 + 前 3 页带锚点正文）。
 */
export async function redirectBinaryDocumentRead(
  filePath: string,
  context: PreviewInspectionContext,
): Promise<string> {
  if (!isAbsolute(filePath) && !context.agentCwd?.trim()) {
    throw new Error('当前会话没有可用的 Agent 工作目录，已拒绝解析相对路径文档')
  }
  const resolved = isAbsolute(filePath) ? filePath : resolve(context.agentCwd, filePath)
  const parsed = await parseAttachedDocument(resolved, context)
  if (!parsed) {
    throw new Error(`无法解析文档文件: ${filePath}`)
  }
  const handle = formatDocumentArtifactHandle(parsed)
  const slice = await executeReadDocumentArtifact(
    { file: parsed.materialized?.fileId ?? parsed.materialized?.artifactId ?? resolved, pages: '1-3', includeAnchors: true },
    context,
  )
  return [
    `[内核透明重定向] 检测到对二进制文档 (${basename(resolved)}) 调用了 read 工具；已自动重定向至客户端内核高精解析产物：`,
    handle,
    '',
    slice.content,
  ].join('\n')
}
