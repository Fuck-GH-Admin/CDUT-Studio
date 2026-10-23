/**
 * 实验室跨文献分层检索路由
 *
 * 复用 study/hierarchical-graphrag.ts 的 Leiden 分层社区；
 * 检索为本地词法 BM25 近似 + 社群加权，不引入向量库或外部服务。
 */

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
import { assertLabId } from './cslab-paths'

const DEFAULT_TOP_K = 5
const MAX_TOP_K = 20
const EXCERPT_MAX_CHARS = 500

/** 同一实验室只允许一个后台重建任务，避免检索抖动触发重复构建。 */
const pendingIndexBuilds = new Map<string, Promise<void>>()

/** 后台单飞重建文献索引；失败只记录警告，不影响本次检索。 */
function scheduleLiteratureIndexRebuild(labId: string): void {
  if (pendingIndexBuilds.has(labId)) return
  const task = buildLabLiteratureIndex(labId)
    .then(() => undefined)
    .catch((error: unknown) => {
      console.warn('[CSLab] 后台重建文献索引失败:', error)
    })
    .finally(() => {
      pendingIndexBuilds.delete(labId)
    })
  pendingIndexBuilds.set(labId, task)
}

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

function searchIndex(
  index: LiteratureIndexFile,
  input: CsLabLiteratureSearchInput,
): CsLabLiteratureSearchResult {
  const queryTerms = new Map<string, number>()
  for (const token of tokenizeLiteratureText(input.query)) {
    queryTerms.set(token, (queryTerms.get(token) ?? 0) + 1)
  }
  if (queryTerms.size === 0) {
    return { ok: false, builtAt: index.builtAt, hits: [], message: '请输入可检索的关键词' }
  }

  const scoped = input.literatureUri
    ? index.chunks.filter((chunk) => chunk.literatureUri === input.literatureUri)
    : index.chunks

  const documentFrequency = computeDocumentFrequency(scoped, new Set(queryTerms.keys()))
  const scored = scoped
    .map((chunk) => ({
      chunk,
      score: scoreChunk(chunk, queryTerms, documentFrequency, scoped.length),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)

  if (scored.length === 0) {
    return { ok: true, builtAt: index.builtAt, hits: [], message: '没有匹配的文献切块' }
  }

  // 社群加权：先找出前 3 个命中块的社群，再给同社群其余块小幅加成。
  const topCommunities = new Set<string>()
  for (const item of scored.slice(0, 3)) {
    const community = index.chunkCommunity[item.chunk.id]
    if (community) topCommunities.add(community.id)
  }
  for (const item of scored) {
    const community = index.chunkCommunity[item.chunk.id]
    if (community && topCommunities.has(community.id)) item.score *= 1.1
  }
  scored.sort((a, b) => b.score - a.score)

  const limit = Math.max(
    1,
    Math.min(MAX_TOP_K, Math.floor(input.topK ?? DEFAULT_TOP_K) || DEFAULT_TOP_K),
  )
  const querySet = new Set(queryTerms.keys())
  const hits: CsLabLiteratureSearchHit[] = scored.slice(0, limit).map((item) => {
    const community = index.chunkCommunity[item.chunk.id]
    return {
      chunkId: item.chunk.id,
      literatureUri: item.chunk.literatureUri,
      title: item.chunk.title,
      page: item.chunk.page,
      excerpt: buildExcerpt(item.chunk, querySet),
      score: item.score,
      communityId: community?.id ?? '',
      communityTitle: community?.title ?? '未聚类',
    }
  })

  return { ok: true, builtAt: index.builtAt, hits }
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
    }
    return searchIndex(index, { ...input, labId, query })
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
  return {
    ok: !!built.index,
    builtAt: built.index?.builtAt,
    hits: [],
    message: built.message,
  }
}
