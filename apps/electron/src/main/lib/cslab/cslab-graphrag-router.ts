/**
 * 实验室跨文献分层检索路由
 *
 * 复用 study/hierarchical-graphrag.ts 的 Leiden 分层社区；
 * 检索为 Hybrid 混合融合：向量（本地 ONNX 嵌入）+ 词法 BM25 近似 + Leiden 社群，
 * 三路排名经 Reciprocal Rank Fusion（RRF）聚合，chunkId 强对齐（Map O(1) 聚合）。
 *
 * 红线：
 * 1. RRF 权重集中在 RRF_CONFIG，禁止散落硬编码；
 * 2. 向量路缺席（嵌入器不可用）时自动降级为 BM25 + 社群两路，检索永不因嵌入失败不可用；
 * 3. 向量索引与 GraphRAG 索引同 chunkId 对齐，重建时增量同步（未变化文献不重复嵌入）。
 */

import { join } from 'node:path'
import type {
  CsLabLiteratureSearchHit,
  CsLabLiteratureSearchInput,
  CsLabLiteratureSearchResult,
} from '@profer/shared'
import {
  buildLabLiteratureIndex,
  getLiteratureIndexStatus,
  readLiteratureIndex,
  tokenizeLiteratureText,
  type LiteratureChunk,
  type LiteratureIndexFile,
} from './cslab-literature-index'
import { assertLabId, resolveLabDir } from './cslab-paths'
import {
  createDefaultEmbedder,
  deleteLiteratureChunks,
  getLiteratureVectorStore,
  searchLiteratureVectors,
  upsertLiteratureChunks,
  type Embedder,
} from './cslab-vector-store'

const DEFAULT_TOP_K = 5
const MAX_TOP_K = 20
const EXCERPT_MAX_CHARS = 500

/** RRF 融合配置（集中常量，禁止散落硬编码；预留 IPC/设置扩展权重）。 */
export const RRF_CONFIG = {
  k: 60,
  wVector: 1.0,
  wBm25: 1.0,
  wCommunity: 0.5,
} as const

/** 向量检索候选量：融合前放宽召回，RRF 再截断 topK。 */
const VECTOR_CANDIDATE_MULTIPLIER = 4

/** 同一实验室只允许一个后台重建任务，避免检索抖动触发重复构建。 */
const pendingIndexBuilds = new Map<string, Promise<void>>()
/** 需要重建的实验室（防抖窗口内多次变更合并为一次）。 */
const dirtyIndexLabs = new Set<string>()
const indexRebuildTimers = new Map<string, NodeJS.Timeout>()
const INDEX_REBUILD_DEBOUNCE_MS = 500

/** 共享嵌入器（transformers.js 懒加载单飞；null = 本地嵌入不可用，降级纯词法）。 */
let sharedEmbedderPromise: Promise<Embedder | null> | null = null
function getSharedEmbedder(): Promise<Embedder | null> {
  if (!sharedEmbedderPromise) {
    sharedEmbedderPromise = createDefaultEmbedder().catch((error: unknown) => {
      console.warn('[CSLab] 本地嵌入器初始化失败，检索降级纯词法:', error)
      return null
    })
  }
  return sharedEmbedderPromise
}

/** 立即执行所有防抖中的索引重建并等待完成（删除/重置实验室前调用）。 */
export async function flushLiteratureIndexRebuilds(timeoutMs = 15_000): Promise<void> {
  for (const [labId, timer] of indexRebuildTimers) {
    clearTimeout(timer)
    indexRebuildTimers.delete(labId)
    if (dirtyIndexLabs.has(labId)) startIndexRebuild(labId)
  }
  const pending = [...pendingIndexBuilds.values()]
  if (pending.length === 0) return
  await Promise.race([
    Promise.allSettled(pending).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ])
}

function startIndexRebuild(labId: string): void {
  if (pendingIndexBuilds.has(labId)) return
  dirtyIndexLabs.delete(labId)
  const task = buildLabLiteratureIndex(labId)
    .then((built) => {
      // 向量索引随 GraphRAG 索引增量同步（后台，不阻塞重建完成）。
      if (built.index) void syncVectorIndex(labId, built.index)
    })
    .catch((error: unknown) => {
      console.warn('[CSLab] 后台重建文献索引失败:', error)
    })
    .finally(() => {
      pendingIndexBuilds.delete(labId)
      // 构建期间又有新变更：再排一轮，保证最终一致。
      if (dirtyIndexLabs.has(labId)) scheduleLiteratureIndexRebuild(labId)
    })
  pendingIndexBuilds.set(labId, task)
}

/**
 * 后台单飞 + 防抖重建文献索引；失败只记录警告，不影响本次检索。
 *
 * 批量入笼 PDF 时，500ms 窗口内的多次触发会合并，避免密集争抢 SQLite 锁。
 */
export function scheduleLiteratureIndexRebuild(labId: string): void {
  dirtyIndexLabs.add(labId)
  if (pendingIndexBuilds.has(labId)) return
  const existing = indexRebuildTimers.get(labId)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    indexRebuildTimers.delete(labId)
    if (dirtyIndexLabs.has(labId)) startIndexRebuild(labId)
  }, INDEX_REBUILD_DEBOUNCE_MS)
  indexRebuildTimers.set(labId, timer)
}

// ===== 向量索引增量同步 =====

const pendingVectorSyncs = new Map<string, Promise<void>>()

/**
 * 将 GraphRAG 切块增量同步进向量库（同 chunkId 强对齐）：
 * 未变化文献零嵌入成本；变更文献整篇重嵌；消失文献清理向量。
 * 嵌入器不可用时静默跳过（纯词法降级）。单实验室单飞。
 */
export function syncVectorIndex(labId: string, index: LiteratureIndexFile): Promise<void> {
  const existing = pendingVectorSyncs.get(labId)
  if (existing) return existing
  const task = syncVectorIndexOnce(labId, index)
    .catch((error: unknown) => {
      console.warn('[CSLab] 向量索引同步失败（检索降级纯词法）:', error)
    })
    .finally(() => {
      pendingVectorSyncs.delete(labId)
    })
  pendingVectorSyncs.set(labId, task)
  return task
}

async function syncVectorIndexOnce(labId: string, index: LiteratureIndexFile): Promise<void> {
  const embed = await getSharedEmbedder()
  if (!embed) return

  const store = getLiteratureVectorStore(join(resolveLabDir(labId), 'db', 'literature_vectors.sqlite'))
  const rows = store.raw
    .prepare('SELECT chunk_id, literature_uri FROM literature_chunks')
    .all() as Array<{ chunk_id: string; literature_uri: string }>
  const existingIds = new Set(rows.map((row) => row.chunk_id))

  const chunksByUri = new Map<string, LiteratureChunk[]>()
  const currentIds = new Set<string>()
  for (const chunk of index.chunks) {
    currentIds.add(chunk.id)
    const list = chunksByUri.get(chunk.literatureUri) ?? []
    list.push(chunk)
    chunksByUri.set(chunk.literatureUri, list)
  }

  // 消失文献：清理其全部向量。
  const vanishedUris = new Set<string>()
  for (const row of rows) {
    if (!currentIds.has(row.chunk_id)) vanishedUris.add(row.literature_uri)
  }
  for (const uri of vanishedUris) {
    if (!chunksByUri.has(uri)) deleteLiteratureChunks(labId, uri)
  }

  // 变更文献（有新增或残留切块）：整篇删除后重嵌。
  const existingByUri = new Map<string, Set<string>>()
  for (const row of rows) {
    const set = existingByUri.get(row.literature_uri) ?? new Set<string>()
    set.add(row.chunk_id)
    existingByUri.set(row.literature_uri, set)
  }
  for (const [uri, chunks] of chunksByUri) {
    const known = existingByUri.get(uri) ?? new Set<string>()
    const changed =
      chunks.some((chunk) => !known.has(chunk.id)) ||
      [...known].some((id) => !currentIds.has(id))
    if (!changed) continue
    deleteLiteratureChunks(labId, uri)
    await upsertLiteratureChunks(
      labId,
      chunks.map((chunk) => ({
        chunkId: chunk.id,
        literatureUri: chunk.literatureUri,
        title: chunk.title,
        page: chunk.page,
        text: chunk.text,
        bbox: chunk.bbox,
      })),
      embed,
    )
  }
}

// ===== 检索融合 =====

function buildExcerpt(chunk: LiteratureChunk, queryTerms: Set<string>): string {
  const sentences = chunk.text
    .replace(/\r/g, '')
    .split(/(?<=[。！？!?；;])|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
  if (sentences.length === 0) return chunk.text.slice(0, EXCERPT_MAX_CHARS)

  const scored = sentences
    .map((sentence, index) => {
      const tokens = tokenizeLiteratureText(sentence)
      let hits = 0
      for (const token of tokens) if (queryTerms.has(token)) hits += 1
      return { sentence, index, score: hits / Math.max(8, tokens.length) }
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)

  let excerpt = ''
  for (const item of scored) {
    if (excerpt.length >= EXCERPT_MAX_CHARS) break
    excerpt += `${item.sentence}`
    if (excerpt.length >= EXCERPT_MAX_CHARS * 0.6) break
  }
  return (excerpt || chunk.text).slice(0, EXCERPT_MAX_CHARS)
}

function computeDocumentFrequency(chunks: LiteratureChunk[], terms: Set<string>): Map<string, number> {
  const frequency = new Map<string, number>()
  for (const chunk of chunks) {
    const unique = new Set(tokenizeLiteratureText(`${chunk.title} ${chunk.text}`))
    for (const term of unique) {
      if (!terms.has(term)) continue
      frequency.set(term, (frequency.get(term) ?? 0) + 1)
    }
  }
  return frequency
}

function scoreChunk(
  chunk: LiteratureChunk,
  queryTerms: Map<string, number>,
  documentFrequency: Map<string, number>,
  totalChunks: number,
): number {
  const bodyTokens = tokenizeLiteratureText(chunk.text)
  const titleTokens = new Set(tokenizeLiteratureText(chunk.title))
  const termFrequency = new Map<string, number>()
  for (const token of bodyTokens) {
    termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1)
  }

  let score = 0
  for (const [term, queryWeight] of queryTerms) {
    const tf = termFrequency.get(term) ?? 0
    if (tf === 0 && !titleTokens.has(term)) continue
    const df = documentFrequency.get(term) ?? 0
    const idf = Math.log(1 + totalChunks / Math.max(1, df))
    score += queryWeight * (1 + Math.log(1 + tf)) * idf
    if (titleTokens.has(term)) score += 1.5 * idf
  }
  return score
}

/** RRF：score(d) = Σ_m w_m / (k + rank_m(d))；rank 从 1 起，Map O(1) 聚合。 */
export function fuseRanks(rankLists: Array<{ ids: string[]; weight: number }>): Map<string, number> {
  const fused = new Map<string, number>()
  for (const list of rankLists) {
    list.ids.forEach((id, index) => {
      const contribution = list.weight / (RRF_CONFIG.k + index + 1)
      fused.set(id, (fused.get(id) ?? 0) + contribution)
    })
  }
  return fused
}

interface SearchDeps {
  labId?: string
  embed?: Embedder | null
  /** 向量检索端口（测试注入 Mock；缺省走 searchLiteratureVectors）。 */
  vectorSearch?: (query: string, topK: number) => Promise<Array<{ chunkId: string; score: number }>>
}

function resolveVectorSearch(deps: SearchDeps): SearchDeps['vectorSearch'] | null {
  if (deps.vectorSearch) return deps.vectorSearch
  if (deps.labId && deps.embed) {
    return (query, topK) => searchLiteratureVectors(deps.labId!, query, topK, deps.embed!)
  }
  return null
}

/** 检索融合核心（导出供测试注入向量路 Mock；生产路径经 searchLabLiterature）。 */
export async function searchIndex(
  index: LiteratureIndexFile,
  input: CsLabLiteratureSearchInput,
  deps: SearchDeps = {},
): Promise<CsLabLiteratureSearchResult> {
  const queryTerms = new Map<string, number>()
  for (const token of tokenizeLiteratureText(input.query)) {
    queryTerms.set(token, (queryTerms.get(token) ?? 0) + 1)
  }

  const scoped = input.literatureUri
    ? index.chunks.filter((chunk) => chunk.literatureUri === input.literatureUri)
    : index.chunks
  const chunkById = new Map(scoped.map((chunk) => [chunk.id, chunk]))

  // ---- 路 1：BM25 词法排名 ----
  const bm25RankIds: string[] = []
  if (queryTerms.size > 0) {
    const documentFrequency = computeDocumentFrequency(scoped, new Set(queryTerms.keys()))
    const scored = scoped
      .map((chunk) => ({
        chunk,
        score: scoreChunk(chunk, queryTerms, documentFrequency, scoped.length),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
    bm25RankIds.push(...scored.map((item) => item.chunk.id))

    // ---- 路 3：Leiden 社群排名（社群聚合得分降序，同社群内按 BM25） ----
    const communityAggregate = new Map<string, number>()
    for (const item of scored) {
      const community = index.chunkCommunity[item.chunk.id]
      if (!community) continue
      communityAggregate.set(
        community.id,
        (communityAggregate.get(community.id) ?? 0) + item.score,
      )
    }
    const communityRankIds = [...scored]
      .sort((a, b) => {
        const communityA = index.chunkCommunity[a.chunk.id]
        const communityB = index.chunkCommunity[b.chunk.id]
        const aggregateA = communityA ? communityAggregate.get(communityA.id) ?? 0 : 0
        const aggregateB = communityB ? communityAggregate.get(communityB.id) ?? 0 : 0
        return aggregateB - aggregateA || b.score - a.score
      })
      .map((item) => item.chunk.id)

    // ---- 路 2：向量排名（本地 ONNX；不可用时缺席，两路降级） ----
    const vectorRankIds: string[] = []
    const vectorSearch = resolveVectorSearch(deps)
    if (vectorSearch) {
      try {
        const limit = Math.max(DEFAULT_TOP_K, (input.topK ?? DEFAULT_TOP_K)) * VECTOR_CANDIDATE_MULTIPLIER
        const hits = await vectorSearch(input.query, limit)
        vectorRankIds.push(
          ...hits
            .filter((hit) => chunkById.has(hit.chunkId))
            .map((hit) => hit.chunkId),
        )
      } catch (error) {
        console.warn('[CSLab] 向量检索失败，本轮降级两路融合:', error)
      }
    }

    const fused = fuseRanks([
      { ids: bm25RankIds, weight: RRF_CONFIG.wBm25 },
      { ids: vectorRankIds, weight: RRF_CONFIG.wVector },
      { ids: communityRankIds, weight: RRF_CONFIG.wCommunity },
    ])

    if (fused.size > 0) {
      const limit = Math.max(
        1,
        Math.min(MAX_TOP_K, Math.floor(input.topK ?? DEFAULT_TOP_K) || DEFAULT_TOP_K),
      )
      const querySet = new Set(queryTerms.keys())
      const ranked = [...fused.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
      const hits: CsLabLiteratureSearchHit[] = ranked.map(([chunkId, score]) => {
        const chunk = chunkById.get(chunkId)!
        const community = index.chunkCommunity[chunk.id]
        return {
          chunkId: chunk.id,
          literatureUri: chunk.literatureUri,
          title: chunk.title,
          page: chunk.page,
          excerpt: buildExcerpt(chunk, querySet),
          score,
          communityId: community?.id ?? '',
          communityTitle: community?.title ?? '未聚类',
          bbox: chunk.bbox,
        }
      })
      return { ok: true, builtAt: index.builtAt, hits }
    }
    return { ok: true, builtAt: index.builtAt, hits: [], message: '没有匹配的文献切块' }
  }

  // 词法无可检索词：仅向量路兜底（如长句/同义表述）。
  const vectorSearchOnly = resolveVectorSearch(deps)
  if (vectorSearchOnly) {
    try {
      const limit = Math.max(
        1,
        Math.min(MAX_TOP_K, Math.floor(input.topK ?? DEFAULT_TOP_K) || DEFAULT_TOP_K),
      )
      const hits = await vectorSearchOnly(input.query, limit)
      const querySet = new Set(tokenizeLiteratureText(input.query))
      const mapped: CsLabLiteratureSearchHit[] = hits
        .filter((hit) => chunkById.has(hit.chunkId))
        .map((hit) => {
          const chunk = chunkById.get(hit.chunkId)!
          const community = index.chunkCommunity[chunk.id]
          return {
            chunkId: chunk.id,
            literatureUri: chunk.literatureUri,
            title: chunk.title,
            page: chunk.page,
            excerpt: buildExcerpt(chunk, querySet),
            score: hit.score,
            communityId: community?.id ?? '',
            communityTitle: community?.title ?? '未聚类',
            bbox: chunk.bbox,
          }
        })
      if (mapped.length > 0) return { ok: true, builtAt: index.builtAt, hits: mapped }
    } catch (error) {
      console.warn('[CSLab] 向量检索失败:', error)
    }
  }
  return { ok: false, builtAt: index.builtAt, hits: [], message: '请输入可检索的关键词' }
}

export async function searchLabLiterature(
  input: CsLabLiteratureSearchInput,
): Promise<CsLabLiteratureSearchResult> {
  const labId = assertLabId(input.labId)
  const query = typeof input.query === 'string' ? input.query.trim() : ''
  if (!query) return { ok: false, hits: [], message: '请输入检索关键词' }

  try {
    let index = await readLiteratureIndex(labId)
    if (index) {
      // 文献集合变化时先用旧索引即时响应，再后台单飞重建，避免检索请求同步解析全部 PDF。
      const status = await getLiteratureIndexStatus(labId)
      if (status.fingerprint !== index.fingerprint) {
        scheduleLiteratureIndexRebuild(labId)
      }
    } else {
      const built = await buildLabLiteratureIndex(labId)
      index = built.index
      if (!index) return { ok: false, hits: [], message: built.message }
      void syncVectorIndex(labId, index)
    }
    const embed = await getSharedEmbedder()
    return await searchIndex(index, { ...input, labId, query }, { labId, embed })
  } catch (error) {
    return {
      ok: false,
      hits: [],
      message: error instanceof Error ? error.message : '文献检索失败',
    }
  }
}

export async function buildLiteratureIndex(
  labIdInput: string,
  force = false,
): Promise<CsLabLiteratureSearchResult> {
  const labId = assertLabId(labIdInput)
  const built = await buildLabLiteratureIndex(labId, { force })
  if (built.index) void syncVectorIndex(labId, built.index)
  return {
    ok: !!built.index,
    builtAt: built.index?.builtAt,
    hits: [],
    message: built.message,
  }
}
