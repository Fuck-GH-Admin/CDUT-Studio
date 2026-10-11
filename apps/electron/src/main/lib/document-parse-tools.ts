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
import { extname, basename, join, resolve, isAbsolute } from 'node:path'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { resolveAuthorizedFile, type PreviewInspectionContext } from './preview-inspection-service'

/** 单次返回给模型的文本上限（字符），超出截断并显式标注，避免上下文爆炸。 */
export const MAX_DOCUMENT_CHARS = 160_000

/** 单次切片读取（read_document_artifact）返回的最大字符数。 */
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
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
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
    text: `${text.slice(0, MAX_DOCUMENT_CHARS)}\n\n…（内容过长，已截断，如需后续内容请使用 read_document_artifact 按页读取）`,
    truncated: true,
  }
}

/**
 * 从带拓扑锚点的 Markdown 中提取所有块的 BBox 坐标，并将锚点统一冠以 `fileId:` 命名空间前缀。
 */
export function extractAndNamespaceAnchors(
  markdown: string,
  fileId: string,
): { namespacedMarkdown: string; blocks: Record<string, DocumentAnchorBlockMeta> } {
  const blocks: Record<string, DocumentAnchorBlockMeta> = {}
  const anchorCommentRe =
    /<!--\s*anchor:\s*(?:([a-zA-Z]+\d+):)?(p(\d+)-b\d+)\s*\[([^\]]+)\]\s*loc="([^"]*)"\s*-->/g

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
    const loc = match[5] ?? `第${pageNum}页`
    blocks[rawBlockId] = {
      blockId: rawBlockId,
      scopedId: `${fileId}:${rawBlockId}`,
      pageNumber: pageNum,
      bbox,
      loc,
    }
  }

  const namespacedMarkdown = markdown
    .replace(
      /<span id="(?:[a-zA-Z]+\d+:)?(p\d+-b\d+)" data-loc="([^"]*)"><\/span>/g,
      `<span id="${fileId}:$1" data-loc="$2"></span>`,
    )
    .replace(
      /<!--\s*anchor:\s*(?:[a-zA-Z]+\d+:)?(p\d+-b\d+)\s*\[([^\]]+)\]\s*loc="([^"]*)"\s*-->/g,
      `<!-- anchor: ${fileId}:$1 [$2] loc="$3" -->`,
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
function materializeToWorkspace(
  resolvedSourcePath: string,
  agentCwd: string,
  parsed: Omit<ParseDocumentResult, 'materialized'>,
): MaterializedDocumentIndex | undefined {
  if (!agentCwd || !existsSync(agentCwd)) return undefined
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

    const fileId = allocateSessionFileId(artifactsDir, stem, resolvedSourcePath, manifest)

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
  const revision = `sha256:${createHash('sha256').update(buffer).digest('hex')}`
  const file = {
    name: basename(resolved),
    size: metadata.size,
    modifiedAt: metadata.mtime.toISOString(),
    revision,
  }

  // PDF：唯一路径 = 高精解析引擎
  if (extname(resolved).toLowerCase() === '.pdf') {
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

  // 其余文档格式：基座解析器（DOCX/XLSX/PPTX/RTF/文本等）
  const { extractTextFromFile } = await import('./document-parser')
  const raw = await extractTextFromFile(resolved)
  const { text, truncated } = truncate(raw)
  const ext = extname(resolved).toLowerCase()
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
    `<preview>\n${previewSnippet}${previewHasMore ? '\n...(后文已省略，请使用 read_document_artifact 按页或关键词检阅)' : ''}\n</preview>`,
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
    '<!-- 3. 按需切片精读：若用户要求总结全文、回答问题或核对实验数据/公式，请调用 `read_document_artifact` 工具按页码范围（如 pages="1-4"）或关键词（query="..."）读取带双轨定位锚点的原文，并用 [第X页·位置](#f1:pX-bY) 格式引用证据。 -->',
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
 * 执行按页/按关键词的文档切片检阅（`read_document_artifact` 工具后端）。
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
      `\n[分页提示：当前已返回第 ${returnedPages.join(',')} 页（共 ${totalPages} 页）。如需继续阅读后续页面，请调用 read_document_artifact({ file: "${fileId}", pages: "${nextSuggestedPages}" })]`,
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
 * 解析形如 `#f1:p1-b11`、`#f1-p1-b11` 或 `#p1-b11` 的双平行拓扑定位锚点，
 * 反查目标 PDF/文档的绝对路径、页码以及块级归一化 BBox 坐标 `[x0, y0, x1, y1]`。
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
  const match = /^(?:([a-zA-Z]+\d+)[:\-])?(p(\d+)(?:-b\d+)?)$/i.exec(cleaned)
  if (!match) return null

  const requestedFileId = match[1]?.toLowerCase()
  const rawBlockId = match[2]!.toLowerCase()
  const pageNumber = Math.max(1, parseInt(match[3]!, 10) || 1)
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

    for (let idxPos = 0; idxPos < files.length; idxPos++) {
      const f = files[idxPos]!
      const fullIndexPath = resolve(artifactsDir, f)
      if (seenIndexPaths.has(fullIndexPath)) continue
      seenIndexPaths.add(fullIndexPath)

      try {
        const idx = JSON.parse(readFileSync(fullIndexPath, 'utf-8')) as MaterializedDocumentIndex
        if (!idx.fileId) {
          idx.fileId = `f${idxPos + 1}`
        }
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
    const blockMeta = selectedIndex.blocks?.[rawBlockId]
    return {
      fileId: selectedIndex.fileId || 'f1',
      filePath: selectedIndex.sourcePath,
      fileName: selectedIndex.sourceName || basename(selectedIndex.sourcePath),
      pageNumber: blockMeta?.pageNumber ?? pageNumber,
      blockId: rawBlockId,
      bbox: blockMeta?.bbox,
      label: label || blockMeta?.loc || `第${pageNumber}页`,
    }
  }

  // 保底：若工作区尚无 .index.json，回退查找候选目录或附加文件中的 PDF
  for (const fb of options.fallbackFiles ?? []) {
    if (fb && extname(fb).toLowerCase() === '.pdf' && existsSync(fb)) {
      return {
        fileId: requestedFileId || 'f1',
        filePath: fb,
        fileName: basename(fb),
        pageNumber,
        blockId: rawBlockId,
        label: label || `第${pageNumber}页`,
      }
    }
  }

  for (const dir of options.candidateDirs) {
    if (!dir || !existsSync(dir)) continue
    try {
      const pdfFile = readdirSync(dir).find((f) => extname(f).toLowerCase() === '.pdf')
      if (pdfFile) {
        const fullPdf = join(dir, pdfFile)
        return {
          fileId: requestedFileId || 'f1',
          filePath: fullPdf,
          fileName: pdfFile,
          pageNumber,
          blockId: rawBlockId,
          label: label || `第${pageNumber}页`,
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
  const resolved = isAbsolute(filePath) ? filePath : resolve(context.agentCwd || process.cwd(), filePath)
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
