/**
 * 工作区静默 RAG 供给服务（Workspace Silent RAG）
 *
 * 职责：
 *   把会话工作区内由内核前置解析并双态落盘的文档产物（`.context/artifacts/*.index.json`）
 *   在内存中切成带真实物理锚点（如 `f3:p3-b1`）的检索切片，建立纯内存 BM25 倒排索引；
 *   在用户提问时前置检索最相关的 Top-K 切片，组装为极度紧凑的 `<document_evidence>` 块，
 *   使模型在首轮（Turn 1）即可直接精准作答并携带可点击定位胶囊，彻底消除工具调用爆炸。
 *
 * 严格红线约束：
 *   - 纯本地运行，零 SQLite、零重型数据库，全部内存 Map 结构；
 *   - 零额外磁盘写操作，直接复用既有的 `.index.json` 落盘产物；
 *   - 复用 `document-parse-tools` 的锚点与几何元数据，绝不重复解析原始文档。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  upgradeStaleOfficeIndexIfNeeded,
  type DocumentAnchorBlockMeta,
  type MaterializedDocumentIndex,
} from '../document-parse-tools'
import { buildEntityIndex, findRelationalBridges, type EntityIndex } from './entity-graph'

// ===== 检索参数常量 =====

/** BM25 词频饱和系数 */
const BM25_K1 = 1.5
/** BM25 长度归一化系数 */
const BM25_B = 0.75
/** 默认召回切片数 */
const DEFAULT_TOP_K = 5
/** 单切片注入 `<document_evidence>` 的字符上限（覆盖完整单页花名册/任职名单，避免截断丢失尾部实体） */
const EVIDENCE_EXCERPT_MAX_CHARS = 1200
/** `<document_evidence>` 块的总字符预算 */
const EVIDENCE_BLOCK_MAX_CHARS = 5200

/** 中文 / 英文常见停用词（检索噪音，直接剔除） */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'is', 'are', 'was', 'were', 'be', 'been',
  'for', 'with', 'as', 'by', 'at', 'from', 'that', 'this', 'these', 'those', 'it', 'its',
  '的', '了', '和', '与', '及', '或', '是', '在', '对', '为', '中', '上', '下', '里', '把', '被',
  '请', '我', '你', '他', '她', '它', '这', '那', '有', '无', '不', '也', '就', '都', '会', '能',
])

/**
 * 词元化：兼容中文（单字 + 相邻 bigram）与英文 / 数字 / 希腊字母。
 * 例：`马晨超` → 马 / 晨 / 超 / 马晨 / 晨超。
 */
function tokenize(text: string): string[] {
  const cleaned = text.replace(/\[#[a-zA-Z]+\d+:p\d+-b\d+(?:\s*\([^\)]*\))?\]/g, ' ')
  const lower = cleaned.toLowerCase()
  const tokens: string[] = []
  for (const word of lower.match(/[a-z0-9]{2,}/g) ?? []) {
    if (!STOP_WORDS.has(word)) tokens.push(word)
  }
  for (const greek of lower.match(/[\u0370-\u03ff]{1,2}/g) ?? []) {
    if (!STOP_WORDS.has(greek)) tokens.push(greek)
  }
  const han = lower.match(/[\u4e00-\u9fa5]/g) ?? []
  for (let i = 0; i < han.length; i++) {
    const single = han[i]!
    if (!STOP_WORDS.has(single)) tokens.push(single)
    if (i + 1 < han.length) tokens.push(`${single}${han[i + 1]}`)
  }
  return tokens
}

// ===== 切片与索引结构 =====

/** 工作区文档检索切片 */
export interface WorkspaceRagChunk {
  chunkId: string
  /** 会话级文件标识（如 "f3"） */
  fileId: string
  fileName: string
  /** 真实物理锚点（如 "f3:p3-b1"） */
  anchorId: string
  /** 人类可读位置标签（如 "工管2班·A1:B22" 或 "第3页"） */
  locLabel: string
  pageNumber: number
  sheetName?: string
  cellRef?: string
  bbox?: [number, number, number, number]
  /** 该切片的纯净 Markdown 正文 */
  content: string
  /** 词频（仅内存态，不落盘） */
  termFreq: Map<string, number>
  length: number
}

/** 检索命中项 */
export interface WorkspaceRagHit {
  chunk: WorkspaceRagChunk
  score: number
  excerpt: string
}

interface WorkspaceRagIndex {
  chunks: WorkspaceRagChunk[]
  docFreq: Map<string, number>
  avgLength: number
  /** 跨文档二分实体图（与切片同源，仅索引重建时重算） */
  entityIndex: EntityIndex
}

// ===== 索引缓存 =====

/** 工作区 cwd → { 轻量指纹, 内存倒排索引 }（仅指纹变化时重建） */
const cache = new Map<string, { fingerprint: string; index: WorkspaceRagIndex }>()

/** 取裸 blockId（剥离 `fN:` 命名空间前缀） */
function bareBlockId(scopedId: string | undefined): string {
  if (!scopedId) return ''
  const idx = scopedId.indexOf(':')
  return idx >= 0 ? scopedId.slice(idx + 1) : scopedId
}

/** 读取工作区已落盘的文档索引产物（如遇旧版 Office 索引则静默原地升级） */
function readArtifactIndices(artifactsDir: string): MaterializedDocumentIndex[] {
  const indices: MaterializedDocumentIndex[] = []
  let files: string[] = []
  try {
    files = readdirSync(artifactsDir).filter((f) => f.endsWith('.index.json'))
  } catch {
    return indices
  }
  for (const file of files) {
    try {
      const fullPath = resolve(artifactsDir, file)
      const parsed = JSON.parse(readFileSync(fullPath, 'utf-8')) as MaterializedDocumentIndex
      indices.push(upgradeStaleOfficeIndexIfNeeded(parsed, fullPath))
    } catch {
      // 忽略损坏的索引
    }
  }
  return indices
}

/** 轻量指纹：仅对 `.index.json` 做目录枚举与 stat，不读取内容 */
function computeFingerprint(artifactsDir: string): string {
  if (!existsSync(artifactsDir)) return 'empty'
  const parts: string[] = []
  try {
    for (const file of readdirSync(artifactsDir)) {
      if (!file.endsWith('.index.json')) continue
      try {
        const stat = statSync(join(artifactsDir, file))
        parts.push(`${file}:${stat.size}:${stat.mtimeMs}`)
      } catch {
        // 缺失/不可读的文件不参与指纹
      }
    }
  } catch {
    return 'empty'
  }
  parts.sort()
  return parts.length > 0 ? parts.join('|') : 'empty'
}

/**
 * 将带 `<!-- anchor: fN:pX-bY ... -->` 的页面 Markdown 压缩为带行内块锚点 `[#fN:pX-bY]` 的紧凑正文，
 * 使模型在 `<document_evidence>` 中能直接看到每个段落/形状的精确块级锚点。
 */
function buildInlineAnchoredContent(
  anchoredText: string | undefined,
  cleanText: string | undefined,
  fileId: string,
): string {
  const rawAnchored = (anchoredText ?? '').trim()
  if (rawAnchored && rawAnchored.includes('<!-- anchor:')) {
    const inlined = rawAnchored
      .replace(/<span\s+id="[^"]*"[^>]*><\/span>\s*/g, '')
      .replace(
        /<!--\s*anchor:\s*(?:([a-zA-Z]+\d+):)?(p\d+-b\d+)\s*\[[^\]]*\](?:[^>]*?cell="([^"]*)")?[^>]*-->\s*/g,
        (_m, fId: string | undefined, blockId: string, cell: string | undefined) => {
          const scoped = `${(fId || fileId).toLowerCase()}:${blockId}`
          return cell ? `[#${scoped} (${cell})] ` : `[#${scoped}] `
        },
      )
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    if (inlined) return inlined
  }
  return (cleanText ?? '').trim()
}

/** 由单份文档索引构建切片集合 */
function buildChunksFromIndex(index: MaterializedDocumentIndex): WorkspaceRagChunk[] {
  const fileId = index.fileId || 'f1'
  const fileName = index.sourceName || index.artifactId || fileId
  const chunks: WorkspaceRagChunk[] = []

  for (const page of index.pages ?? []) {
    const content = buildInlineAnchoredContent(page.anchoredText, page.cleanText, fileId)
    if (!content) continue

    const blockKey = bareBlockId(page.firstBlockId)
    const blockMeta: DocumentAnchorBlockMeta | undefined = blockKey ? index.blocks?.[blockKey] : undefined
    const anchorId = page.firstBlockId ?? `${fileId}:p${page.pageNumber}-b1`
    const locLabel = blockMeta?.loc || (page.headings[0] ? `Page ${page.pageNumber} · ${page.headings[0]}` : `Page ${page.pageNumber}`)

    const termFreq = new Map<string, number>()
    const words = tokenize(content)
    for (const word of words) termFreq.set(word, (termFreq.get(word) ?? 0) + 1)

    chunks.push({
      chunkId: `${fileId}:p${page.pageNumber}`,
      fileId,
      fileName,
      anchorId,
      locLabel,
      pageNumber: page.pageNumber,
      ...(blockMeta?.sheetName ? { sheetName: blockMeta.sheetName } : {}),
      ...(blockMeta?.cellRef ? { cellRef: blockMeta.cellRef } : {}),
      ...(blockMeta?.bbox ? { bbox: blockMeta.bbox } : {}),
      content,
      termFreq,
      length: Math.max(1, words.length),
    })
  }

  return chunks
}

/** 构建（必要时重建）指定工作区的内存倒排索引 */
function getIndex(agentCwd: string): WorkspaceRagIndex {
  const artifactsDir = join(agentCwd, '.context', 'artifacts')
  const fingerprint = computeFingerprint(artifactsDir)
  const cached = cache.get(agentCwd)
  if (cached && cached.fingerprint === fingerprint) return cached.index

  const chunks: WorkspaceRagChunk[] = []
  const docFreq = new Map<string, number>()
  let totalLength = 0

  for (const index of readArtifactIndices(artifactsDir)) {
    for (const chunk of buildChunksFromIndex(index)) {
      for (const term of chunk.termFreq.keys()) docFreq.set(term, (docFreq.get(term) ?? 0) + 1)
      chunks.push(chunk)
      totalLength += chunk.length
    }
  }

  const built: WorkspaceRagIndex = {
    chunks,
    docFreq,
    avgLength: chunks.length > 0 ? totalLength / chunks.length : 1,
    entityIndex: buildEntityIndex(chunks.map((chunk) => chunk.content)),
  }
  cache.set(agentCwd, { fingerprint, index: built })
  return built
}

/** 该工作区是否存在可供检索的已解析文档 */
export function hasWorkspaceDocuments(agentCwd: string): boolean {
  if (!agentCwd) return false
  return computeFingerprint(join(agentCwd, '.context', 'artifacts')) !== 'empty'
}

/** 失效指定（或全部）工作区的索引缓存 */
export function invalidateWorkspaceRag(agentCwd?: string): void {
  if (agentCwd) cache.delete(agentCwd)
  else cache.clear()
}

// ===== 检索与显著性剪枝 =====

/** 提取与 Query（及跨文档关联键）最相关的关键片段 */
function buildExcerpt(
  content: string,
  queryTerms: readonly string[],
  sharedKeys: readonly string[] = [],
): string {
  const compact = content.replace(/[ \t]+\n/g, '\n').trim()
  if (compact.length <= EVIDENCE_EXCERPT_MAX_CHARS) return compact

  // 当存在跨文档共享关联键（如学号/寝室号）且全文超长时，优先聚合所有命中关联键与查询词的行（保留表头），防止截断漏掉尾部关联实体
  if (sharedKeys.length > 0) {
    const lines = compact.split('\n')
    const matchedLines: string[] = []
    let chars = 0
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      const lower = line.toLowerCase()
      const isHeader = i < 3 || line.startsWith('###') || line.includes('---')
      const hitsShared = sharedKeys.some((k) => lower.includes(k.toLowerCase()))
      const hitsQuery = queryTerms.some((t) => t.length >= 2 && lower.includes(t))
      if (isHeader || hitsShared || hitsQuery) {
        if (chars + line.length + 1 <= EVIDENCE_EXCERPT_MAX_CHARS) {
          matchedLines.push(line)
          chars += line.length + 1
        }
      }
    }
    if (matchedLines.length > 0) {
      return matchedLines.join('\n')
    }
  }

  // 优先以命中词第一次出现的位置为中心开窗
  let anchor = -1
  for (const term of queryTerms) {
    if (term.length < 2) continue
    const pos = compact.toLowerCase().indexOf(term)
    if (pos >= 0 && (anchor < 0 || pos < anchor)) anchor = pos
  }
  if (anchor < 0) return `${compact.slice(0, EVIDENCE_EXCERPT_MAX_CHARS)}…`

  const half = Math.floor(EVIDENCE_EXCERPT_MAX_CHARS / 2)
  const start = Math.max(0, anchor - half)
  const end = Math.min(compact.length, start + EVIDENCE_EXCERPT_MAX_CHARS)
  return `${start > 0 ? '…' : ''}${compact.slice(start, end)}${end < compact.length ? '…' : ''}`
}

/** BM25 打分：返回按得分降序、仅保留有分切片的 { 切片下标, 得分 } 列表 */
function scoreQuery(
  index: WorkspaceRagIndex,
  queryTerms: readonly string[],
): Array<{ index: number; score: number }> {
  const totalChunks = index.chunks.length
  const scored: Array<{ index: number; score: number }> = []
  for (let i = 0; i < index.chunks.length; i++) {
    const chunk = index.chunks[i]!
    let score = 0
    for (const term of queryTerms) {
      const tf = chunk.termFreq.get(term)
      if (!tf) continue
      const df = index.docFreq.get(term) ?? 0
      const idf = Math.log(1 + (totalChunks - df + 0.5) / (df + 0.5))
      const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * chunk.length) / index.avgLength)
      score += idf * ((tf * (BM25_K1 + 1)) / denom)
    }
    if (score > 0) scored.push({ index: i, score })
  }
  return scored.sort((a, b) => b.score - a.score)
}

/**
 * 跨文档 BM25 检索：召回与用户提问最相关的 Top-K 文档切片。
 */
export function searchWorkspaceRag(
  agentCwd: string,
  query: string,
  options: { topK?: number } = {},
): WorkspaceRagHit[] {
  if (!agentCwd) return []
  const trimmed = query.trim()
  if (!trimmed) return []

  const index = getIndex(agentCwd)
  if (index.chunks.length === 0) return []

  const queryTerms = tokenize(trimmed)
  if (queryTerms.length === 0) return []

  const topK = Math.max(1, options.topK ?? DEFAULT_TOP_K)
  return scoreQuery(index, queryTerms)
    .slice(0, topK)
    .map(({ index: chunkIndex, score }) => {
      const chunk = index.chunks[chunkIndex]!
      return { chunk, score, excerpt: buildExcerpt(chunk.content, queryTerms) }
    })
}

// ===== `<document_evidence>` 组装 =====

/** 把检索命中组装为紧凑的 `<document_evidence>` 块；无命中返回空串 */
export function formatDocumentEvidence(
  hits: WorkspaceRagHit[],
  relationalSharedKeys: readonly string[] = [],
): string {
  if (hits.length === 0) return ''

  const sections: string[] = []
  let used = 0
  for (const hit of hits) {
    const sheet = hit.chunk.sheetName ? ` | Sheet: ${hit.chunk.sheetName}` : ''
    const cell = hit.chunk.cellRef ? ` | Cell: ${hit.chunk.cellRef}` : ''
    const section =
      `[Source: ${hit.chunk.fileName} | Location: ${hit.chunk.locLabel}${sheet}${cell} | Anchor: #${hit.chunk.anchorId}]\n` +
      hit.excerpt
    if (used + section.length > EVIDENCE_BLOCK_MAX_CHARS && sections.length > 0) break
    sections.push(section)
    used += section.length
  }
  if (sections.length === 0) return ''

  const relationalNote =
    relationalSharedKeys.length > 0
      ? `<!-- Cross-document entity linkage: the chunks above are connected across documents through the shared identifiers [${relationalSharedKeys.join(', ')}]. Combine evidence from multiple documents when answering. -->`
      : ''

  return [
    '<document_evidence>',
    '<!-- The kernel pre-retrieved and injected the most relevant document excerpts and location anchors below based on the query. Trust this content 100% and answer directly from it; when citing sources, use the anchor markers directly (e.g., [location description](#fN:pX-bY)). -->',
    ...(relationalNote ? [relationalNote] : []),
    ...sections,
    '</document_evidence>',
  ].join('\n')
}

/**
 * 一站式入口：对工作区文档执行静默 RAG 检索并组装 `<document_evidence>` 块。
 *
 * 除常规 BM25 Top-K 外，额外执行「跨文档关系 Join」：当种子切片分属不同文档且通过
 * 共享学号/寝室号等高基数键建立联系时，把另一份文档的关联切片一并注入，
 * 解决「A 有班级无角色、B 有角色无班级」的实体孤岛问题，封死模型自写脚本 Join 的冲动。
 * 工作区无文档或检索无命中时返回空串，绝不注入任何内容。
 */
export function buildDocumentEvidenceForMessage(
  agentCwd: string,
  query: string,
  options: { topK?: number } = {},
): string {
  if (!agentCwd || !hasWorkspaceDocuments(agentCwd)) return ''
  const trimmed = query.trim()
  if (!trimmed) return ''

  const index = getIndex(agentCwd)
  if (index.chunks.length === 0) return ''
  const queryTerms = tokenize(trimmed)
  if (queryTerms.length === 0) return ''

  const topK = Math.max(1, options.topK ?? DEFAULT_TOP_K)
  const ranked = scoreQuery(index, queryTerms).slice(0, topK)
  if (ranked.length === 0) return ''

  // 跨文档关系 Join：以种子切片的高基数键为桥，召回其它文档的关联切片
  const bridges = findRelationalBridges(
    index.entityIndex,
    ranked.map((entry) => entry.index),
    (chunkIndex) => index.chunks[chunkIndex]?.fileId ?? '',
  )

  const hits: WorkspaceRagHit[] = ranked.map(({ index: chunkIndex, score }) => {
    const chunk = index.chunks[chunkIndex]!
    return {
      chunk,
      score,
      excerpt: buildExcerpt(chunk.content, queryTerms, bridges.sharedKeys),
    }
  })

  for (const bridgeIndex of bridges.bridgeIndices) {
    const chunk = index.chunks[bridgeIndex]
    if (!chunk) continue
    hits.push({
      chunk,
      score: 0,
      excerpt: buildExcerpt(chunk.content, [...queryTerms, ...bridges.sharedKeys], bridges.sharedKeys),
    })
  }

  return formatDocumentEvidence(hits, bridges.sharedKeys)
}
