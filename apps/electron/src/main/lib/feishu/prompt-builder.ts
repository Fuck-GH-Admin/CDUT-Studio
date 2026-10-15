/**
 * 飞书消息上下文 → Agent 系统提示词 + user message 的构造器。
 *
 * 解决的真实问题：
 *   1. Agent 看不到引用回复——用户在飞书里"长按 → 回复"某条消息时，
 *      飞书把被引用消息的 messageId 放在 message.parent_id 里。原来
 *      Profer 只把 user text 给 Agent，丢掉了"用户在问哪条消息"这个上下文。
 *   2. Agent 不知道 chat 类型与发送者——群聊 vs 私聊、用户名等元数据
 *      此前是隐式的（仅在群聊 prefix 里出现）。
 *   3. Agent 看不到被引用的卡片内容——用户引用 Bot 发的卡片提问时，
 *      只看到一串 "[card]" 占位文本。
 *
 * 借鉴 zara/feishu-claude-code-bridge `src/agent/claude/adapter.ts`
 * 的 BRIDGE_SYSTEM_PROMPT 约定 + `src/bot/quote.ts` 的引用消息抓取，
 * 但 Profer 用动态系统提示词构建，BRIDGE_SYSTEM_PROMPT 作为
 * AgentSendInput.userMessage 的前置 XML 块（不是 system prompt）。
 *
 * 约定的 XML 块（教 Agent 见 BRIDGE_USER_MESSAGE_PRELUDE）：
 *   <bridge_context>       chat_id / chat_type / sender 元数据
 *   <quoted_message>       被引用消息内容（含 merge_forward 展开）
 *   <interactive_card>     被引用消息是卡片时，注入完整 card JSON
 *   <attached_files>       本地附件列表（已有，由 handleUserMessage 构造）
 */

import type { Client as LarkClient } from '@larksuiteoapi/node-sdk'

/** 引用消息的简化结构，由 Bridge 调 im.message.get 拉取得到。 */
export interface QuotedMessage {
  messageId: string
  senderOpenId?: string
  senderName?: string
  createdAt?: number
  contentType: string
  /** 文本内容（已从飞书 content JSON 解出） */
  content: string
  /** 如果被引用消息本身是 interactive 卡片，这里是原 card JSON 字符串 */
  cardJson?: string
}

export interface BridgeContext {
  chatId: string
  chatType: 'p2p' | 'group' | 'topic'
  senderOpenId: string
  senderName?: string
  /** 话题群的 thread_id；普通群/p2p 留空 */
  threadId?: string
}

export interface BuildOptions {
  /** 用户原始文本（已合并多消息 batch 时由调用方拼好） */
  userText: string
  /** chat / sender 元数据 */
  context: BridgeContext
  /** 引用回复目标（用户长按"回复"指向的消息）；可选 */
  quoted?: QuotedMessage
  /** 附件路径引用块；handleUserMessage 已有逻辑构造，原样拼入 */
  attachedFilesBlock?: string
  /** 群聊额外注入：群名 / 成员列表 / 历史摘要 */
  groupExtraBlock?: string
}

/** 教 Agent 如何看待 bridge 注入的 XML 块。会被前置到每条 userMessage。 */
export const BRIDGE_USER_MESSAGE_PRELUDE = `<!-- You are handling user messages from Feishu (Lark) through the Profer Feishu bridge. The bridge injects
metadata about the current conversation via XML blocks. The XML blocks below are **invisible to the user**;
never copy them verbatim into your reply.

Possible XML blocks:
- <bridge_context>: Feishu-side metadata such as chat_id / chat_type / sender
- <quoted_message>: the message the user long-pressed "Reply" on (your answer should revolve around it)
- <interactive_card>: when the quoted message is a card, the original card JSON is attached for you to understand its structure
- <attached_files>: images/files the user uploaded have been saved locally; absolute paths are given to you

The user's actual question follows these blocks. Focus your answer on the user's question; the XML blocks are for context understanding only.

[Important Feishu bridge constraints]
1. **Never call the AskUserQuestion tool**: the Feishu bridge currently has no interactive Q&A UI channel; calling it would hang the session. If information is insufficient, give the best inference from what you have (you may state your assumptions in the reply), or directly tell the user what extra information you need so they can supply it in the next message.
   Absolutely never call AskUserQuestion.
2. **Prefer the Read tool for attachments**: <attached_files> provides absolute paths already saved locally; you can Read them directly (images go through multimodal reading) or inspect them with Bash commands like file/cat.
3. **Reply format**: the Feishu side renders markdown rich-text cards, so markdown formatting is safe to use.
4. **Prefer Feishu Docs for long content**: Feishu message cards suit short replies; overly long content gets truncated or split across multiple cards with poor readability. When the final deliverable is structured or lengthy (research reports, solution comparisons, analysis documents, long summaries, etc.), prefer creating a Feishu cloud document carrying the full content, and reply in the message with a brief summary + document link. Whether to use document delivery is your call based on content shape and length; short Q&A, fragmentary info, and code snippets should still be answered directly in the message.
-->`

/**
 * 把上下文 / 引用 / 附件 / 用户文本组装成最终的 AgentSendInput.userMessage。
 *
 * 输出结构（自上而下）：
 *   BRIDGE_USER_MESSAGE_PRELUDE
 *   <bridge_context>...</bridge_context>
 *   <quoted_message>...</quoted_message>     // 仅当 quoted 存在
 *   <interactive_card>...</interactive_card> // 仅当被引用消息是卡片
 *   <attached_files>...</attached_files>     // 仅当有附件
 *   <group_extra>...</group_extra>           // 仅当群聊（群名/成员/历史）
 *   <user_message>用户文本</user_message>
 */
export function buildAgentUserMessage(opts: BuildOptions): string {
  const parts: string[] = [BRIDGE_USER_MESSAGE_PRELUDE]

  parts.push(buildBridgeContextBlock(opts.context))

  if (opts.quoted) {
    parts.push(buildQuotedMessageBlock(opts.quoted))
    if (opts.quoted.cardJson) {
      parts.push(buildInteractiveCardBlock(opts.quoted.cardJson))
    }
  }

  if (opts.attachedFilesBlock && opts.attachedFilesBlock.trim()) {
    parts.push(opts.attachedFilesBlock.trim())
  }

  if (opts.groupExtraBlock && opts.groupExtraBlock.trim()) {
    parts.push(`<group_extra>\n${opts.groupExtraBlock.trim()}\n</group_extra>`)
  }

  parts.push(`<user_message>\n${opts.userText}\n</user_message>`)

  return parts.join('\n\n')
}

function buildBridgeContextBlock(ctx: BridgeContext): string {
  const lines = [
    `chat_id: ${ctx.chatId}`,
    `chat_type: ${ctx.chatType}`,
    `sender_id: ${ctx.senderOpenId}`,
  ]
  if (ctx.senderName) lines.push(`sender_name: ${ctx.senderName}`)
  if (ctx.threadId) lines.push(`thread_id: ${ctx.threadId}`)
  return `<bridge_context>\n${lines.join('\n')}\n</bridge_context>`
}

function buildQuotedMessageBlock(q: QuotedMessage): string {
  const attrs = [
    `id="${q.messageId}"`,
    q.senderOpenId ? `sender_id="${q.senderOpenId}"` : '',
    q.senderName ? `sender_name="${escapeAttr(q.senderName)}"` : '',
    q.createdAt ? `created_at="${new Date(q.createdAt).toISOString()}"` : '',
    `type="${q.contentType}"`,
  ].filter(Boolean).join(' ')
  return `<quoted_message ${attrs}>\n${q.content}\n</quoted_message>`
}

function buildInteractiveCardBlock(cardJson: string): string {
  return `<interactive_card>\n${cardJson}\n</interactive_card>`
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'))
}

/**
 * 从飞书 im.message.get 拿到被引消息的 raw 字段后，转换成 QuotedMessage。
 * 调用方应处理网络错误并返回 undefined，让 prompt 不带 quoted 块即可。
 */
export async function fetchQuotedMessage(
  client: LarkClient,
  parentMessageId: string,
): Promise<QuotedMessage | undefined> {
  try {
    const resp = await client.im.v1.message.get({
      path: { message_id: parentMessageId },
    })
    const item = resp.data?.items?.[0]
    if (!item) return undefined

    const contentType = item.msg_type ?? 'unknown'
    const bodyContent = item.body?.content ?? ''
    const senderId = item.sender?.id
    const createTime = typeof item.create_time === 'string'
      ? Number(item.create_time)
      : item.create_time

    let content = ''
    let cardJson: string | undefined

    if (contentType === 'text') {
      content = safeJsonField(bodyContent, 'text') ?? bodyContent
    } else if (contentType === 'post') {
      // post 是富文本，飞书内容是 { title, content: [[{tag, text|content}]] }
      // 简化：拼接所有 text 段
      content = extractPostText(bodyContent)
    } else if (contentType === 'interactive') {
      content = '(The quoted item is an interactive card; see <interactive_card> for details)'
      cardJson = bodyContent
    } else if (contentType === 'image') {
      content = `(The quoted item is an image message, image_key=${safeJsonField(bodyContent, 'image_key') ?? '?'})`
    } else if (contentType === 'file') {
      content = `(The quoted item is a file message, file_name=${safeJsonField(bodyContent, 'file_name') ?? '?'})`
    } else {
      // 兜底：原始 JSON 截断
      content = bodyContent.length > 500 ? bodyContent.slice(0, 500) + '…' : bodyContent
    }

    return {
      messageId: parentMessageId,
      senderOpenId: senderId,
      createdAt: typeof createTime === 'number' ? createTime : undefined,
      contentType,
      content,
      cardJson,
    }
  } catch (err) {
    console.warn('[飞书 PromptBuilder] 拉取被引消息失败', {
      parentMessageId,
      err: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}

function safeJsonField(bodyContent: string, field: string): string | undefined {
  try {
    const obj = JSON.parse(bodyContent) as Record<string, unknown>
    const v = obj[field]
    return typeof v === 'string' ? v : undefined
  } catch {
    return undefined
  }
}

interface PostNode {
  tag?: string
  text?: string
  content?: string
}

function extractPostText(bodyContent: string): string {
  try {
    const obj = JSON.parse(bodyContent) as {
      title?: string
      content?: PostNode[][]
    }
    const lines: string[] = []
    if (obj.title) lines.push(obj.title)
    if (Array.isArray(obj.content)) {
      for (const line of obj.content) {
        if (!Array.isArray(line)) continue
        const seg = line.map((n) => n.text ?? n.content ?? '').join('')
        if (seg) lines.push(seg)
      }
    }
    return lines.join('\n')
  } catch {
    return bodyContent
  }
}
