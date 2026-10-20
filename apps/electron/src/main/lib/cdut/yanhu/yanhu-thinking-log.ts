/**
 * 砚小龙 · 思考链落盘（append-only JSONL）
 *
 * 为什么单独落一个文件，而不是塞进 `yanhu-pet-history.json`：
 *   1. 单轮思考链可达数万字符，写进会话存储会让整份 JSON **每轮被原子重写**（越滚越慢、越滚越大）；
 *   2. 追加式（append-only）不需要读-改-写，天然无竞态，也不受记忆窗口裁剪影响；
 *   3. 一行一轮，便于 grep 与直接导出排查（历史排查正是靠人工拼这份时间线完成的）。
 *
 * 输出：`~/.cdutai/yanhu-thinking.jsonl`（开发版为 `~/.cdutai-dev/…`）。
 * 每行一个 JSON 对象：`{ at, messageId, userText, reasoning, tools[] }`，
 * 其中 `tools` 是当轮工具时间线（标签 + 状态 + 已瘦身结果），与思考正文共同还原完整的「思考链」。
 */

import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getConfigDir } from '../../config-paths'

/** 单轮思考正文的落盘上限（超出截断并标记，防止病态长思考撑爆磁盘） */
export const MAX_THINKING_REASONING_CHARS = 200_000
/** 时间线里单条工具结果的落盘上限 */
export const MAX_THINKING_TOOL_RESULT_CHARS = 400

/** 思考链时间线上的一个工具步骤 */
export interface YanhuThinkingToolStep {
  label: string
  status: string
  result: string
}

/** 思考链落盘记录（一行一轮） */
export interface YanhuThinkingRecord {
  at: number
  messageId: string
  userText: string
  reasoning: string
  tools: YanhuThinkingToolStep[]
}

/** 思考链日志路径：~/.cdutai/yanhu-thinking.jsonl */
export function getYanhuThinkingLogPath(): string {
  return join(getConfigDir(), 'yanhu-thinking.jsonl')
}

/** 按上限截断文本（超出部分以明确的计数标记收尾，绝不静默丢内容） */
function clipText(raw: string, limit: number): string {
  if (raw.length <= limit) return raw
  return `${raw.slice(0, limit)}\n…[已截断：原始 ${raw.length} 字符，超出上限 ${limit}]`
}

/**
 * 组装一条思考链记录（纯函数，便于单测）。
 *
 * 传入的 `tools` 允许携带工具名等额外字段：本函数只取落盘所需的三个字段，
 * 保证日志结构与实现演进解耦。
 */
export function buildYanhuThinkingRecord(input: {
  messageId: string
  userText: string
  reasoning: string
  tools?: ReadonlyArray<{ label: string; status: string; result: unknown }>
  at?: number
}): YanhuThinkingRecord {
  const tools: YanhuThinkingToolStep[] = (input.tools ?? []).map((tool) => ({
    label: tool.label,
    status: tool.status,
    result: clipText(typeof tool.result === 'string' ? tool.result : String(tool.result ?? ''), MAX_THINKING_TOOL_RESULT_CHARS),
  }))
  return {
    at: input.at ?? Date.now(),
    messageId: input.messageId,
    userText: input.userText,
    reasoning: clipText(input.reasoning ?? '', MAX_THINKING_REASONING_CHARS),
    tools,
  }
}

/** 序列化为一行 JSONL（纯函数，便于单测：必须恰好一行、可被 JSON.parse 还原） */
export function serializeYanhuThinkingRecord(record: YanhuThinkingRecord): string {
  return `${JSON.stringify(record)}\n`
}

/**
 * 追加一轮思考链到磁盘。
 *
 * 采用**异步追加**：绝不阻塞 Electron 主线程；写失败仅告警，绝不影响本轮对话结果。
 */
export async function appendYanhuThinkingRecord(
  record: YanhuThinkingRecord,
  filePath: string = getYanhuThinkingLogPath(),
): Promise<void> {
  try {
    await appendFile(filePath, serializeYanhuThinkingRecord(record), 'utf8')
  } catch (err) {
    console.warn('[砚小龙] 思考链落盘失败:', err)
  }
}
