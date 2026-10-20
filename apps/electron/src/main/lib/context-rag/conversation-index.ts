/**
 * 会话历史增量索引（RAG 索引模式专用）。
 *
 * 设计要点：
 *   - 纯内存 Map 缓存，零 SQLite / 零向量库 / 零额外磁盘写；
 *   - 按 JSONL 字节偏移增量读取，只解析新增行，避免每轮重读全量会话；
 *   - 图谱边与 Leiden 社群按 chunk 增量阈值重建，控制长会话计算成本；
 *   - 索引只读会话 JSONL，绝不修改原始消息。
 */

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import type { SDKMessage } from '@profer/shared'
import { getAgentSessionMessagesPath } from '../config-paths'
import {
  buildHierarchicalCommunities,
  type CommunityNode,
  type WeightedEdge,
} from '../study/hierarchical-graphrag'
import {
  appendMessagesToTurnState,
  appendTurnsToChunkState,
  buildChunksFromTurns,
  finalizeOpenTurn,
  trimChunkState,
  type ConversationChunk,
  type ConversationChunkState,
  type ConversationTurnState,
} from './conversation-chunks'

/** 单会话最多保留的切片数（超出丢弃最旧 25%） */
const MAX_CHUNKS = 5000
/** 图谱边重建阈值：新增切片数达到该值才重建 */
const EDGE_REBUILD_DELTA = 5
/** 社群重建阈值：新增切片数达到该值才重新聚类 */
const COMMUNITY_REBUILD_DELTA = 20
/** 图谱边硬上限 */
const MAX_GRAPH_EDGES = 2000
/** 单个切片参与共现建边的词元上限 */
const MAX_TERMS_PER_CHUNK = 120
/** 单切片实体抽取的最大扫描字符数 */
const MAX_ENTITY_SCAN_CHARS = 4000
/** 单切片最多抽取的实体数 */
const MAX_ENTITIES_PER_CHUNK = 60

const PATH_PATTERN = /(?:[A-Za-z]:)?[\w./\\-]+\.(?:ts|tsx|js|jsx|json|md|py|rs|go|java|css|html|yml|yaml|toml|sh|ps1)\b/gi
const ERROR_PATTERN = /\b(?:E[A-Z0-9]{3,}|HTTP\s?[1-5]\d{2})\b/g
const VERSION_PATTERN = /\bv?\d+\.\d+(?:\.\d+)?\b/g
const NUMERIC_ID_PATTERN = /\b\d{6,}\b/g
const IDENTIFIER_PATTERN = /\b(?:[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*|[a-z0-9]+_[a-z0-9_]+)\b/g

/** 与会话索引缓存项 */
export interface ConversationIndexEntry {
  sessionId: string
  filePath: string
  fileSize: number
  byteOffset: number
  /** 上一次读取末尾未闭合的 JSONL 行 */
  carry: string
  turnState: ConversationTurnState
  chunkState: ConversationChunkState
  edges: WeightedEdge[]
  communities: CommunityNode[]
  edgesAtChunkCount: number
  communitiesAtChunkCount: number
}

/** 检索语料：正式切片 + 尚未闭合的当前段 */
export interface ConversationSearchCorpus {
  chunks: ConversationChunk[]
  docFreq: Map<string, number>
  avgLength: number
}

const cache = new Map<string, ConversationIndexEntry>()

function createEmptyEntry(sessionId: string): ConversationIndexEntry {
  return {
    sessionId,
    filePath: getAgentSessionMessagesPath(sessionId),
    fileSize: 0,
    byteOffset: 0,
    carry: '',
    turnState: { turns: [], openTurn: null },
    chunkState: { chunks: [], pendingTurns: [], similarities: [] },
    edges: [],
    communities: [],
    edgesAtChunkCount: 0,
    communitiesAtChunkCount: 0,
  }
}

/** 读取指定区间的新增字节（避免整文件 readFileSync） */
function readNewBytes(filePath: string, offset: number, size: number): string {
  const length = size - offset
  if (length <= 0) return ''
  const buffer = Buffer.alloc(length)
  const fd = openSync(filePath, 'r')
  try {
    readSync(fd, buffer, 0, length, offset)
  } finally {
    closeSync(fd)
  }
  return buffer.toString('utf-8')
}

/** 抽取跨轮次高辨识度实体（路径 / 标识符 / 错误码 / 版本 / 长数字 ID） */
function extractChunkEntities(content: string): string[] {
  const text = content.slice(0, MAX_ENTITY_SCAN_CHARS)
  const entities = new Set<string>()
  const pushMatches = (pattern: RegExp): void => {
    for (const match of text.matchAll(pattern)) {
      if (entities.size >= MAX_ENTITIES_PER_CHUNK) return
      const value = match[0]?.trim()
      if (value && value.length >= 4) entities.add(value.toLowerCase())
    }
  }
  pushMatches(PATH_PATTERN)
  pushMatches(ERROR_PATTERN)
  pushMatches(VERSION_PATTERN)
  pushMatches(NUMERIC_ID_PATTERN)
  pushMatches(IDENTIFIER_PATTERN)
  return [...entities]
}

/** 构建会话图谱边：相邻 0.8 / 共享实体 1.0 / 概念共现 0.5，总数封顶 */
function buildConversationEdges(chunks: readonly ConversationChunk[]): WeightedEdge[] {
  const edges: WeightedEdge[] = []
  const seen = new Set<string>()
  const addEdge = (source: string, target: string, weight: number): void => {
    if (!source || !target || source === target) return
    if (edges.length >= MAX_GRAPH_EDGES) return
    const key = source < target ? `${source}|${target}` : `${target}|${source}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ source, target, weight })
  }

  // 1. 相邻切片：体现对话线性叙事
  for (let i = 1; i < chunks.length && edges.length < MAX_GRAPH_EDGES; i++) {
    addEdge(chunks[i - 1]!.chunkId, chunks[i]!.chunkId, 0.8)
  }

  // 2. 共享高辨识度实体：跨轮次强关联
  const entityIndex = new Map<string, string[]>()
  for (const chunk of chunks) {
    for (const entity of extractChunkEntities(chunk.content)) {
      const list = entityIndex.get(entity) ?? []
      if (list.length >= 8) continue
      list.push(chunk.chunkId)
      entityIndex.set(entity, list)
    }
  }
  for (const ids of entityIndex.values()) {
    if (ids.length < 2) continue
    for (let i = 0; i < ids.length && edges.length < MAX_GRAPH_EDGES; i++) {
      for (let j = i + 1; j < ids.length && edges.length < MAX_GRAPH_EDGES; j++) {
        addEdge(ids[i]!, ids[j]!, 1.0)
      }
    }
  }

  // 3. 概念共现：仅在出现于 2~8 个切片时连边，权重 0.5
  const termIndex = new Map<string, string[]>()
  for (const chunk of chunks) {
    const topTerms = [...chunk.termFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_TERMS_PER_CHUNK)
    for (const [term] of topTerms) {
      const list = termIndex.get(term) ?? []
      if (list.length >= 8) continue
      list.push(chunk.chunkId)
      termIndex.set(term, list)
    }
  }
  for (const ids of termIndex.values()) {
    if (ids.length < 2 || ids.length > 8) continue
    for (let i = 0; i < ids.length && edges.length < MAX_GRAPH_EDGES; i++) {
      for (let j = i + 1; j < ids.length && edges.length < MAX_GRAPH_EDGES; j++) {
        addEdge(ids[i]!, ids[j]!, 0.5)
      }
    }
  }

  return edges
}

/** 按阈值重建图谱边与 Leiden 社群 */
function refreshGraph(entry: ConversationIndexEntry): void {
  const chunks = entry.chunkState.chunks
  if (chunks.length === 0) {
    entry.edges = []
    entry.communities = []
    entry.edgesAtChunkCount = 0
    entry.communitiesAtChunkCount = 0
    return
  }

  const shouldRebuildEdges =
    entry.edges.length === 0 || chunks.length - entry.edgesAtChunkCount >= EDGE_REBUILD_DELTA
  if (shouldRebuildEdges) {
    entry.edges = buildConversationEdges(chunks)
    entry.edgesAtChunkCount = chunks.length
  }

  const shouldRebuildCommunities =
    entry.communities.length === 0 || chunks.length - entry.communitiesAtChunkCount >= COMMUNITY_REBUILD_DELTA
  if (shouldRebuildCommunities) {
    entry.communities = buildHierarchicalCommunities({
      nodes: chunks.map((chunk) => ({
        id: chunk.chunkId,
        title: (chunk.userText || chunk.assistantText || chunk.content).slice(0, 60),
      })),
      edges: entry.edges,
    })
    entry.communitiesAtChunkCount = chunks.length
  }
}

/**
 * 获取（必要时增量更新）指定会话的索引。
 * 文件被截断时自动从零重建；文件不存在时返回空索引。
 */
export function getConversationIndex(sessionId: string): ConversationIndexEntry {
  const filePath = getAgentSessionMessagesPath(sessionId)
  let entry = cache.get(sessionId)

  if (!existsSync(filePath)) {
    if (entry && entry.filePath === filePath && entry.fileSize === 0) return entry
    const empty = createEmptyEntry(sessionId)
    cache.set(sessionId, empty)
    return empty
  }

  if (!entry || entry.filePath !== filePath) {
    entry = createEmptyEntry(sessionId)
    cache.set(sessionId, entry)
  }

  let size = 0
  try {
    size = statSync(filePath).size
  } catch {
    return entry
  }

  // JSONL 被截断 / 重建：清空状态重新读取
  if (size < entry.byteOffset) {
    entry.fileSize = 0
    entry.byteOffset = 0
    entry.carry = ''
    entry.turnState = { turns: [], openTurn: null }
    entry.chunkState = { chunks: [], pendingTurns: [], similarities: [] }
    entry.edges = []
    entry.communities = []
    entry.edgesAtChunkCount = 0
    entry.communitiesAtChunkCount = 0
  }

  if (size === entry.fileSize) {
    refreshGraph(entry)
    return entry
  }

  const newText = `${entry.carry}${readNewBytes(filePath, entry.byteOffset, size)}`
  const lines = newText.split('\n')
  entry.carry = lines.pop() ?? ''

  const messages: SDKMessage[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      messages.push(JSON.parse(trimmed) as SDKMessage)
    } catch {
      // 损坏行直接跳过，绝不阻断后续索引
    }
  }

  const previousTurnCount = entry.turnState.turns.length
  appendMessagesToTurnState(entry.turnState, messages)
  const newTurns = entry.turnState.turns.slice(previousTurnCount)
  appendTurnsToChunkState(entry.chunkState, newTurns, sessionId)
  const chunksBeforeTrim = entry.chunkState.chunks.length
  trimChunkState(entry.chunkState, MAX_CHUNKS)
  if (entry.chunkState.chunks.length !== chunksBeforeTrim) {
    // 丢弃旧切片后，旧图谱边与社群成员会失效，必须整体重建。
    entry.edges = []
    entry.communities = []
    entry.edgesAtChunkCount = 0
    entry.communitiesAtChunkCount = 0
  }

  entry.byteOffset = size
  entry.fileSize = size
  refreshGraph(entry)
  return entry
}

/** 检索语料：正式切片 + 尚未闭合的 pending/open 轮次 */
export function getConversationSearchCorpus(entry: ConversationIndexEntry): ConversationSearchCorpus {
  const pending = [...entry.chunkState.pendingTurns]
  const open = finalizeOpenTurn(entry.turnState)
  const provisionalTurns = open ? [...pending, open] : pending
  const chunks = [
    ...entry.chunkState.chunks,
    ...buildChunksFromTurns(entry.sessionId, provisionalTurns),
  ]

  const docFreq = new Map<string, number>()
  let totalLength = 0
  for (const chunk of chunks) {
    for (const term of chunk.termFreq.keys()) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1)
    }
    totalLength += chunk.length
  }

  return {
    chunks,
    docFreq,
    avgLength: chunks.length > 0 ? totalLength / chunks.length : 1,
  }
}

/** 失效指定会话（或全部）索引缓存 */
export function invalidateConversationIndex(sessionId?: string): void {
  if (sessionId) cache.delete(sessionId)
  else cache.clear()
}
