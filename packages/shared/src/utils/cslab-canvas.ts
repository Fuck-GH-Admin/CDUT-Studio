/**
 * CSLab JSON Canvas 无损读写纯函数
 *
 * 契约：
 * 1. 只负责 `cdut_science` 命名空间，绝不改动 Obsidian 原生字段（文本/坐标/颜色等）；
 * 2. 序列化时保留未知顶层字段与未知节点/边字段，保证与 Obsidian 双向互通；
 * 3. 冲突合并只合并 `cdut_science`，结构差异由调用方写时间戳分叉副本。
 */

import type {
  CsLabCanvasDocument,
  CsLabCanvasEdge,
  CsLabCanvasNode,
  CsLabCanvasNodeType,
  CsLabDagEdgeInput,
  CsLabDagEvaluation,
  CsLabDagNodeInput,
  CsLabDagOperator,
  CsLabDagValidationState,
} from '../types/cslab'

const NODE_TYPES: CsLabCanvasNodeType[] = ['text', 'file', 'link', 'group']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function normalizeNode(raw: unknown, index: number): CsLabCanvasNode | null {
  if (!isRecord(raw)) return null
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id : `node-${index + 1}`
  const type = NODE_TYPES.includes(raw.type as CsLabCanvasNodeType)
    ? (raw.type as CsLabCanvasNodeType)
    : 'text'

  return {
    ...raw,
    id,
    type,
    x: finiteNumber(raw.x, 0),
    y: finiteNumber(raw.y, 0),
    width: finiteNumber(raw.width, 260),
    height: finiteNumber(raw.height, 140),
    ...(isRecord(raw.cdut_science) ? { cdut_science: raw.cdut_science } : {}),
  } as CsLabCanvasNode
}

function normalizeEdge(raw: unknown, index: number): CsLabCanvasEdge | null {
  if (!isRecord(raw)) return null
  if (typeof raw.fromNode !== 'string' || typeof raw.toNode !== 'string') return null
  return {
    ...raw,
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id : `edge-${index + 1}`,
    fromNode: raw.fromNode,
    toNode: raw.toNode,
    ...(isRecord(raw.cdut_science) ? { cdut_science: raw.cdut_science } : {}),
  } as CsLabCanvasEdge
}

/** 解析 `.canvas` 文本；缺字段时做温和归一化，但绝不补造业务内容。 */
export function parseCanvasDocument(text: string): CsLabCanvasDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Canvas 文档不是合法 JSON')
  }
  if (!isRecord(parsed)) throw new Error('Canvas 文档格式无效')
  if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    throw new Error('Canvas 文档必须包含 nodes 与 edges 数组')
  }

  const nodes = parsed.nodes
    .map((node, index) => normalizeNode(node, index))
    .filter((node): node is CsLabCanvasNode => node !== null)
  const edges = parsed.edges
    .map((edge, index) => normalizeEdge(edge, index))
    .filter((edge): edge is CsLabCanvasEdge => edge !== null)

  const { nodes: _nodes, edges: _edges, ...rest } = parsed
  return { ...rest, nodes, edges }
}

/** 稳定序列化：nodes → edges → 其它未知顶层字段，保留全部未知属性。 */
export function serializeCanvasDocument(doc: CsLabCanvasDocument): string {
  const { nodes, edges, ...rest } = doc
  const payload = {
    nodes: Array.isArray(nodes) ? nodes : [],
    edges: Array.isArray(edges) ? edges : [],
    ...rest,
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}

export function createEmptyCanvasDocument(): CsLabCanvasDocument {
  return { nodes: [], edges: [] }
}

function normalizeManualState(value: unknown): CsLabDagValidationState {
  return value === 'verified' || value === 'dead_end' ? value : 'pending'
}

/** 读取人工事实：优先 manual_status，绝不把派生 pruned 当作人工输入。 */
function resolveManualStatus(meta: Record<string, unknown> | undefined): CsLabDagValidationState {
  if (!meta) return 'pending'
  const manual = meta.manual_status
  if (manual === 'verified' || manual === 'dead_end' || manual === 'pending') return manual
  const effective = meta.verification_status
  return normalizeManualState(effective)
}

function normalizeOperator(value: unknown): CsLabDagOperator {
  return value === 'OR' ? 'OR' : 'AND'
}

/**
 * 画布 → DAG 输入。
 *
 * 仅带 `cdut_science` 推演标记（`cdut_uri` / `node_kind` / `logical_operator` / `verification_status`）
 * 的节点参与推演；`group` 节点始终排除。未标记节点仍然正常渲染，只是不参与剪枝。
 */
export function canvasToDagGraph(doc: CsLabCanvasDocument): {
  nodes: CsLabDagNodeInput[]
  edges: CsLabDagEdgeInput[]
} {
  const orTargets = new Set<string>()
  for (const edge of doc.edges) {
    if (edge.cdut_science?.dependency_type === 'disjunctive') orTargets.add(edge.toNode)
  }

  const nodes: CsLabDagNodeInput[] = []
  const idSet = new Set<string>()

  for (const node of doc.nodes) {
    if (node.type === 'group') continue
    const meta = isRecord(node.cdut_science) ? node.cdut_science : undefined
    const participates =
      !!meta &&
      (typeof meta.cdut_uri === 'string' ||
        typeof meta.node_kind === 'string' ||
        typeof meta.logical_operator === 'string' ||
        typeof meta.verification_status === 'string' ||
        typeof meta.manual_status === 'string')
    if (!participates) continue

    idSet.add(node.id)
    nodes.push({
      id: node.id,
      state: resolveManualStatus(meta),
      operator: meta?.logical_operator
        ? normalizeOperator(meta.logical_operator)
        : orTargets.has(node.id)
          ? 'OR'
          : 'AND',
      gpuTaskId:
        typeof meta?.gpu_task_id === 'string' && meta.gpu_task_id.trim()
          ? meta.gpu_task_id
          : undefined,
    })
  }

  const edges: CsLabDagEdgeInput[] = []
  for (const edge of doc.edges) {
    if (!idSet.has(edge.fromNode) || !idSet.has(edge.toNode)) continue
    edges.push({ id: edge.id, fromNode: edge.fromNode, toNode: edge.toNode })
  }

  return { nodes, edges }
}

/**
 * 将 DAG 评估结果写回画布。
 * - 写入派生 `verification_status`（含 pruned）；
 * - 被剪枝且带 gpu_task_id 的节点标记 `job_cancel_requested`，保留任务 ID 供 Phase 4 真正取消。
 */
export function applyDagEvaluation(
  doc: CsLabCanvasDocument,
  evaluation: CsLabDagEvaluation,
  cancelledJobIds: string[] = [],
): CsLabCanvasDocument {
  const cloned = JSON.parse(JSON.stringify(doc)) as CsLabCanvasDocument
  const cancelled = new Set(cancelledJobIds)

  cloned.nodes = cloned.nodes.map((node) => {
    const state = evaluation.states[node.id]
    if (!state) return node
    const meta = isRecord(node.cdut_science) ? { ...node.cdut_science } : {}
    // 先固化人工事实，再写派生状态：pruned 永远不会污染 manual_status。
    meta.manual_status = resolveManualStatus(meta)
    meta.verification_status = state
    const gpuTaskId = typeof meta.gpu_task_id === 'string' ? meta.gpu_task_id : null
    if (state === 'pruned' && gpuTaskId && cancelled.has(gpuTaskId)) {
      meta.job_cancel_requested = true
    }
    return { ...node, cdut_science: meta }
  })

  return cloned
}

export interface CanvasMetaMergeResult {
  document: CsLabCanvasDocument
  orphanNodeIds: string[]
  orphanEdgeIds: string[]
}

/**
 * Obsidian 外部修改后，仅把 incoming 的 `cdut_science` 合并进磁盘文档。
 * 磁盘不存在的节点/边进入 orphan 列表，由调用方写分叉副本。
 */
export function mergeCanvasScienceMeta(
  diskDoc: CsLabCanvasDocument,
  incomingDoc: CsLabCanvasDocument,
): CanvasMetaMergeResult {
  const merged = JSON.parse(JSON.stringify(diskDoc)) as CsLabCanvasDocument
  const incomingNodes = new Map(incomingDoc.nodes.map((node) => [node.id, node]))
  const incomingEdges = new Map(incomingDoc.edges.map((edge) => [edge.id, edge]))
  const diskNodeIds = new Set(merged.nodes.map((node) => node.id))
  const diskEdgeIds = new Set(merged.edges.map((edge) => edge.id))

  merged.nodes = merged.nodes.map((node) => {
    const incoming = incomingNodes.get(node.id)
    if (!incoming?.cdut_science) return node
    const incomingMeta = { ...incoming.cdut_science }
    // 外部/旧版画布可能只写 verification_status：同步补齐人工事实，避免磁盘上
    // 旧的 manual_status 覆盖用户刚刚设置的 verified / dead_end。
    if (incomingMeta.manual_status === undefined) {
      const status = incomingMeta.verification_status
      if (status === 'verified' || status === 'dead_end' || status === 'pending') {
        incomingMeta.manual_status = status
      }
    }
    return {
      ...node,
      cdut_science: {
        ...(isRecord(node.cdut_science) ? node.cdut_science : {}),
        ...incomingMeta,
      },
    }
  })

  merged.edges = merged.edges.map((edge) => {
    const incoming = incomingEdges.get(edge.id)
    if (!incoming?.cdut_science) return edge
    return {
      ...edge,
      cdut_science: {
        ...(isRecord(edge.cdut_science) ? edge.cdut_science : {}),
        ...incoming.cdut_science,
      },
    }
  })

  return {
    document: merged,
    orphanNodeIds: incomingDoc.nodes
      .filter((node) => !diskNodeIds.has(node.id))
      .map((node) => node.id),
    orphanEdgeIds: incomingDoc.edges
      .filter((edge) => !diskEdgeIds.has(edge.id))
      .map((edge) => edge.id),
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 生成 `{base}_conflict_YYYYMMDD_HHmm.canvas` 分叉副本相对路径。 */
export function buildConflictRelPath(relPath: string, now: Date = new Date()): string {
  const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}_${pad2(
    now.getHours(),
  )}${pad2(now.getMinutes())}`
  const withoutExt = relPath.replace(/\.canvas$/i, '')
  return `${withoutExt}_conflict_${stamp}.canvas`
}

/** 从相对路径推导画布标题（去除扩展名与连字符）。 */
export function canvasTitleFromRelPath(relPath: string): string {
  const base = relPath.split(/[\\/]/).pop() ?? relPath
  return base
    .replace(/\.canvas$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim() || '未命名画布'
}
