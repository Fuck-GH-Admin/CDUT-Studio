/**
 * 长期记忆前置检索（Classic RAG）
 *
 * 复用工作区静默 RAG 的成熟算法：纯内存 BM25（词频饱和 + 长度归一化）+ 中英混合词元化
 * （中文单字 + 相邻 bigram、英文/数字整词）+ 标签桥接召回。
 *
 * 与文档检索的差异：
 *   - 语料是「很短的记忆节点」（30~200 字），BM25 长度归一化后强相关文本的原始分通常
 *     只有 0.20~0.30，因此阈值下调至 0.20，并叠加「强命中直通」规则（标签精确命中 /
 *     标题命中 / 查询覆盖率 ≥ 0.6），确保强相关偏好不会被阈值误杀。
 *   - 额外施加 weight / confidence 增益，让高频验证过的偏好优先进入上下文。
 *
 * 红线：纯内存 Map，零 SQLite、零额外磁盘写入；查询走缓存，不进写队列。
 */

import { LONGTERM_MEMORY_CATEGORY_META, type LongTermMemoryHit, type LongTermMemoryNode } from '@profer/shared'
import { getLongTermMemoryGraphPath } from '../config-paths'
import { readLongTermMemoryGraph } from './longterm-memory-store'

// ===== 检索参数 =====

const BM25_K1 = 1.5
const BM25_B = 0.75
const DEFAULT_TOP_K = 4
/** 单条记忆极短，阈值必须低于文档检索（0.35） */
const MIN_SCORE = 0.2
/** 注入块总字符预算 */
const BLOCK_MAX_CHARS = 1400
const EXCERPT_MAX_CHARS = 200
/** 单标签命中加分（最多叠加 2 个） */
const TAG_BRIDGE_BONUS = 0.5
const TAG_BRIDGE_MAX_MATCHES = 2
/** 查询覆盖率直通阈值 */
const COVERAGE_BYPASS = 0.6
/** 标题覆盖率直通阈值 */
const TITLE_COVERAGE_BYPASS = 0.5

/** 中文 / 英文常见停用词（与 workspace-rag-service 同口径） */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'is', 'are', 'was', 'were', 'be', 'been',
  'for', 'with', 'as', 'by', 'at', 'from', 'that', 'this', 'these', 'those', 'it', 'its',
  '的', '了', '和', '与', '及', '或', '是', '在', '对', '为', '中', '上', '下', '里', '把', '被',
  '请', '我', '你', '他', '她', '它', '这', '那', '有', '无', '不', '也', '就', '都', '会', '能',
])

/**
 * 词元化：兼容中文（单字 + 相邻 bigram）与英文/数字。
 * 例：`状态管理` → 状 / 态 / 管 / 理 / 状态 / 态管 / 管理。
 */
export function tokenizeLongTermMemoryText(text: string): string[] {
  const lower = text.toLowerCase()
  const tokens: string[] = []
  for (const word of lower.match(/[a-z0-9]{2,}/g) ?? []) {
    if (!STOP_WORDS.has(word)) tokens.push(word)
  }
  const han = lower.match(/[\u4e00-\u9fa5]/g) ?? []
  for (let i = 0; i < han.length; i++) {
    const single = han[i]!
    if (!STOP_WORDS.has(single)) tokens.push(single)
    if (i + 1 < han.length) tokens.push(`${single}${han[i + 1]}`)
  }
  return tokens
}

// ===== 索引 =====

interface MemoryDoc {
  node: LongTermMemoryNode
  termFreq: Map<string, number>
  length: number
  titleTerms: Set<string>
}

interface MemoryIndex {
  revision: string
  docs: MemoryDoc[]
  docFreq: Map<string, number>
  avgLength: number
}

const indexCache = new Map<string, MemoryIndex>()

function buildDoc(node: LongTermMemoryNode): MemoryDoc {
  const text = `${node.title}\n${node.content}\n${node.tags.join(' ')}`
  const terms = tokenizeLongTermMemoryText(text)
  const termFreq = new Map<string, number>()
  for (const term of terms) {
    termFreq.set(term, (termFreq.get(term) ?? 0) + 1)
  }
  return {
    node,
    termFreq,
    length: terms.length,
    titleTerms: new Set(tokenizeLongTermMemoryText(node.title)),
  }
}

function revisionOf(nodes: LongTermMemoryNode[], fallback: number): string {
  let maxUpdatedAt = fallback
  for (const node of nodes) {
    if (node.updatedAt > maxUpdatedAt) maxUpdatedAt = node.updatedAt
  }
  return `${maxUpdatedAt}:${nodes.length}`
}

function getIndex(graphPath: string): MemoryIndex {
  const graph = readLongTermMemoryGraph(graphPath)
  const revision = revisionOf(graph.nodes, graph.updatedAt)
  const cached = indexCache.get(graphPath)
  if (cached && cached.revision === revision) return cached

  const docs = graph.nodes.map(buildDoc)
  const docFreq = new Map<string, number>()
  let totalLength = 0
  for (const doc of docs) {
    totalLength += doc.length
    for (const term of doc.termFreq.keys()) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1)
    }
  }
  const index: MemoryIndex = {
    revision,
    docs,
    docFreq,
    avgLength: docs.length > 0 ? totalLength / docs.length : 0,
  }
  indexCache.set(graphPath, index)
  return index
}

// ===== 打分 =====

function scoreBm25(index: MemoryIndex, doc: MemoryDoc, queryTerms: readonly string[]): number {
  let score = 0
  const avgLength = index.avgLength > 0 ? index.avgLength : 1
  for (const term of queryTerms) {
    const tf = doc.termFreq.get(term) ?? 0
    if (tf === 0) continue
    const df = index.docFreq.get(term) ?? 0
    const idf = Math.log(1 + (index.docs.length - df + 0.5) / (df + 0.5))
    const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / avgLength))
    score += idf * ((tf * (BM25_K1 + 1)) / denominator)
  }
  return score
}

/** 标签桥接：标签整词出现在原查询中，或标签的全部词元都被查询覆盖 */
function countMatchedTags(node: LongTermMemoryNode, queryTerms: Set<string>, queryLower: string): number {
  let matched = 0
  for (const tag of node.tags) {
    const tagLower = tag.toLowerCase().trim()
    if (!tagLower) continue
    if (queryLower.includes(tagLower)) {
      matched += 1
      continue
    }
    const tagTerms = tokenizeLongTermMemoryText(tagLower)
    if (tagTerms.length > 0 && tagTerms.every((term) => queryTerms.has(term))) {
      matched += 1
    }
  }
  return Math.min(matched, TAG_BRIDGE_MAX_MATCHES)
}

function countOverlap(terms: ReadonlySet<string>, target: { has(value: string): boolean }): number {
  let count = 0
  for (const term of terms) {
    if (target.has(term)) count += 1
  }
  return count
}

/** 取与查询重叠度最高的句子作为证据摘录 */
function buildExcerpt(node: LongTermMemoryNode, queryTerms: Set<string>): string {
  const sentences = node.content
    .split(/(?<=[。！？!?\n])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)

  let best = ''
  let bestOverlap = -1
  for (const sentence of sentences) {
    const overlap = countOverlap(new Set(tokenizeLongTermMemoryText(sentence)), queryTerms)
    if (overlap > bestOverlap) {
      bestOverlap = overlap
      best = sentence
    }
  }
  const source = best || node.content
  return source.length > EXCERPT_MAX_CHARS ? `${source.slice(0, EXCERPT_MAX_CHARS)}…` : source
}

export interface LongTermMemorySearchOptions {
  topK?: number
  minScore?: number
  graphPath?: string
}

/**
 * 检索长期记忆节点。
 * 只读、纯内存；缓存按图谱 revision 失效，不阻塞、不进写队列。
 */
export function searchLongTermMemory(
  query: string,
  options: LongTermMemorySearchOptions = {},
): LongTermMemoryHit[] {
  const trimmed = query.trim()
  if (!trimmed) return []

  const graphPath = options.graphPath ?? getLongTermMemoryGraphPath()
  const topK = Math.max(1, options.topK ?? DEFAULT_TOP_K)
  const minScore = options.minScore ?? MIN_SCORE

  const index = getIndex(graphPath)
  if (index.docs.length === 0) return []

  const queryTermsList = tokenizeLongTermMemoryText(trimmed)
  if (queryTermsList.length === 0) return []
  const queryTerms = new Set(queryTermsList)
  const queryLower = trimmed.toLowerCase()

  const scored: Array<{ doc: MemoryDoc; score: number; bypass: boolean }> = []
  for (const doc of index.docs) {
    const bm25 = scoreBm25(index, doc, queryTermsList)
    if (bm25 <= 0) continue

    const tagMatches = countMatchedTags(doc.node, queryTerms, queryLower)
    const weightBoost = 0.6 + 0.4 * Math.min(1, doc.node.weight / 10)
    const confidenceBoost = 0.7 + 0.3 * doc.node.confidence
    const score = bm25 * weightBoost * confidenceBoost + tagMatches * TAG_BRIDGE_BONUS

    const queryOverlap = countOverlap(queryTerms, doc.termFreq)
    const queryCoverage = queryOverlap / queryTerms.size
    const titleCoverage = countOverlap(queryTerms, doc.titleTerms) / queryTerms.size
    // 直通必须至少命中一个「有实义」词元（英文整词或中文 bigram），避免单字噪声灌入
    const meaningfulHit = [...queryTerms].some(
      (term) => term.length >= 2 && doc.termFreq.has(term),
    )
    const bypass =
      meaningfulHit && (tagMatches > 0 || queryCoverage >= COVERAGE_BYPASS || titleCoverage >= TITLE_COVERAGE_BYPASS)

    if (!bypass && score < minScore) continue
    scored.push({ doc, score, bypass })
  }

  scored.sort((a, b) => b.score - a.score)

  return scored.slice(0, topK).map(({ doc, score }) => ({
    node: { ...doc.node, tags: [...doc.node.tags] },
    score,
    excerpt: buildExcerpt(doc.node, queryTerms),
  }))
}

/**
 * 组装 `<user_longterm_memory>` 上下文块；无命中返回空串。
 *
 * 该块只会进入 `<SYSTEM_CONTEXT>`，绝不进入 `<USER_REQUEST>`，
 * 也不触碰静态 System Prompt，因此厂商前缀缓存 100% 命中。
 */
export function buildLongTermMemoryBlock(
  query: string,
  options: LongTermMemorySearchOptions = {},
): string {
  const hits = searchLongTermMemory(query, options)
  if (hits.length === 0) return ''

  const header = [
    '<user_longterm_memory>',
    'Retrieved long-term habits and preferences about this user (auto-learned or user-edited).',
    'Treat them as soft defaults: follow them naturally, never quote or mention this block,',
    'and when a listed tool or workflow clearly fits the current request, recommend it briefly at most once.',
  ].join('\n')
  const footer = '</user_longterm_memory>'

  const lines: string[] = []
  let length = header.length + footer.length + 2
  for (const hit of hits) {
    const label = LONGTERM_MEMORY_CATEGORY_META[hit.node.category].promptLabel
    const content = hit.node.content.length > EXCERPT_MAX_CHARS
      ? `${hit.node.content.slice(0, EXCERPT_MAX_CHARS)}…`
      : hit.node.content
    const line = `- [${label}] ${content} (confidence ${hit.node.confidence.toFixed(2)})`
    if (lines.length > 0 && length + line.length + 1 > BLOCK_MAX_CHARS) break
    lines.push(line)
    length += line.length + 1
  }
  if (lines.length === 0) return ''

  return `${header}\n${lines.join('\n')}\n${footer}`
}

/** 供测试或外部显式失效使用 */
export function invalidateLongTermMemoryIndex(): void {
  indexCache.clear()
}
