/**
 * 会话历史切块引擎（RAG 索引模式专用）。
 *
 * 职责：
 *   1. 把 `~/.cdutai/agent-sessions/{id}.jsonl` 中的 SDKMessage 解析成「用户提问 → 助手回复 + 工具活动/工具结果」的完整轮次；
 *   2. 以轮次为最小单位，按相邻轮次主题漂移合并为 800~1500 字的语义段；
 *   3. 输出带 message UUID 锚点、工具摘要与工具结果摘要的可检索切片。
 *
 * 设计红线：
 *   - 纯本地、零依赖、绝不修改原始会话 JSONL；
 *   - 不采信 / 不编造任何原文之外的内容；
 *   - thinking 块不进入索引，避免污染检索与浪费字符预算。
 */

import type { SDKMessage } from '@profer/shared'

/** 单段最小字符数（不足会与相邻段合并） */
const MIN_CHUNK_CHARS = 800
/** 单段目标最大字符数（超过则在主题漂移点或句末切分） */
const MAX_CHUNK_CHARS = 1500
/** 单轮硬上限（超过时按句子边界单独拆分，绝不截断句子） */
const HARD_MAX_TURN_CHARS = 1800
/** 主题漂移阈值：相似度低于 均值 - K × 标准差 时切段 */
const DRIFT_K = 0.6
/** 滑动窗口半径 */
const WINDOW_RADIUS = 2
/** 单个工具结果进入索引的最大字符数 */
const TOOL_RESULT_MAX_CHARS = 600
/** 单轮工具结果总量上限 */
const TURN_TOOL_RESULTS_MAX_CHARS = 1200
/** 工具调用摘要最大字符数 */
const TOOL_SUMMARY_MAX_CHARS = 240

/** 中文 / 英文常见停用词 */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'is', 'are', 'was', 'were', 'be', 'been',
  'for', 'with', 'as', 'by', 'at', 'from', 'that', 'this', 'these', 'those', 'it', 'its',
  '的', '了', '和', '与', '及', '或', '是', '在', '对', '为', '中', '上', '下', '里', '把', '被',
  '请', '我', '你', '他', '她', '它', '这', '那', '有', '无', '不', '也', '就', '都', '会', '能',
])

interface ContentBlock {
  type?: string
  text?: string
  name?: string
  input?: Record<string, unknown>
  content?: unknown
  is_error?: boolean
  tool_use_id?: string
  id?: string
}

/** 工具结果摘要 */
export interface ConversationToolResult {
  toolName?: string
  text: string
  isError: boolean
}

/** 一轮完整对话（User + Assistant + 工具活动） */
export interface ConversationTurn {
  turnIndex: number
  userText: string
  assistantText: string
  toolSummary: string
  toolResults: ConversationToolResult[]
  messageIds: string[]
  timestamp: number
}

/** 可检索的会话语义段 */
export interface ConversationChunk {
  chunkId: string
  turnStart: number
  turnEnd: number
  messageIds: string[]
  timestamp: number
  userText: string
  assistantText: string
  toolSummary: string
  toolResults: ConversationToolResult[]
  content: string
  termFreq: Map<string, number>
  length: number
}

/** 内部可变轮次：额外保存 tool_use_id → 工具名映射，便于回填工具结果 */
export interface MutableTurn extends ConversationTurn {
  toolNamesById: Map<string, string>
}

/** 轮次累积状态：openTurn 表示尚未收到下一条用户消息的最后一轮 */
export interface ConversationTurnState {
  turns: ConversationTurn[]
  openTurn: MutableTurn | null
}

/** 切块累积状态 */
export interface ConversationChunkState {
  chunks: ConversationChunk[]
  pendingTurns: ConversationTurn[]
  similarities: number[]
}



/** 词元化：中文单字 + 相邻 bigram，英文/数字取长度 >=2 的词，过滤停用词 */
export function tokenizeConversationText(text: string): string[] {
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

/** FNV-1a 32 位哈希（确定性 chunkId 后缀） */
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function truncate(text: string, maxChars: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, maxChars)}…`
}

function getContent(message: SDKMessage): ContentBlock[] {
  const content = (message as { message?: { content?: unknown } }).message?.content
  return Array.isArray(content) ? (content as ContentBlock[]) : []
}

function getMessageUuid(message: SDKMessage): string | undefined {
  const uuid = (message as { uuid?: unknown }).uuid
  return typeof uuid === 'string' && uuid.length > 0 ? uuid : undefined
}

function getMessageTimestamp(message: SDKMessage): number {
  const record = message as { _createdAt?: unknown; timestamp?: unknown }
  if (typeof record._createdAt === 'number') return record._createdAt
  if (typeof record.timestamp === 'number') return record.timestamp
  return 0
}

/** 把 tool_result.content（字符串 / 文本块数组 / 对象）统一压成纯文本 */
function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const item of content) {
      if (typeof item === 'string') {
        parts.push(item)
        continue
      }
      if (item && typeof item === 'object') {
        const block = item as { text?: unknown; content?: unknown }
        if (typeof block.text === 'string') parts.push(block.text)
        else if (block.content !== undefined) parts.push(stringifyToolResultContent(block.content))
      }
    }
    return parts.join('\n')
  }
  if (content && typeof content === 'object') {
    try {
      return JSON.stringify(content)
    } catch {
      return ''
    }
  }
  return ''
}

/** 提取可见文本（忽略 thinking） */
function extractTextBlocks(blocks: ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      parts.push(block.text.trim())
    }
  }
  return parts.join('\n')
}

/** 提取 tool_use 摘要与 tool_use_id → 工具名映射 */
function extractToolUse(blocks: ContentBlock[]): { summary: string; namesById: Map<string, string> } {
  const summaries: string[] = []
  const namesById = new Map<string, string>()
  for (const block of blocks) {
    if (block.type !== 'tool_use' || !block.name) continue
    if (block.id) namesById.set(block.id, block.name)
    const input = block.input ?? {}
    const keyParam = input.file_path ?? input.command ?? input.path ?? input.query ?? ''
    const paramStr = keyParam ? `: ${String(keyParam).slice(0, 100)}` : ''
    summaries.push(`[tool: ${block.name}${paramStr}]`)
  }
  return { summary: truncate(summaries.join(' '), TOOL_SUMMARY_MAX_CHARS), namesById }
}

/** 提取工具结果块 */
function extractToolResults(blocks: ContentBlock[]): Array<{ toolUseId?: string; text: string; isError: boolean }> {
  const results: Array<{ toolUseId?: string; text: string; isError: boolean }> = []
  for (const block of blocks) {
    if (block.type !== 'tool_result') continue
    const text = truncate(stringifyToolResultContent(block.content), TOOL_RESULT_MAX_CHARS)
    if (!text) continue
    results.push({ toolUseId: block.tool_use_id, text, isError: block.is_error === true })
  }
  return results
}

function createOpenTurn(userText: string, message: SDKMessage): MutableTurn {
  return {
    turnIndex: -1,
    userText,
    assistantText: '',
    toolSummary: '',
    toolResults: [],
    messageIds: [],
    timestamp: getMessageTimestamp(message),
    toolNamesById: new Map(),
  }
}

function addMessageId(turn: MutableTurn, message: SDKMessage): void {
  const uuid = getMessageUuid(message)
  if (uuid && !turn.messageIds.includes(uuid)) turn.messageIds.push(uuid)
}

function appendToolResult(turn: MutableTurn, result: { toolUseId?: string; text: string; isError: boolean }): void {
  const currentChars = turn.toolResults.reduce((sum, item) => sum + item.text.length, 0)
  if (currentChars >= TURN_TOOL_RESULTS_MAX_CHARS) return
  const remaining = TURN_TOOL_RESULTS_MAX_CHARS - currentChars
  turn.toolResults.push({
    toolName: result.toolUseId ? turn.toolNamesById.get(result.toolUseId) : undefined,
    text: truncate(result.text, Math.min(TOOL_RESULT_MAX_CHARS, remaining)),
    isError: result.isError,
  })
}

function hasTurnContent(turn: MutableTurn): boolean {
  return Boolean(turn.userText.trim() || turn.assistantText.trim() || turn.toolSummary.trim() || turn.toolResults.length)
}

/** 把内部可变轮次转为公开轮次（剥离 tool_use_id 映射） */
function toConversationTurn(turn: MutableTurn): ConversationTurn {
  return {
    turnIndex: turn.turnIndex,
    userText: turn.userText,
    assistantText: turn.assistantText,
    toolSummary: turn.toolSummary,
    toolResults: turn.toolResults,
    messageIds: turn.messageIds,
    timestamp: turn.timestamp,
  }
}

function closeOpenTurn(state: ConversationTurnState): void {
  if (!state.openTurn || !hasTurnContent(state.openTurn)) {
    state.openTurn = null
    return
  }
  state.openTurn.turnIndex = state.turns.length
  state.turns.push(toConversationTurn(state.openTurn))
  state.openTurn = null
}

/**
 * 增量消费一批 SDKMessage，更新轮次状态。
 * 每次索引追加新行后调用；未完成的最后一轮保留在 openTurn 中。
 */
export function appendMessagesToTurnState(state: ConversationTurnState, messages: readonly SDKMessage[]): void {
  for (const message of messages) {
    const type = (message as { type?: unknown }).type
    if (type === 'user') {
      const blocks = getContent(message)
      const text = extractTextBlocks(blocks)
      const toolResults = extractToolResults(blocks)
      if (text) {
        closeOpenTurn(state)
        state.openTurn = createOpenTurn(text, message)
        addMessageId(state.openTurn, message)
      }
      if (toolResults.length > 0) {
        if (!state.openTurn) state.openTurn = createOpenTurn('', message)
        addMessageId(state.openTurn, message)
        for (const result of toolResults) appendToolResult(state.openTurn, result)
      }
      continue
    }

    if (type !== 'assistant') continue
    if (!state.openTurn) state.openTurn = createOpenTurn('', message)
    addMessageId(state.openTurn, message)
    const blocks = getContent(message)
    const text = extractTextBlocks(blocks)
    if (text) {
      state.openTurn.assistantText = state.openTurn.assistantText
        ? `${state.openTurn.assistantText}\n${text}`
        : text
    }
    const toolUse = extractToolUse(blocks)
    if (toolUse.summary) {
      state.openTurn.toolSummary = state.openTurn.toolSummary
        ? `${state.openTurn.toolSummary} ${toolUse.summary}`
        : toolUse.summary
    }
    for (const [id, name] of toolUse.namesById) state.openTurn.toolNamesById.set(id, name)
  }
}

/** 把 openTurn 收尾为正式轮次（用于查询时的最近上下文） */
export function finalizeOpenTurn(state: ConversationTurnState): ConversationTurn | undefined {
  if (!state.openTurn || !hasTurnContent(state.openTurn)) return undefined
  const turn = toConversationTurn(state.openTurn)
  return turn.turnIndex >= 0 ? turn : { ...turn, turnIndex: state.turns.length }
}

/** 获取最近 N 轮（含尚未闭合的当前轮） */
export function getRecentTurns(state: ConversationTurnState, count: number): ConversationTurn[] {
  if (count <= 0) return []
  const all = [...state.turns]
  const open = finalizeOpenTurn(state)
  if (open) all.push(open)
  return all.slice(-Math.max(0, count))
}

/** 渲染单轮为纯文本块（带 message 锚点） */
export function renderTurnText(turn: ConversationTurn): string {
  const lines: string[] = []
  const turnLabel = turn.turnIndex >= 0 ? `Turn ${turn.turnIndex + 1}` : 'Turn'
  const time = turn.timestamp > 0 ? new Date(turn.timestamp).toLocaleString('zh-CN', { hour12: false }) : ''
  const anchors = turn.messageIds.length > 0 ? ` | msg:${turn.messageIds.join(',')}` : ''
  lines.push(`[${turnLabel}${time ? ` | ${time}` : ''}${anchors}]`)
  if (turn.userText) lines.push(`User: ${turn.userText}`)
  if (turn.assistantText) lines.push(`Assistant: ${turn.assistantText}`)
  if (turn.toolSummary) lines.push(`Tool activity: ${turn.toolSummary}`)
  for (const result of turn.toolResults) {
    const name = result.toolName ? ` (${result.toolName})` : ''
    const flag = result.isError ? ' [error]' : ''
    lines.push(`Tool result${name}${flag}: ${result.text}`)
  }
  return lines.join('\n')
}

function turnCharLength(turn: ConversationTurn): number {
  return renderTurnText(turn).length
}

function toTokenSet(turn: ConversationTurn): Set<string> {
  return new Set(tokenizeConversationText(`${turn.userText} ${turn.assistantText} ${turn.toolSummary}`))
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const token of a) if (b.has(token)) intersection++
  return intersection / (a.size + b.size - intersection)
}

/** 用滑动窗口均值/标准差判断是否为主题漂移点 */
function isDrift(similarities: readonly number[], latest: number): boolean {
  if (similarities.length < 2) return false
  const window = similarities.slice(-(WINDOW_RADIUS * 2 + 1))
  const mean = window.reduce((sum, value) => sum + value, 0) / window.length
  const variance = window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / window.length
  const std = Math.sqrt(variance)
  if (std < 1e-6) return false
  return latest < mean - DRIFT_K * std
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\r/g, '')
    .split(/(?<=[。！？!?；;])|\n{2,}/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

function buildChunk(sessionId: string, turns: ConversationTurn[], part = 0): ConversationChunk {
  const first = turns[0]!
  const last = turns[turns.length - 1]!
  const content = turns.map(renderTurnText).join('\n\n')
  const userText = turns.map((turn) => turn.userText).filter(Boolean).join('\n')
  const assistantText = turns.map((turn) => turn.assistantText).filter(Boolean).join('\n')
  const toolSummary = turns.map((turn) => turn.toolSummary).filter(Boolean).join(' ')
  const toolResults = turns.flatMap((turn) => turn.toolResults)
  const messageIds = [...new Set(turns.flatMap((turn) => turn.messageIds))]
  const termFreq = new Map<string, number>()
  const words = tokenizeConversationText(content)
  for (const word of words) termFreq.set(word, (termFreq.get(word) ?? 0) + 1)
  const partSuffix = part > 0 ? `-p${part}` : ''
  return {
    chunkId: `conv-${sessionId}-${first.turnIndex}-${last.turnIndex}${partSuffix}-${fnv1aHex(content)}`,
    turnStart: first.turnIndex,
    turnEnd: last.turnIndex,
    messageIds,
    timestamp: first.timestamp,
    userText,
    assistantText,
    toolSummary,
    toolResults,
    content,
    termFreq,
    length: Math.max(1, words.length),
  }
}

/** 单轮超过硬上限时按句子边界拆分 */
function splitOversizedTurn(sessionId: string, turn: ConversationTurn): ConversationChunk[] {
  const rendered = renderTurnText(turn)
  if (rendered.length <= HARD_MAX_TURN_CHARS) return [buildChunk(sessionId, [turn])]
  const sentences = splitSentences(rendered)
  if (sentences.length === 0) return [buildChunk(sessionId, [turn])]

  const chunks: ConversationChunk[] = []
  let buffer: string[] = []
  let size = 0
  let part = 0
  const flush = (): void => {
    if (buffer.length === 0) return
    const text = buffer.join('')
    const base = buildChunk(sessionId, [turn], part)
    const words = tokenizeConversationText(text)
    const termFreq = new Map<string, number>()
    for (const word of words) termFreq.set(word, (termFreq.get(word) ?? 0) + 1)
    chunks.push({
      ...base,
      content: text,
      termFreq,
      length: Math.max(1, words.length),
      chunkId: `conv-${sessionId}-${turn.turnIndex}-${turn.turnIndex}-p${part}-${fnv1aHex(text)}`,
    })
    part += 1
    buffer = []
    size = 0
  }
  for (const sentence of sentences) {
    if (size + sentence.length > MAX_CHUNK_CHARS) flush()
    buffer.push(sentence)
    size += sentence.length
  }
  flush()
  return chunks
}

/** 把一组轮次作为单个语义段输出 */
export function buildChunksFromTurns(sessionId: string, turns: readonly ConversationTurn[]): ConversationChunk[] {
  if (turns.length === 0) return []
  return [buildChunk(sessionId, [...turns])]
}

/** 关闭 pendingTurns，产出正式切片 */
function closePending(state: ConversationChunkState, sessionId: string): void {
  if (state.pendingTurns.length === 0) return
  state.chunks.push(...buildChunksFromTurns(sessionId, state.pendingTurns))
  state.pendingTurns = []
}

/**
 * 增量追加已闭合轮次，按主题漂移合并为语义段。
 * 只有收到「下一轮」时才能判断上一轮是否可闭合，因此当前轮始终留在 pendingTurns。
 */
export function appendTurnsToChunkState(
  state: ConversationChunkState,
  turns: readonly ConversationTurn[],
  sessionId: string,
): void {
  for (const turn of turns) {
    const chars = turnCharLength(turn)
    if (chars > HARD_MAX_TURN_CHARS) {
      closePending(state, sessionId)
      state.chunks.push(...splitOversizedTurn(sessionId, turn))
      continue
    }
    if (state.pendingTurns.length > 0) {
      const previous = state.pendingTurns[state.pendingTurns.length - 1]!
      const similarity = jaccard(toTokenSet(previous), toTokenSet(turn))
      state.similarities.push(similarity)
      const pendingChars = state.pendingTurns.reduce((sum, item) => sum + turnCharLength(item), 0)
      const shouldCut = pendingChars >= MIN_CHUNK_CHARS && isDrift(state.similarities, similarity)
      const wouldOverflow = pendingChars + chars > MAX_CHUNK_CHARS
      if (shouldCut || wouldOverflow) closePending(state, sessionId)
    }
    state.pendingTurns.push(turn)
    const pendingChars = state.pendingTurns.reduce((sum, item) => sum + turnCharLength(item), 0)
    if (pendingChars >= MAX_CHUNK_CHARS) closePending(state, sessionId)
  }
}

/** 查询时使用的完整切片集合（正式切片 + 尚未闭合的当前段） */
export function getSearchChunks(state: ConversationChunkState, sessionId: string): ConversationChunk[] {
  return [...state.chunks, ...buildChunksFromTurns(sessionId, state.pendingTurns)]
}

/** 超限保护：丢弃最旧的 25% 切片 */
export function trimChunkState(state: ConversationChunkState, maxChunks: number): void {
  if (state.chunks.length <= maxChunks) return
  const keepFrom = Math.floor(state.chunks.length * 0.25)
  state.chunks = state.chunks.slice(keepFrom)
}

/** 从零重建切块状态（用于索引文件被截断后的恢复） */
export function rebuildChunkState(
  turns: readonly ConversationTurn[],
  sessionId: string,
): ConversationChunkState {
  const state: ConversationChunkState = { chunks: [], pendingTurns: [], similarities: [] }
  appendTurnsToChunkState(state, turns, sessionId)
  return state
}
