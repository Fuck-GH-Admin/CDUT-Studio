/**
 * Pi 的静态化提示词组装（Context Sandwich 静态前缀）。
 *
 * 为保证大模型服务端的前缀缓存命中（享受 1 折 Cache Read），同一会话生命周期内
 * 输出的 systemPrompt 必须字节级稳定：这里不再根据用户提问文本（正则）动态增删 SOP，
 * 只按「会话稳定」的工具挂载与能力开关裁剪。工具的可用能力始终由 ToolDefinition 暴露，
 * 裁剪只影响辅助说明文案，不隐藏能力、也不改变权限。
 */

export interface PiTaskPromptOptions {
  /** 仅传 buildSystemPrompt() 的原始输出，不要在此之前拼接附件/预设自定义段落。 */
  basePrompt: string
  /**
   * 用户本轮消息。静态化后不再参与裁剪决策（仅为兼容既有调用方保留），
   * 确保同一会话内 systemPrompt 不随用户文本变化。
   */
  userMessage: string
  toolNames: Iterable<string>
  /** 自动任务运行上下文：需要完整 Automation SOP。 */
  forceAutomation?: boolean
  /** PPT 专用能力是否已由会话级门禁激活。 */
  pptCapabilityActive?: boolean
}

interface PromptSection {
  text: string
  rest: string
}

function removeSection(prompt: string, startMarker: string, endMarker: string | string[]): PromptSection | undefined {
  const start = prompt.indexOf(startMarker)
  if (start < 0) return undefined
  const markers = Array.isArray(endMarker) ? endMarker : [endMarker]
  let end = -1
  for (const marker of markers) {
    const idx = prompt.indexOf(marker, start + startMarker.length)
    if (idx >= 0 && (end === -1 || idx < end)) {
      end = idx
    }
  }
  if (end < 0) return undefined
  return {
    text: prompt.slice(start, end).trim(),
    rest: `${prompt.slice(0, start)}${prompt.slice(end)}`,
  }
}

/** 只取当前段落及其子标题；下一个 ## 标题或关闭标签后的常驻规则必须保留。 */
function removeHeadingSection(prompt: string, startMarker: string): PromptSection | undefined {
  const start = prompt.indexOf(startMarker)
  if (start < 0) return undefined
  const contentStart = start + startMarker.length
  const nextBoundary = prompt.slice(contentStart).search(/^(?:## |<\/[a-z_]+>)/m)
  const end = nextBoundary < 0 ? prompt.length : contentStart + nextBoundary
  return {
    text: prompt.slice(start, end).trim(),
    rest: `${prompt.slice(0, start)}${prompt.slice(end)}`,
  }
}

function hasAnyTool(toolNames: Set<string>, predicate: (name: string) => boolean): boolean {
  return [...toolNames].some(predicate)
}

/**
 * 返回本轮 Pi 实际使用的 system prompt。
 *
 * 低频 SOP 从基础 prompt 中取出后，仅按「会话稳定」的判定（工具是否实际注册、能力是否
 * 激活）决定是否追加，完全不参考用户提问文本。因此同一会话内（工具集合不变时）输出
 * 字节级一致，前缀缓存 100% 命中。如果以后某段文案变更导致未找到 marker，函数保守地
 * 保留原始 prompt，绝不静默丢失安全指令。
 */
export function buildPiTaskPrompt(options: PiTaskPromptOptions): string {
  const tools = new Set(options.toolNames)
  const lowFrequency: string[] = []
  let prompt = options.basePrompt

  const collaboration = removeSection(prompt, '## SubAgent Delegation Policy', ['</subagents>', '## Pi Agent Runtime'])
  if (collaboration) {
    prompt = collaboration.rest
    if (hasAnyTool(tools, (name) => name.startsWith('mcp__collaboration__'))) lowFrequency.push(collaboration.text)
  }

  const piMemory = removeHeadingSection(prompt, '### Pi Runtime & File Memory')
  if (piMemory) {
    prompt = piMemory.rest
    const hasMemoryTool = hasAnyTool(tools, (name) => name.startsWith('mcp__memory-archive__') || name.startsWith('mcp__team-memory__'))
    // 完整的知识维护与收尾回写规则由常驻的「CDUT Studio 知识维护架构」承载；此处只保留
    // Pi 专属文件操作细节，按记忆工具是否注册恢复，避免普通本地任务重复携带长段落。
    if (hasMemoryTool) lowFrequency.push(piMemory.text)
  }

  const teamMemory = removeSection(prompt, '## Team Shared Knowledge Memory', '## Uncertainty Handling')
  if (teamMemory) {
    prompt = teamMemory.rest
    if (hasAnyTool(tools, (name) => name.startsWith('mcp__team-memory__'))) lowFrequency.push(teamMemory.text)
  }

  const knowledgeGovernance = removeSection(prompt, '## CDUT Studio Knowledge Maintenance Architecture', '## Task Completion Criteria')
  if (knowledgeGovernance) {
    prompt = knowledgeGovernance.rest
    // 知识维护是跨任务的常驻行为约束，不能只在出现“记忆”关键词时注入。
    lowFrequency.push(knowledgeGovernance.text)
  }

  const automation = removeSection(prompt, '7. **Scheduled tasks (Automation)**', '8. **Sending existing local images**')
  if (automation) {
    prompt = automation.rest
    // 定时任务工具按会话注册；forceAutomation 用于自动任务运行上下文强制保留。
    const hasAutomationTool = hasAnyTool(tools, (name) => name.startsWith('mcp__automation__'))
    if (hasAutomationTool || options.forceAutomation === true) lowFrequency.push(automation.text)
  }

  const delivery = removeSection(prompt, '8. **Sending existing local images**', ['## CDUT Studio Managed Browser', '</guidelines>'])
  if (delivery) {
    prompt = delivery.rest
    const hasImageOutput = tools.has('send_local_image')
    const hasPptWorkflow = options.pptCapabilityActive === true
      && tools.has('plan_ppt_visuals')
      && tools.has('audit_ppt_delivery')
      && tools.has('open_file_preview')
      && tools.has('inspect_file_preview')
    // 图片发送/生成/皮肤与 PPT 交付共用同一段 SOP：任一相关工具实际注册即恢复。
    const hasDeliveryTools = hasImageOutput
      || tools.has('generate_image')
      || tools.has('create_skin')
      || hasPptWorkflow
    if (hasDeliveryTools) lowFrequency.push(delivery.text)
  }

  const browser = removeHeadingSection(prompt, '## CDUT Studio Managed Browser')
  if (browser) {
    prompt = browser.rest
    if (hasAnyTool(tools, (name) => name.startsWith('Browser'))) lowFrequency.push(browser.text)
  }

  if (lowFrequency.length > 0) {
    const recencyMarker = '> **CRITICAL EXECUTION REMINDER**:'
    const reminderIdx = prompt.lastIndexOf(recencyMarker)
    if (reminderIdx >= 0) {
      return `${prompt.slice(0, reminderIdx).trim()}\n\n${lowFrequency.join('\n\n')}\n\n${prompt.slice(reminderIdx).trim()}`
    }
    return `${prompt.trim()}\n\n${lowFrequency.join('\n\n')}`
  }
  return prompt.trim()
}
