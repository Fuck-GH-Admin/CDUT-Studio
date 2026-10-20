/**
 * 会话历史双引擎检索（RAG 索引模式专用）。
 *
 * 复用 AI 速课堂已经验证过的两类检索思想，但**不修改速课堂任何实现**：
 *   - 经典混合：BM25 + 主题覆盖 + 图谱 1-Hop + RRF + 句级显著性剪枝；
 *   - GraphRAG：Leiden 三层社群 + 词法×社群归属打分 + 宏观意图摘要。
 *
 * 两条链路各自召回后做二次 RRF 融合，最终组装为 <conversation_evidence>。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CommunityNode } from '../study/hierarchical-graphrag'
import {
  finalizeOpenTurn,
  getRecentTurns,
  renderTurnText,
  tokenizeConversationText,
  type ConversationChunk,
  type ConversationTurn,
} from './conversation-chunks'
import {
  getConversationIndex,
  getConversationSearchCorpus,
  type ConversationIndexEntry,
  type ConversationSearchCorpus,
} from './conversation-index'

const BM25_K1 = 1.5
const BM25_B = 0.75
const RRF_K = 60
const CANDIDATE_K = 12
const FINAL_TOP_K = 6
const EVIDENCE_CHAR_BUDGET = 4000
const EXCERPT_MAX_CHARS = 500
const RECENT_TURN_PAIRS = 1
const WORKING_MEMORY_MAX_CHARS = 2000
const MACRO_INTENT_WORDS = ['思想', '演变', '概述', '全局', '总结', '主线', '体系']

/** 单条会话证据 */
export interface ConversationEvidenceItem {
  chunkId: string
  turnStart: number
  turnEnd: number
  messageIds: string[]
  content: string
  score: number
}

/** 检索结果 */
export interface ConversationRetrievalResult {
  evidence: ConversationEvidenceItem[]
  macroSummaries: string[]
  recentTurns: ConversationTurn[]
  stats: {
    chunks: number
    classicCandidates: number
    graphCandidates: number
    fusedCandidates: number
    evidenceChars: number
  }
}

function uniqueTerms(text: string): string[] {
  return [...new Set(tokenizeConversationText(text))]
}

function rankByScore(scores: Map<string, number>, limit?: number): string[] {
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
  return limit ? ranked.slice(0, limit) : ranked
}

function scoreBm25(corpus: ConversationSearchCorpus, queryTerms: readonly string[]): Map<string, number> {
  const scores = new Map<string, number>()
  const totalChunks = corpus.chunks.length
  for (const chunk of corpus.chunks) {
    let score = 0
    for (const term of queryTerms) {
      const tf = chunk.termFreq.get(term)
      if (!tf) continue
      const df = corpus.docFreq.get(term) ?? 0
      const idf = Math.log(1 + (totalChunks - df + 0.5) / (df + 0.5))
      const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * chunk.length) / corpus.avgLength)
      score += idf * ((tf * (BM25_K1 + 1)) / denom)
    }
    if (score > 0) scores.set(chunk.chunkId, score)
  }
  return scores
}

function scoreSemantic(chunk: ConversationChunk, queryTerms: readonly string[]): number {
  if (queryTerms.length === 0) return 0
  const titleTerms = new Set(tokenizeConversationText(chunk.userText))
  const bodyTerms = new Set(tokenizeConversationText(`${chunk.assistantText} ${chunk.toolSummary}`))
  let titleHits = 0
  let bodyHits = 0
  for (const term of queryTerms) {
    if (titleTerms.has(term)) titleHits++
    else if (bodyTerms.has(term)) bodyHits++
  }
  const coverage = (titleHits + bodyHits * 0.6) / queryTerms.length
  return coverage
}

function buildAdjacency(entry: ConversationIndexEntry): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>()
  const link = (a: string, b: string): void => {
    if (!a || !b || a === b) return
    if (!adjacency.has(a)) adjacency.set(a, new Set())
    adjacency.get(a)!.add(b)
  }
  for (const edge of entry.edges) {
    link(edge.source, edge.target)
    link(edge.target, edge.source)
  }
  return adjacency
}

function addRank(rrf: Map<string, number>, ids: readonly string[], allowed: ReadonlySet<string>): void {
  ids.forEach((id, index) => {
    if (!allowed.has(id)) return
    rrf.set(id, (rrf.get(id) ?? 0) + 1 / (RRF_K + index + 1))
  })
}

/** 经典混合召回：BM25 + 主题覆盖 + 图谱 1-Hop → RRF */
export function searchClassicHybrid(
  entry: ConversationIndexEntry,
  corpus: ConversationSearchCorpus,
  queryTerms: readonly string[],
): string[] {
  const bm25 = scoreBm25(corpus, queryTerms)
  const semantic = new Map<string, number>()
  for (const chunk of corpus.chunks) {
    const score = scoreSemantic(chunk, queryTerms)
    if (score > 0) semantic.set(chunk.chunkId, score)
  }

  const bm25Rank = rankByScore(bm25)
  const semanticRank = rankByScore(semantic)
  const adjacency = buildAdjacency(entry)
  const seeds = [...bm25Rank.slice(0, 5), ...semanticRank.slice(0, 5)]
  const graphRank: string[] = []
  const graphSeen = new Set<string>()
  for (const seed of seeds) {
    for (const neighbor of adjacency.get(seed) ?? []) {
      if (graphSeen.has(neighbor)) continue
      graphSeen.add(neighbor)
      graphRank.push(neighbor)
    }
  }

  const allowed = new Set(corpus.chunks.map((chunk) => chunk.chunkId))
  const rrf = new Map<string, number>()
  addRank(rrf, bm25Rank, allowed)
  addRank(rrf, semanticRank, allowed)
  addRank(rrf, graphRank, allowed)
  return rankByScore(rrf, CANDIDATE_K)
}

interface ConversationCommunityIndex {
  level1Of: Map<string, number>
  level1Terms: Map<number, Set<string>>
  level2: CommunityNode[]
}

function buildCommunityIndex(
  entry: ConversationIndexEntry,
  corpus: ConversationSearchCorpus,
): ConversationCommunityIndex {
  const level1Of = new Map<string, number>()
  const level1Terms = new Map<number, Set<string>>()
  const level2: CommunityNode[] = []
  const chunkById = new Map(corpus.chunks.map((chunk) => [chunk.chunkId, chunk]))

  for (const community of entry.communities) {
    if (community.level === 1) {
      const number = Number(community.id.split('::')[1] ?? '0')
      const terms = new Set<string>()
      for (const member of community.memberEntities) {
        level1Of.set(member, number)
        const chunk = chunkById.get(member)
        if (!chunk) continue
        for (const term of tokenizeConversationText(`${chunk.userText} ${chunk.assistantText}`)) {
          terms.add(term)
        }
      }
      level1Terms.set(number, terms)
    } else if (community.level === 2) {
      level2.push(community)
    }
  }

  return { level1Of, level1Terms, level2 }
}

function scoreGraphRag(
  chunk: ConversationChunk,
  queryTerms: readonly string[],
  index: ConversationCommunityIndex,
): number {
  if (queryTerms.length === 0) return 0
  const titleTerms = new Set(tokenizeConversationText(chunk.userText))
  const bodyTerms = new Set(tokenizeConversationText(`${chunk.assistantText} ${chunk.toolSummary}`))
  let hits = 0
  for (const term of queryTerms) {
    if (titleTerms.has(term)) hits += 1
    else if (bodyTerms.has(term)) hits += 0.6
  }
  const lexical = hits / queryTerms.length

  let communityBoost = 0
  const communityNumber = index.level1Of.get(chunk.chunkId)
  const communityTerms = communityNumber !== undefined ? index.level1Terms.get(communityNumber) : undefined
  if (communityTerms) {
    let communityHits = 0
    for (const term of queryTerms) if (communityTerms.has(term)) communityHits++
    communityBoost = communityHits / queryTerms.length
  }

  return lexical * 0.7 + communityBoost * 0.3
}

/** GraphRAG 召回：词法 × 社群归属，宏观意图时附带 level-2 摘要 */
export function searchGraphRag(
  entry: ConversationIndexEntry,
  corpus: ConversationSearchCorpus,
  queryTerms: readonly string[],
  query: string,
): { ranked: string[]; macroSummaries: string[] } {
  const communityIndex = buildCommunityIndex(entry, corpus)
  const scores = new Map<string, number>()
  for (const chunk of corpus.chunks) {
    const score = scoreGraphRag(chunk, queryTerms, communityIndex)
    if (score > 0) scores.set(chunk.chunkId, score)
  }

  const ranked = rankByScore(scores, CANDIDATE_K)
  const macroSummaries: string[] = []
  if (MACRO_INTENT_WORDS.some((word) => query.includes(word))) {
    for (const community of communityIndex.level2) {
      const terms = new Set(tokenizeConversationText(`${community.title} ${community.summary}`))
      let hits = 0
      for (const term of queryTerms) if (terms.has(term)) hits++
      if (hits === 0) continue
      macroSummaries.push(`[${community.title}] ${community.summary}`)
      if (macroSummaries.length >= 2) break
    }
  }
  return { ranked, macroSummaries }
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\r/g, '')
    .split(/(?<=[。！？!?；;])|\n{2,}/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

/** 句级显著性剪枝：保留与 query 最相关的句子，按原顺序拼接 */
function buildExcerpt(chunk: ConversationChunk, queryTerms: readonly string[]): string {
  const content = chunk.content.trim()
  if (content.length <= EXCERPT_MAX_CHARS) return content
  const sentences = splitSentences(content)
  if (sentences.length === 0) return content.slice(0, EXCERPT_MAX_CHARS)

  const termSet = new Set(queryTerms)
  const scored = sentences.map((sentence, order) => {
    const tokens = new Set(tokenizeConversationText(sentence))
    let hits = 0
    for (const term of termSet) if (tokens.has(term)) hits++
    return { sentence, order, hits }
  })
  const matched = scored.filter((item) => item.hits > 0)
  const selected = matched.length > 0 ? matched.sort((a, b) => b.hits - a.hits) : scored.slice(0, 4)
  selected.sort((a, b) => a.order - b.order)

  const parts: string[] = []
  let used = 0
  for (const item of selected) {
    if (used >= EXCERPT_MAX_CHARS) break
    const remain = EXCERPT_MAX_CHARS - used
    const piece = item.sentence.length > remain ? item.sentence.slice(0, remain) : item.sentence
    parts.push(piece)
    used += piece.length
  }
  return parts.join('')
}

/**
 * 双引擎召回 + 二次 RRF 融合。
 * 最近 1 轮固定由 <recent_context> 注入，因此从证据候选中排除，避免重复。
 */
export function retrieveConversationContext(
  entry: ConversationIndexEntry,
  query: string,
  options: { recentTurns?: number } = {},
): ConversationRetrievalResult {
  const corpus = getConversationSearchCorpus(entry)
  const recentTurnsWanted = Math.max(1, options.recentTurns ?? RECENT_TURN_PAIRS)
  // 多取一轮：当前用户消息可能已落盘为 openTurn，需要保留它前面的完整轮次。
  const recentWindow = getRecentTurns(entry.turnState, recentTurnsWanted + 1)
  const openTurn = finalizeOpenTurn(entry.turnState)
  const trailingIndex = recentWindow[recentWindow.length - 1]?.turnIndex
  const hasTrailingUserOnly =
    openTurn !== undefined
    && !openTurn.assistantText.trim()
    && openTurn.turnIndex === trailingIndex
  // 当前用户消息没有助手回复时，不应重复进入 recent_context
  const recentForPrompt = (hasTrailingUserOnly ? recentWindow.slice(0, -1) : recentWindow)
    .slice(-recentTurnsWanted)
  // 证据候选排除最近一轮窗口，避免与 <recent_context> 重复；
  // 若最近窗口为空，至少排除当前 openTurn，防止当前提问命中自身。
  const recentStart = recentForPrompt.length > 0
    ? recentForPrompt[0]!.turnIndex
    : (openTurn?.turnIndex ?? Number.POSITIVE_INFINITY)

  const queryTerms = uniqueTerms(query)
  if (queryTerms.length === 0 || corpus.chunks.length === 0) {
    return {
      evidence: [],
      macroSummaries: [],
      recentTurns: recentForPrompt,
      stats: {
        chunks: corpus.chunks.length,
        classicCandidates: 0,
        graphCandidates: 0,
        fusedCandidates: 0,
        evidenceChars: 0,
      },
    }
  }

  const classic = searchClassicHybrid(entry, corpus, queryTerms)
  const graph = searchGraphRag(entry, corpus, queryTerms, query)

  const allowed = new Set(
    corpus.chunks
      .filter((chunk) => chunk.turnEnd < recentStart)
      .map((chunk) => chunk.chunkId),
  )
  const rrf = new Map<string, number>()
  addRank(rrf, classic, allowed)
  addRank(rrf, graph.ranked, allowed)
  const fused = rankByScore(rrf, FINAL_TOP_K)

  const chunkById = new Map(corpus.chunks.map((chunk) => [chunk.chunkId, chunk]))
  const evidence: ConversationEvidenceItem[] = []
  let evidenceChars = 0
  for (const chunkId of fused) {
    const chunk = chunkById.get(chunkId)
    if (!chunk) continue
    const content = buildExcerpt(chunk, queryTerms)
    if (evidence.length > 0 && evidenceChars + content.length > EVIDENCE_CHAR_BUDGET) break
    evidence.push({
      chunkId,
      turnStart: chunk.turnStart,
      turnEnd: chunk.turnEnd,
      messageIds: chunk.messageIds,
      content,
      score: rrf.get(chunkId) ?? 0,
    })
    evidenceChars += content.length
  }

  return {
    evidence,
    macroSummaries: graph.macroSummaries,
    recentTurns: recentForPrompt,
    stats: {
      chunks: corpus.chunks.length,
      classicCandidates: classic.length,
      graphCandidates: graph.ranked.length,
      fusedCandidates: fused.length,
      evidenceChars,
    },
  }
}

/** 读取会话工作台的工作记忆（当前仅 todo.md） */
function readWorkingMemory(agentCwd?: string): string {
  if (!agentCwd) return ''
  const todoPath = join(agentCwd, '.context', 'todo.md')
  if (!existsSync(todoPath)) return ''
  try {
    const text = readFileSync(todoPath, 'utf-8').trim()
    if (!text) return ''
    if (text.length <= WORKING_MEMORY_MAX_CHARS) return text
    return `${text.slice(0, WORKING_MEMORY_MAX_CHARS)}\n\n[工作记忆已截断]`
  } catch {
    return ''
  }
}

function formatEvidence(result: ConversationRetrievalResult): string {
  const sections: string[] = []
  for (const item of result.evidence) {
    const anchors = item.messageIds.length > 0 ? ` | msg:${item.messageIds.join(',')}` : ''
    sections.push(
      `[Source: conversation | Turn ${item.turnStart + 1}-${item.turnEnd + 1}${anchors}]\n${item.content}`,
    )
  }
  if (sections.length === 0 && result.macroSummaries.length === 0) return ''
  return [
    '<conversation_evidence>',
    '<!-- The client pre-retrieved the most relevant historical conversation excerpts for the current question. Trust them; cite with the msg:<uuid> anchors when useful. -->',
    ...result.macroSummaries.map((summary) => `[Macro summary] ${summary}`),
    ...sections,
    '</conversation_evidence>',
  ].join('\n')
}

/**
 * 索引模式的最终 prompt：
 *   <conversation_evidence> + <recent_context> + <working_memory> + 当前消息封包
 *
 * @param currentMessage 已包含 ADDITIONAL_METADATA 与 <USER_REQUEST> 的当轮消息
 * @param query 原始用户输入（用于检索打分，不含系统封包）
 */
export function buildIndexedContextPrompt(input: {
  sessionId: string
  currentMessage: string
  query: string
  agentCwd?: string
}): string {
  const entry = getConversationIndex(input.sessionId)
  const result = retrieveConversationContext(entry, input.query)

  const blocks: string[] = []
  const evidenceBlock = formatEvidence(result)
  if (evidenceBlock) blocks.push(evidenceBlock)

  if (result.recentTurns.length > 0) {
    blocks.push(
      `<recent_context>\n${result.recentTurns.map(renderTurnText).join('\n\n')}\n</recent_context>`,
    )
  }

  const workingMemory = readWorkingMemory(input.agentCwd)
  if (workingMemory) {
    blocks.push(`<working_memory>\n${workingMemory}\n</working_memory>`)
  }

  blocks.push(input.currentMessage)

  console.log(
    `[上下文索引] session=${input.sessionId} chunks=${result.stats.chunks} classic=${result.stats.classicCandidates} graph=${result.stats.graphCandidates} fused=${result.stats.fusedCandidates} evidenceChars=${result.stats.evidenceChars} recent=${result.recentTurns.length}`,
  )

  return blocks.join('\n\n')
}
