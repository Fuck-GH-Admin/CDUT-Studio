import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@profer/shared'
import {
  appendMessagesToTurnState,
  appendTurnsToChunkState,
  getRecentTurns,
  getSearchChunks,
  type ConversationChunkState,
  type ConversationTurnState,
} from './conversation-chunks'

function userMessage(text: string, uuid: string, createdAt: number): SDKMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    uuid,
    _createdAt: createdAt,
  } as unknown as SDKMessage
}

function assistantMessage(
  text: string,
  uuid: string,
  createdAt: number,
  tool?: { id: string; name: string; input: Record<string, unknown> },
): SDKMessage {
  const content: Array<Record<string, unknown>> = []
  if (text) content.push({ type: 'text', text })
  if (tool) content.push({ type: 'tool_use', id: tool.id, name: tool.name, input: tool.input })
  return {
    type: 'assistant',
    message: { content },
    parent_tool_use_id: null,
    uuid,
    _createdAt: createdAt,
  } as unknown as SDKMessage
}

function toolResultMessage(toolUseId: string, text: string, uuid: string, createdAt: number): SDKMessage {
  return {
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: false }],
    },
    parent_tool_use_id: null,
    uuid,
    _createdAt: createdAt,
  } as unknown as SDKMessage
}

function createTurnState(): ConversationTurnState {
  return { turns: [], openTurn: null }
}

describe('会话历史轮次解析', () => {
  test('Given 用户-助手-工具结果序列 When 解析 Then 工具结果归属同一轮并保留锚点', () => {
    const state = createTurnState()
    appendMessagesToTurnState(state, [
      userMessage('请读取 src/a.ts', 'u1', 1),
      assistantMessage('我来读取文件。', 'a1', 2, {
        id: 'tool-1',
        name: 'Read',
        input: { file_path: 'src/a.ts' },
      }),
      toolResultMessage('tool-1', '文件内容', 'r1', 3),
      userMessage('继续', 'u2', 4),
    ])

    expect(state.turns).toHaveLength(1)
    const turn = state.turns[0]!
    expect(turn.turnIndex).toBe(0)
    expect(turn.userText).toBe('请读取 src/a.ts')
    expect(turn.assistantText).toBe('我来读取文件。')
    expect(turn.toolSummary).toContain('[tool: Read: src/a.ts]')
    expect(turn.toolResults).toHaveLength(1)
    expect(turn.toolResults[0]).toMatchObject({ toolName: 'Read', text: '文件内容', isError: false })
    expect(turn.messageIds).toEqual(['u1', 'a1', 'r1'])
    // 第二条用户消息成为新的 openTurn
    expect(state.openTurn?.userText).toBe('继续')
  })

  test('Given 工具结果超长 When 解析 Then 单条截断且单轮总量受限', () => {
    const state = createTurnState()
    appendMessagesToTurnState(state, [
      userMessage('执行命令', 'u1', 1),
      assistantMessage('开始', 'a1', 2, { id: 'tool-1', name: 'Bash', input: { command: 'ls' } }),
      toolResultMessage('tool-1', 'x'.repeat(5000), 'r1', 3),
      toolResultMessage('tool-1', 'y'.repeat(5000), 'r2', 4),
    ])

    const turn = state.openTurn!
    expect(turn.toolResults[0]!.text.length).toBeLessThanOrEqual(601)
    const total = turn.toolResults.reduce((sum, item) => sum + item.text.length, 0)
    expect(total).toBeLessThanOrEqual(1201)
  })

  test('Given openTurn When 获取最近轮次 Then 包含尚未闭合的当前轮', () => {
    const state = createTurnState()
    appendMessagesToTurnState(state, [
      userMessage('第一轮', 'u1', 1),
      assistantMessage('第一轮回复', 'a1', 2),
      userMessage('第二轮', 'u2', 3),
      assistantMessage('第二轮回复', 'a2', 4),
    ])

    const recent = getRecentTurns(state, 1)
    expect(recent).toHaveLength(1)
    expect(recent[0]!.userText).toBe('第二轮')
    expect(recent[0]!.assistantText).toBe('第二轮回复')
  })
})

describe('会话语义段切块', () => {
  test('Given 多轮短对话 When 切块 Then 合并为 800~1800 字的语义段', () => {
    const state = createTurnState()
    const turns = Array.from({ length: 4 }, (_, index) => ({
      turnIndex: index,
      userText: `第${index}轮问题：${'甲'.repeat(160)}`,
      assistantText: `第${index}轮回复：${'乙'.repeat(160)}`,
      toolSummary: '',
      toolResults: [],
      messageIds: [`u${index}`, `a${index}`],
      timestamp: index,
    }))

    const chunkState: ConversationChunkState = { chunks: [], pendingTurns: [], similarities: [] }
    appendTurnsToChunkState(chunkState, turns, 'session-1')

    const searchChunks = getSearchChunks(chunkState, 'session-1')
    expect(searchChunks.length).toBeGreaterThanOrEqual(1)
    // 已闭合的语义段必须满足最小长度；尚未闭合的当前段允许不足 800 字
    for (const chunk of chunkState.chunks) {
      expect(chunk.content.length).toBeGreaterThanOrEqual(800)
    }
    for (const chunk of searchChunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(1800)
      expect(chunk.chunkId).toStartWith('conv-session-1-')
    }
  })

  test('Given 单轮超长 When 切块 Then 按句边界拆为多个切片且不截断句子', () => {
    const sentence = '这是一个用于验证切块边界的完整句子。'
    const state = createTurnState()
    const longTurn = {
      turnIndex: 0,
      userText: '长问题',
      assistantText: sentence.repeat(120),
      toolSummary: '',
      toolResults: [],
      messageIds: ['u1', 'a1'],
      timestamp: 1,
    }

    const chunkState: ConversationChunkState = { chunks: [], pendingTurns: [], similarities: [] }
    appendTurnsToChunkState(chunkState, [longTurn], 'session-2')

    expect(chunkState.chunks.length).toBeGreaterThan(1)
    for (const chunk of chunkState.chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(1800)
      expect(chunk.content.endsWith('。')).toBe(true)
    }
  })

  test('Given pending 轮次 When 获取检索切片 Then 当前段也参与检索', () => {
    const state = createTurnState()
    appendMessagesToTurnState(state, [
      userMessage('当前问题', 'u1', 1),
      assistantMessage('当前回复', 'a1', 2),
    ])
    const chunkState: ConversationChunkState = { chunks: [], pendingTurns: [], similarities: [] }
    appendTurnsToChunkState(chunkState, getRecentTurns(state, 1), 'session-3')

    const searchChunks = getSearchChunks(chunkState, 'session-3')
    expect(searchChunks).toHaveLength(1)
    expect(searchChunks[0]!.content).toContain('当前问题')
  })
})
