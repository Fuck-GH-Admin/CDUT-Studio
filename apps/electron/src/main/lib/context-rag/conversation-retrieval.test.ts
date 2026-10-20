import { describe, expect, test } from 'bun:test'
import type { CommunityNode } from '../study/hierarchical-graphrag'
import {
  buildChunksFromTurns,
  type ConversationChunk,
  type ConversationTurn,
} from './conversation-chunks'
import type { ConversationIndexEntry } from './conversation-index'
import { retrieveConversationContext } from './conversation-retrieval'

function turn(
  turnIndex: number,
  userText: string,
  assistantText: string,
  toolSummary = '',
): ConversationTurn {
  return {
    turnIndex,
    userText,
    assistantText,
    toolSummary,
    toolResults: [],
    messageIds: [`u${turnIndex}`, `a${turnIndex}`],
    timestamp: turnIndex,
  }
}

function buildEntry(): ConversationIndexEntry {
  const turns: ConversationTurn[] = [
    turn(0, '数据库连接池应该怎么配置？', '连接池大小需要结合并发量和数据库上限评估。'),
    turn(1, '读取 src/cache.ts，看看缓存淘汰策略。', '当前实现使用 LRU，并在写入时刷新 TTL。', '[tool: Read: src/cache.ts]'),
    turn(2, '部署脚本放在哪里？', '部署脚本位于 scripts/deploy.ps1。'),
    turn(3, '继续刚才的文件。', '好的，我继续读取 src/cache.ts。'),
  ]
  const chunks: ConversationChunk[] = turns.map((item) => buildChunksFromTurns('session-1', [item])[0]!)

  const communities: CommunityNode[] = [
    {
      id: 'L1::0',
      level: 1,
      title: '缓存实现',
      summary: '缓存淘汰与读取',
      memberEntities: [chunks[1]!.chunkId, chunks[3]!.chunkId],
    },
    {
      id: 'L2::0',
      level: 2,
      title: '项目主线',
      summary: '围绕缓存实现与部署脚本展开',
      memberEntities: chunks.map((chunk) => chunk.chunkId),
    },
  ]

  return {
    sessionId: 'session-1',
    filePath: '/tmp/session-1.jsonl',
    fileSize: 0,
    byteOffset: 0,
    carry: '',
    turnState: { turns, openTurn: null },
    chunkState: { chunks, pendingTurns: [], similarities: [] },
    edges: [
      { source: chunks[1]!.chunkId, target: chunks[3]!.chunkId, weight: 0.8 },
    ],
    communities,
    edgesAtChunkCount: chunks.length,
    communitiesAtChunkCount: chunks.length,
  }
}

describe('会话历史双引擎检索', () => {
  test('Given 文件缓存提问 When 检索 Then 命中相关轮次且排除最近一轮', () => {
    const entry = buildEntry()
    const result = retrieveConversationContext(entry, 'src/cache.ts 的缓存淘汰策略')

    expect(result.evidence.length).toBeGreaterThan(0)
    expect(result.evidence[0]!.chunkId).toBe(entry.chunkState.chunks[1]!.chunkId)
    // 最近一轮固定由 recent_context 注入，不得重复进入证据
    expect(result.evidence.some((item) => item.turnEnd === 3)).toBe(false)
    expect(result.recentTurns).toHaveLength(1)
    expect(result.recentTurns[0]!.userText).toBe('继续刚才的文件。')
  })

  test('Given 当前用户消息已落盘为 openTurn When 检索 Then 最近上下文保留上一完整轮', () => {
    const entry = buildEntry()
    const previousTurns = entry.turnState.turns.slice(0, 3)
    entry.turnState = {
      turns: previousTurns,
      openTurn: {
        ...entry.turnState.turns[3]!,
        userText: '当前新问题',
        assistantText: '',
        messageIds: ['u-open'],
        toolNamesById: new Map(),
      },
    }

    const result = retrieveConversationContext(entry, '当前新问题')

    expect(result.recentTurns).toHaveLength(1)
    expect(result.recentTurns[0]!.userText).toBe('部署脚本放在哪里？')
    // 当前 openTurn 与最近完整轮都不得重复进入证据
    expect(result.evidence.some((item) => item.turnEnd >= 2)).toBe(false)
  })

  test('Given 宏观意图 When 检索 Then 返回 level-2 社群摘要', () => {
    const entry = buildEntry()
    const result = retrieveConversationContext(entry, '总结一下这个项目的主线')

    expect(result.macroSummaries.length).toBeGreaterThan(0)
    expect(result.macroSummaries[0]).toContain('项目主线')
  })

  test('Given 空 query When 检索 Then 不返回证据但保留最近上下文', () => {
    const entry = buildEntry()
    const result = retrieveConversationContext(entry, '   ')

    expect(result.evidence).toHaveLength(0)
    expect(result.recentTurns).toHaveLength(1)
  })

  test('Given 命中证据 When 组装 Then 总字符数不超过证据预算', () => {
    const entry = buildEntry()
    const result = retrieveConversationContext(entry, '缓存 部署 数据库 文件 脚本')

    const totalChars = result.evidence.reduce((sum, item) => sum + item.content.length, 0)
    expect(totalChars).toBeLessThanOrEqual(4000)
  })
})
