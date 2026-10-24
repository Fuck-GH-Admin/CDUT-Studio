/**
 * CSLab 文献结构化解析与智能导读
 *
 * 职责：
 * - PDF 入笼后后台解析标题/作者/摘要/DOI/章节/公式/表格；
 * - 结构化结果写入 vault/lit/{entityUuid}.structure.json，摘要字段回填 literature_sources.metadata_json；
 * - 解析成功后触发 GraphRAG 索引重建（带防抖与单飞）；
 * - 为 Agent 工具与前端导读面板提供结构化读取。
 *
 * 红线：解析失败绝不阻断入笼；所有长任务串行限流（最多 2 个并发），避免批量拖入 PDF 时压垮主进程。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type {
  CsLabLiteratureEquationRef,
  CsLabLiteratureGuide,
  CsLabLiteratureSectionRef,
  CsLabLiteratureTableRef,
  DocumentLayoutAST,
  DocumentLayoutBlock,
} from '@profer/shared'
import {
  getCsLabDatabase,
  getEntityByUri,
  getLiteratureSource,
  upsertLiteratureSource,
  updateEntityTitle,
} from './cslab-db'
import { assertLabId, resolveLabDir, resolveLabRelativePath } from './cslab-paths'
import { readLiteratureBuffer } from './cslab-literature'
import { broadcastCsLabEvent } from './cslab-events'
import { CSLAB_IPC_CHANNELS } from './cslab-types'

const MAX_PARSE_BYTES = 160 * 1024 * 1024
const MAX_PAGES = 300
const MAX_SECTION_CHARS = 8_000
const MAX_ABSTRACT_CHARS = 2_000
const MAX_MARKDOWN_CHARS = 2_000_000
const MAX_CONCURRENT_ENRICHMENTS = 2

export interface LiteratureStructureSection {
  title: string
  level: number
  page: number
  text: string
}

export interface LiteratureStructureFile {
  version: 1
  uri: string
  sha256?: string
  parsedAt: number
  pageCount: number
  title: string
  authors: string[]
  year?: string
  doi?: string
  publication?: string
  abstract?: string
  keywords: string[]
  sections: LiteratureStructureSection[]
  equations: Array<{ latex: string; tag?: string; page: number }>
  tables: Array<{ page: number; markdown: string; caption?: string }>
  /** kind === 'figure' 的版面块（bbox 为页面点坐标，供图表抽取配对）。 */
  figures?: Array<{ page: number; bbox: [number, number, number, number]; caption: string }>
  pages: Array<{ page: number; text: string }>
  markdown: string
  warnings: string[]
}

function labDb(labId: string) {
  return getCsLabDatabase(join(resolveLabDir(labId), 'db', 'central_meta.sqlite'))
}

function entityUuidOf(uri: string): string {
  return uri.split('/').pop() || 'literature'
}

export function literatureStructureRelPath(uri: string): string {
  return `vault/lit/${entityUuidOf(uri)}.structure.json`
}

export function literatureStructurePath(labId: string, uri: string): string {
  return resolveLabRelativePath(assertLabId(labId), literatureStructureRelPath(uri))
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

const HEADING_FALLBACK = /^(?:\d+(?:\.\d+)*\s+[A-Z][A-Za-z0-9 ,&/()-]{2,80}|abstract|摘要|keywords?|关键词|references|acknowledg(?:e)?ments?|limitations?|conclusions?|discussion|introduction|methods?|results?)$/i

function isHeading(block: DocumentLayoutBlock): boolean {
  if (block.kind === 'section-heading' || block.kind === 'title') return true
  // 演示 PDF / 纯文本排版可能没有字号层级：用编号标题做保守兜底。
  return HEADING_FALLBACK.test(cleanText(block.text))
}

function looksLikeEquationText(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 5 || trimmed.length > 160) return false
  if (/[。.!?]\s/.test(trimmed)) return false
  if (/\b(with|where|and|the|is|are|for|from|this|that)\b/i.test(trimmed)) return false
  return /=/.test(trimmed) && /[*^+\-/()]/.test(trimmed) && !/^\d+(?:\.\d+)*\s+[A-Z]/.test(trimmed)
}

function looksLikeTableText(text: string): boolean {
  const pipes = text.split('|').length - 1
  return pipes >= 2 && !/^\d+(?:\.\d+)*\s+[A-Z]/.test(text.trim())
}

function pickTitle(blocks: DocumentLayoutBlock[], fallback: string): string {
  const explicit = blocks.find((block) => block.kind === 'title' && cleanText(block.text).length >= 4)
  if (explicit) return cleanText(explicit.text).slice(0, 240)
  const candidates = blocks
    .slice(0, 12)
    .filter((block) => block.kind !== 'table' && block.kind !== 'equation')
    .map((block) => ({ text: cleanText(block.text), score: (block as DocumentLayoutBlock & { fontSize?: number }).fontSize ?? 0 }))
    .filter((item) => item.text.length >= 8 && item.text.length <= 240)
    .sort((a, b) => b.score - a.score)
  return candidates[0]?.text ?? fallback.replace(/\.pdf$/i, '')
}

function pickAuthors(blocks: DocumentLayoutBlock[], title: string): string[] {
  const titleIndex = blocks.findIndex((block) => cleanText(block.text) === title)
  if (titleIndex < 0) return []
  const collected: string[] = []
  for (let index = titleIndex + 1; index < Math.min(blocks.length, titleIndex + 8); index += 1) {
    const block = blocks[index]!
    const text = cleanText(block.text)
    if (!text) continue
    if (/^(abstract|摘要|keywords?|关键词|introduction|引言)\b/i.test(text)) break
    if (text.length > 300 || /[。.!?]\s/.test(text)) break
    collected.push(text)
  }
  if (collected.length === 0) return []
  return collected
    .join(', ')
    .split(/[,，、;；]|\band\b/i)
    .map((name) => name.replace(/\s*[\d*†‡]+$/g, '').trim())
    .filter((name) => name.length >= 2 && name.length <= 80)
    .slice(0, 8)
}

function pickAbstract(blocks: DocumentLayoutBlock[]): string | undefined {
  const start = blocks.findIndex((block) => /^(abstract|摘要)\b/i.test(cleanText(block.text)))
  if (start < 0) return undefined
  const parts: string[] = []
  for (let index = start; index < blocks.length; index += 1) {
    const block = blocks[index]!
    const text = cleanText(block.text)
    if (index > start && isHeading(block)) break
    if (index > start && /^(keywords?|关键词|introduction|引言)\b/i.test(text)) break
    parts.push(text)
    if (parts.join(' ').length >= MAX_ABSTRACT_CHARS) break
  }
  return parts.join(' ').slice(0, MAX_ABSTRACT_CHARS)
}

function pickKeywords(blocks: DocumentLayoutBlock[]): string[] {
  const block = blocks.find((item) => /^(keywords?|关键词)\b/i.test(cleanText(item.text)))
  if (!block) return []
  return cleanText(block.text)
    .replace(/^(keywords?|关键词)\s*[:：]?\s*/i, '')
    .split(/[;；,，、]/)
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword.length >= 2 && keyword.length <= 40)
    .slice(0, 12)
}

function extractDoi(blocks: DocumentLayoutBlock[]): string | undefined {
  const text = blocks
    .filter((block) => block.pageNumber <= 2)
    .map((block) => block.text)
    .join('\n')
  return /10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/.exec(text)?.[0]
}

function extractYear(blocks: DocumentLayoutBlock[], doi?: string): string | undefined {
  const firstPages = blocks
    .filter((block) => block.pageNumber <= 2)
    .map((block) => block.text)
    .join('\n')
  const matches = firstPages.match(/\b(19|20)\d{2}\b/g)
  if (matches && matches.length > 0) {
    // 优先取与 DOI/版权行相邻的年份；退而取首个合理年份。
    const candidates = matches.filter((year) => Number(year) >= 1900 && Number(year) <= 2100)
    if (candidates.length > 0) return candidates[candidates.length - 1]
  }
  const yearFromDoi = doi?.match(/\b(19|20)\d{2}\b/)?.[0]
  return yearFromDoi
}

function buildSections(blocks: DocumentLayoutBlock[]): LiteratureStructureSection[] {
  const sections: LiteratureStructureSection[] = []
  let current: LiteratureStructureSection | null = null
  for (const block of blocks) {
    if (isHeading(block)) {
      const title = cleanText(block.text)
      if (!title) continue
      current = {
        title: title.slice(0, 200),
        level: block.headingLevel ?? (block.kind === 'title' ? 1 : 2),
        page: block.pageNumber,
        text: '',
      }
      sections.push(current)
      continue
    }
    if (!current) continue
    if (block.kind === 'table' || block.kind === 'equation') continue
    const text = cleanText(block.text)
    if (!text) continue
    if (current.text.length + text.length > MAX_SECTION_CHARS) continue
    current.text = current.text ? `${current.text} ${text}` : text
  }
  return sections.filter((section) => section.text.length > 0 || section.level === 1)
}

function buildPages(blocks: DocumentLayoutBlock[]): Array<{ page: number; text: string }> {
  const byPage = new Map<number, string[]>()
  for (const block of blocks) {
    const text = cleanText(block.text)
    if (!text) continue
    const list = byPage.get(block.pageNumber) ?? []
    list.push(text)
    byPage.set(block.pageNumber, list)
  }
  return [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([page, lines]) => ({ page, text: lines.join('\n') }))
}

export function buildStructureFromAst(
  uri: string,
  ast: DocumentLayoutAST,
  fallbackTitle: string,
  sha256?: string,
): LiteratureStructureFile {
  const blocks = [...ast.readingOrderedBlocks].sort(
    (a, b) => a.readingOrderIndex - b.readingOrderIndex,
  )
  const title = pickTitle(blocks, fallbackTitle)
  const authors = pickAuthors(blocks, title)
  const abstract = pickAbstract(blocks)
  const keywords = pickKeywords(blocks)
  const doi = extractDoi(blocks)
  const year = extractYear(blocks, doi)
  const sections = buildSections(blocks)
  const equations = blocks
    .filter((block) => block.kind === 'equation' || looksLikeEquationText(block.text))
    .map((block) => ({
      latex: block.equation?.latex ?? block.text,
      tag: block.equation?.tag,
      page: block.pageNumber,
    }))
    .filter((item) => item.latex.length > 0)
  const tables = blocks
    .filter((block) => block.kind === 'table' || looksLikeTableText(block.text))
    .map((block) => ({
      page: block.pageNumber,
      markdown: block.table?.markdown ?? block.text,
      caption: block.table?.caption,
    }))
    .filter((item) => item.markdown.length > 0)
  // 图表块：归一化 bbox 乘页面尺寸还原为点坐标（左上原点），供图表抽取做位置配对。
  const pageDims = new Map(ast.pages.map((page) => [page.pageNumber, page]))
  const figures = blocks
    .filter((block) => block.kind === 'figure')
    .map((block) => {
      const dims = pageDims.get(block.pageNumber)
      const [x0, y0, x1, y1] = block.bbox
      const width = dims && dims.width > 0 ? dims.width : 1
      const height = dims && dims.height > 0 ? dims.height : 1
      return {
        page: block.pageNumber,
        bbox: [x0 * width, y0 * height, x1 * width, y1 * height] as [number, number, number, number],
        caption: cleanText(block.text).slice(0, 500),
      }
    })

  return {
    version: 1,
    uri,
    sha256,
    parsedAt: Date.now(),
    pageCount: ast.pageCount,
    title,
    authors,
    year,
    doi,
    abstract,
    keywords,
    sections,
    equations,
    tables,
    figures,
    pages: buildPages(blocks),
    markdown: ast.markdown.slice(0, MAX_MARKDOWN_CHARS),
    warnings: [],
  }
}

async function readStructure(labId: string, uri: string): Promise<LiteratureStructureFile | null> {
  try {
    const raw = await fs.readFile(literatureStructurePath(labId, uri), 'utf-8')
    const parsed = JSON.parse(raw) as LiteratureStructureFile
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.sections)) return null
    return parsed
  } catch {
    return null
  }
}

async function writeStructure(
  labId: string,
  structure: LiteratureStructureFile,
): Promise<void> {
  const target = literatureStructurePath(labId, structure.uri)
  await fs.mkdir(join(target, '..'), { recursive: true })
  const tmp = `${target}.tmp`
  await fs.writeFile(tmp, JSON.stringify(structure), 'utf-8')
  await fs.rename(tmp, target)
}

function mergeMetadata(
  raw: string | undefined,
  structure: LiteratureStructureFile,
): string {
  let current: Record<string, unknown> = {}
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (parsed && typeof parsed === 'object') current = parsed
    } catch {
      current = {}
    }
  }
  const authors = structure.authors.length > 0
    ? structure.authors
    : Array.isArray(current.authors) ? current.authors : []
  return JSON.stringify({
    ...current,
    authors,
    year: structure.year ?? current.year,
    doi: structure.doi ?? current.doi,
    abstract: structure.abstract ?? current.abstract,
    keywords: structure.keywords.length > 0 ? structure.keywords : current.keywords ?? [],
    pageCount: structure.pageCount,
    sectionCount: structure.sections.length,
    sectionTitles: structure.sections.slice(0, 40).map((section) => section.title),
    structureVersion: 1,
    structureRelPath: literatureStructureRelPath(structure.uri),
    parsedAt: structure.parsedAt,
  })
}

function appendParseWarning(raw: string | undefined, warning: string): string {
  let current: Record<string, unknown> = {}
  if (raw) {
    try {
      current = JSON.parse(raw) as Record<string, unknown>
    } catch {
      current = {}
    }
  }
  return JSON.stringify({ ...current, parseWarning: warning })
}

/** 解析并回填单篇文献；失败只记录 parseWarning。`deferIndexRebuild` 为 true 时跳过 GraphRAG 重建（由入库流水线统一调度）。 */
async function enrichLiteratureOnce(labId: string, uri: string, deferIndexRebuild = false): Promise<void> {
  const db = labDb(labId)
  const entity = getEntityByUri(db, uri)
  if (!entity || entity.layerType !== 'lit') return
  const source = getLiteratureSource(db, uri)
  if (!source) return

  const buffer = await readLiteratureBuffer(labId, uri, MAX_PARSE_BYTES)
  if (!buffer) {
    upsertLiteratureSource(db, {
      ...source,
      metadataJson: appendParseWarning(source.metadataJson, 'PDF 文件不可读或超过解析上限'),
      updatedAt: Date.now(),
    })
    return
  }

  try {
    const { parsePdfDocument } = await import('@profer/core/pdf-engine')
    const ast = await parsePdfDocument(buffer, {
      fileName: entity.title,
      maxPages: MAX_PAGES,
    })
    const structure = buildStructureFromAst(uri, ast, entity.title, entity.sha256)
    if (structure.warnings.length === 0 && ast.pageCount > MAX_PAGES) {
      structure.warnings.push(`仅解析前 ${MAX_PAGES} 页`)
    }
    await writeStructure(labId, structure)
    updateEntityTitle(db, uri, structure.title, Date.now())
    upsertLiteratureSource(db, {
      ...source,
      metadataJson: mergeMetadata(source.metadataJson, structure),
      pageCount: structure.pageCount,
      updatedAt: Date.now(),
    })
    broadcastCsLabEvent(CSLAB_IPC_CHANNELS.ON_ASSET_CHANGED, {
      labId,
      uri,
      kind: 'updated',
      revision: entity.revision,
    })
    if (deferIndexRebuild) {
      // 入库流水线尚未完成 Vault/向量阶段，重建推迟到流水线末尾统一触发，
      // 杜绝过早重建与后续阶段的重复锁竞争。
    } else {
      const { scheduleLiteratureIndexRebuild } = await import('./cslab-graphrag-router')
      scheduleLiteratureIndexRebuild(labId)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'PDF 结构解析失败'
    console.warn(`[CSLab] 文献结构解析失败 (${uri}):`, error)
    upsertLiteratureSource(db, {
      ...source,
      metadataJson: appendParseWarning(source.metadataJson, message),
      updatedAt: Date.now(),
    })
  }
}

interface EnrichmentJob {
  labId: string
  uri: string
  deferIndexRebuild: boolean
  resolve: () => void
  reject: (error: unknown) => void
}

const enrichmentQueue: EnrichmentJob[] = []
const inFlightEnrichments = new Map<string, Promise<void>>()
let activeEnrichments = 0

function drainEnrichmentQueue(): void {
  while (activeEnrichments < MAX_CONCURRENT_ENRICHMENTS && enrichmentQueue.length > 0) {
    const job = enrichmentQueue.shift()!
    activeEnrichments += 1
    void enrichLiteratureOnce(job.labId, job.uri, job.deferIndexRebuild)
      .then(job.resolve, job.reject)
      .finally(() => {
        activeEnrichments -= 1
        drainEnrichmentQueue()
      })
  }
}

/** 批量入笼限流：最多 2 个 PDF 并行解析，其余排队；同一文献单飞。 */
export function enrichLiteratureInBackground(
  labId: string,
  uri: string,
  options: { deferIndexRebuild?: boolean } = {},
): Promise<void> {
  const normalizedLabId = assertLabId(labId)
  const key = `${normalizedLabId}|${uri}`
  const existing = inFlightEnrichments.get(key)
  if (existing) return existing
  const task = new Promise<void>((resolve, reject) => {
    enrichmentQueue.push({
      labId: normalizedLabId,
      uri,
      deferIndexRebuild: options.deferIndexRebuild === true,
      resolve,
      reject,
    })
    drainEnrichmentQueue()
  })
  inFlightEnrichments.set(key, task)
  void task.then(
    () => inFlightEnrichments.delete(key),
    () => inFlightEnrichments.delete(key),
  )
  return task
}

/** 等待所有在途富化结束（删除/重置实验室前释放文件句柄）。 */
export async function waitForLiteratureEnrichments(timeoutMs = 8_000): Promise<void> {
  const pending = [...inFlightEnrichments.values()]
  if (pending.length === 0) return
  await Promise.race([
    Promise.allSettled(pending).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ])
}

/** 读取结构；`ensure` 为 true 时按需同步解析（导读按钮首次点击）。 */
export async function getLiteratureStructure(
  labIdInput: string,
  uri: string,
  options: { ensure?: boolean } = {},
): Promise<LiteratureStructureFile | null> {
  const labId = assertLabId(labIdInput)
  const cached = await readStructure(labId, uri)
  if (cached) return cached
  if (!options.ensure) return null
  await enrichLiteratureInBackground(labId, uri)
  return readStructure(labId, uri)
}

function sectionRef(section: LiteratureStructureSection, excerptChars = 600): CsLabLiteratureSectionRef {
  return {
    title: section.title,
    level: section.level,
    page: section.page,
    excerpt: section.text.slice(0, excerptChars),
  }
}

function findSectionByPattern(
  sections: LiteratureStructureSection[],
  pattern: RegExp,
): LiteratureStructureSection | undefined {
  return sections.find((section) => pattern.test(section.title))
}

/** 构建结构化导读（不生成主观结论；语义综合交给科学助理）。 */
export async function buildLiteratureGuide(
  labIdInput: string,
  uri: string,
): Promise<CsLabLiteratureGuide> {
  const labId = assertLabId(labIdInput)
  const db = labDb(labId)
  const entity = getEntityByUri(db, uri)
  const source = getLiteratureSource(db, uri)
  if (!entity || entity.layerType !== 'lit') {
    return {
      ok: false,
      uri,
      title: '',
      authors: [],
      pageCount: 0,
      keywords: [],
      outline: [],
      equations: [],
      tables: [],
      limitations: [],
      readingPath: [],
      message: '文献不存在或不属于当前实验室',
    }
  }

  const structure = await getLiteratureStructure(labId, uri, { ensure: true })
  if (!structure) {
    return {
      ok: false,
      uri,
      title: entity.title,
      authors: [],
      pageCount: source?.pageCount ?? 0,
      keywords: [],
      outline: [],
      equations: [],
      tables: [],
      limitations: [],
      readingPath: [],
      message: 'PDF 未能解析出文本结构（可能为扫描版或加密 PDF）',
    }
  }

  const limitations = structure.sections
    .filter((section) => /limitation|局限|不足|future work|outlook/i.test(section.title))
    .slice(0, 3)
    .map((section) => sectionRef(section))
  const conclusion = findSectionByPattern(structure.sections, /conclusion|结论|summary|总结/i)
  const readingPath = [
    structure.abstract ? '先读摘要，建立问题与贡献的整体印象' : '先浏览首页，确认研究问题与贡献',
    structure.sections.length > 0
      ? `沿章节脉络推进：${structure.sections.slice(0, 5).map((section) => section.title).join(' → ')}`
      : '按页顺序通读正文',
    structure.equations.length > 0
      ? `重点核对 ${structure.equations.length} 个公式的变量定义与适用条件`
      : '留意正文中的模型假设与边界条件',
    structure.tables.length > 0
      ? `对照 ${structure.tables.length} 张表格检查数据一致性`
      : '核对图注与正文中的数据口径',
    limitations.length > 0 ? '最后阅读局限/展望章节，评估结论边界' : '最后复核结论与适用边界',
  ]

  return {
    ok: true,
    uri,
    title: structure.title || entity.title,
    authors: structure.authors,
    year: structure.year,
    doi: structure.doi,
    publication: undefined,
    pageCount: structure.pageCount,
    abstract: structure.abstract,
    keywords: structure.keywords,
    outline: structure.sections.map((section) => sectionRef(section, 160)),
    equations: structure.equations.slice(0, 20).map<CsLabLiteratureEquationRef>((item) => ({
      latex: item.latex,
      tag: item.tag,
      page: item.page,
    })),
    tables: structure.tables.slice(0, 10).map<CsLabLiteratureTableRef>((item) => ({
      page: item.page,
      caption: item.caption,
      markdownPreview: item.markdown.slice(0, 400),
    })),
    limitations,
    conclusion: conclusion ? sectionRef(conclusion) : undefined,
    readingPath,
    parsedAt: structure.parsedAt,
  }
}

export interface PaperSectionReadResult {
  ok: boolean
  title: string
  page?: number
  markdown: string
  equations: CsLabLiteratureEquationRef[]
  tables: CsLabLiteratureTableRef[]
  message?: string
}

/** 按章节标题或页码读取纯净文本。 */
export async function readPaperSection(
  labIdInput: string,
  uri: string,
  input: { section?: string; page?: number; pageEnd?: number },
): Promise<PaperSectionReadResult> {
  const labId = assertLabId(labIdInput)
  const structure = await getLiteratureStructure(labId, uri, { ensure: true })
  if (!structure) {
    return {
      ok: false,
      title: '',
      markdown: '',
      equations: [],
      tables: [],
      message: 'PDF 未能解析出文本结构（可能为扫描版或加密 PDF）',
    }
  }

  const sectionQuery = input.section?.trim().toLowerCase()
  if (sectionQuery) {
    const section = structure.sections.find((item) => (
      item.title.toLowerCase().includes(sectionQuery)
      || sectionQuery.includes(item.title.toLowerCase())
    ))
    if (!section) {
      return {
        ok: false,
        title: structure.title,
        markdown: '',
        equations: [],
        tables: [],
        message: `未找到章节「${input.section}」；可用章节：${structure.sections.slice(0, 12).map((item) => item.title).join(' / ')}`,
      }
    }
    return {
      ok: true,
      title: section.title,
      page: section.page,
      markdown: section.text.slice(0, 20_000),
      equations: structure.equations
        .filter((item) => item.page === section.page)
        .map((item) => ({ latex: item.latex, tag: item.tag, page: item.page })),
      tables: structure.tables
        .filter((item) => item.page === section.page)
        .map((item) => ({ page: item.page, caption: item.caption, markdownPreview: item.markdown })),
    }
  }

  const start = Math.max(1, input.page ?? 1)
  const end = Math.max(start, input.pageEnd ?? start)
  const pages = structure.pages.filter((item) => item.page >= start && item.page <= end)
  if (pages.length === 0) {
    return {
      ok: false,
      title: structure.title,
      markdown: '',
      equations: [],
      tables: [],
      message: `页码 ${start}-${end} 没有可读文本`,
    }
  }
  const markdown = pages.map((item) => `## Page ${item.page}\n${item.text}`).join('\n\n')
  return {
    ok: true,
    title: structure.title,
    page: start,
    markdown: markdown.slice(0, 20_000),
    equations: structure.equations
      .filter((item) => item.page >= start && item.page <= end)
      .map((item) => ({ latex: item.latex, tag: item.tag, page: item.page })),
    tables: structure.tables
      .filter((item) => item.page >= start && item.page <= end)
      .map((item) => ({ page: item.page, caption: item.caption, markdownPreview: item.markdown })),
  }
}
