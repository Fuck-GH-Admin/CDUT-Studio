/**
 * 实验室跨文献分层索引
 *
 * 流程：PDF 文本提取（pdfjs 几何图元）→ 页内行重建 → 切块 →
 *       相邻/共现边 → Leiden 分层社区 → 落盘 graphrag-index.json。
 *
 * 红线：
 * 1. 文本只能来自 PDF 真实字符流，提取失败如实记录，不生成摘要替代原文；
 * 2. 索引缓存按文献 updatedAt 失效；
 * 3. 社群标题只由成员块标题派生。
 */

import { createHash } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import { join } from 'node:path'
import type {
  CsLabLiteratureGraphEdge,
  CsLabLiteratureGraphNode,
  CsLabLiteratureGraphResult,
  CsLabLiteratureIndexStatus,
} from '@profer/shared'
import { buildHierarchicalCommunities, type CommunityNode, type WeightedEdge } from '../study/hierarchical-graphrag'
import { assertLabId, resolveLabRelativePath } from './cslab-paths'
import { listLiteratureEntities, readLiteratureBuffer } from './cslab-literature'

const CHUNK_TARGET_CHARS = 900
const MAX_COOCCURRENCE_EDGES = 2000

export interface LiteratureChunk {
  id: string
  literatureUri: string
  title: string
  page: number
  text: string
  /** 切块在 PDF 页内的归一化坐标 [x0, y0, x1, y1]（0-1）；旧索引缺省时仅跳页不高亮。 */
  bbox?: [number, number, number, number]
}

export interface LiteratureIndexFile {
  version: 1
  builtAt: number
  fingerprint: string
  literatureCount: number
  chunks: LiteratureChunk[]
  communities: CommunityNode[]
  /** chunkId -> L0 社区。 */
  chunkCommunity: Record<string, { id: string; title: string }>
  /** 切块级共现边（L0 聚类与全景图谱的数据源）；旧版索引可能缺省。 */
  edges: WeightedEdge[]
}

interface CachedPageText {
  page: number
  text: string
  /** 页面尺寸（PDF 视口单位），用于把行框归一化为 0-1 坐标；旧缓存缺省。 */
  width?: number
  height?: number
  /** 行级文本框（PDF 视口坐标）；旧缓存缺省时仅跳页不高亮。 */
  lines?: Array<{ text: string; x0: number; y0: number; x1: number; y1: number }>
}

interface CachedLiteratureText {
  uri: string
  updatedAt: number
  pages: CachedPageText[]
  extractedAt: number
}

function textCachePath(labId: string, entityUuid: string): string {
  return resolveLabRelativePath(labId, `db/lit-text/${entityUuid}.json`)
}

function indexFilePath(labId: string): string {
  return resolveLabRelativePath(labId, 'db/graphrag-index.json')
}

interface PageLineText {
  text: string
  x0: number
  y0: number
  x1: number
  y1: number
}

interface PageTextWithLines {
  text: string
  lines: PageLineText[]
}

/** 依据 pdfjs 字形坐标重建每页文本与行级文本框（供切块 bbox 联动）。 */
function glyphsToPageText(
  glyphs: Array<{
    char: string
    originX: number
    originY: number
    width: number
    fontSize: number
  }>,
): PageTextWithLines {
  if (glyphs.length === 0) return { text: '', lines: [] }
  const sorted = [...glyphs].sort((a, b) => (a.originY - b.originY) || (a.originX - b.originX))
  const lines: Array<{ y: number; items: typeof glyphs }> = []

  // 顺序聚合（O(n)）：同一行的 y 抖动由字号容差吸收，避免逐字形 find 的 O(n²) 开销。
  for (const glyph of sorted) {
    const tolerance = Math.max(2, (glyph.fontSize || 10) * 0.6)
    const last = lines[lines.length - 1]
    if (last && Math.abs(last.y - glyph.originY) <= tolerance) {
      last.items.push(glyph)
      last.y = (last.y * (last.items.length - 1) + glyph.originY) / last.items.length
    } else {
      lines.push({ y: glyph.originY, items: [glyph] })
    }
  }

  lines.sort((a, b) => a.y - b.y)
  const pageLines: PageLineText[] = []
  for (const line of lines) {
    const items = line.items.sort((a, b) => a.originX - b.originX)
    let text = ''
    let previousEnd = 0
    for (const item of items) {
      const gap = item.originX - previousEnd
      if (text && gap > Math.max(4, (item.fontSize || 10) * 0.45)) text += ' '
      text += item.char
      previousEnd = item.originX + Math.max(0, item.width)
    }
    const trimmed = text.trim()
    if (!trimmed) continue
    const x0 = Math.min(...items.map((item) => item.originX))
    const x1 = Math.max(...items.map((item) => item.originX + Math.max(0, item.width)))
    const y0 = Math.min(...items.map((item) => item.originY - item.fontSize))
    const y1 = Math.max(...items.map((item) => item.originY + Math.max(1, item.fontSize * 0.25)))
    pageLines.push({ text: trimmed, x0, y0, x1, y1 })
  }
  return { text: pageLines.map((line) => line.text).join('\n'), lines: pageLines }
}

async function extractPageText(labId: string, uri: string): Promise<CachedPageText[]> {
  const buffer = await readLiteratureBuffer(labId, uri)
  if (!buffer) throw new Error('无法读取 PDF 文件')
  const { extractPdfGeometry } = await import('@profer/core/pdf-engine')
  // 长综述限 300 页，避免一次性把数百页字形全部驻留内存。
  const geometry = await extractPdfGeometry(buffer, { maxPages: 300 })
  return geometry.pages.map((page) => {
    const { text, lines } = glyphsToPageText(
      page.glyphs.map((glyph) => ({
        char: glyph.char,
        originX: glyph.originX,
        originY: glyph.originY,
        width: glyph.width,
        fontSize: glyph.fontSize,
      })),
    )
    return {
      page: page.pageNumber,
      text,
      width: page.width,
      height: page.height,
      lines,
    }
  })
}

async function loadOrExtractText(
  labId: string,
  entity: { uri: string; entityUuid: string; updatedAt: number },
): Promise<CachedLiteratureText | null> {
  const cachePath = textCachePath(labId, entity.entityUuid)
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(await fs.readFile(cachePath, 'utf-8')) as CachedLiteratureText
      if (cached.uri === entity.uri && cached.updatedAt >= entity.updatedAt) return cached
    } catch {
      // 缓存损坏，重新提取。
    }
  }

  try {
    const pages = await extractPageText(labId, entity.uri)
    const payload: CachedLiteratureText = {
      uri: entity.uri,
      updatedAt: entity.updatedAt,
      pages,
      extractedAt: Date.now(),
    }
    await fs.mkdir(join(cachePath, '..'), { recursive: true })
    await fs.writeFile(cachePath, JSON.stringify(payload), 'utf-8')
    return payload
  } catch (error) {
    console.warn(`[CSLab] 文献文本提取失败（${entity.uri}）:`, error)
    return null
  }
}

function splitIntoChunks(text: string): string[] {
  const normalized = text.replace(/\r/g, '').trim()
  if (!normalized) return []
  const sentences = normalized
    .split(/(?<=[。！？!?；;])|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
  const chunks: string[] = []
  let current = ''

  for (const sentence of sentences) {
    if (sentence.length > CHUNK_TARGET_CHARS) {
      if (current) {
        chunks.push(current)
        current = ''
      }
      for (let index = 0; index < sentence.length; index += CHUNK_TARGET_CHARS) {
        chunks.push(sentence.slice(index, index + CHUNK_TARGET_CHARS))
      }
      continue
    }
    if ((current + sentence).length > CHUNK_TARGET_CHARS && current) {
      chunks.push(current)
      current = sentence
    } else {
      current += sentence
    }
  }
  if (current) chunks.push(current)
  return chunks
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'is', 'are', 'was', 'were', 'be', 'been',
  'for', 'with', 'as', 'by', 'at', 'from', 'that', 'this', 'these', 'those', 'it', 'its',
  '的', '了', '和', '与', '及', '或', '是', '在', '对', '为', '中', '上', '下', '里', '把', '被',
  '请', '我', '你', '他', '她', '它', '这', '那', '有', '无', '不', '也', '就', '都', '会', '能',
])

export function tokenizeLiteratureText(text: string): string[] {
  const lower = text.toLowerCase()
  const tokens: string[] = []
  for (const word of lower.match(/[a-z0-9]{2,}/g) ?? []) {
    if (!STOP_WORDS.has(word)) tokens.push(word)
  }
  const han = lower.match(/[\u4e00-\u9fa5]/g) ?? []
  for (let index = 0; index < han.length; index += 1) {
    const single = han[index]!
    if (!STOP_WORDS.has(single)) tokens.push(single)
    if (index + 1 < han.length) tokens.push(`${single}${han[index + 1]}`)
  }
  return tokens
}

function buildChunkEdges(chunks: LiteratureChunk[]): WeightedEdge[] {
  const edges: WeightedEdge[] = []
  const seen = new Set<string>()
  const add = (a: string, b: string, weight: number): void => {
    if (!a || !b || a === b) return
    const key = a < b ? `${a}|${b}` : `${b}|${a}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ source: a, target: b, weight })
  }

  const byLiterature = new Map<string, LiteratureChunk[]>()
  for (const chunk of chunks) {
    const list = byLiterature.get(chunk.literatureUri) ?? []
    list.push(chunk)
    byLiterature.set(chunk.literatureUri, list)
  }
  for (const list of byLiterature.values()) {
    list.sort((a, b) => a.page - b.page || a.id.localeCompare(b.id))
    for (let index = 1; index < list.length; index += 1) {
      add(list[index - 1]!.id, list[index]!.id, 0.8)
    }
  }

  if (edges.length < MAX_COOCCURRENCE_EDGES) {
    const termIndex = new Map<string, string[]>()
    for (const chunk of chunks) {
      const terms = new Set(tokenizeLiteratureText(`${chunk.title} ${chunk.text}`))
      for (const term of terms) {
        const list = termIndex.get(term) ?? []
        list.push(chunk.id)
        termIndex.set(term, list)
      }
    }
    for (const ids of termIndex.values()) {
      if (ids.length < 2 || ids.length > 8) continue
      for (let i = 0; i < ids.length && edges.length < MAX_COOCCURRENCE_EDGES; i += 1) {
        for (let j = i + 1; j < ids.length && edges.length < MAX_COOCCURRENCE_EDGES; j += 1) {
          add(ids[i]!, ids[j]!, 0.5)
        }
      }
      if (edges.length >= MAX_COOCCURRENCE_EDGES) break
    }
  }
  return edges
}

function computeFingerprint(
  entities: Array<{ uri: string; updatedAt: number; sha256?: string }>,
): string {
  const material = entities
    .map((entity) => `${entity.uri}:${entity.updatedAt}:${entity.sha256 ?? ''}`)
    .sort()
    .join('|')
  return createHash('sha256').update(material).digest('hex')
}

/**
 * 推导每个切块在页内的归一化 bbox。
 *
 * 切块是页文本的连续切片（splitIntoChunks 保序），以移动游标在页文本中顺序定位
 * 每个切块的字符区间，再取覆盖行框的并集。旧缓存（无 lines/width/height）返回
 * undefined，命中时仅跳页不高亮。
 */
function deriveChunkBboxes(
  pageText: string,
  pageChunks: string[],
  page: CachedPageText,
): Array<[number, number, number, number] | undefined> {
  const lines = page.lines
  if (!lines || lines.length === 0 || !page.width || !page.height) {
    return pageChunks.map(() => undefined)
  }

  // 行框与其在页文本（\n 连接）中的字符区间。
  const lineSpans: Array<{ start: number; end: number; line: PageLineText }> = []
  let cursor = 0
  for (const line of lines) {
    const start = pageText.indexOf(line.text, cursor)
    if (start < 0) return pageChunks.map(() => undefined)
    const end = start + line.text.length
    lineSpans.push({ start, end, line })
    cursor = end
  }

  const pageWidth = page.width
  const pageHeight = page.height
  const results: Array<[number, number, number, number] | undefined> = []
  let searchFrom = 0
  for (const chunk of pageChunks) {
    const start = pageText.indexOf(chunk, searchFrom)
    if (start < 0) {
      results.push(undefined)
      continue
    }
    const end = start + chunk.length
    searchFrom = Math.max(searchFrom, start)
    let x0 = Number.POSITIVE_INFINITY
    let y0 = Number.POSITIVE_INFINITY
    let x1 = Number.NEGATIVE_INFINITY
    let y1 = Number.NEGATIVE_INFINITY
    let covered = false
    for (const span of lineSpans) {
      if (span.end <= start || span.start >= end) continue
      covered = true
      x0 = Math.min(x0, span.line.x0)
      y0 = Math.min(y0, span.line.y0)
      x1 = Math.max(x1, span.line.x1)
      y1 = Math.max(y1, span.line.y1)
    }
    results.push(
      covered
        ? [
            Math.max(0, x0 / pageWidth),
            Math.max(0, y0 / pageHeight),
            Math.min(1, x1 / pageWidth),
            Math.min(1, y1 / pageHeight),
          ]
        : undefined,
    )
  }
  return results
}

export async function readLiteratureIndex(labIdInput: string): Promise<LiteratureIndexFile | null> {
  const labId = assertLabId(labIdInput)
  const path = indexFilePath(labId)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(await fs.readFile(path, 'utf-8')) as LiteratureIndexFile
    if (parsed.version !== 1 || !Array.isArray(parsed.chunks)) return null
    // 旧版索引无 edges 字段：容错为空数组，下次 force 重建时自动补全。
    return { ...parsed, edges: Array.isArray(parsed.edges) ? parsed.edges : [] }
  } catch {
    return null
  }
}

export async function getLiteratureIndexStatus(
  labIdInput: string,
): Promise<CsLabLiteratureIndexStatus> {
  const labId = assertLabId(labIdInput)
  const entities = listLiteratureEntities(labId)
  const fingerprint = computeFingerprint(entities)
  const index = await readLiteratureIndex(labId)
  if (!index) {
    return {
      chunkCount: 0,
      communityCount: 0,
      literatureCount: entities.length,
      fingerprint,
    }
  }
  return {
    builtAt: index.builtAt,
    chunkCount: index.chunks.length,
    communityCount: index.communities.length,
    literatureCount: index.literatureCount,
    fingerprint,
  }
}

export interface BuildIndexOptions {
  force?: boolean
}

/** 构建或复用实验室跨文献索引。 */
export async function buildLabLiteratureIndex(
  labIdInput: string,
  options: BuildIndexOptions = {},
): Promise<{ index: LiteratureIndexFile | null; built: boolean; message: string }> {
  const labId = assertLabId(labIdInput)
  const entities = listLiteratureEntities(labId)
  if (entities.length === 0) {
    return { index: null, built: false, message: '实验室中还没有文献' }
  }

  const fingerprint = computeFingerprint(entities)
  const existing = await readLiteratureIndex(labId)
  if (
    !options.force &&
    existing &&
    existing.fingerprint === fingerprint &&
    existing.literatureCount === entities.length
  ) {
    return { index: existing, built: false, message: '索引已是最新' }
  }

  const chunks: LiteratureChunk[] = []
  let extracted = 0
  let processedPages = 0
  for (let entityIndex = 0; entityIndex < entities.length; entityIndex += 1) {
    const entity = entities[entityIndex]!
    const text = await loadOrExtractText(labId, entity)
    if (text) {
      extracted += 1
      for (const page of text.pages) {
        const pageChunks = splitIntoChunks(page.text)
        const bboxes = deriveChunkBboxes(page.text, pageChunks, page)
        pageChunks.forEach((content, index) => {
          chunks.push({
            id: `${entity.uri}#p${page.page}-s${index}`,
            literatureUri: entity.uri,
            title: entity.title,
            page: page.page,
            text: content,
            bbox: bboxes[index],
          })
        })
        processedPages += 1
        // 大篇幅综述会切出大量页文本，定期让出事件循环，避免主进程假死。
        if (processedPages % 200 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
      }
    }
    if ((entityIndex + 1) % 4 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }

  if (chunks.length === 0) {
    return {
      index: null,
      built: false,
      message: extracted === 0 ? '未能从文献中提取文本（可能为扫描版 PDF）' : '文献没有可索引文本',
    }
  }

  const edges = buildChunkEdges(chunks)
  const communities = buildHierarchicalCommunities({
    nodes: chunks.map((chunk) => ({
      id: chunk.id,
      title: `${chunk.title} · p${chunk.page}`,
    })),
    edges,
  })

  const chunkCommunity: Record<string, { id: string; title: string }> = {}
  for (const community of communities) {
    if (community.level !== 0) continue
    for (const member of community.memberEntities) {
      chunkCommunity[member] = { id: community.id, title: community.title }
    }
  }

  const index: LiteratureIndexFile = {
    version: 1,
    builtAt: Date.now(),
    fingerprint,
    literatureCount: entities.length,
    chunks,
    communities,
    chunkCommunity,
    edges,
  }

  const path = indexFilePath(labId)
  await fs.mkdir(join(path, '..'), { recursive: true })
  const tmpPath = `${path}.tmp`
  await fs.writeFile(tmpPath, JSON.stringify(index), 'utf-8')
  await fs.rename(tmpPath, path)

  return {
    index,
    built: true,
    message: `已索引 ${extracted} 篇文献、${chunks.length} 个切块、${communities.length} 个社群`,
  }
}

/**
 * 文献智脑全景图谱（未搜索时的默认视图）。
 *
 * 将切块级索引聚合为文献级节点/边：节点社群取该文献切块的多数 L0 社群，
 * 边按文献对聚合共现权重。复用已持久化的 edges，无需重建索引。
 */
export async function getLiteratureGraph(
  labIdInput: string,
): Promise<CsLabLiteratureGraphResult> {
  const labId = assertLabId(labIdInput)
  const index = await readLiteratureIndex(labId)
  if (!index || index.chunks.length === 0) {
    return {
      ok: false,
      nodes: [],
      edges: [],
      communityCount: 0,
      message: '尚未构建跨文献索引，请先执行索引构建',
    }
  }

  // 文献节点：社群 = 切块 L0 社群多数投票。
  const chunkCountByUri = new Map<string, number>()
  const communityVotes = new Map<string, Map<string, number>>()
  const uriTitle = new Map<string, string>()
  for (const chunk of index.chunks) {
    chunkCountByUri.set(chunk.literatureUri, (chunkCountByUri.get(chunk.literatureUri) ?? 0) + 1)
    uriTitle.set(chunk.literatureUri, chunk.title)
    const community = index.chunkCommunity[chunk.id]
    if (!community) continue
    const votes = communityVotes.get(chunk.literatureUri) ?? new Map<string, number>()
    votes.set(community.id, (votes.get(community.id) ?? 0) + 1)
    communityVotes.set(chunk.literatureUri, votes)
  }

  const communityTitleById = new Map<string, string>()
  for (const community of index.communities) {
    if (community.level === 0) communityTitleById.set(community.id, community.title)
  }

  const nodes: CsLabLiteratureGraphNode[] = [...chunkCountByUri.entries()].map(([uri, count]) => {
    const votes = communityVotes.get(uri)
    let bestId = ''
    let bestCount = -1
    if (votes) {
      for (const [id, count] of votes) {
        if (count > bestCount) {
          bestId = id
          bestCount = count
        }
      }
    }
    return {
      uri,
      title: uriTitle.get(uri) ?? uri,
      communityId: bestId,
      communityTitle: communityTitleById.get(bestId) ?? bestId,
      chunkCount: count,
    }
  })

  // 文献对聚合共现边：chunkId 前缀即 literatureUri。
  const pairWeight = new Map<string, number>()
  for (const edge of index.edges) {
    const source = edge.source.split('#')[0] ?? ''
    const target = edge.target.split('#')[0] ?? ''
    if (!source || !target || source === target) continue
    const key = source < target ? `${source}|${target}` : `${target}|${source}`
    pairWeight.set(key, (pairWeight.get(key) ?? 0) + edge.weight)
  }
  const knownUris = new Set(nodes.map((node) => node.uri))
  const graphEdges: CsLabLiteratureGraphEdge[] = []
  for (const [key, weight] of pairWeight) {
    const [source, target] = key.split('|')
    if (!source || !target || !knownUris.has(source) || !knownUris.has(target)) continue
    graphEdges.push({ source, target, weight })
  }
  graphEdges.sort((a, b) => b.weight - a.weight)

  return {
    ok: true,
    nodes,
    edges: graphEdges,
    communityCount: communityTitleById.size,
    builtAt: index.builtAt,
  }
}
