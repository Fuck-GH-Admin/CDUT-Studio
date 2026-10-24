/**
 * 运行图执行器单测（M3，A11/A18：检查点续跑/等待/取消/失败重试）
 */
import { describe, expect, test } from 'bun:test'
import type { TemplateVersion } from '@profer/shared'
import { executeRunGraph, planRunGraph, type NodeExecutor, type NodeKind, type RunGraphNode } from './review-run-graph'

const template = (stages: TemplateVersion['stages']): TemplateVersion =>
  ({ templateId: 't', version: 1, schemaVersion: 2, name: 't', objectType: 'person', displayName: { template: '' }, fields: [], materialSlots: [], policyVersionIds: [], stages, outputs: [], status: 'published', createdAt: '' }) as unknown as TemplateVersion

const ok: NodeExecutor = async (_node, hash) => ({ status: 'done', inputHash: hash })
const ALL_KINDS: NodeKind[] = ['register', 'parse', 'ocr', 'extract', 'bind', 'plan', 'check', 'calculate', 'verify', 'summarize', 'task']
const okAll = Object.fromEntries(ALL_KINDS.map((kind) => [kind, ok])) as Record<NodeKind, NodeExecutor>

describe('planRunGraph', () => {
  test('Given 两级流程模板 When 生成 Then 节点线性依赖', () => {
    const nodes = planRunGraph(template([
      { id: 'auto', name: '自动', kind: 'auto-check', executorRole: 'system' },
      { id: 'review', name: '初审', kind: 'manual-review', executorRole: 'reviewer' },
      { id: 'final', name: '终审', kind: 'manual-review', executorRole: 'teacher' },
    ]))
    expect(nodes.map((node) => node.id)).toEqual([
      'node-auto-register', 'node-auto-parse', 'node-auto-ocr', 'node-auto-extract', 'node-auto-bind', 'node-auto-plan', 'node-auto-check', 'node-auto-calculate', 'node-auto-verify', 'node-auto-summarize',
      'node-review-task', 'node-final-task',
    ])
    expect(nodes[1]!.dependsOn).toEqual(['node-auto-register'])
    expect(nodes[10]!.kind).toBe('task')
  })
})

describe('executeRunGraph（A18）', () => {
  test('Given 全部成功 When 执行 Then completed 且事件含 started/completed', async () => {
    const outcome = await executeRunGraph(planRunGraph(template([
      { id: 'a', name: 'a', kind: 'auto-check', executorRole: 'system' },
      { id: 'b', name: 'b', kind: 'manual-review', executorRole: 'teacher' },
    ])), okAll)
    expect(outcome.status).toBe('completed')
    expect(outcome.checkpoints).toHaveLength(11) // auto 阶段 10 步 + 人工 task 1
    expect(outcome.events.some((event) => event.kind === 'node-started')).toBeTrue()
    expect(outcome.events.some((event) => event.kind === 'run-completed')).toBeTrue()
  })

  test('Given 第二节点等待输入 When 执行 Then awaiting-input 且第三节点不执行（分支暂停）', async () => {
    const waiting = Object.fromEntries(ALL_KINDS.map((kind) => [kind, async (_node: RunGraphNode, hash: string) => (_node.stageId === 'b' && _node.kind === 'task' ? { status: 'waiting-input' as const, reason: '缺证明材料' } : { status: 'done' as const, inputHash: hash })])) as Record<NodeKind, NodeExecutor>
    const outcome = await executeRunGraph(planRunGraph(template([
      { id: 'a', name: 'a', kind: 'auto-check', executorRole: 'system' },
      { id: 'b', name: 'b', kind: 'manual-review', executorRole: 'teacher' },
      { id: 'c', name: 'c', kind: 'summary', executorRole: 'organizer' },
    ])), waiting)
    expect(outcome.status).toBe('awaiting-input')
    expect(outcome.waiting).toEqual([{ nodeId: 'node-b-task', reason: '缺证明材料' }])
    // c 是 b 的下游，未执行
    const cCheckpoint = outcome.checkpoints.find((checkpoint) => checkpoint.nodeId === 'node-c-task')
    expect(cCheckpoint).toBeUndefined()
  })

  test('Given 执行中取消 When 执行 Then 未启动节点不执行且 run=cancelled（K18）', async () => {
    let calls = 0
    const counting: NodeExecutor = async (node, hash) => {
      calls += 1
      return ok(node, hash)
    }
    const countingAll = Object.fromEntries(ALL_KINDS.map((kind) => [kind, counting])) as Record<NodeKind, NodeExecutor>
    const outcome = await executeRunGraph(planRunGraph(template([
      { id: 'a', name: 'a', kind: 'auto-check', executorRole: 'system' },
      { id: 'b', name: 'b', kind: 'manual-review', executorRole: 'teacher' },
      { id: 'c', name: 'c', kind: 'summary', executorRole: 'organizer' },
    ])), countingAll, { cancelled: () => calls >= 1 })
    expect(outcome.status).toBe('cancelled')
    expect(outcome.events.some((event) => event.kind === 'run-cancelled')).toBeTrue()
    expect(outcome.checkpoints.length).toBeLessThan(3) // 未全部执行
    expect(outcome.events.some((event) => event.kind === 'run-completed')).toBeFalse()
  })

  test('Given 节点抛错 When 执行 Then failed + attempts 递增 + lastError 落 checkpoint', async () => {
    const boom: NodeExecutor = async () => {
      throw new Error('模型超时')
    }
    const outcome = await executeRunGraph(planRunGraph(template([{ id: 'a', name: 'a', kind: 'auto-check', executorRole: 'system' }])),
      { ...okAll, register: boom })
    expect(outcome.status).toBe('failed')
    expect(outcome.checkpoints[0]!.attempts).toBe(1)
    expect(outcome.checkpoints[0]!.lastError).toContain('模型超时')
  })
})
