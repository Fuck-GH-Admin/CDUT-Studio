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
import type { CsLabLiteratureIndexStatus } from '@profer/shared'
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
}

interface CachedPageText {
  page: number
  text: string
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

/** 依据 pdfjs 字形坐标重建每页文本。 */
function glyphsToPageText(
  glyphs: Array<{
    char: string
    originX: number
    originY: number
    fontSize: number
  }>,
): string {
  if (glyphs.length === 0) return ''
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
  return lines
    .map((line) => {
      const items = line.items.sort((a, b) => a.originX - b.originX)
      let text = ''
      let previousEnd = 0
      for (const item of items) {
        const gap = item.originX - previousEnd
        if (text && gap > Math.max(4, (item.fontSize || 10) * 0.45)) text += ' '
        text += item.char
        previousEnd = item.originX + Math.max(0, item.fontSize * 0.5)
      }
      return text.trim()
    })
    .filter(Boolean)
    .join('\n')
}

async function extractPageText(labId: string, uri: string): Promise<CachedPageText[]> {
  const buffer = await readLiteratureBuffer(labId, uri)
  if (!buffer) throw new Error('无法读取 PDF 文件')
  const { extractPdfGeometry } = await import('@profer/core/pdf-engine')
  // 长综述限 300 页，避免一次性把数百页字形全部驻留内存。
  const geometry = await extractPdfGeometry(buffer, { maxPages: 300 })
  return geometry.pages.map((page) => ({
    page: page.pageNumber,
    text: glyphsToPageText(
      page.glyphs.map((glyph) => ({
        char: glyph.char,
        originX: glyph.originX,
        originY: glyph.originY,
        fontSize: glyph.fontSize,
      })),
    ),
  }))
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

export async function readLiteratureIndex(labIdInput: string): Promise<LiteratureIndexFile | null> {
  const labId = assertLabId(labIdInput)
  const path = indexFilePath(labId)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(await fs.readFile(path, 'utf-8')) as LiteratureIndexFile
    if (parsed.version !== 1 || !Array.isArray(parsed.chunks)) return null
    return parsed
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
        pageChunks.forEach((content, index) => {
          chunks.push({
            id: `${entity.uri}#p${page.page}-s${index}`,
            literatureUri: entity.uri,
            title: entity.title,
            page: page.page,
            text: content,
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
