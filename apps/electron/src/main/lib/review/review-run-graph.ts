/**
 * 审核运行图执行器（M3，设计 03 §6 自动运行图 + §11.1 M3）
 *
 * - 计划：从模板阶段生成节点图（parse→extract→bind→check→compute→summarize，按依赖串联）
 * - 检查点：节点完成落 checkpoint（inputHash + status）；续跑时 done 且 hash 一致 → 跳过不重做（A11/A18）
 * - 暂停：节点声明 waiting-input → 该分支暂停，其他分支继续（避免整跑卡死）；run 进入 awaiting-input
 * - 取消：取消后不再启动新节点；进行中节点完成后 run=cancelled，禁止后续决定/写回（A18/K18）
 * - 事件：节点级事件流（订阅者驱动 UI 阶段进度），不替代持久化
 */

import type { CheckpointRecord, RunV2Status, TemplateVersion, WorkflowStageSpec } from '@profer/shared'

export type NodeKind = 'register' | 'parse' | 'ocr' | 'extract' | 'bind' | 'plan' | 'check' | 'calculate' | 'verify' | 'summarize' | 'task'

export interface RunGraphNode {
  id: string
  kind: NodeKind
  stageId: string
  dependsOn: string[]
  status: CheckpointRecord['status']
  inputHash?: string
  attempts: number
  lastError?: string
}

export type RunEventKind = 'node-started' | 'node-completed' | 'node-failed' | 'node-waiting' | 'node-skipped' | 'run-cancelled' | 'run-completed'

export interface RunEvent {
  kind: RunEventKind
  nodeId?: string
  at: string
  detail?: string
}

/** 节点执行体：返回 done 或 waiting（业务等待，如缺材料/待确认） */
/** 节点产物（07 §4.2：不能只返回 done+hash；checks/opinions 由产物装配） */
export interface NodeArtifact {
  runId: string
  nodeId: string
  dependencyHash: string
  schemaRevision: 2
  sourceIds: string[]
  checks?: Array<Record<string, unknown>>
  opinions?: Array<Record<string, unknown>>
  observations?: Array<Record<string, unknown>>
  links?: Array<Record<string, unknown>>
  parseIndex?: Array<Record<string, unknown>>
  summary?: string
}

export type NodeExecutor = (node: RunGraphNode, inputHash: string) => Promise<{ status: 'done'; inputHash: string; artifact?: Omit<NodeArtifact, 'runId' | 'nodeId' | 'dependencyHash' | 'schemaRevision'> } | { status: 'waiting-input'; reason: string }>

/** 自动审核阶段的技术步骤展开（07 §4.1：一个 auto-check ≠ 一个节点） */
const AUTO_CHECK_STEPS: Array<{ suffix: string; kind: NodeKind; label: string }> = [
  { suffix: 'register', kind: 'register', label: '登记分类' },
  { suffix: 'parse', kind: 'parse', label: '按文件解析' },
  { suffix: 'ocr', kind: 'ocr', label: '按页 OCR' },
  { suffix: 'extract', kind: 'extract', label: '按对象提取' },
  { suffix: 'bind', kind: 'bind', label: '绑定候选证明' },
  { suffix: 'plan', kind: 'plan', label: '生成检查计划' },
  { suffix: 'check', kind: 'check', label: '规则检查' },
  { suffix: 'calculate', kind: 'calculate', label: '组级计算' },
  { suffix: 'verify', kind: 'verify', label: '引用与覆盖核验' },
  { suffix: 'summarize', kind: 'summarize', label: '生成摘要' },
]

/**
 * 生成节点图（N2a 修正，07 §4.1）：
 * - auto-check 展开为 10 个技术步骤节点（线性依赖，同 stage 前后串联）
 * - 人工阶段（manual-review/independent-rating 等）→ 单个 task 节点（由应用服务建 WorkflowTask 推进，
 *   不映射为任意 AI check 节点）
 */
export function planRunGraph(template: TemplateVersion): RunGraphNode[] {
  const nodes: RunGraphNode[] = []
  let previous: string | null = null
  const push = (id: string, kind: NodeKind, stageId: string): void => {
    nodes.push({ id, kind, stageId, dependsOn: previous ? [previous] : [], status: 'pending', attempts: 0 })
    previous = id
  }
  for (const stage of template.stages) {
    if (stage.kind === 'auto-check') {
      for (const step of AUTO_CHECK_STEPS) {
        push(`node-${stage.id}-${step.suffix}`, step.kind, stage.id)
      }
    } else {
      // 人工/评分/交接阶段：应用服务建任务；执行器负责任务落盘与状态（不是 AI 检查）
      push(`node-${stage.id}-task`, 'task', stage.id)
    }
  }
  return nodes
}

export interface RunOutcome {
  status: RunV2Status
  checkpoints: CheckpointRecord[]
  events: RunEvent[]
  /** waiting-input 的节点与原因（供 UI 待办） */
  waiting: Array<{ nodeId: string; reason: string }>
}

/**
 * 执行运行图：
 * - 逐节点（按依赖就绪顺序）；done 检查点跳过并发 node-skipped 事件
 * - executor 返回 waiting-input → checkpoint waiting-input，run=awaiting-input，跳过其下游
 * - 取消：cancelled=true 时不启动新节点（已完成的保留），run=cancelled
 * - executor 抛错 → attempts+1 落 failed checkpoint，run=failed（可重试：重跑时 failed 转回 pending）
 */
export async function executeRunGraph(
  inputNodes: RunGraphNode[],
  executors: Record<NodeKind, NodeExecutor>,
  options: { cancelled?: () => boolean; now?: () => string; onEvent?: (event: RunEvent) => void; writeArtifact?: (nodeId: string, artifact: NodeArtifact) => void; writeCheckpoint?: (checkpoint: CheckpointRecord) => void; runId?: string } = {},
): Promise<RunOutcome> {
  const now = options.now ?? (() => new Date().toISOString())
  const nodes = inputNodes.map((node) => ({ ...node }))
  const checkpoints: CheckpointRecord[] = []
  const events: RunEvent[] = []
  const waiting: Array<{ nodeId: string; reason: string }> = []
  const emit = (kind: RunEventKind, nodeId?: string, detail?: string): void => {
    // N2b：事件即时回调（执行中推送，持久化后订阅广播；不再等整图结束）
    const event: RunEvent = { kind, nodeId, at: now(), detail }
    events.push(event)
    options.onEvent?.(event)
  }

  const byId = new Map(nodes.map((node) => [node.id, node]))
  let anyWaiting = false
  let anyFailed = false

  // 依赖就绪循环：每轮执行所有依赖满足且 pending 的节点（waiting 节点的下游本轮跳过）
  let progress = true
  while (progress) {
    progress = false
    for (const node of nodes) {
      if (node.status !== 'pending') continue
      if (options.cancelled?.()) break
      const depsReady = node.dependsOn.every((depId) => byId.get(depId)?.status === 'done')
      if (!depsReady) continue
      progress = true

      emit('node-started', node.id)
      node.status = 'running'
      try {
        const result = await executors[node.kind](node, node.inputHash ?? 'no-input')
        if (result.status === 'done') {
          node.status = 'done'
          node.inputHash = result.inputHash
          const checkpoint: CheckpointRecord = { nodeId: node.id, inputHash: result.inputHash, status: 'done', attempts: node.attempts + 1 }
          if (result.artifact) {
            const artifact: NodeArtifact = { ...result.artifact, runId: options.runId ?? 'run', nodeId: node.id, dependencyHash: result.inputHash, schemaRevision: 2 }
            options.writeArtifact?.(node.id, artifact)
            checkpoint.outputRef = `artifacts/${node.id}.json`
          }
          checkpoints.push(checkpoint)
          options.writeCheckpoint?.(checkpoint)
          emit('node-completed', node.id)
        } else {
          node.status = 'waiting-input'
          node.lastError = result.reason
          const checkpoint: CheckpointRecord = { nodeId: node.id, inputHash: node.inputHash ?? 'no-input', status: 'waiting-input', attempts: node.attempts + 1, lastError: result.reason }
          checkpoints.push(checkpoint)
          options.writeCheckpoint?.(checkpoint)
          waiting.push({ nodeId: node.id, reason: result.reason })
          anyWaiting = true
          emit('node-waiting', node.id, result.reason)
        }
      } catch (error) {
        node.attempts += 1
        node.status = 'failed'
        node.lastError = error instanceof Error ? error.message : String(error)
        const checkpoint: CheckpointRecord = { nodeId: node.id, inputHash: node.inputHash ?? 'no-input', status: 'failed', attempts: node.attempts, lastError: node.lastError }
        checkpoints.push(checkpoint)
        options.writeCheckpoint?.(checkpoint)
        anyFailed = true
        emit('node-failed', node.id, node.lastError)
      }
    }
  }

  // 取消语义：cancelled 时未启动节点保持 pending，run=cancelled；不产生完成事件（K18）
  const cancelled = options.cancelled?.() ?? false
  if (cancelled) {
    emit('run-cancelled', undefined, '取消后未启动新节点；进行中节点结果保留')
    return { status: 'cancelled', checkpoints, events, waiting }
  }
  if (anyFailed) {
    return { status: 'failed', checkpoints, events, waiting }
  }
  if (anyWaiting) {
    return { status: 'awaiting-input', checkpoints, events, waiting }
  }
  const unfinished = nodes.filter((node) => node.status === 'pending')
  if (unfinished.length > 0) {
    // 存在永远无法就绪的节点（缺依赖/环/计划错误）→ 绝不返回 completed（07 §4.3）
    const detail = `${unfinished.length} 个节点无法就绪（依赖缺失或计划错误）`
    emit('node-failed', undefined, detail)
    return { status: 'failed', checkpoints, events, waiting }
  }
  emit('run-completed', undefined, '全部节点完成')
  return { status: 'completed', checkpoints, events, waiting }
}
