/**
 * Agent Prompt 构建工具函数
 *
 * 从 agent-orchestrator.ts 提取的纯函数，用于构建上下文注入和恢复 prompt。
 */
import { join } from 'node:path'
import { getAgentSessionSDKMessages, getAgentSessionMeta } from './agent-session-manager'
import { getBundledCliPath, resolveConfigDir, toDisplayPath } from './config-paths'
import type { SDKMessage, AgentSessionMeta } from '@profer/shared'

/** 历史长对话按需检索时的候选轮次扫描上限 */
export const MAX_CONTEXT_MESSAGES = 20

/** 单条工具摘要最大字符数 */
const MAX_TOOL_SUMMARY_LENGTH = 200

/** 默认会话标题 */
export const DEFAULT_SESSION_TITLE = '新 Agent 会话'

/** 默认模型 ID */
export const DEFAULT_MODEL_ID = 'claude-sonnet-4-6'

/**
 * 从 SDKMessage assistant 消息的 content 中提取工具活动摘要
 */
export function extractSDKToolSummary(content: Array<{ type: string; name?: string; input?: Record<string, unknown> }>): string {
  const summaries: string[] = []
  for (const block of content) {
    if (block.type === 'tool_use' && block.name) {
      const input = block.input ?? {}
      const keyParam = input.file_path ?? input.command ?? input.path ?? input.query ?? ''
      const paramStr = keyParam ? `: ${String(keyParam).slice(0, 100)}` : ''
      summaries.push(`[tool: ${block.name}${paramStr}]`)
    }
  }
  if (summaries.length === 0) return ''
  const joined = summaries.join(' ')
  return joined.length > MAX_TOOL_SUMMARY_LENGTH
    ? joined.slice(0, MAX_TOOL_SUMMARY_LENGTH) + '...'
    : joined
}

/** 紧邻保留的完整轮数（User + Assistant） */
const RECENT_TURN_PAIRS = 1

/** 历史检索相似度阈值（查询词元覆盖率） */
const HISTORY_RELEVANCE_THRESHOLD = 0.2

/** 历史检索命中的最小词元数 */
const HISTORY_MIN_MATCHED_TERMS = 2

/** 单次最多注入的相关历史轮数 */
const MAX_RELEVANT_TURNS = 2

/** 中文 / 英文常见停用词（历史检索噪音过滤） */
const CONTEXT_STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'is', 'are', 'was', 'were', 'be', 'been',
  'for', 'with', 'as', 'by', 'at', 'from', 'that', 'this', 'these', 'those', 'it', 'its',
  '的', '了', '和', '与', '及', '或', '是', '在', '对', '为', '中', '上', '下', '里', '把', '被',
  '请', '我', '你', '他', '她', '它', '这', '那', '有', '无', '不', '也', '就', '都', '会', '能',
])

/** 轻量词元化：中文（单字 + 相邻 bigram）与英文 / 数字，用于历史相关度打分 */
function contextTokenize(text: string): Set<string> {
  const lower = text.toLowerCase()
  const tokens = new Set<string>()
  for (const word of lower.match(/[a-z0-9]{2,}/g) ?? []) {
    if (!CONTEXT_STOP_WORDS.has(word)) tokens.add(word)
  }
  const han = lower.match(/[\u4e00-\u9fa5]/g) ?? []
  for (let i = 0; i < han.length; i++) {
    const single = han[i]!
    if (!CONTEXT_STOP_WORDS.has(single)) tokens.add(single)
    if (i + 1 < han.length) tokens.add(`${single}${han[i + 1]}`)
  }
  return tokens
}

/** 一轮完整对话（User + Assistant） */
interface ConversationTurn {
  userText: string
  assistantText: string
  assistantToolSummary: string
}

type SDKContentBlock = { type: string; text?: string; name?: string; input?: Record<string, unknown> }

/** 从消息 content 中提取纯文本 */
function extractContentText(content: SDKContentBlock[]): string {
  return content
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text!)
    .join('\n')
}

/** 把消息序列聚合为按「用户提问 → 助手回复」配对的对话轮次 */
function toConversationTurns(messages: SDKMessage[]): ConversationTurn[] {
  const turns: ConversationTurn[] = []
  let pendingUser = ''
  let hasPendingUser = false
  for (const message of messages) {
    if (message.type !== 'user' && message.type !== 'assistant') continue
    const content = (message as { message?: { content?: SDKContentBlock[] } }).message?.content
    if (!Array.isArray(content)) continue
    if (message.type === 'user') {
      const text = extractContentText(content)
      if (text) {
        pendingUser = text
        hasPendingUser = true
      }
      continue
    }
    const assistantText = extractContentText(content)
    const toolSummary = extractSDKToolSummary(content)
    if (!assistantText && !toolSummary) continue
    turns.push({
      userText: hasPendingUser ? pendingUser : '',
      assistantText,
      assistantToolSummary: toolSummary,
    })
    pendingUser = ''
    hasPendingUser = false
  }
  return turns
}

/** 渲染单轮对话为上下文行 */
function renderTurnLine(turn: ConversationTurn): string {
  const lines: string[] = []
  if (turn.userText) lines.push(`[user]: ${turn.userText}`)
  if (turn.assistantText) lines.push(`[assistant]: ${turn.assistantText}`)
  if (turn.assistantToolSummary) lines.push(`  工具活动: ${turn.assistantToolSummary}`)
  return lines.join('\n')
}

/**
 * 构建带历史上下文的 prompt。
 *
 * 记忆策略（打碎 ReAct 历史累乘）：
 *   - 紧邻连贯窗口：仅保留当前提问 + 刚完整回复好的上 1 轮（User + Assistant）；
 *   - 历史长对话：对更早轮次按当前提问做轻量倒排检索，仅在相似度超阈值时注入
 *     最相关的 1~2 轮摘要到 `<relevant_history>`，否则不注入任何历史。
 */
export function buildContextPrompt(
  sessionId: string,
  currentUserMessage: string,
  sessionHint?: { agentCwd: string },
  retrievalQuery?: string,
): string {
  const allMessages = getAgentSessionSDKMessages(sessionId)
  if (allMessages.length === 0) return currentUserMessage

  const history = allMessages.slice(0, -1)
  if (history.length === 0) return currentUserMessage

  const turns = toConversationTurns(history)
  if (turns.length === 0) return currentUserMessage

  const recentTurns = turns.slice(-RECENT_TURN_PAIRS)
  const olderTurns = turns.slice(0, turns.length - RECENT_TURN_PAIRS)
  const recentLines = recentTurns.map(renderTurnLine)

  const sessionInfoBlock = sessionHint
    ? `\n<session_info>\nSession ID: ${sessionId}\nSession CWD: ${sessionHint.agentCwd}\nNote: 上方仅保留紧邻上一轮对话。如需更多上下文，可读取 ${sessionHistoryDisplayPath(sessionId)} 获取完整历史。\n</session_info>\n`
    : ''
  const historyBlock = `<conversation_history>${sessionInfoBlock}\n${recentLines.join('\n')}\n</conversation_history>`

  // 历史长对话按需静默检索：仅当相似度超阈值时注入相关历史切片
  let relevantBlock = ''
  let relevantTurnCount = 0
  const query = (retrievalQuery ?? '').trim()
  if (olderTurns.length > 0 && query) {
    const queryTokens = contextTokenize(query)
    if (queryTokens.size > 0) {
      const candidates = olderTurns.slice(-MAX_CONTEXT_MESSAGES)
      const scored = candidates
        .map((turn, order) => {
          const turnTokens = contextTokenize(`${turn.userText} ${turn.assistantText}`)
          let matched = 0
          for (const token of queryTokens) if (turnTokens.has(token)) matched++
          return { turn, order, matched, coverage: matched / queryTokens.size }
        })
        .filter((item) => item.matched >= HISTORY_MIN_MATCHED_TERMS && item.coverage >= HISTORY_RELEVANCE_THRESHOLD)
        .sort((a, b) => b.coverage - a.coverage)
        .slice(0, MAX_RELEVANT_TURNS)
        .sort((a, b) => a.order - b.order)
      if (scored.length > 0) {
        relevantTurnCount = scored.length
        relevantBlock =
          `\n\n<relevant_history>\n` +
          `<!-- 以下为按当前提问检索到的较早相关讨论，仅供参考，不代表本轮用户诉求。 -->\n` +
          `${scored.map((item) => renderTurnLine(item.turn)).join('\n')}\n` +
          `</relevant_history>`
      }
    }
  }

  console.log(
    `[Agent 编排] buildContextPrompt: 读取 ${allMessages.length} 条消息，注入紧邻 ${recentTurns.length} 轮` +
      `${relevantTurnCount > 0 ? ` + 相关历史 ${relevantTurnCount} 轮` : ''}${sessionHint ? '（含 session 元信息）' : ''}`,
  )
  return `${historyBlock}${relevantBlock}\n\n${currentUserMessage}`
}

/** 会话历史文件展示路径：默认折叠为 ~/.cdutai[-dev]/...，PROFER_CONFIG_DIR 覆盖时给绝对路径。 */
function sessionHistoryDisplayPath(sessionId: string): string {
  return toDisplayPath(join(resolveConfigDir(), 'agent-sessions', `${sessionId}.jsonl`))
}

/**
 * 构建 Session 恢复 prompt
 */
export function buildRecoveryPrompt(
  sessionId: string,
  currentUserMessage: string,
  sessionHint: { agentCwd: string },
): string {
  const meta = getAgentSessionMeta(sessionId)
  const title = meta ? escapeContextAttr(meta.title) : sessionId
  const historyPath = sessionHistoryDisplayPath(sessionId)

  const recoveryBlock =
    `<session_recovery>\n` +
    `你正在接续一个已有的 Agent 会话（因模型切换等原因需要重新建立连接）。\n` +
    `当前会话的完整历史记录在下方路径中，请先读取它以恢复上下文，然后继续处理用户的最新请求。\n` +
    `<session id="${sessionId}" title="${title}" cwd="${sessionHint.agentCwd}">\n` +
    `History path: ${historyPath}\n` +
    `</session>\n` +
    `</session_recovery>`

  console.log(`[Agent 编排] buildRecoveryPrompt: 注入 session 自引用 → ${historyPath}`)
  return `${recoveryBlock}\n\n${currentUserMessage}`
}

export function escapeContextAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function getSessionCliCommandPrefix(): string {
  return getBundledCliPath() ? '"$PROFER_CLI"' : 'profer'
}

export function buildReferencedSessionsPrompt(
  currentSessionId: string,
  mentionedSessionIds?: string[],
  workspaceId?: string,
): string {
  const uniqueIds = [...new Set((mentionedSessionIds ?? []).filter(Boolean))]
  if (uniqueIds.length === 0) return ''

  const currentWorkspaceId = workspaceId ?? getAgentSessionMeta(currentSessionId)?.workspaceId
  const sessionBlocks: string[] = []

  for (const referencedSessionId of uniqueIds) {
    if (referencedSessionId === currentSessionId) continue

    const meta = getAgentSessionMeta(referencedSessionId)
    if (!meta || meta.archived) continue
    if (currentWorkspaceId && meta.workspaceId !== currentWorkspaceId) continue

    const title = escapeContextAttr(meta.title)
    const historyPath = sessionHistoryDisplayPath(referencedSessionId)
    const explorationBoundary = meta.explorationParentSessionId && meta.explorationSourceMessageId
      ? `\n<exploration_delta parentSessionId="${escapeContextAttr(meta.explorationParentSessionId)}" sourceMessageId="${escapeContextAttr(meta.explorationSourceMessageId)}">\n` +
        '此会话是从主线分叉的探索分支；用户引用的仅是 sourceMessageId 之后新增的探索内容。\n' +
        '分叉前复制的主线历史不是本次引用内容：不要读取、总结或重复处理它。\n' +
        `请先用 ${getSessionCliCommandPrefix()} session export ${referencedSessionId} --after-message ${meta.explorationSourceMessageId} 精确读取分叉后的内容。\n` +
        '仅当必须核验分支内更早的新增内容时，才在该边界之后渐进读取；不要导出完整 fork 历史。\n' +
        '</exploration_delta>'
      : ''
    sessionBlocks.push(
      `<session id="${referencedSessionId}" title="${title}" updatedAt="${meta.updatedAt}">\n` +
      `History path: ${historyPath}\n` +
      `</session>${explorationBoundary}`,
    )
  }

  if (sessionBlocks.length === 0) return ''

  return `<referenced_sessions>\n用户在消息中明确引用了以下同工作区 Agent 会话。不要假设这些会话的内容；需要上下文时，请先读取对应的 History path，再基于读取结果继续完成任务。\n\n重要提示：会话历史文件（.jsonl）可能包含大量消息和 tool results，文件较大。请优先使用 Grep 搜索关键词定位相关消息片段，再局部读取。避免一次性 Read 整个大文件。\n${sessionBlocks.join('\n\n')}\n</referenced_sessions>`
}
