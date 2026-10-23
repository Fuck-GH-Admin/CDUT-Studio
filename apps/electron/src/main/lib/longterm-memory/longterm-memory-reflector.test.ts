/**
 * 长期记忆反思器测试
 *
 * 覆盖：强偏好提取、去重加权、类别推断、工具频次、Slash 指令、
 * 并发写入一致性、整句切分语义完整性、睡眠整合衰减与淘汰。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LongTermMemoryGraph, LongTermMemoryNode, LongTermMemoryNodeInput } from '@profer/shared'
import { writeJsonFileAtomic } from '../safe-file'
import {
  consolidateLongTermMemory,
  extractPreferenceCandidates,
  extractToolNamesFromMessages,
  reflectOnTurn,
  splitPreferenceCandidates,
} from './longterm-memory-reflector'
import { listLongTermMemoryNodes, resetLongTermMemoryCache } from './longterm-memory-store'

let workDir = ''
let graphPath = ''

function createNode(overrides: Partial<LongTermMemoryNode> & { id: string }): LongTermMemoryNode {
  const now = Date.now()
  return {
    category: 'coding_preference',
    title: '历史节点',
    content: '历史内容',
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
  workDir = mkdtempSync(join(tmpdir(), 'ltm-reflect-'))
  graphPath = join(workDir, 'graph.json')
  await resetLongTermMemoryCache()
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('偏好候选提取', () => {
  test('Given 强偏好句式，Then 提炼为编码偏好候选', () => {
    const candidates = extractPreferenceCandidates('以后都用 Jotai 管理状态')

    expect(candidates.length).toBe(1)
    expect(candidates[0]!.category).toBe('coding_preference')
    expect(candidates[0]!.content).toContain('Jotai')
  })

  test('Given 校园高频需求，Then 归类为 CDUT 专属域', () => {
    const candidates = extractPreferenceCandidates('以后查空教室都用 CDUT 专区')

    expect(candidates.length).toBe(1)
    expect(candidates[0]!.category).toBe('cdut_special_domain')
  })

  test('Given 含逗号的长句，Then 不被逗号切断且保留完整语境', () => {
    const message = '以后做科研绘图的时候不要用 matplotlib，统一走 CSLab 原生 Origin'
    const units = splitPreferenceCandidates(message)
    const candidates = extractPreferenceCandidates(message)

    expect(units.length).toBe(1)
    expect(candidates.length).toBe(1)
    expect(candidates[0]!.content).toContain('matplotlib')
    expect(candidates[0]!.content).toContain('Origin')
  })

  test('Given 纯指代片段，Then 不生成任何候选', () => {
    expect(extractPreferenceCandidates('把它换掉')).toEqual([])
  })

  test('Given 普通问答，Then 不生成候选', () => {
    expect(extractPreferenceCandidates('这个函数是做什么的')).toEqual([])
  })

  test('Given 疑问句，Then 不提炼为长期偏好', () => {
    expect(extractPreferenceCandidates('请记住这个错误日志吗？')).toEqual([])
    expect(extractPreferenceCandidates('我们以后统一走 CAS 认证对不对')).toEqual([])
    expect(extractPreferenceCandidates('下次怎么才能自动部署？')).toEqual([])
  })

  test('Given 句尾「吧」的建议表达，Then 仍能正常提炼（不误杀）', () => {
    const candidates = extractPreferenceCandidates('以后都用 Jotai 吧')

    expect(candidates.length).toBe(1)
    expect(candidates[0]!.content).toContain('Jotai')
  })
})

describe('单轮反思落盘', () => {
  test('Given 首轮强偏好，Then 新增一条自动节点', async () => {
    await reflectOnTurn({ userMessage: '以后都用 Jotai 管理状态', graphPath })

    const nodes = listLongTermMemoryNodes(graphPath)
    expect(nodes.length).toBe(1)
    expect(nodes[0]!.source).toBe('auto_inferred')
    expect(nodes[0]!.category).toBe('coding_preference')
  })

  test('Given 同一偏好重复出现，Then 节点数不增且权重与置信度提升', async () => {
    await reflectOnTurn({ userMessage: '以后都用 Jotai 管理状态', graphPath })
    await reflectOnTurn({ userMessage: '以后都用 Jotai 管理状态', graphPath })

    const nodes = listLongTermMemoryNodes(graphPath)
    expect(nodes.length).toBe(1)
    expect(nodes[0]!.weight).toBe(2)
    expect(nodes[0]!.confidence).toBeCloseTo(0.7, 5)
  })

  test('Given 同轮重复调用同一工具，Then 生成一条工具节点且权重累加', async () => {
    await reflectOnTurn({
      userMessage: '帮我读一下这个文件',
      toolNames: ['read_file', 'read_file', 'grep'],
      graphPath,
    })

    const tools = listLongTermMemoryNodes(graphPath).filter((node) => node.category === 'tool_affinity')
    expect(tools.length).toBe(2)
    const readFile = tools.find((node) => node.title.includes('read_file'))
    expect(readFile).toBeDefined()
    expect(readFile!.weight).toBe(2)
  })

  test('Given Slash 指令，Then 生成常用指令节点', async () => {
    await reflectOnTurn({ userMessage: '/goal 跑一个长任务', graphPath })

    const nodes = listLongTermMemoryNodes(graphPath)
    expect(nodes.length).toBe(1)
    expect(nodes[0]!.category).toBe('workflow_habit')
    expect(nodes[0]!.title).toBe('常用指令 /goal')
  })

  test('Given 并发两轮反思，Then 两条记忆都保留且 JSON 合法', async () => {
    await Promise.all([
      reflectOnTurn({ userMessage: '以后都用 Jotai 管理状态', graphPath }),
      reflectOnTurn({ userMessage: '以后注释必须用中文', graphPath }),
    ])

    const nodes = listLongTermMemoryNodes(graphPath)
    expect(nodes.length).toBe(2)
    expect(new Set(nodes.map((node) => node.id)).size).toBe(2)
  })

  test('Given /compact 指令，Then 不产生任何记忆', async () => {
    await reflectOnTurn({ userMessage: '/compact', graphPath })
    expect(listLongTermMemoryNodes(graphPath)).toEqual([])
  })
})

describe('工具名提取', () => {
  test('Given assistant 消息含 tool_use 块，Then 保留重复调用以支撑频次统计', () => {
    const messages = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'read_file' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'read_file' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
      { type: 'user', message: { content: [{ type: 'tool_use', name: 'ignored' }] } },
    ]

    expect(extractToolNamesFromMessages(messages)).toEqual(['read_file', 'read_file'])
  })
})

describe('写入前隔离审核', () => {
  test('Given 审核通过，Then 正常写入并保留原置信度', async () => {
    const audited: LongTermMemoryNodeInput[] = []
    await reflectOnTurn({
      userMessage: '以后都用 Jotai 管理状态',
      graphPath,
      auditCandidate: async (input) => {
        audited.push(input)
        return { status: 'approved', reason: 'durable rule' }
      },
    })

    const nodes = listLongTermMemoryNodes(graphPath)
    expect(audited.length).toBe(1)
    expect(nodes.length).toBe(1)
    expect(nodes[0]!.confidence).toBeCloseTo(0.65, 5)
  })

  test('Given 审核拒绝，Then 候选被静默丢弃', async () => {
    await reflectOnTurn({
      userMessage: '以后都用 Jotai 管理状态',
      graphPath,
      auditCandidate: async () => ({ status: 'rejected', reason: 'one-time task' }),
    })

    expect(listLongTermMemoryNodes(graphPath)).toEqual([])
  })

  test('Given 审核不可用，Then 降置信度写入', async () => {
    await reflectOnTurn({
      userMessage: '以后都用 Jotai 管理状态',
      graphPath,
      auditCandidate: async () => ({ status: 'unavailable', reason: 'timeout' }),
    })

    const nodes = listLongTermMemoryNodes(graphPath)
    expect(nodes.length).toBe(1)
    expect(nodes[0]!.confidence).toBeCloseTo(0.45, 5)
  })

  test('Given 审核抛出异常，Then 降置信度写入而非整轮失败', async () => {
    await reflectOnTurn({
      userMessage: '以后都用 Jotai 管理状态',
      graphPath,
      auditCandidate: async () => {
        throw new Error('boom')
      },
    })

    const nodes = listLongTermMemoryNodes(graphPath)
    expect(nodes.length).toBe(1)
    expect(nodes[0]!.confidence).toBeCloseTo(0.45, 5)
  })

  test('Given 已有节点再次命中，Then 不重复审核且权重提升', async () => {
    await reflectOnTurn({
      userMessage: '以后都用 Jotai 管理状态',
      graphPath,
      auditCandidate: async () => ({ status: 'approved', reason: 'durable rule' }),
    })

    let calls = 0
    await reflectOnTurn({
      userMessage: '以后都用 Jotai 管理状态',
      graphPath,
      auditCandidate: async () => {
        calls += 1
        return { status: 'rejected', reason: 'should not be called' }
      },
    })

    const nodes = listLongTermMemoryNodes(graphPath)
    expect(calls).toBe(0)
    expect(nodes.length).toBe(1)
    expect(nodes[0]!.weight).toBe(2)
  })

  test('Given 工具与 Slash 候选，Then 不进入审核', async () => {
    let calls = 0
    await reflectOnTurn({
      userMessage: '/goal 跑一个长任务',
      toolNames: ['read_file'],
      graphPath,
      auditCandidate: async () => {
        calls += 1
        return { status: 'rejected', reason: 'should not be called' }
      },
    })

    expect(calls).toBe(0)
    expect(listLongTermMemoryNodes(graphPath).length).toBe(2)
  })
})

describe('睡眠整合', () => {
  test('Given 陈旧弱自动节点，Then 被淘汰；同条件手动节点保留', async () => {
    const old = Date.now() - 90 * 86_400_000
    writeGraph([
      createNode({ id: 'weak', weight: 0.1, confidence: 0.4, updatedAt: old, createdAt: old }),
      createNode({
        id: 'manual',
        weight: 0.1,
        confidence: 0.4,
        updatedAt: old,
        createdAt: old,
        source: 'user_manual',
      }),
    ])

    const result = await consolidateLongTermMemory({ graphPath })
    const remaining = listLongTermMemoryNodes(graphPath)

    expect(result.removed).toBe(1)
    expect(remaining.map((node) => node.id)).toEqual(['manual'])
    expect(remaining[0]!.weight).toBeCloseTo(0.1, 5)
  })

  test('Given 新鲜节点，Then 不衰减、不淘汰', async () => {
    writeGraph([createNode({ id: 'fresh', weight: 2, confidence: 0.8 })])

    const result = await consolidateLongTermMemory({ graphPath })
    const remaining = listLongTermMemoryNodes(graphPath)

    expect(result.removed).toBe(0)
    expect(remaining.length).toBe(1)
    expect(remaining[0]!.weight).toBe(2)
  })

  test('Given 空闲自动节点，Then 衰减不刷新 updatedAt，空闲天数可持续累积', async () => {
    const now = Date.now()
    const oldUpdatedAt = now - 40 * 86_400_000
    writeGraph([createNode({ id: 'idle', weight: 1, confidence: 0.8, updatedAt: oldUpdatedAt, createdAt: oldUpdatedAt })])

    await consolidateLongTermMemory({ graphPath, now })
    const firstWeight = listLongTermMemoryNodes(graphPath)[0]!.weight
    expect(firstWeight).toBeLessThan(1)
    expect(listLongTermMemoryNodes(graphPath)[0]!.updatedAt).toBe(oldUpdatedAt)

    // 同一时间点的第二次整合仍以原始 updatedAt 计算空闲天数，证明衰减可累积
    await consolidateLongTermMemory({ graphPath, now })
    const second = listLongTermMemoryNodes(graphPath)[0]!
    expect(second.weight).toBeLessThan(firstWeight)
    expect(second.updatedAt).toBe(oldUpdatedAt)
  })
})
