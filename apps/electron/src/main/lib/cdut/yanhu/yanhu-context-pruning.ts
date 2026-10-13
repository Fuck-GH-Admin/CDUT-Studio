/**
 * 智联万站 · 多步工具循环上下文剪枝（Context Pruning）
 *
 * 纯函数，不依赖 Electron / 供应商适配器，便于单测。
 *
 * 仅重写「早于最后 keepSteps 步」的旧 tool 结果内容，保留 toolCallId / isError，
 * 阻断 continuationMessages 随步数 O(N²) 膨胀；最后 keepSteps 步完全不动，
 * 以保护 Anthropic 家族必需的最新 thinking 签名块与工具配对完整性。
 */

import type { ContinuationMessage, ToolResult } from '@profer/core'

/** 单步工具循环的默认保留步数（更早步骤的工具结果将被压缩为占位摘要） */
export const PRUNE_KEEP_STEPS = 2

/** 旧步骤工具结果的压缩占位文本 */
const PRUNED_READ_PAGE = '[前序页面观察记录已由最新一步结果继承更新]'
const PRUNED_LOGS = '[前序日志已压缩]'
const PRUNED_GENERIC = '[前序结果已折叠]'
/** 通用结果保留前缀长度 */
const PRUNED_PREFIX_CHARS = 80
/** 旧步骤错误回执保留的诊断前缀长度（保留首段定位，便于模型自我纠偏） */
const PRUNED_ERROR_CHARS = 60

// ===== 跨轮次历史脱敏瘦身（History Slimming）：把落盘的巨型中间结果压为单行摘要 =====

/** 历史中单条通用工具结果保留的最大字符数 */
export const HISTORY_RESULT_MAX_CHARS = 200

/** 从巨型 PageDigest 文本中提取页面标题（`=== [PageDigest: 标题] ===`） */
function extractPageDigestTitle(text: string): string | null {
  const match = text.match(/^=== \[PageDigest: ([^\]]+)\] ===/)
  const title = match?.[1]?.trim()
  return title ? title : null
}

/**
 * 把工具执行结果压缩为「单行紧凑执行摘要」，供助手消息落盘写历史时使用。
 *
 * 巨型 PageDigest / network_logs 原始文本会被替换为一句话摘要，
 * 使下一轮加载历史上下文时前几轮的上下文占用从数万 Token 骤降至数百 Token。
 */
export function slimYanhuToolResultForHistory(toolName: string, result: unknown): unknown {
  if (toolName === 'yanhu_read_page') {
    const text = typeof result === 'string' ? result : ''
    if (text.includes('页面无变化')) return '[已读取页面: 无变化]'
    const title = extractPageDigestTitle(text)
    return title ? `[已读取页面: ${title}]` : '[已读取页面]'
  }
  if (toolName === 'yanhu_get_network_logs') return '[网络日志已折叠]'
  if (toolName === 'yanhu_get_console_logs') return '[控制台日志已折叠]'
  if (typeof result === 'string' && result.length > HISTORY_RESULT_MAX_CHARS) {
    return `${result.slice(0, HISTORY_RESULT_MAX_CHARS)}…`
  }
  return result
}

/** 判定一条消息是否为「携带工具调用的步骤分界」assistant 消息 */
function isToolStep(message: ContinuationMessage): message is Extract<ContinuationMessage, { role: 'assistant' }> {
  return message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length > 0
}

/**
 * 剪枝续接消息：压缩旧步骤的工具结果。
 *
 * @param messages 完整累积的续接消息序列（assistant / tool 交替）
 * @param options.keepSteps 需原样保留的末尾步数（默认 {@link PRUNE_KEEP_STEPS}）
 */
export function pruneYanhuContinuationMessages(
  messages: readonly ContinuationMessage[],
  options: { keepSteps?: number } = {},
): ContinuationMessage[] {
  const keepSteps = options.keepSteps && options.keepSteps > 0 ? options.keepSteps : PRUNE_KEEP_STEPS

  const nameById = new Map<string, string>()
  let totalSteps = 0
  for (const message of messages) {
    if (isToolStep(message)) {
      totalSteps += 1
      for (const call of message.toolCalls) nameById.set(call.id, call.name)
    }
  }
  if (totalSteps <= keepSteps) return [...messages]

  const out: ContinuationMessage[] = []
  let stepIndex = -1
  for (const message of messages) {
    if (message.role === 'assistant') {
      if (isToolStep(message)) stepIndex += 1
      out.push(message)
      continue
    }
    // tool 消息：仅当属于「早于最后 keepSteps 步」的旧步骤时才压缩
    if (stepIndex < 0 || stepIndex >= totalSteps - keepSteps) {
      out.push(message)
      continue
    }
    const results: ToolResult[] = message.results.map((result) => {
      const name = nameById.get(result.toolCallId) ?? ''
      let content: string
      if (name === 'yanhu_read_page') content = PRUNED_READ_PAGE
      else if (name === 'yanhu_get_network_logs' || name === 'yanhu_get_console_logs') content = PRUNED_LOGS
      else if (result.isError === true) {
        // 中间步骤的**工具错误回执**同样纳入精简压缩：仅保留首段诊断前缀，
        // 避免 20 步循环中大量长篇报错（BID 台账 / 选项清单等）累积膨胀至数十万 Token。
        const raw = result.content || ''
        content = raw.length > PRUNED_ERROR_CHARS ? `${raw.slice(0, PRUNED_ERROR_CHARS)}…` : raw || PRUNED_GENERIC
      } else if (result.content && result.content.length > PRUNED_PREFIX_CHARS) {
        content = `${result.content.slice(0, PRUNED_PREFIX_CHARS)}…`
      } else {
        content = result.content || PRUNED_GENERIC
      }
      return { ...result, content }
    })
    out.push({ role: 'tool', results })
  }
  return out
}
