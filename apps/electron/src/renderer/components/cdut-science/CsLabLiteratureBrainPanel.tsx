/**
 * CsLabLiteratureBrainPanel — 跨文献分层 GraphRAG 检索 + 全景知识图谱
 *
 * 未搜索时渲染基于已建索引的全景图谱（Leiden 社区着色，文献级共现网络）；
 * 检索命中点击后跳转 PDF 页码并按 bbox 高亮聚焦选框。
 * 头部支持 2D Leiden Map / 3D Spatial Topology 分段切换（3D 为分层空间拓扑视口）。
 */

import * as React from 'react'
import { Box, Loader2, Maximize2, Minimize2, Network, Search, X } from 'lucide-react'
import type {
  CsLabLiteratureGraphResult,
  CsLabLiteratureSearchResult,
  Hierarchical3DGraphData,
} from '@profer/shared'
import { cn } from '@/lib/utils'
import { CsLab3DTopologyViewport } from './CsLab3DTopologyViewport'

interface CsLabLiteratureBrainPanelProps {
  labId: string
  onOpenLiterature: (uri: string, page: number, bbox?: [number, number, number, number]) => void
}

const TEXT_LAYER_HINT = '文献缺少文本层（扫描版 PDF），请导入带 OCR/文本层的 PDF 后再建索引。'

/** 图谱视图模式：2D Leiden 社群图 / 3D 分层空间拓扑。 */
type TopologyViewMode = '2d' | '3d'

/** 3D 拓扑 IPC 由并行任务接线；方法缺失时降级提示而非崩溃。 */
interface Literature3DGraphApi {
  getLiterature3DGraph?: (labId: string, uri?: string) => Promise<Hierarchical3DGraphData | null>
}

/** 渲染规模软保护：防止数千级 SVG DOM 卡顿渲染主线程。 */
const MAX_GRAPH_NODES = 250
const MAX_GRAPH_EDGES = 400

/** 判断后端消息是否属于「扫描版 PDF 无文本层」而非真实异常。 */
function isTextLayerMessage(message?: string): boolean {
  return !!message && (message.includes('扫描版') || message.includes('未能从文献中提取文本'))
}

/** 社群 ID → 稳定色相（确定性哈希，跨渲染一致）。 */
function communityHue(communityId: string): number {
  let hash = 0
  for (let index = 0; index < communityId.length; index += 1) {
    hash = (hash * 31 + communityId.charCodeAt(index)) % 360
  }
  return hash
}

// ===== 2D 确定性力导向布局（思路对齐 cslab-3d-topology 的层内松弛；禁 Math.random） =====

/** FNV-1a 32 位哈希的基值与素数。 */
const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193

/** FNV-1a 32 位稳定哈希（跨渲染 / 跨运行结果一致）。 */
function fnv1a32(text: string): number {
  let hash = FNV_OFFSET_BASIS
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, FNV_PRIME) >>> 0
  }
  return hash >>> 0
}

/** 理想间距（斥力与引力平衡点，布局单位）。 */
const FORCE_IDEAL_SPACING = 30
/** 单次迭代位移上限（模拟温度，随迭代线性衰减）。 */
const FORCE_MAX_STEP = 7
/** 向心弱力系数（防整图漂出视口）。 */
const FORCE_CENTER_PULL = 0.018
/** 社区质心引力系数（空间聚类，不改变上游 Leiden 社群划分）。 */
const FORCE_COMMUNITY_PULL = 0.05
/** 社区质心初始锚点的环半径。 */
const FORCE_COMMUNITY_RING = 78
/** 节点相对社区质心的初始散布半径。 */
const FORCE_COMMUNITY_SCATTER = 20
/** 松弛迭代上限（固定值，禁止随机终止）。 */
const FORCE_MAX_ITERATIONS = 300
/** 位移收敛阈值（整轮最大位移低于该值即提前收敛）。 */
const FORCE_CONVERGE_EPSILON = 1e-3

interface ForcePoint {
  x: number
  y: number
}

/**
 * 力导向松弛：两两斥力（k²/dist）+ 边弹簧引力（dist²/k）+ 社区质心引力 + 轻微向心力。
 * 固定遍历顺序（输入序）+ 固定迭代上限，同输入必得同输出；
 * pinned 的节点按给定坐标冻结（节点拖动时继续松弛其余节点）。
 */
function relaxForceLayout2D(
  nodes: Array<{ id: string; communityId: string }>,
  edges: Array<{ source: string; target: string }>,
  positions: Map<string, ForcePoint>,
  iterations: number,
  pinned?: ReadonlyMap<string, ForcePoint>,
): void {
  const n = nodes.length
  if (n === 0) return
  const indexById = new Map<string, number>()
  nodes.forEach((node, index) => indexById.set(node.id, index))
  const links: Array<[number, number]> = []
  for (const edge of edges) {
    const i = indexById.get(edge.source)
    const j = indexById.get(edge.target)
    if (i === undefined || j === undefined || i === j) continue
    links.push([i, j])
  }
  const communityGroups = new Map<string, number[]>()
  nodes.forEach((node, index) => {
    const key = node.communityId || '_'
    const group = communityGroups.get(key)
    if (group) group.push(index)
    else communityGroups.set(key, [index])
  })

  const x = new Float64Array(n)
  const y = new Float64Array(n)
  const fx = new Float64Array(n)
  const fy = new Float64Array(n)

  for (let iter = 0; iter < iterations; iter += 1) {
    const temperature = 1 + FORCE_MAX_STEP * (1 - iter / iterations)
    for (let i = 0; i < n; i += 1) {
      const point = positions.get(nodes[i]!.id)
      x[i] = point?.x ?? 0
      y[i] = point?.y ?? 0
      fx[i] = 0
      fy[i] = 0
    }

    // 两两斥力：k²/dist（百级节点直接 O(n²)，不做 Barnes-Hut）。
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const dx = x[i]! - x[j]!
        const dy = y[i]! - y[j]!
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01)
        const repel = (FORCE_IDEAL_SPACING * FORCE_IDEAL_SPACING) / dist
        const ux = (dx / dist) * repel
        const uy = (dy / dist) * repel
        fx[i] = fx[i]! + ux
        fy[i] = fy[i]! + uy
        fx[j] = fx[j]! - ux
        fy[j] = fy[j]! - uy
      }
    }

    // 边弹簧引力：dist²/k，向理想间距收敛。
    for (const [i, j] of links) {
      const dx = x[i]! - x[j]!
      const dy = y[i]! - y[j]!
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01)
      const attract = (dist * dist) / FORCE_IDEAL_SPACING
      const ux = (dx / dist) * attract
      const uy = (dy / dist) * attract
      fx[i] = fx[i]! - ux
      fy[i] = fy[i]! - uy
      fx[j] = fx[j]! + ux
      fy[j] = fy[j]! + uy
    }

    // 社区质心引力（按当前质心拉回，形成空间聚类）+ 轻微向心力（防飞散）。
    for (const group of communityGroups.values()) {
      let cx = 0
      let cy = 0
      for (const index of group) {
        cx += x[index]!
        cy += y[index]!
      }
      cx /= group.length
      cy /= group.length
      for (const index of group) {
        fx[index] = fx[index]! + (cx - x[index]!) * FORCE_COMMUNITY_PULL
        fy[index] = fy[index]! + (cy - y[index]!) * FORCE_COMMUNITY_PULL
      }
    }
    for (let i = 0; i < n; i += 1) {
      fx[i] = fx[i]! - x[i]! * FORCE_CENTER_PULL
      fy[i] = fy[i]! - y[i]! * FORCE_CENTER_PULL
    }

    // 位移钳制（温度上限）；pinned 节点坐标写死，位置冻结。
    let maxMove = 0
    for (let i = 0; i < n; i += 1) {
      const id = nodes[i]!.id
      const frozen = pinned?.get(id)
      if (frozen) {
        positions.set(id, { x: frozen.x, y: frozen.y })
        continue
      }
      const magnitude = Math.sqrt(fx[i]! * fx[i]! + fy[i]! * fy[i]!)
      const step = magnitude > 0 ? Math.min(magnitude, temperature) / magnitude : 0
      const nextX = x[i]! + fx[i]! * step
      const nextY = y[i]! + fy[i]! * step
      maxMove = Math.max(maxMove, Math.abs(nextX - x[i]!) + Math.abs(nextY - y[i]!))
      positions.set(id, { x: nextX, y: nextY })
    }
    if (maxMove < FORCE_CONVERGE_EPSILON) break
  }
}

/**
 * 2D 确定性力导向布局：社区质心环 + 节点哈希散布作初值 -> 力导向松弛收敛。
 * 同输入必得同输出（全程禁 Math.random）；pinned 用于拖动节点时冻结其位置继续松弛。
 */
function buildForceLayout2D(
  nodes: Array<{ id: string; communityId: string }>,
  edges: Array<{ source: string; target: string }>,
  communities: string[],
  pinned?: ReadonlyMap<string, ForcePoint>,
): Map<string, ForcePoint> {
  const positions = new Map<string, ForcePoint>()
  const order = communities.length > 0 ? communities : ['_']
  const centerByCommunity = new Map<string, ForcePoint>()
  order.forEach((communityId, index) => {
    const angle = (index / order.length) * Math.PI * 2 - Math.PI / 2
    centerByCommunity.set(communityId, {
      x: Math.cos(angle) * FORCE_COMMUNITY_RING,
      y: Math.sin(angle) * FORCE_COMMUNITY_RING,
    })
  })
  for (const node of nodes) {
    const anchor = centerByCommunity.get(node.communityId || '_') ?? { x: 0, y: 0 }
    const angle = ((fnv1a32(node.id) % 3600) / 3600) * Math.PI * 2
    const radius = Math.sqrt((fnv1a32(`${node.id}|radius`) % 1000) / 1000) * FORCE_COMMUNITY_SCATTER
    positions.set(node.id, {
      x: anchor.x + Math.cos(angle) * radius,
      y: anchor.y + Math.sin(angle) * radius,
    })
  }
  relaxForceLayout2D(nodes, edges, positions, FORCE_MAX_ITERATIONS, pinned)
  return positions
}

interface GraphLayoutNode {
  uri: string
  title: string
  communityId: string
  communityTitle: string
  chunkCount: number
  x: number
  y: number
  degree: number
}

/**
 * 力导向布局编排：按连接度截断核心节点后，调用 buildForceLayout2D 做确定性空间排布；
 * 社区划分沿用上游 Leiden 结论（communityId），力导向只负责空间聚类。
 */
function layoutGraph(
  graph: CsLabLiteratureGraphResult,
): { nodes: GraphLayoutNode[]; edges: Array<{ source: GraphLayoutNode; target: GraphLayoutNode; weight: number }>; truncated: boolean } {
  const degree = new Map<string, number>()
  for (const edge of graph.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
  }

  // 软保护：按连接度截断核心节点。
  const sortedNodes = [...graph.nodes].sort(
    (a, b) => (degree.get(b.uri) ?? 0) - (degree.get(a.uri) ?? 0),
  )
  const truncated = sortedNodes.length > MAX_GRAPH_NODES
  const kept = sortedNodes.slice(0, MAX_GRAPH_NODES)
  const keptUris = new Set(kept.map((node) => node.uri))

  // 布局遍历顺序固定（社群序 + uri 字典序），保证同输入同输出。
  const ordered = [...kept].sort((a, b) =>
    (a.communityId || a.uri).localeCompare(b.communityId || b.uri) || a.uri.localeCompare(b.uri),
  )

  const rawEdges: Array<{ source: string; target: string; weight: number }> = []
  for (const edge of graph.edges) {
    if (rawEdges.length >= MAX_GRAPH_EDGES) break
    if (!keptUris.has(edge.source) || !keptUris.has(edge.target)) continue
    rawEdges.push(edge)
  }

  const communities = [...new Set(ordered.map((node) => node.communityId || '_'))].sort()
  const positions = buildForceLayout2D(
    ordered.map((node) => ({ id: node.uri, communityId: node.communityId || '_' })),
    rawEdges,
    communities,
  )

  const nodes: GraphLayoutNode[] = ordered.map((node) => {
    const point = positions.get(node.uri) ?? { x: 0, y: 0 }
    return {
      uri: node.uri,
      title: node.title,
      communityId: node.communityId,
      communityTitle: node.communityTitle,
      chunkCount: node.chunkCount,
      degree: degree.get(node.uri) ?? 0,
      x: point.x,
      y: point.y,
    }
  })
  const byUri = new Map(nodes.map((node) => [node.uri, node]))

  const edges: Array<{ source: GraphLayoutNode; target: GraphLayoutNode; weight: number }> = []
  for (const edge of rawEdges) {
    const source = byUri.get(edge.source)
    const target = byUri.get(edge.target)
    if (!source || !target) continue
    edges.push({ source, target, weight: edge.weight })
  }
  return { nodes, edges, truncated }
}

export function CsLabLiteratureBrainPanel({
  labId,
  onOpenLiterature,
}: CsLabLiteratureBrainPanelProps): React.ReactElement {
  const [query, setQuery] = React.useState('')
  const [result, setResult] = React.useState<CsLabLiteratureSearchResult | null>(null)
  const [indexInfo, setIndexInfo] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<'build' | 'search' | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [hint, setHint] = React.useState<string | null>(null)
  const [graph, setGraph] = React.useState<CsLabLiteratureGraphResult | null>(null)
  const [graphLoading, setGraphLoading] = React.useState(false)
  const [viewMode, setViewMode] = React.useState<TopologyViewMode>('2d')
  const [graph3d, setGraph3d] = React.useState<Hierarchical3DGraphData | null>(null)
  const [graph3dLoading, setGraph3dLoading] = React.useState(false)
  const [graph3dLoaded, setGraph3dLoaded] = React.useState(false)
  const [graph3dError, setGraph3dError] = React.useState<string | null>(null)

  const loadGraph = React.useCallback(async (): Promise<void> => {
    setGraphLoading(true)
    try {
      const payload = await window.electronAPI.cslab.getLiteratureGraph(labId)
      setGraph(payload)
    } catch {
      setGraph(null)
    } finally {
      setGraphLoading(false)
    }
  }, [labId])

  // 未在搜索时加载全景图谱（挂载 + 搜索清除回退）。
  React.useEffect(() => {
    if (result === null && graph === null && !graphLoading) void loadGraph()
  }, [result, graph, graphLoading, loadGraph])

  /** 加载 3D 分层空间拓扑（IPC 防御：方法缺失时降级提示而非崩溃）。 */
  const loadGraph3d = React.useCallback(async (): Promise<void> => {
    const api = window.electronAPI.cslab as unknown as Literature3DGraphApi
    if (typeof api.getLiterature3DGraph !== 'function') {
      setGraph3dError('3D 拓扑接口尚未就绪（IPC getLiterature3DGraph 未接线）')
      return
    }
    setGraph3dLoading(true)
    setGraph3dError(null)
    try {
      const payload = await api.getLiterature3DGraph(labId)
      setGraph3d(payload)
    } catch (err) {
      setGraph3d(null)
      setGraph3dError(err instanceof Error ? err.message : '3D 拓扑加载失败')
    } finally {
      setGraph3dLoading(false)
      setGraph3dLoaded(true)
    }
  }, [labId])

  // 3D 模式下按需加载分层拓扑（首次切换 + 索引重建后回填）。
  React.useEffect(() => {
    if (viewMode !== '3d' || graph3dLoaded || graph3dLoading || graph3dError) return
    void loadGraph3d()
  }, [viewMode, graph3dLoaded, graph3dLoading, graph3dError, loadGraph3d])

  const build = async (force: boolean): Promise<void> => {
    setBusy('build')
    setError(null)
    setHint(null)
    try {
      const payload = await window.electronAPI.cslab.buildLiteratureIndex({ labId, force })
      setIndexInfo(payload.message ?? null)
      if (!payload.ok) {
        if (isTextLayerMessage(payload.message)) setHint(TEXT_LAYER_HINT)
        else setError(payload.message ?? '索引构建失败')
      }
      // 索引重建后刷新全景图谱数据（2D / 3D 一并回填）。
      setGraph(null)
      setGraph3d(null)
      setGraph3dLoaded(false)
      setGraph3dError(null)
      if (result === null) void loadGraph()
    } catch (err) {
      setError(err instanceof Error ? err.message : '索引构建失败')
    } finally {
      setBusy(null)
    }
  }

  const search = async (): Promise<void> => {
    if (!query.trim()) return
    setBusy('search')
    setError(null)
    setHint(null)
    try {
      const payload = await window.electronAPI.cslab.searchLiterature({
        labId,
        query: query.trim(),
        topK: 8,
      })
      setResult(payload)
      if (!payload.ok) {
        if (isTextLayerMessage(payload.message)) setHint(TEXT_LAYER_HINT)
        else setError(payload.message ?? '检索失败')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '检索失败')
    } finally {
      setBusy(null)
    }
  }

  /** 清空搜索：一键回退全景图谱视图。 */
  const clearSearch = (): void => {
    setQuery('')
    setResult(null)
    setError(null)
    setHint(null)
  }

  const layout = React.useMemo(
    () => (graph?.ok && graph.nodes.length > 0 ? layoutGraph(graph) : null),
    [graph],
  )

  // ===== 2D 视口：光标锚点滚轮缩放 + 拖拽平移 + 节点拖动（冻结拖动节点继续松弛） =====

  const [maximized, setMaximized] = React.useState(false)
  const [view, setView] = React.useState<{ cx: number; cy: number; scale: number }>({
    cx: 0,
    cy: 0,
    scale: 1,
  })
  const [graphSize, setGraphSize] = React.useState({ width: 640, height: 224 })
  const svgRef = React.useRef<SVGSVGElement | null>(null)
  const positionsRef = React.useRef<Map<string, ForcePoint>>(new Map())
  const interactRef = React.useRef<
    | { type: 'pan'; lastX: number; lastY: number }
    | {
        type: 'node'
        uri: string
        startX: number
        startY: number
        lastX: number
        lastY: number
        moved: boolean
        relaxAt: number
      }
    | null
  >(null)
  // 坐标缓存是 ref（频繁松弛不重建 Map），手动触发重绘。
  const [, forceGraphRender] = React.useReducer((tick: number) => tick + 1, 0)

  const hasGraph = layout !== null

  // 图谱数据变化：重置坐标缓存并按包围盒取景。
  React.useEffect(() => {
    if (!layout) return
    const next = new Map<string, ForcePoint>()
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const node of layout.nodes) {
      next.set(node.uri, { x: node.x, y: node.y })
      minX = Math.min(minX, node.x)
      minY = Math.min(minY, node.y)
      maxX = Math.max(maxX, node.x)
      maxY = Math.max(maxY, node.y)
    }
    positionsRef.current = next
    const rect = svgRef.current?.getBoundingClientRect()
    const width = rect && rect.width > 0 ? rect.width : 640
    const height = rect && rect.height > 0 ? rect.height : 224
    const spanX = Number.isFinite(minX) ? Math.max(20, maxX - minX) : 20
    const spanY = Number.isFinite(minY) ? Math.max(20, maxY - minY) : 20
    setView({
      cx: Number.isFinite(minX) ? (minX + maxX) / 2 : 0,
      cy: Number.isFinite(minY) ? (minY + maxY) / 2 : 0,
      scale: Math.min(4, Math.max(0.2, Math.min((width * 0.86) / spanX, (height * 0.86) / spanY))),
    })
    interactRef.current = null
    forceGraphRender()
  }, [layout, forceGraphRender])

  // SVG 尺寸跟踪（取景与坐标换算依赖像素尺寸）。
  React.useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width
        const height = entry.contentRect.height
        if (!(width > 0) || !(height > 0)) continue
        setGraphSize({ width, height })
      }
    })
    observer.observe(svg)
    return () => observer.disconnect()
  }, [hasGraph])

  // 滚轮缩放（原生监听 + passive:false 才能 preventDefault），以光标为锚点。
  React.useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = svg.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      const mx = event.clientX - rect.left
      const my = event.clientY - rect.top
      const factor = Math.exp(-event.deltaY * 0.0015)
      setView((previous) => {
        const scale = Math.min(8, Math.max(0.2, previous.scale * factor))
        if (scale === previous.scale) return previous
        return {
          cx: previous.cx + (mx - rect.width / 2) * (1 / previous.scale - 1 / scale),
          cy: previous.cy + (my - rect.height / 2) * (1 / previous.scale - 1 / scale),
          scale,
        }
      })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [hasGraph])

  // 全屏态 Esc 退出。
  React.useEffect(() => {
    if (!maximized) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMaximized(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [maximized])

  /** 屏幕像素 -> 布局坐标（与 view.cx / view.cy / view.scale 互逆）。 */
  const toLayoutPoint = (clientX: number, clientY: number): ForcePoint => {
    const rect = svgRef.current?.getBoundingClientRect()
    const width = rect && rect.width > 0 ? rect.width : graphSize.width
    const height = rect && rect.height > 0 ? rect.height : graphSize.height
    const left = rect?.left ?? 0
    const top = rect?.top ?? 0
    return {
      x: (clientX - left - width / 2) / view.scale + view.cx,
      y: (clientY - top - height / 2) / view.scale + view.cy,
    }
  }

  const relaxSeeds = (): Array<{ id: string; communityId: string }> =>
    (layout?.nodes ?? []).map((node) => ({ id: node.uri, communityId: node.communityId || '_' }))
  const relaxLinks = (): Array<{ source: string; target: string }> =>
    (layout?.edges ?? []).map((edge) => ({ source: edge.source.uri, target: edge.target.uri }))

  const handleGraphPointerDown = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0) return
    interactRef.current = { type: 'pan', lastX: event.clientX, lastY: event.clientY }
    svgRef.current?.setPointerCapture(event.pointerId)
  }

  const handleNodePointerDown = (event: React.PointerEvent<SVGGElement>, uri: string): void => {
    if (event.button !== 0) return
    event.stopPropagation()
    interactRef.current = {
      type: 'node',
      uri,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
      relaxAt: 0,
    }
    svgRef.current?.setPointerCapture(event.pointerId)
  }

  const handleGraphPointerMove = (event: React.PointerEvent<SVGSVGElement>): void => {
    const interact = interactRef.current
    if (!interact) return
    if (interact.type === 'pan') {
      const dx = event.clientX - interact.lastX
      const dy = event.clientY - interact.lastY
      interact.lastX = event.clientX
      interact.lastY = event.clientY
      setView((previous) => ({
        ...previous,
        cx: previous.cx - dx / previous.scale,
        cy: previous.cy - dy / previous.scale,
      }))
      return
    }
    interact.lastX = event.clientX
    interact.lastY = event.clientY
    if (
      Math.abs(event.clientX - interact.startX) > 4 ||
      Math.abs(event.clientY - interact.startY) > 4
    ) {
      interact.moved = true
    }
    if (!interact.moved || !layout) return
    // 拖动节点：该节点坐标由光标冻结，其余节点继续松弛（节流，防高频全量迭代）。
    const point = toLayoutPoint(event.clientX, event.clientY)
    positionsRef.current.set(interact.uri, point)
    const now = Date.now()
    if (now - interact.relaxAt > 80) {
      interact.relaxAt = now
      relaxForceLayout2D(
        relaxSeeds(),
        relaxLinks(),
        positionsRef.current,
        12,
        new Map([[interact.uri, point]]),
      )
    }
    forceGraphRender()
  }

  const handleGraphPointerUp = (event: React.PointerEvent<SVGSVGElement>): void => {
    const interact = interactRef.current
    interactRef.current = null
    try {
      svgRef.current?.releasePointerCapture(event.pointerId)
    } catch {
      // 未捕获时忽略。
    }
    if (!interact) return
    if (interact.type === 'node' && !interact.moved) {
      // 位移 < 4px 视为点击：打开文献。
      onOpenLiterature(interact.uri, 1)
      return
    }
    if (interact.type === 'node' && layout) {
      relaxForceLayout2D(relaxSeeds(), relaxLinks(), positionsRef.current, 40)
      forceGraphRender()
    }
  }

  const showGraph = result === null

  return (
    <div className="space-y-4">
      {/* 图谱视图分段切换：2D Leiden 社群图 / 3D 分层空间拓扑 + 放大至主视区 */}
      <div className="flex items-center gap-1">
        <div className="inline-flex items-center gap-0.5 self-start rounded-lg border border-cslab-border bg-cslab-elevated p-0.5">
          <button
            type="button"
            title="力导向社群布局（2D，可缩放/平移/拖动节点）"
            onClick={() => {
              setViewMode('2d')
              setMaximized(false)
            }}
            className={cn(
              'rounded-md px-2 py-1 text-[10px] transition-colors',
              viewMode === '2d'
                ? 'bg-cslab-accent/10 text-cslab-accent'
                : 'text-cslab-muted hover:bg-cslab-surface hover:text-cslab-text',
            )}
          >
            2D Leiden Map
          </button>
          <button
            type="button"
            title="分层 3D 空间拓扑（宏观/中观/微观）"
            onClick={() => {
              setViewMode('3d')
              setMaximized(false)
            }}
            className={cn(
              'rounded-md px-2 py-1 text-[10px] transition-colors',
              viewMode === '3d'
                ? 'bg-cslab-accent/10 text-cslab-accent'
                : 'text-cslab-muted hover:bg-cslab-surface hover:text-cslab-text',
            )}
          >
            3D Spatial Topology
          </button>
        </div>
        {viewMode === '2d' && showGraph && layout && !maximized && (
          <button
            type="button"
            title="放大至主视区"
            aria-label="放大至主视区"
            onClick={() => setMaximized(true)}
            className="rounded-lg border border-cslab-border bg-cslab-elevated p-1 text-cslab-muted transition-colors hover:bg-cslab-surface hover:text-cslab-text"
          >
            <Maximize2 size={11} />
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 rounded-xl border border-cslab-border bg-cslab-elevated px-2.5 py-1.5">
        <Search size={12} className="shrink-0 text-cslab-muted" />
        <input
          value={query}
          onChange={(event) => {
            const next = event.target.value
            setQuery(next)
            // 退格清空输入框时自动回退全景图谱。
            if (!next.trim() && result !== null) setResult(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void search()
            if (event.key === 'Escape') clearSearch()
          }}
          placeholder="跨文献检索，例如：界面阻抗"
          className="w-full bg-transparent text-[11px] text-cslab-text outline-none placeholder:text-cslab-muted/60"
        />
        {query && (
          <button
            type="button"
            aria-label="清空检索"
            title="清空并返回全景图谱"
            onClick={clearSearch}
            className="shrink-0 rounded-md p-0.5 text-cslab-muted transition-colors hover:bg-cslab-surface hover:text-cslab-text"
          >
            <X size={11} />
          </button>
        )}
        <button
          type="button"
          disabled={busy !== null || !query.trim()}
          onClick={() => void search()}
          className="shrink-0 rounded-md bg-cslab-accent px-2 py-1 text-[10px] text-white transition-colors hover:bg-cslab-accentHover disabled:opacity-50"
        >
          {busy === 'search' ? <Loader2 size={10} className="animate-spin" /> : '检索'}
        </button>
      </div>

      {viewMode === '2d' && showGraph && (
        <div
          className={cn(
            'space-y-2',
            maximized && 'fixed inset-0 z-50 flex flex-col space-y-0 bg-cslab-bg p-4',
          )}
        >
          <div className="flex items-center justify-between">
            <p className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-cslab-muted">
              <Network size={10} /> 全景知识图谱
              {maximized && <span className="text-cslab-accent">（全屏）</span>}
            </p>
            <div className="flex items-center gap-2">
              {graph?.ok && (
                <span className="text-[9px] text-cslab-muted/80">
                  {graph.nodes.length} 篇文献 · {graph.communityCount} 个社群
                </span>
              )}
              {maximized && (
                <button
                  type="button"
                  title="退出全屏 (Esc)"
                  aria-label="退出全屏"
                  onClick={() => setMaximized(false)}
                  className="rounded-md border border-cslab-border bg-cslab-elevated p-1 text-cslab-muted transition-colors hover:bg-cslab-surface hover:text-cslab-text"
                >
                  <Minimize2 size={12} />
                </button>
              )}
            </div>
          </div>
          {graphLoading && (
            <p className="flex items-center gap-1.5 text-[10px] text-cslab-muted">
              <Loader2 size={10} className="animate-spin" /> 图谱加载中…
            </p>
          )}
          {!graphLoading && layout && (
            <div
              className={cn(
                'overflow-hidden rounded-xl border border-cslab-border bg-cslab-bg',
                maximized && 'mt-2 min-h-0 flex-1 rounded-none border-0',
              )}
            >
              <svg
                ref={svgRef}
                role="img"
                aria-label="文献全景关联图谱"
                className={cn(
                  'h-56 w-full cursor-grab touch-none select-none active:cursor-grabbing',
                  maximized && 'h-full',
                )}
                onPointerDown={handleGraphPointerDown}
                onPointerMove={handleGraphPointerMove}
                onPointerUp={handleGraphPointerUp}
                onPointerCancel={handleGraphPointerUp}
              >
                <g
                  transform={`translate(${graphSize.width / 2 - view.scale * view.cx} ${
                    graphSize.height / 2 - view.scale * view.cy
                  }) scale(${view.scale})`}
                >
                  {layout.edges.map((edge, index) => {
                    const source = positionsRef.current.get(edge.source.uri) ?? edge.source
                    const target = positionsRef.current.get(edge.target.uri) ?? edge.target
                    return (
                      <line
                        key={`e-${index}`}
                        x1={source.x}
                        y1={source.y}
                        x2={target.x}
                        y2={target.y}
                        stroke="currentColor"
                        className="text-cslab-muted"
                        strokeOpacity={Math.min(0.45, 0.08 + edge.weight * 0.06)}
                        strokeWidth={Math.min(1.6, 0.4 + edge.weight * 0.12)}
                      />
                    )
                  })}
                  {layout.nodes.map((node) => {
                    const point = positionsRef.current.get(node.uri) ?? node
                    return (
                      <g
                        key={node.uri}
                        transform={`translate(${point.x} ${point.y})`}
                        className="cursor-pointer"
                        onPointerDown={(event) => handleNodePointerDown(event, node.uri)}
                      >
                        <title>{`${node.title} · ${node.communityTitle || '未聚类'} · ${node.chunkCount} 块`}</title>
                        <circle
                          r={3 + Math.min(5, node.chunkCount * 0.3)}
                          fill={`hsl(${communityHue(node.communityId || '_')} 62% 58%)`}
                          fillOpacity={0.85}
                          stroke="transparent"
                        />
                      </g>
                    )
                  })}
                </g>
              </svg>
              <p className="border-t border-cslab-border px-2.5 py-1.5 text-[9px] leading-relaxed text-cslab-muted">
                {`${
                  layout.truncated
                    ? '已展示核心全景关联（按连接度截断前 250 篇文献）。'
                    : '节点按 Leiden 社群着色，连线为跨文献共现强度。'
                }滚轮以光标为锚点缩放、拖拽空白平移、拖动节点调整布局、点击节点打开文献。`}
              </p>
            </div>
          )}
          {!graphLoading && graph && !graph.ok && (
            <p className="text-[10px] leading-relaxed text-cslab-muted">{graph.message}</p>
          )}
        </div>
      )}

      {viewMode === '3d' && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-cslab-muted">
              <Box size={10} /> 分层 3D 空间拓扑
            </p>
            {graph3d && (
              <span className="text-[9px] text-cslab-muted/80">
                {graph3d.nodes.length} 节点 · {graph3d.edges.length} 关联
              </span>
            )}
          </div>
          {!graph3dError && (graph3dLoading || !graph3dLoaded) && (
            <p className="flex items-center gap-1.5 text-[10px] text-cslab-muted">
              <Loader2 size={10} className="animate-spin" /> 3D 拓扑加载中…
            </p>
          )}
          {graph3dError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[10px] leading-relaxed text-red-600">
              <p>{graph3dError}</p>
              <button
                type="button"
                onClick={() => {
                  setGraph3dError(null)
                  setGraph3dLoaded(false)
                }}
                className="mt-1.5 rounded-md border border-dashed border-red-300 px-2 py-1 text-[10px] text-red-600 transition-colors hover:bg-red-100"
              >
                重试
              </button>
            </div>
          )}
          {!graph3dError && graph3dLoaded && graph3d && (
            <CsLab3DTopologyViewport data={graph3d} height={224} />
          )}
          {!graph3dError && graph3dLoaded && graph3d === null && (
            <p className="text-[10px] leading-relaxed text-cslab-muted">暂无拓扑数据。</p>
          )}
        </div>
      )}

      {busy === 'search' && (
        <p className="text-[10px] leading-relaxed text-cslab-muted">
          检索中（首次需构建索引，请稍候）
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void build(false)}
          className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg border border-cslab-border px-2 py-1.5 text-[10px] text-cslab-text transition-colors hover:bg-cslab-surface disabled:opacity-50"
        >
          {busy === 'build' ? <Loader2 size={10} className="animate-spin" /> : <Network size={10} />}
          建立索引
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void build(true)}
          className="rounded-lg border border-dashed border-cslab-border px-2 py-1.5 text-[10px] text-cslab-muted transition-colors hover:bg-cslab-surface hover:text-cslab-text disabled:opacity-50"
        >
          重建
        </button>
      </div>

      {indexInfo && (
        <p className="rounded-lg border border-cslab-border bg-cslab-surface px-3 py-2 text-[10px] leading-relaxed text-cslab-text">
          {indexInfo}
        </p>
      )}

      {result?.ok && result.hits.length === 0 && (
        <p className="text-[11px] text-cslab-muted">没有匹配的文献切块。</p>
      )}

      {result?.hits.map((hit) => (
        <button
          key={hit.chunkId}
          type="button"
          onClick={() => onOpenLiterature(hit.literatureUri, hit.page, hit.bbox)}
          className="block w-full rounded-xl border border-cslab-border bg-cslab-bg p-3 text-left transition-colors hover:bg-cslab-surface"
        >
          <div className="flex items-baseline justify-between gap-2">
            <p className="min-w-0 flex-1 truncate font-serif text-[12px] text-cslab-text">
              {hit.title}
            </p>
            <span className="shrink-0 text-[9px] tabular-nums text-cslab-muted">p{hit.page}</span>
          </div>
          <p className="mt-1 line-clamp-4 text-[10px] leading-relaxed text-cslab-muted">
            {hit.excerpt}
          </p>
          <div className="mt-1.5 flex items-center gap-2 text-[9px] text-cslab-muted/80">
            <span className="rounded-full bg-cslab-surface px-1.5 py-0.5">{hit.communityTitle}</span>
            <span className="tabular-nums">score {hit.score.toFixed(2)}</span>
            {hit.bbox && <span className="text-cslab-accent/80">点击定位原文</span>}
          </div>
        </button>
      ))}

      {hint && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[10px] leading-relaxed text-amber-600 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
          {hint}
        </p>
      )}

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[10px] leading-relaxed text-red-600">
          {error}
        </p>
      )}

      <p className="text-[10px] leading-relaxed text-cslab-muted">
        索引基于 PDF 真实字符流切块，再用 Leiden 分层社区聚类；扫描版 PDF 若无文本层会如实返回空结果。
      </p>
    </div>
  )
}
