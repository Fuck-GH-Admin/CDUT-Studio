/**
 * CSLab 分层 3D 空间知识拓扑构建器（论文自动入库流水线 · 阶段二）
 *
 * 为每篇论文构建宏观 / 中观 / 微观三层空间知识拓扑，供 Three.js 视口渲染：
 * - 宏观（macro，z∈[150,250]）：论文本体 / 作者 / 期刊会议 / 研究领域 / 引用条目；
 * - 中观（meso，z∈[-50,50]）：概念 / 方法 / 实验协议；
 * - 微观（micro，z∈[-250,-150]）：数值指标 / 图表资产。
 *
 * 红线：
 * 1. 确定性布局：初始 (x,y,z) 仅由节点 id 的 FNV-1a 稳定哈希决定，层内松弛为固定迭代次数，
 *    全程禁止 Math.random（同一输入必得同一坐标输出）；
 * 2. Z 分层严格：macro z∈[150,250]、meso z∈[-50,50]、micro z∈[-250,-150]，
 *    松弛迭代只改 (x,y) 层内平面坐标，绝不改动 z；
 * 3. 边引用完整性：每条边 source/target 必须已存在于 nodes，自环与悬空边宁可丢弃；
 * 4. 落盘 `.tmp + rename` 原子写；坏 JSON 只 console.warn 返回 null，失败路径绝不向上抛出
 *    （纯 builder 的 uri / title 参数校验除外）；
 * 5. 路径经 assertLabId / resolveLabDir 校验后才可拼接；rootDir 仅为测试注入覆盖。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type {
  EmpiricalMetric,
  ExperimentalProtocol,
  Hierarchical3DGraphData,
  Hierarchical3DGraphEdge,
  Hierarchical3DGraphNode,
  PaperConceptGraph,
  PaperFigureAsset,
  PaperReference,
} from '@profer/shared'
import { assertLabId, resolveLabDir } from './cslab-paths'

// ===== 布局常量（全部固定值，保证确定性） =====

/** FNV-1a 32 位哈希的基值与素数。 */
const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193

/** 层 -> z 区间（硬约束：macro > meso > micro 严格有序）。 */
const LAYER_Z_BAND: Record<Hierarchical3DGraphNode['layer'], [number, number]> = {
  macro: [150, 250],
  meso: [-50, 50],
  micro: [-250, -150],
}

/** 层 -> zLevel（2 macro / 1 meso / 0 micro）。 */
const LAYER_ZLEVEL: Record<Hierarchical3DGraphNode['layer'], number> = {
  macro: 2,
  meso: 1,
  micro: 0,
}

/** 层内平面散布半径。 */
const LAYER_RADIUS: Record<Hierarchical3DGraphNode['layer'], number> = {
  macro: 240,
  meso: 200,
  micro: 160,
}

/** 层内力导向松弛迭代次数（固定值，禁止随机终止）。 */
const LAYOUT_ITERATIONS = 80
/** 理想间距（斥力与引力的平衡点）。 */
const IDEAL_SPACING = 70
/** 单次迭代位移上限（模拟温度，随迭代线性衰减）。 */
const MAX_LAYOUT_STEP = 36
/** 向心弱力系数（层内约束，防止整层漂移）。 */
const CENTER_PULL = 0.02

// ===== 对外类型 =====

/** 单篇论文的拓扑输入（阶段一产物的汇总视图）。 */
export interface PaperTopologyInput {
  uri: string
  title: string
  authors: string[]
  venue?: string
  year?: string
  taxonomy?: string[]
  conceptGraph?: PaperConceptGraph
  protocols?: ExperimentalProtocol[]
  metrics?: EmpiricalMetric[]
  figureAssets?: PaperFigureAsset[]
  references?: PaperReference[]
}

// ===== 稳定哈希与命名工具 =====

/** FNV-1a 32 位稳定哈希（跨进程 / 跨运行结果一致）。 */
function fnv1a32(text: string): number {
  let hash = FNV_OFFSET_BASIS
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, FNV_PRIME) >>> 0
  }
  return hash >>> 0
}

/** 名称归一化：折叠空白并去首尾空格（同名节点合并的比较基准）。 */
function normalizeName(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** 标题匹配键：归一化后转小写（库内同名标题识别）。 */
function titleKey(title: string): string {
  return normalizeName(title).toLowerCase()
}

/** 多段文本拼接为小写匹配文本（协议 ↔ 方法 / 指标 ↔ 协议 匹配用）。 */
function matchText(...parts: Array<string | undefined>): string {
  return parts
    .map((part) => normalizeName(part ?? ''))
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function asArray<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : []
}

/** uri 末段 -> 论文 id；清洗文件系统非法字符，杜绝路径穿越。 */
function paperIdFromUri(uri: string): string {
  const last = String(uri ?? '').split('/').filter(Boolean).pop() ?? ''
  const cleaned = last
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  return cleaned || 'paper'
}

/** 拓扑 JSON 的实验室相对路径（`db/graph_3d_<paper_id>.json`）。 */
export function topologyRelPath(uri: string): string {
  return `db/graph_3d_${paperIdFromUri(uri)}.json`
}

// ===== 节点 / 边累积上下文 =====

interface TopologyBuildContext {
  nodes: Hierarchical3DGraphNode[]
  nodeById: Map<string, Hierarchical3DGraphNode>
  /** 边候选（finalize 时统一做完整性过滤与去重）。 */
  edges: Hierarchical3DGraphEdge[]
  /** 聚合模式：同名节点合并为一个并累加 details.count / details.paperUris。 */
  mergeCount: boolean
  /** 当前正在追加的论文 URI（聚合计数用）。 */
  currentPaperUri: string
}

function createContext(mergeCount: boolean): TopologyBuildContext {
  return {
    nodes: [],
    nodeById: new Map(),
    edges: [],
    mergeCount,
    currentPaperUri: '',
  }
}

function makeNode(
  id: string,
  label: string,
  layer: Hierarchical3DGraphNode['layer'],
  type: Hierarchical3DGraphNode['type'],
  details?: Record<string, unknown>,
): Hierarchical3DGraphNode {
  return {
    id,
    label,
    layer,
    type,
    zLevel: LAYER_ZLEVEL[layer],
    ...(details ? { details } : {}),
  }
}

/**
 * 登记节点；id 冲突时：
 * - 聚合模式合并为一个节点并累加 details.count / details.paperUris（同名作者 / 概念等）；
 * - 单篇模式保留首个节点（宁可少建不可重复）。
 */
function addNode(ctx: TopologyBuildContext, node: Hierarchical3DGraphNode): void {
  const existing = ctx.nodeById.get(node.id)
  if (existing) {
    if (ctx.mergeCount) {
      const details = existing.details ?? (existing.details = {})
      details.count = Number(details.count ?? 1) + 1
      const uris = Array.isArray(details.paperUris) ? (details.paperUris as string[]) : []
      if (ctx.currentPaperUri && !uris.includes(ctx.currentPaperUri)) {
        uris.push(ctx.currentPaperUri)
        details.paperUris = uris
      }
    }
    return
  }
  const stored = ctx.mergeCount
    ? {
        ...node,
        details: {
          ...node.details,
          count: 1,
          paperUris: ctx.currentPaperUri ? [ctx.currentPaperUri] : [],
        },
      }
    : node
  ctx.nodeById.set(stored.id, stored)
  ctx.nodes.push(stored)
}

/** 记录边候选（自环直接丢弃；悬空与重复在 finalizeEdges 统一过滤）。 */
function pushEdge(
  ctx: TopologyBuildContext,
  source: string,
  target: string,
  relation: string,
): void {
  if (!source || !target || source === target) return
  ctx.edges.push({ source, target, relation })
}

/** 边引用完整性收口：端点必须存在于 nodes，按 source|target|relation 去重。 */
function finalizeEdges(ctx: TopologyBuildContext): Hierarchical3DGraphEdge[] {
  const result: Hierarchical3DGraphEdge[] = []
  const keys = new Set<string>()
  for (const edge of ctx.edges) {
    if (!ctx.nodeById.has(edge.source) || !ctx.nodeById.has(edge.target)) continue
    const key = `${edge.source}|${edge.target}|${edge.relation}`
    if (keys.has(key)) continue
    keys.add(key)
    result.push(edge)
  }
  return result
}

// ===== 确定性布局 =====

/**
 * 初始确定性布局：(x,y) 由节点 id 稳定哈希在层内圆盘上散布，z 落入层区间。
 * 原地写入 x/y/z，禁止 Math.random。
 */
export function assignDeterministicPositions(nodes: Hierarchical3DGraphNode[]): void {
  for (const node of nodes) {
    const [zMin, zMax] = LAYER_Z_BAND[node.layer]
    const hAngle = fnv1a32(node.id)
    const hRadius = fnv1a32(`${node.id}|radius`)
    const hZ = fnv1a32(`${node.id}|z`)
    node.z = zMin + (hZ % (zMax - zMin + 1))
    const angle = ((hAngle % 3600) / 3600) * Math.PI * 2
    const radius = Math.sqrt((hRadius % 1000) / 1000) * LAYER_RADIUS[node.layer]
    node.x = Math.cos(angle) * radius
    node.y = Math.sin(angle) * radius
  }
}

/**
 * 层内力导向松弛（斥力 + 边引力 + 向心/半径层内约束）：
 * 固定迭代次数，仅改 (x,y)，绝不触碰 z；同层内节点顺序固定，结果确定性可复现。
 */
export function relaxLayerLayout(
  nodes: Hierarchical3DGraphNode[],
  edges: Hierarchical3DGraphEdge[],
  iterations: number = LAYOUT_ITERATIONS,
): void {
  // 按层分组（保持传入顺序，保证迭代顺序确定）。
  const groups = new Map<Hierarchical3DGraphNode['layer'], Hierarchical3DGraphNode[]>()
  const layerOf = new Map<string, Hierarchical3DGraphNode['layer']>()
  for (const node of nodes) {
    layerOf.set(node.id, node.layer)
    const list = groups.get(node.layer)
    if (list) list.push(node)
    else groups.set(node.layer, [node])
  }

  // 层内边索引（跨层边不参与层内松弛）。
  const internalEdges = new Map<Hierarchical3DGraphNode['layer'], Hierarchical3DGraphEdge[]>()
  for (const edge of edges) {
    const layer = layerOf.get(edge.source)
    if (!layer || layerOf.get(edge.target) !== layer) continue
    const list = internalEdges.get(layer)
    if (list) list.push(edge)
    else internalEdges.set(layer, [edge])
  }

  for (let iter = 0; iter < iterations; iter += 1) {
    // 温度随迭代线性衰减：前期大步收敛，后期小步微调。
    const temperature = 1 + MAX_LAYOUT_STEP * (1 - iter / iterations)
    for (const [layer, group] of groups) {
      const n = group.length
      if (n === 0) continue
      const indexById = new Map<string, number>()
      group.forEach((node, index) => indexById.set(node.id, index))
      const fx = new Float64Array(n)
      const fy = new Float64Array(n)

      // 两两斥力：k²/dist，重叠时按最小距离兜底。
      for (let i = 0; i < n; i += 1) {
        const nodeI = group[i]!
        const xi = nodeI.x ?? 0
        const yi = nodeI.y ?? 0
        for (let j = i + 1; j < n; j += 1) {
          const nodeJ = group[j]!
          const dx = xi - (nodeJ.x ?? 0)
          const dy = yi - (nodeJ.y ?? 0)
          const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01)
          const repel = (IDEAL_SPACING * IDEAL_SPACING) / dist
          const ux = (dx / dist) * repel
          const uy = (dy / dist) * repel
          fx[i] = fx[i]! + ux
          fy[i] = fy[i]! + uy
          fx[j] = fx[j]! - ux
          fy[j] = fy[j]! - uy
        }
      }

      // 层内边引力：dist²/k，向理想间距收敛。
      for (const edge of internalEdges.get(layer) ?? []) {
        const i = indexById.get(edge.source)
        const j = indexById.get(edge.target)
        if (i === undefined || j === undefined || i === j) continue
        const nodeI = group[i]!
        const nodeJ = group[j]!
        const dx = (nodeI.x ?? 0) - (nodeJ.x ?? 0)
        const dy = (nodeI.y ?? 0) - (nodeJ.y ?? 0)
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01)
        const attract = (dist * dist) / IDEAL_SPACING
        const ux = (dx / dist) * attract
        const uy = (dy / dist) * attract
        fx[i] = fx[i]! - ux
        fy[i] = fy[i]! - uy
        fx[j] = fx[j]! + ux
        fy[j] = fy[j]! + uy
      }

      // 层内约束：向心弱力，防止整层漂出视口。
      for (let i = 0; i < n; i += 1) {
        const node = group[i]!
        fx[i] = fx[i]! - (node.x ?? 0) * CENTER_PULL
        fy[i] = fy[i]! - (node.y ?? 0) * CENTER_PULL
      }

      // 位移钳制（温度上限）+ 层内圆盘半径钳制；只写 x/y，z 原样保留。
      const radiusLimit = LAYER_RADIUS[layer]
      for (let i = 0; i < n; i += 1) {
        const node = group[i]!
        const magnitude = Math.sqrt(fx[i]! * fx[i]! + fy[i]! * fy[i]!)
        const step = magnitude > 0 ? Math.min(magnitude, temperature) / magnitude : 0
        let x = (node.x ?? 0) + fx[i]! * step
        let y = (node.y ?? 0) + fy[i]! * step
        const radius = Math.sqrt(x * x + y * y)
        if (radius > radiusLimit) {
          x = (x / radius) * radiusLimit
          y = (y / radius) * radiusLimit
        }
        node.x = x
        node.y = y
      }
    }
  }
}

/** 统一收口：过滤悬空边 -> 确定性初始布局 -> 层内松弛 -> 装配结果。 */
function finalizeTopology(ctx: TopologyBuildContext, paperUri: string): Hierarchical3DGraphData {
  const edges = finalizeEdges(ctx)
  assignDeterministicPositions(ctx.nodes)
  relaxLayerLayout(ctx.nodes, edges)
  return { nodes: ctx.nodes, edges, paperUri, builtAt: Date.now() }
}

// ===== 拓扑构建 =====

function protocolNodeId(paperId: string, protocol: ExperimentalProtocol, index: number): string {
  return `protocol:${paperId}:${normalizeName(protocol.id) || `p${index}`}`
}

/**
 * 追加单篇论文的节点与边候选。
 *
 * 边约定：
 * paper→author 'authored' / paper→venue 'published-in' / paper→field 'in-field' /
 * paper→concept 'mentions' / paper→method 'uses' / paper→protocol 'applies' /
 * concept↔concept 'related' / method→concept|method 'depends-on' /
 * protocol→method 'uses-method' / metric→protocol|paper 'measures' /
 * figure→paper 'figure-of' / paper→paper|ref 'cites'。
 *
 * corpusPaperTitles：库内同名标题节点索引（标题键 -> 论文节点 id）；
 * 命中时引用直连该论文节点，不再生成引用条目节点。
 */
function appendPaperTopology(
  input: PaperTopologyInput,
  ctx: TopologyBuildContext,
  corpusPaperTitles: Map<string, string>,
): void {
  const paperId = paperIdFromUri(input.uri)
  const paperNodeId = `paper:${paperId}`
  const authors = asArray(input.authors).map(normalizeName).filter(Boolean)
  const taxonomy = asArray(input.taxonomy).map(normalizeName).filter(Boolean)
  const concepts = asArray(input.conceptGraph?.concepts).filter(
    (concept) => normalizeName(concept.name).length > 0,
  )
  const methods = asArray(input.conceptGraph?.methods).filter(
    (method) => normalizeName(method.name).length > 0,
  )
  const protocols = asArray(input.protocols).filter(
    (protocol) => normalizeName(protocol.name).length > 0,
  )
  const metrics = asArray(input.metrics)
  const figures = asArray(input.figureAssets)
  const references = asArray(input.references)

  // ===== 节点 =====

  addNode(
    ctx,
    makeNode(paperNodeId, normalizeName(input.title), 'macro', 'paper', {
      uri: input.uri,
      authors,
      ...(input.year ? { year: normalizeName(input.year) } : {}),
      ...(input.venue ? { venue: normalizeName(input.venue) } : {}),
    }),
  )

  for (const name of authors) {
    addNode(ctx, makeNode(`author:${name}`, name, 'macro', 'author'))
  }

  const venueName = normalizeName(input.venue ?? '')
  if (venueName) {
    addNode(
      ctx,
      makeNode(`venue:${venueName}`, venueName, 'macro', 'venue', {
        ...(input.year ? { year: normalizeName(input.year) } : {}),
      }),
    )
  }

  // 研究领域取 taxonomy 顶层：type 用 'concept'、layer 用 'macro'。
  const fieldName = taxonomy[0]
  if (fieldName) {
    addNode(ctx, makeNode(`field:${fieldName}`, fieldName, 'macro', 'concept', { taxonomy }))
  }

  const conceptNodeIdByRef = new Map<string, string>()
  for (const concept of concepts) {
    const name = normalizeName(concept.name)
    const nodeId = `concept:${name}`
    addNode(
      ctx,
      makeNode(nodeId, name, 'meso', 'concept', {
        ...(concept.definition ? { definition: concept.definition } : {}),
      }),
    )
    conceptNodeIdByRef.set(concept.id, nodeId)
  }

  const methodNodeIdByRef = new Map<string, string>()
  for (const method of methods) {
    const name = normalizeName(method.name)
    const nodeId = `method:${name}`
    addNode(
      ctx,
      makeNode(nodeId, name, 'meso', 'method', {
        role: method.role,
        ...(method.description ? { description: method.description } : {}),
      }),
    )
    methodNodeIdByRef.set(method.id, nodeId)
  }

  protocols.forEach((protocol, index) => {
    addNode(
      ctx,
      makeNode(
        protocolNodeId(paperId, protocol, index),
        normalizeName(protocol.name),
        'meso',
        'protocol',
        {
          category: protocol.category,
          steps: asArray(protocol.steps),
          parameters: protocol.parameters ?? {},
          ...(protocol.instruments && protocol.instruments.length > 0
            ? { instruments: protocol.instruments }
            : {}),
        },
      ),
    )
  })

  metrics.forEach((metric, index) => {
    addNode(
      ctx,
      makeNode(
        `metric:${paperId}:${index}`,
        normalizeName(metric.name) || `metric-${index}`,
        'micro',
        'metric',
        {
          value: metric.value,
          ...(metric.unit ? { unit: metric.unit } : {}),
          ...(metric.baseline !== undefined && metric.baseline !== null
            ? { baseline: metric.baseline }
            : {}),
          ...(metric.condition ? { condition: metric.condition } : {}),
          page: metric.page,
        },
      ),
    )
  })

  figures.forEach((figure, index) => {
    addNode(
      ctx,
      makeNode(
        `figure:${paperId}:${index}`,
        normalizeName(figure.caption) || `图 ${index + 1}`,
        'micro',
        'figure',
        {
          page: figure.pageNumber,
          renderSource: figure.renderSource,
          ...(figure.relPath ? { relPath: figure.relPath } : {}),
          ...(figure.caption ? { caption: figure.caption } : {}),
        },
      ),
    )
  })

  // 引用条目（宏观层 'paper'，label 为引用标题）；命中库内同名标题时不建条目节点。
  const citeTargets = references.map((reference, index) => {
    const title = normalizeName(reference.title ?? '')
    const matched = title ? corpusPaperTitles.get(titleKey(title)) : undefined
    const target = matched && matched !== paperNodeId ? matched : null
    if (!target && title) {
      addNode(
        ctx,
        makeNode(`ref:${paperId}:${index}`, title, 'macro', 'paper', {
          ...(reference.authors && reference.authors.length > 0
            ? { authors: reference.authors.map(normalizeName).filter(Boolean) }
            : {}),
          ...(reference.year ? { year: reference.year } : {}),
          ...(reference.venue ? { venue: reference.venue } : {}),
          ...(reference.doi ? { doi: reference.doi } : {}),
        }),
      )
    }
    return { index, title, target }
  })

  // ===== 边 =====

  for (const name of authors) pushEdge(ctx, paperNodeId, `author:${name}`, 'authored')
  if (venueName) pushEdge(ctx, paperNodeId, `venue:${venueName}`, 'published-in')
  if (fieldName) pushEdge(ctx, paperNodeId, `field:${fieldName}`, 'in-field')

  for (const concept of concepts) {
    const nodeId = conceptNodeIdByRef.get(concept.id)
    if (!nodeId) continue
    pushEdge(ctx, paperNodeId, nodeId, 'mentions')
    // concept↔concept 'related'：无向关系按字典序归一，天然去重。
    for (const relatedId of asArray(concept.relatedConceptIds)) {
      const targetId = conceptNodeIdByRef.get(relatedId)
      if (!targetId || targetId === nodeId) continue
      const [source, target] = nodeId < targetId ? [nodeId, targetId] : [targetId, nodeId]
      pushEdge(ctx, source, target, 'related')
    }
  }

  for (const method of methods) {
    const nodeId = methodNodeIdByRef.get(method.id)
    if (!nodeId) continue
    pushEdge(ctx, paperNodeId, nodeId, 'uses')
    // dependsOn 可能指向方法或概念（查不到宁可少连，绝不悬空）。
    for (const depId of asArray(method.dependsOn)) {
      const targetId = methodNodeIdByRef.get(depId) ?? conceptNodeIdByRef.get(depId)
      if (targetId) pushEdge(ctx, nodeId, targetId, 'depends-on')
    }
  }

  // paper→protocol 'applies'；protocol→method 'uses-method'（协议名称/步骤/仪器文本命中方法名）。
  protocols.forEach((protocol, index) => {
    pushEdge(ctx, paperNodeId, protocolNodeId(paperId, protocol, index), 'applies')
    const protocolName = normalizeName(protocol.name).toLowerCase()
    const protocolText = matchText(
      protocol.name,
      ...asArray(protocol.steps),
      ...asArray(protocol.instruments),
    )
    for (const method of methods) {
      const methodName = normalizeName(method.name).toLowerCase()
      const methodNodeId = methodNodeIdByRef.get(method.id)
      if (!methodName || !protocolName || !methodNodeId) continue
      if (protocolText.includes(methodName) || methodName.includes(protocolName)) {
        pushEdge(ctx, protocolNodeId(paperId, protocol, index), methodNodeId, 'uses-method')
      }
    }
  })

  // metric→protocol|paper 'measures'：条件/指标名命中协议名时挂协议，否则挂论文。
  metrics.forEach((metric, index) => {
    const metricNodeId = `metric:${paperId}:${index}`
    const metricText = matchText(metric.condition, metric.name)
    let target: string | null = null
    for (let i = 0; i < protocols.length; i += 1) {
      const protocol = protocols[i]!
      const protocolName = normalizeName(protocol.name).toLowerCase()
      if (protocolName && metricText.includes(protocolName)) {
        target = protocolNodeId(paperId, protocol, i)
        break
      }
    }
    pushEdge(ctx, metricNodeId, target ?? paperNodeId, 'measures')
  })

  figures.forEach((_, index) => {
    pushEdge(ctx, `figure:${paperId}:${index}`, paperNodeId, 'figure-of')
  })

  for (const cite of citeTargets) {
    if (!cite.title) continue
    const target = cite.target ?? `ref:${paperId}:${cite.index}`
    pushEdge(ctx, paperNodeId, target, 'cites')
  }
}

/**
 * 单篇论文分层 3D 拓扑（纯函数，不落盘）。
 * 除 uri / title 缺失外不抛出；坐标完全由输入决定（禁随机）。
 */
export function buildPaperTopology(input: PaperTopologyInput): Hierarchical3DGraphData {
  if (!input || typeof input.uri !== 'string' || !input.uri.trim()) {
    throw new Error('论文拓扑构建失败：缺少 uri')
  }
  if (typeof input.title !== 'string' || !input.title.trim()) {
    throw new Error('论文拓扑构建失败：缺少 title')
  }
  const ctx = createContext(false)
  ctx.currentPaperUri = input.uri
  // 单篇视角不存在「库内同名标题」，引用一律落引用条目节点。
  appendPaperTopology(input, ctx, new Map())
  return finalizeTopology(ctx, input.uri)
}

/**
 * 全库聚合拓扑（纯函数）：多篇论文节点并入，同名作者/概念/领域/期刊合并为
 * 单节点并累加 details.count / details.paperUris；paperUri 固定 'corpus'。
 */
export function buildCorpusTopology(papers: PaperTopologyInput[]): Hierarchical3DGraphData {
  const list = asArray(papers)
  // 库内同名标题节点索引：引用命中时直连论文节点（首个同名标题胜出）。
  const titleIndex = new Map<string, string>()
  for (const paper of list) {
    const key = titleKey(paper?.title ?? '')
    if (!key) continue
    const nodeId = `paper:${paperIdFromUri(paper.uri)}`
    if (!titleIndex.has(key)) titleIndex.set(key, nodeId)
  }

  const ctx = createContext(true)
  for (const paper of list) {
    if (!paper || typeof paper.uri !== 'string' || !paper.uri.trim()) continue
    if (typeof paper.title !== 'string' || !paper.title.trim()) continue
    ctx.currentPaperUri = paper.uri
    appendPaperTopology(paper, ctx, titleIndex)
  }
  return finalizeTopology(ctx, 'corpus')
}

// ===== 持久化（纯 JSON 落盘，不碰 SQLite） =====

/** 拓扑文件绝对路径；labId 过 assertLabId 红线，rootDir 仅供测试注入覆盖。 */
function resolveTopologyFile(labId: string, uri: string, rootDir?: string): string {
  const id = assertLabId(labId)
  const root = rootDir ? resolve(rootDir) : resolveLabDir(id)
  return join(root, topologyRelPath(uri))
}

/** 原子落盘（`.tmp + rename`）；任何失败只 console.warn，绝不向上抛出。 */
export function saveTopology(
  labId: string,
  data: Hierarchical3DGraphData,
  rootDir?: string,
): void {
  try {
    const target = resolveTopologyFile(labId, data.paperUri, rootDir)
    mkdirSync(dirname(target), { recursive: true })
    const tmpPath = `${target}.tmp`
    writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8')
    renameSync(tmpPath, target)
  } catch (error) {
    console.warn(`[CSLab] 3D 拓扑落盘失败 (${data?.paperUri ?? ''}):`, error)
  }
}

/** 读取拓扑；坏 JSON / 结构不合法只 console.warn 返回 null，文件缺失静默返回 null。 */
export function loadTopology(
  labId: string,
  uri: string,
  rootDir?: string,
): Hierarchical3DGraphData | null {
  let target = ''
  try {
    target = resolveTopologyFile(labId, uri, rootDir)
    if (!existsSync(target)) return null
    const parsed = JSON.parse(readFileSync(target, 'utf-8')) as Partial<Hierarchical3DGraphData>
    if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
      console.warn(`[CSLab] 3D 拓扑文件结构不合法，已忽略: ${target}`)
      return null
    }
    return {
      nodes: parsed.nodes as Hierarchical3DGraphNode[],
      edges: parsed.edges as Hierarchical3DGraphEdge[],
      paperUri: typeof parsed.paperUri === 'string' ? parsed.paperUri : uri,
      builtAt: typeof parsed.builtAt === 'number' ? parsed.builtAt : 0,
    }
  } catch (error) {
    console.warn(`[CSLab] 3D 拓扑读取失败，已按空拓扑继续: ${target}`, error)
    return null
  }
}

/** 聚合读取实验室全部论文拓扑（`db/graph_3d_*.json` 合并去重）；无任何拓扑返回 null。 */
export function loadCorpusTopology(labId: string, rootDir?: string): Hierarchical3DGraphData | null {
  try {
    const safeLabId = assertLabId(labId)
    const dbDir = rootDir ? join(rootDir, 'db') : join(resolveLabDir(safeLabId), 'db')
    if (!existsSync(dbDir)) return null
    const files = readdirSync(dbDir)
      .filter((name) => name.startsWith('graph_3d_') && name.endsWith('.json'))
      .sort()
    if (files.length === 0) return null

    const nodeById = new Map<string, Hierarchical3DGraphNode>()
    const edgeKeys = new Set<string>()
    const edges: Hierarchical3DGraphEdge[] = []
    let builtAt = 0
    for (const file of files) {
      try {
        const parsed = JSON.parse(readFileSync(join(dbDir, file), 'utf-8')) as Partial<Hierarchical3DGraphData>
        if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) continue
        for (const node of parsed.nodes) {
          if (!node || typeof node.id !== 'string' || nodeById.has(node.id)) continue
          nodeById.set(node.id, node)
        }
        for (const edge of parsed.edges) {
          if (!edge || typeof edge.source !== 'string' || typeof edge.target !== 'string') continue
          const key = `${edge.source}|${edge.target}|${edge.relation}`
          if (edgeKeys.has(key)) continue
          edgeKeys.add(key)
          edges.push(edge)
        }
        if (typeof parsed.builtAt === 'number') builtAt = Math.max(builtAt, parsed.builtAt)
      } catch (error) {
        console.warn(`[CSLab] 3D 拓扑聚合跳过坏文件: ${file}`, error)
      }
    }
    // 悬空边过滤（跨文件合并后端点可能被去重掉）。
    const mergedEdges = edges.filter((edge) => nodeById.has(edge.source) && nodeById.has(edge.target))
    return {
      nodes: [...nodeById.values()],
      edges: mergedEdges,
      paperUri: 'corpus',
      builtAt,
    }
  } catch (error) {
    console.warn('[CSLab] 3D 拓扑聚合读取失败，已按空拓扑继续:', error)
    return null
  }
}
