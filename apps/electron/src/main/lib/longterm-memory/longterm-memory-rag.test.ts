/**
 * 长期记忆 RAG 检索测试
 *
 * 覆盖：中文/英文召回、权重加权、标签桥接、强命中直通、Top-K 与注入块格式。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LongTermMemoryCategory, LongTermMemoryGraph, LongTermMemoryNode } from '@profer/shared'
import { writeJsonFileAtomic } from '../safe-file'
import { invalidateLongTermMemoryIndex, buildLongTermMemoryBlock, searchLongTermMemory } from './longterm-memory-rag'
import { resetLongTermMemoryCache } from './longterm-memory-store'

let workDir = ''
let graphPath = ''

function createNode(
  id: string,
  category: LongTermMemoryCategory,
  title: string,
  content: string,
  overrides: Partial<LongTermMemoryNode> = {},
): LongTermMemoryNode {
  const now = Date.now()
  return {
    id,
    category,
    title,
    content,
    tags: [],
    weight: 1,
    confidence: 0.8,
    createdAt: now,
    updatedAt: now,
    source: 'auto_inferred',
    ...overrides,
  }
}

function writeGraph(nodes: LongTermMemoryNode[]): void {
  const graph: LongTermMemoryGraph = { version: 1, updatedAt: Date.now(), nodes }
  writeJsonFileAtomic(graphPath, graph)
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'ltm-rag-'))
  graphPath = join(workDir, 'graph.json')
  invalidateLongTermMemoryIndex()
  await resetLongTermMemoryCache()
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('长期记忆 RAG 检索', () => {
  test('Given 一条中文编码偏好，When 查询组件编写，Then 该节点被召回', () => {
    writeGraph([
      createNode(
        'n1',
        'coding_preference',
        '状态管理统一使用 Jotai',
        '写 React 组件时所有状态必须使用 Jotai，严禁使用 useState。',
        { tags: ['jotai', 'react'] },
      ),
    ])

    const hits = searchLongTermMemory('帮我写个计数器组件', { graphPath })

    expect(hits.length).toBe(1)
    expect(hits[0]!.node.id).toBe('n1')
    expect(hits[0]!.score).toBeGreaterThan(0)
  })

  test('Given 两条同类节点权重不同，When 查询词相同，Then 高权重节点排名靠前', () => {
    writeGraph([
      createNode('low', 'coding_preference', 'Jotai 状态管理', 'Jotai 管理状态，保持简单。', { weight: 1 }),
      createNode('high', 'coding_preference', 'Jotai 状态管理规范', 'Jotai 管理状态，保持简单。', { weight: 9 }),
    ])

    const hits = searchLongTermMemory('Jotai 管理状态', { graphPath })

    expect(hits.length).toBe(2)
    expect(hits[0]!.node.id).toBe('high')
  })

  test('Given 节点标签精确命中，When 正文不含该词，Then 仍通过标签桥接召回', () => {
    writeGraph([
      createNode('n1', 'coding_preference', '团队状态规范', '状态管理请遵循团队统一约定。', { tags: ['jotai'] }),
    ])

    const hits = searchLongTermMemory('jotai 规范', { graphPath })

    expect(hits.map((hit) => hit.node.id)).toContain('n1')
  })

  test('Given 查询为空或纯停用词，Then 返回空数组', () => {
    writeGraph([createNode('n1', 'coding_preference', 'Jotai', 'Jotai 管理状态。')])

    expect(searchLongTermMemory('', { graphPath })).toEqual([])
    expect(searchLongTermMemory('   ', { graphPath })).toEqual([])
    expect(searchLongTermMemory('的了和与', { graphPath })).toEqual([])
  })

  test('Given 命中多于 topK，Then 只返回 topK 条且按分数降序', () => {
    writeGraph([
      createNode('a', 'coding_preference', 'Jotai 状态管理 A', 'Jotai 管理状态。', { weight: 9 }),
      createNode('b', 'coding_preference', 'Jotai 状态管理 B', 'Jotai 管理状态。', { weight: 6 }),
      createNode('c', 'coding_preference', 'Jotai 状态管理 C', 'Jotai 管理状态。', { weight: 3 }),
    ])

    const hits = searchLongTermMemory('Jotai 管理状态', { graphPath, topK: 2 })

    expect(hits.length).toBe(2)
    expect(hits[0]!.score).toBeGreaterThanOrEqual(hits[1]!.score)
  })

  test('Given 有命中，When 组装上下文块，Then 输出合规且带类别标签', () => {
    writeGraph([
      createNode('n1', 'coding_preference', '状态管理统一使用 Jotai', '写 React 组件时所有状态必须使用 Jotai。', {
        confidence: 0.85,
      }),
    ])

    const block = buildLongTermMemoryBlock('写组件用什么状态管理', { graphPath })

    expect(block.startsWith('<user_longterm_memory>')).toBe(true)
    expect(block.endsWith('</user_longterm_memory>')).toBe(true)
    expect(block).toContain('[Coding Style]')
    expect(block.length).toBeLessThanOrEqual(1400)
  })

  test('Given 图谱为空，When 组装上下文块，Then 返回空串', () => {
    writeGraph([])
    expect(buildLongTermMemoryBlock('任意问题', { graphPath })).toBe('')
  })

  test('Given minScore 被异常提高，When 标题完整命中，Then 强命中直通仍召回', () => {
    writeGraph([createNode('n1', 'coding_preference', 'Jotai', '状态管理规范。')])

    const hits = searchLongTermMemory('jotai', { graphPath, minScore: 5 })

    expect(hits.map((hit) => hit.node.id)).toContain('n1')
  })

  test('Given minScore 被异常提高，When 标签精确命中，Then 强命中直通仍召回', () => {
    writeGraph([createNode('n1', 'tool_affinity', '常用工具 read_file', '用户高频调用该工具。', { tags: ['read_file'] })])

    const hits = searchLongTermMemory('read_file', { graphPath, minScore: 5 })

    expect(hits.map((hit) => hit.node.id)).toContain('n1')
  })

  test('Given 查询与所有节点无关，Then 不返回噪声', () => {
    writeGraph([createNode('n1', 'coding_preference', 'Jotai 状态管理', '写 React 组件使用 Jotai。')])

    expect(searchLongTermMemory('量子力学与超导材料', { graphPath })).toEqual([])
  })
})
