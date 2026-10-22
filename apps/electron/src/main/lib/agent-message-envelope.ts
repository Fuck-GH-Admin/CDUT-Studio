/**
 * 当轮消息封装（Context Sandwich）。
 *
 * 目标：`<USER_REQUEST>` 只承载用户直接输入的正文；附件清单、划词引用等由客户端
 * 预置的结构化块与 RAG 证据、工具提示统一收进 `<SYSTEM_CONTEXT>`，避免用户请求
 * 边界被材料/系统指令覆盖（提示注入面）。
 */

/** 客户端预置在用户消息里的结构化块；顺序即出现顺序。 */
const INJECTED_USER_BLOCK_PATTERN = /<(attached_files|quoted_file|quoted_context)\b[^>]*>[\s\S]*?<\/\1>\s*/gi

export interface ExtractedUserBlocks {
  /** 剥离结构化块后的用户正文 */
  pureText: string
  /** 按出现顺序保留的结构化块原文 */
  contextBlocks: string[]
}

/** 从用户消息中抽取附件清单与划词引用块，只保留用户真正输入的正文。 */
export function extractInjectedUserBlocks(userMessage: string): ExtractedUserBlocks {
  const contextBlocks: string[] = []
  const pureText = userMessage.replace(INJECTED_USER_BLOCK_PATTERN, (block) => {
    const trimmed = block.trim()
    if (trimmed) contextBlocks.push(trimmed)
    return '\n'
  })

  return {
    pureText: pureText.replace(/\n{3,}/g, '\n\n').trim(),
    contextBlocks,
  }
}

export interface AgentContextEnvelopeInput {
  /** 本轮用户消息原文（可能含 <attached_files> / <quoted_file> / <quoted_context>） */
  userMessage: string
  /** 运行时元数据块（时间戳、工作目录、浏览器视口等） */
  metadata?: string
  /** 主进程注入的上下文块（引用会话、工具提示、附件文档、RAG 证据等） */
  contextBlocks?: Array<string | undefined | null>
}

/**
 * 组装发往模型的当轮消息：
 *   metadata → <SYSTEM_CONTEXT> → <USER_REQUEST>
 *
 * 结构化块与系统注入内容绝不再进入 `<USER_REQUEST>`。
 */
export function buildAgentContextEnvelope(input: AgentContextEnvelopeInput): string {
  const extracted = extractInjectedUserBlocks(input.userMessage)
  const contextBlocks = [...extracted.contextBlocks, ...(input.contextBlocks ?? [])]
    .map((block) => (typeof block === 'string' ? block.trim() : ''))
    .filter((block) => block.length > 0)

  const sections: string[] = []
  const metadata = input.metadata?.trim()
  if (metadata) sections.push(metadata)
  if (contextBlocks.length > 0) {
    sections.push(`<SYSTEM_CONTEXT>\n${contextBlocks.join('\n\n')}\n</SYSTEM_CONTEXT>`)
  }
  sections.push(`<USER_REQUEST>\n${extracted.pureText}\n</USER_REQUEST>`)

  return sections.join('\n\n')
}
