/**
 * CSLab Prove2Me DAG 推演引擎（主进程 / 渲染进程共用纯函数）
 *
 * 关键契约：
 * 1. `pending / verified / dead_end` 是人工事实；`pruned` 是拓扑派生状态，绝不反向污染人工状态；
 * 2. 使用扩展 Kahn 算法给出拓扑序；存在环时立即停止剪枝，避免节点状态丢失；
 * 3. 支持 Conjunctive(AND) / Disjunctive(OR) 门限：上游失效按门限级联折叠下游。
 */

import type {
  CsLabDagEdgeInput,
  CsLabDagEvaluation,
  CsLabDagNodeInput,
  CsLabDagValidationState,
} from '../types/cslab'

interface GraphIndex {
  ids: string[]
  idSet: Set<string>
  outgoing: Map<string, string[]>
  incoming: Map<string, string[]>
  indegree: Map<string, number>
}

function buildGraph(nodes: CsLabDagNodeInput[], edges: CsLabDagEdgeInput[]): GraphIndex {
  const ids = nodes.map((node) => node.id)
  const idSet = new Set(ids)
  const outgoing = new Map<string, string[]>()
  const incoming = new Map<string, string[]>()
  const indegree = new Map<string, number>()

  for (const id of ids) {
    outgoing.set(id, [])
    incoming.set(id, [])
    indegree.set(id, 0)
  }

  for (const edge of edges) {
    if (!idSet.has(edge.fromNode) || !idSet.has(edge.toNode)) continue
    outgoing.get(edge.fromNode)!.push(edge.toNode)
    incoming.get(edge.toNode)!.push(edge.fromNode)
    indegree.set(edge.toNode, (indegree.get(edge.toNode) ?? 0) + 1)
  }

  return { ids, idSet, outgoing, incoming, indegree }
}

/** 找出剩余子图中的强连通分量（Tarjan），用于环路分组。 */
function findCycles(index: GraphIndex, remaining: Set<string>): string[][] {
  let counter = 0
  const indices = new Map<string, number>()
  const lowLinks = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const cycles: string[][] = []

  const strongConnect = (id: string): void => {
    indices.set(id, counter)
    lowLinks.set(id, counter)
    counter += 1
    stack.push(id)
    onStack.add(id)

    for (const next of index.outgoing.get(id) ?? []) {
      if (!remaining.has(next)) continue
      if (!indices.has(next)) {
        strongConnect(next)
        lowLinks.set(id, Math.min(lowLinks.get(id)!, lowLinks.get(next)!))
      } else if (onStack.has(next)) {
        lowLinks.set(id, Math.min(lowLinks.get(id)!, indices.get(next)!))
      }
    }

    if (lowLinks.get(id) !== indices.get(id)) return

    const component: string[] = []
    while (stack.length > 0) {
      const current = stack.pop()!
      onStack.delete(current)
      component.push(current)
      if (current === id) break
    }

    // 单节点自环也算环。
    const selfLoop =
      component.length === 1 && (index.outgoing.get(component[0]!) ?? []).includes(component[0]!)
    if (component.length > 1 || selfLoop) cycles.push(component.sort())
  }

  for (const id of remaining) {
    if (!indices.has(id)) strongConnect(id)
  }

  return cycles.sort((a, b) => a[0]!.localeCompare(b[0]!))
}

/**
 * 扩展 Kahn 拓扑排序。
 * 返回确定性的拓扑序；若存在环，`order` 只包含成功出队的节点，`cycles` 给出强连通分组。
 */
export function topologicalOrder(
  nodes: CsLabDagNodeInput[],
  edges: CsLabDagEdgeInput[],
): { order: string[]; cycles: string[][] } {
  const index = buildGraph(nodes, edges)
  const indegree = new Map(index.indegree)
  const queue = index.ids.filter((id) => (indegree.get(id) ?? 0) === 0).sort()
  const order: string[] = []

  while (queue.length > 0) {
    const current = queue.shift()!
    order.push(current)
    for (const next of index.outgoing.get(current) ?? []) {
      const nextDegree = (indegree.get(next) ?? 0) - 1
      indegree.set(next, nextDegree)
      if (nextDegree === 0) {
        queue.push(next)
        queue.sort()
      }
    }
  }

  if (order.length === index.ids.length) return { order, cycles: [] }

  const remaining = new Set(index.ids.filter((id) => !order.includes(id)))
  return { order, cycles: findCycles(index, remaining) }
}

/** 新增 from -> to 的边是否会形成环。 */
export function wouldCreateCycle(
  edges: CsLabDagEdgeInput[],
  fromNode: string,
  toNode: string,
): boolean {
  if (fromNode === toNode) return true

  const outgoing = new Map<string, string[]>()
  for (const edge of edges) {
    const list = outgoing.get(edge.fromNode) ?? []
    list.push(edge.toNode)
    outgoing.set(edge.fromNode, list)
  }

  // 若从 toNode 能走回 fromNode，则新边会闭合成环。
  const stack = [toNode]
  const visited = new Set<string>()
  while (stack.length > 0) {
    const current = stack.pop()!
    if (current === fromNode) return true
    if (visited.has(current)) continue
    visited.add(current)
    for (const next of outgoing.get(current) ?? []) stack.push(next)
  }
  return false
}

function normalizeManualState(state: CsLabDagValidationState | undefined): CsLabDagValidationState {
  if (state === 'verified' || state === 'dead_end') return state
  // pruned 是派生值，不允许作为人工输入。
  return 'pending'
}

/**
 * 计算 DAG 生效状态与剪枝结果。
 *
 * - 任一上游为 dead_end / pruned 时，AND 节点折叠；
 * - OR 节点只有在全部上游失效时才折叠；
 * - 存在环时不做任何剪枝，直接回传人工状态。
 */
export function evaluateDag(
  nodes: CsLabDagNodeInput[],
  edges: CsLabDagEdgeInput[],
  manualStates?: Record<string, CsLabDagValidationState>,
): CsLabDagEvaluation {
  const index = buildGraph(nodes, edges)
  const { order, cycles } = topologicalOrder(nodes, edges)

  const manual = new Map<string, CsLabDagValidationState>()
  for (const node of nodes) {
    manual.set(node.id, normalizeManualState(manualStates?.[node.id] ?? node.state))
  }

  if (cycles.length > 0) {
    const states: Record<string, CsLabDagValidationState> = {}
    for (const node of nodes) states[node.id] = manual.get(node.id) ?? 'pending'
    return { order, cycles, states, prunedIds: [], cancelledJobIds: [] }
  }

  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  const effective = new Map<string, CsLabDagValidationState>()
  const prunedIds: string[] = []

  for (const id of order) {
    const node = nodesById.get(id)
    if (!node) continue
    const base = manual.get(id) ?? 'pending'
    const parents = index.incoming.get(id) ?? []

    if (base === 'dead_end' || parents.length === 0) {
      effective.set(id, base)
      continue
    }

    const deadParents = parents.filter((parent) => {
      const state = effective.get(parent) ?? 'pending'
      return state === 'dead_end' || state === 'pruned'
    }).length

    const shouldPrune =
      node.operator === 'OR' ? deadParents === parents.length : deadParents > 0

    if (shouldPrune) {
      effective.set(id, 'pruned')
      prunedIds.push(id)
    } else {
      effective.set(id, base)
    }
  }

  const states: Record<string, CsLabDagValidationState> = {}
  const cancelledJobIds: string[] = []
  for (const node of nodes) {
    const state = effective.get(node.id) ?? 'pending'
    states[node.id] = state
    if (state === 'pruned' && node.gpuTaskId) cancelledJobIds.push(node.gpuTaskId)
  }

  return {
    order,
    cycles,
    states,
    prunedIds,
    cancelledJobIds: [...new Set(cancelledJobIds)].sort(),
  }
}

/** 将 cycles 展平为节点 id 集合，供渲染层高亮环路节点。 */
export function flattenCycleIds(cycles: string[][]): Set<string> {
  const ids = new Set<string>()
  for (const cycle of cycles) for (const id of cycle) ids.add(id)
  return ids
}

/**
 * 从画布节点列表中提取环路节点；便于渲染层在 evaluate 前做视觉告警。
 */
export function findCanvasCycleIds(
  nodes: CsLabDagNodeInput[],
  edges: CsLabDagEdgeInput[],
): Set<string> {
  return flattenCycleIds(topologicalOrder(nodes, edges).cycles)
}
