import type { AgentRuntime, Todo } from '@profer/shared'

/**
 * 构建"处理关联 Todo"的 Agent 首条消息。
 *
 * Claude/Pi 都提供规划 Todo MCP；工具名仅因 runtime 的 MCP 暴露形式不同而不同。
 * 仍保留 Todo 快照作为首条消息的降级上下文，避免工具暂时不可用时丢失用户目标。
 */
export function buildTodoAgentPrompt(todoId: string, agentRuntime: AgentRuntime, todo?: Todo): string {
  const planningGetTool = agentRuntime === 'pi' ? 'mcp__planning__get_todo' : 'get_todo'
  const todoLine = todo
    ? [
        `- Title: ${todo.title}`,
        todo.notes ? `- Notes: ${todo.notes}` : null,
        `- Priority: ${todo.priority === 'high' ? 'High' : todo.priority === 'low' ? 'Low' : 'Medium'}`,
        todo.dueAt ? `- Planned completion time: ${new Date(todo.dueAt).toLocaleString('zh-CN', { hour12: false })}` : null,
        todo.group ? `- Group: ${todo.group.name}` : null,
        todo.tags.length > 0 ? `- Tags: ${todo.tags.map((tag) => `#${tag.name}`).join(', ')}` : null,
      ].filter((line): line is string => line !== null)
    : []

  return [
    `Please work on the linked Todo (ID: ${todoId}).`,
    '',
    `Before starting, you must call \`${planningGetTool}({ id: "${todoId}" })\` to read this Todo's raw latest record (title, notes, priority, planned completion time, and linked context).`,
    '',
    ...(todoLine.length > 0 ? ['Current Todo snapshot (context only; the tool result above takes precedence):', ...todoLine, ''] : []),
    'Then check the current project state and advance the work according to the task goal; ask the user first when clarification or a high-risk operation is needed. Do not mark the Todo as completed unless the work is genuinely done or the user explicitly asks. User-facing output must be written in the user\'s language (e.g., Simplified Chinese when the user writes in Chinese).',
  ].join('\n')
}
