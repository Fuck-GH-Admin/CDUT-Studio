/**
 * CsLabCorpusMindMap — 文献智脑 2D 跨论文大型串联思维导图
 *
 * 功能：
 * 1. 同一画布展示入库多篇论文的详细展开导图（论文核心 -> 章节脉络 -> 图表/指标/方法/概念）；
 * 2. 论文内部章节交错树状连接；
 * 3. 跨论文之间依据共同作者、共享概念、交叉引用形成大型串联网络；
 * 4. 支持滚轮以光标为锚点平滑缩放、抓手拖拽平移、全屏全景查看；
 * 5. 点击任意气泡定位跳转 PDF 对应页与锚点；
 * 6. 支持一键将当前大型串联导图导出为 Prove2Me / Obsidian JSON Canvas (.canvas)。
 */

import * as React from 'react'
import {
  BookOpen,
  Box,
  ChevronRight,
  ExternalLink,
  FileText,
  Image,
  Layers,
  Lightbulb,
  Loader2,
  Maximize2,
  Minimize2,
  Network,
  RotateCcw,
  Search,
  Sigma,
  Table2,
  User,
  Workflow,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import type {
  CsLabCanvasDocument,
  CsLabCanvasEdge,
  CsLabCanvasNode,
  Hierarchical3DGraphData,
  Hierarchical3DGraphEdge,
  Hierarchical3DGraphNode,
} from '@profer/shared'
import { getBeijingTimeInfo } from '@profer/shared'
import { cn } from '@/lib/utils'

interface CsLabCorpusMindMapProps {
  labId: string
  corpusData: Hierarchical3DGraphData | null
  loading?: boolean
  maximized?: boolean
  onToggleMaximize?: () => void
  onOpenLiterature: (uri: string, page: number, bbox?: [number, number, number, number]) => void
  onToast?: (kind: 'info' | 'success' | 'error', text: string) => void
  onOpenCanvas?: (relPath: string) => void
}

interface MindMapLayoutNode {
  id: string
  label: string
  type: string
  layer: Hierarchical3DGraphNode['layer']
  paperUri?: string
  paperTitle?: string
  page?: number
  x: number
  y: number
  width: number
  height: number
  color: string
  details?: Record<string, unknown>
}

interface MindMapLayoutEdge {
  id: string
  source: MindMapLayoutNode
  target: MindMapLayoutNode
  relation: string
  isCrossPaper: boolean
}

const TYPE_CONFIG: Record<
  string,
  { label: string; icon: string; bg: string; border: string; text: string; badge: string }
> = {
  paper: {
    label: '论文',
    icon: '📄',
    bg: 'var(--cslab-surface, #ffffff)',
    border: '#6366f1',
    text: '#4338ca',
    badge: 'rgba(99, 102, 241, 0.12)',
  },
  section: {
    label: '章节',
    icon: '📑',
    bg: 'var(--cslab-surface, #ffffff)',
    border: '#0284c7',
    text: '#0369a1',
    badge: 'rgba(2, 132, 199, 0.1)',
  },
  method: {
    label: '方法',
    icon: '⚙️',
    bg: 'var(--cslab-surface, #ffffff)',
    border: '#9333ea',
    text: '#7e22ce',
    badge: 'rgba(147, 51, 234, 0.1)',
  },
  concept: {
    label: '概念',
    icon: '💡',
    bg: 'var(--cslab-surface, #ffffff)',
    border: '#d97706',
    text: '#b45309',
    badge: 'rgba(217, 119, 6, 0.1)',
  },
  figure: {
    label: '图表',
    icon: '🖼️',
    bg: 'var(--cslab-surface, #ffffff)',
    border: '#e11d48',
    text: '#be123c',
    badge: 'rgba(225, 29, 72, 0.1)',
  },
  metric: {
    label: '指标',
    icon: '📊',
    bg: 'var(--cslab-surface, #ffffff)',
    border: '#059669',
    text: '#047857',
    badge: 'rgba(5, 150, 105, 0.1)',
  },
  author: {
    label: '学者',
    icon: '👤',
    bg: 'var(--cslab-surface, #ffffff)',
    border: '#64748b',
    text: '#475569',
    badge: 'rgba(100, 116, 139, 0.1)',
  },
  table: {
    label: '表格',
    icon: '📋',
    bg: 'var(--cslab-surface, #ffffff)',
    border: '#0d9488',
    text: '#0f766e',
    badge: 'rgba(13, 148, 136, 0.1)',
  },
}

function computeCorpusMindMapLayout(
  data: Hierarchical3DGraphData,
): { nodes: MindMapLayoutNode[]; edges: MindMapLayoutEdge[] } {
  const paperNodes = data.nodes.filter((n) => n.type === 'paper')
  const nonPaperNodes = data.nodes.filter((n) => n.type !== 'paper')

  const layoutNodes: MindMapLayoutNode[] = []
  const nodeMap = new Map<string, MindMapLayoutNode>()

  // 建立邻接关系便于树状派生
  const childrenMap = new Map<string, string[]>()
  for (const edge of data.edges) {
    const list = childrenMap.get(edge.source) ?? []
    list.push(edge.target)
    childrenMap.set(edge.source, list)
  }

  // 1. 论文核心节点排布（单论文居中，多论文纵向整齐排列）
  const paperCount = Math.max(1, paperNodes.length)
  const PAPER_V_SPACING = 520

  paperNodes.forEach((paperNode, pIndex) => {
    const rootX = 0
    const rootY = paperCount > 1 ? (pIndex - (paperCount - 1) / 2) * PAPER_V_SPACING : 0

    const paperLayout: MindMapLayoutNode = {
      id: paperNode.id,
      label: paperNode.label,
      type: 'paper',
      layer: 'macro',
      paperUri: paperNode.id.replace(/^paper:/, ''),
      paperTitle: paperNode.label,
      x: rootX,
      y: rootY,
      width: 240,
      height: 52,
      color: '#6366f1',
      details: paperNode.details,
    }
    layoutNodes.push(paperLayout)
    nodeMap.set(paperNode.id, paperLayout)

    // 获取直系子节点（章节/方法等）
    const directChildrenIds = childrenMap.get(paperNode.id) ?? []
    const directChildren = directChildrenIds
      .map((id) => data.nodes.find((n) => n.id === id))
      .filter((n): n is Hierarchical3DGraphNode => !!n && !nodeMap.has(n.id))

    if (directChildren.length === 0) return

    // 采用经典思维导图：左右双向均匀分支树 (Left / Right balanced tree)
    const rightChildren: Hierarchical3DGraphNode[] = []
    const leftChildren: Hierarchical3DGraphNode[] = []
    directChildren.forEach((child, i) => {
      if (i % 2 === 0) rightChildren.push(child)
      else leftChildren.push(child)
    })

    const layoutBranchSide = (
      branches: Hierarchical3DGraphNode[],
      dir: 1 | -1, // 1 为向右, -1 为向左
    ) => {
      // 预先收集每个分支的二级子项
      const branchItems = branches.map((child) => {
        const subIds = childrenMap.get(child.id) ?? []
        const subNodes = subIds
          .filter((targetId) => {
            const isNextSection = data.edges.some(
              (e) => e.source === child.id && e.target === targetId && e.relation === 'next-section',
            )
            return !isNextSection
          })
          .map((id) => data.nodes.find((n) => n.id === id && !nodeMap.has(n.id)))
          .filter((n): n is Hierarchical3DGraphNode => !!n)
          .slice(0, 5)
        return { child, subNodes }
      })

      // 计算每个一级分支所需的纵向跨度高度（叶子越多高度越大，彻底杜绝重叠）
      const itemHeights = branchItems.map((item) =>
        Math.max(46, item.subNodes.length * 36 + 8),
      )
      const totalBranchHeight = itemHeights.reduce((sum, h) => sum + h, 0)
      let currentTopY = rootY - totalBranchHeight / 2

      branchItems.forEach(({ child, subNodes }, bIdx) => {
        const itemH = itemHeights[bIdx]!
        const centerY = currentTopY + itemH / 2
        currentTopY += itemH

        const isSection = (child.type as string) === 'section' || child.details?.kind === 'section'
        const effectiveType = isSection ? 'section' : child.type
        const width = isSection ? 175 : 140
        const height = isSection ? 38 : 32

        // 一级子节点 X 坐标
        const level1X = rootX + dir * 260
        const level1Y = centerY

        const l1Node: MindMapLayoutNode = {
          id: child.id,
          label: child.label,
          type: effectiveType,
          layer: child.layer,
          paperUri: paperLayout.paperUri,
          paperTitle: paperLayout.paperTitle,
          page: typeof child.details?.page === 'number' ? child.details.page : undefined,
          x: level1X,
          y: level1Y,
          width,
          height,
          color: TYPE_CONFIG[effectiveType]?.border ?? '#0284c7',
          details: child.details,
        }
        layoutNodes.push(l1Node)
        nodeMap.set(child.id, l1Node)

        // 布局该分支下的二级子节点（向同方向继续延伸，纵向平铺）
        const subCount = subNodes.length
        if (subCount > 0) {
          const subStartY = centerY - ((subCount - 1) * 36) / 2
          subNodes.forEach((sub, sIdx) => {
            const subX = level1X + dir * 210
            const subY = subStartY + sIdx * 36

            const subNode: MindMapLayoutNode = {
              id: sub.id,
              label: sub.label,
              type: sub.type,
              layer: sub.layer,
              paperUri: paperLayout.paperUri,
              paperTitle: paperLayout.paperTitle,
              page: typeof sub.details?.page === 'number' ? sub.details.page : undefined,
              x: subX,
              y: subY,
              width: 135,
              height: 28,
              color: TYPE_CONFIG[sub.type]?.border ?? '#059669',
              details: sub.details,
            }
            layoutNodes.push(subNode)
            nodeMap.set(sub.id, subNode)
          })
        }
      })
    }

    // 分别排布右侧分支和左侧分支
    layoutBranchSide(rightChildren, 1)
    layoutBranchSide(leftChildren, -1)
  })

  // 3. 处理全局共享节点（跨论文共同作者、共享概念）
  const remainingNodes = nonPaperNodes.filter((n) => !nodeMap.has(n.id))
  if (remainingNodes.length > 0) {
    let minY = 0
    let maxY = 0
    for (const n of layoutNodes) {
      if (n.y < minY) minY = n.y
      if (n.y > maxY) maxY = n.y
    }
    const globalStartY = maxY + 90
    const cols = 5
    remainingNodes.slice(0, 30).forEach((node, rIndex) => {
      const col = (rIndex % cols) - (cols - 1) / 2
      const row = Math.floor(rIndex / cols)
      const rx = col * 150
      const ry = globalStartY + row * 44

      const layoutNode: MindMapLayoutNode = {
        id: node.id,
        label: node.label,
        type: node.type,
        layer: node.layer,
        x: rx,
        y: ry,
        width: 130,
        height: 28,
        color: TYPE_CONFIG[node.type]?.border ?? '#64748b',
        details: node.details,
      }
      layoutNodes.push(layoutNode)
      nodeMap.set(node.id, layoutNode)
    })
  }

  // 4. 构建边连接
  const layoutEdges: MindMapLayoutEdge[] = []
  data.edges.forEach((edge, index) => {
    const sourceNode = nodeMap.get(edge.source)
    const targetNode = nodeMap.get(edge.target)
    if (!sourceNode || !targetNode) return

    const isCrossPaper =
      sourceNode.paperUri &&
      targetNode.paperUri &&
      sourceNode.paperUri !== targetNode.paperUri

    layoutEdges.push({
      id: `e-${index}-${edge.source}-${edge.target}`,
      source: sourceNode,
      target: targetNode,
      relation: edge.relation,
      isCrossPaper: !!isCrossPaper || edge.relation.includes('citation') || edge.relation.includes('coauthor'),
    })
  })

  return { nodes: layoutNodes, edges: layoutEdges }
}

export function CsLabCorpusMindMap({
  labId,
  corpusData,
  loading,
  maximized,
  onToggleMaximize,
  onOpenLiterature,
  onToast,
  onOpenCanvas,
}: CsLabCorpusMindMapProps): React.ReactElement {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const svgRef = React.useRef<SVGSVGElement | null>(null)

  const [view, setView] = React.useState({ cx: 0, cy: 0, scale: 0.85 })
  const [selectedNode, setSelectedNode] = React.useState<MindMapLayoutNode | null>(null)
  const [filterText, setFilterText] = React.useState('')
  const [exporting, setExporting] = React.useState(false)
  const [containerSize, setContainerSize] = React.useState({ width: 600, height: 320 })

  // 监听容器尺寸变化，避免渲染期同步读取 DOM 引发布局抖动与视口中心漂移
  React.useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const update = (): void => {
      const w = container.clientWidth
      const h = container.clientHeight
      if (w > 0 && h > 0) setContainerSize({ width: w, height: h })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  const interactRef = React.useRef<{
    isPanning: boolean
    startX: number
    startY: number
  }>({ isPanning: false, startX: 0, startY: 0 })

  const layout = React.useMemo(() => {
    if (!corpusData || corpusData.nodes.length === 0) return null
    return computeCorpusMindMapLayout(corpusData)
  }, [corpusData])

  // 居中复位
  const resetView = React.useCallback(() => {
    setView({ cx: 0, cy: 0, scale: maximized ? 1 : 0.85 })
  }, [maximized])

  React.useEffect(() => {
    resetView()
  }, [corpusData, resetView])

  // 滚轮以鼠标光标为锚点平滑缩放
  React.useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = svg.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      const mx = event.clientX - rect.left
      const my = event.clientY - rect.top
      const factor = Math.exp(-event.deltaY * 0.0018)
      setView((previous) => {
        const nextScale = Math.min(4.0, Math.max(0.18, previous.scale * factor))
        if (nextScale === previous.scale) return previous
        return {
          cx: previous.cx + (mx - rect.width / 2) * (1 / previous.scale - 1 / nextScale),
          cy: previous.cy + (my - rect.height / 2) * (1 / previous.scale - 1 / nextScale),
          scale: nextScale,
        }
      })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [])

  // 拖拽平移画布
  const handlePointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return
    interactRef.current = { isPanning: true, startX: event.clientX, startY: event.clientY }
    svgRef.current?.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!interactRef.current.isPanning) return
    const dx = event.clientX - interactRef.current.startX
    const dy = event.clientY - interactRef.current.startY
    interactRef.current.startX = event.clientX
    interactRef.current.startY = event.clientY
    setView((previous) => ({
      ...previous,
      cx: previous.cx - dx / previous.scale,
      cy: previous.cy - dy / previous.scale,
    }))
  }

  const handlePointerUp = (event: React.PointerEvent<SVGSVGElement>) => {
    interactRef.current.isPanning = false
    try {
      svgRef.current?.releasePointerCapture(event.pointerId)
    } catch {
      // 容错释放
    }
  }

  // 导出为 Prove2Me / Obsidian .canvas
  const exportToCanvas = async () => {
    if (!layout || exporting) return
    setExporting(true)
    try {
      const docNodes: CsLabCanvasNode[] = layout.nodes.map((node) => {
        const config = TYPE_CONFIG[node.type] ?? TYPE_CONFIG.concept!
        const prefix = config.icon
        const color = node.color
        return {
          id: node.id.replace(/[^A-Za-z0-9_-]/g, '_'),
          type: 'text',
          text: `### ${prefix} ${node.label}\n\n*${config.label}* ${node.page ? `· 第 ${node.page} 页` : ''}`,
          x: Math.round(node.x),
          y: Math.round(node.y),
          width: Math.round(node.width * 1.2),
          height: Math.round(node.height * 1.5),
          color,
        }
      })

      const docEdges: CsLabCanvasEdge[] = layout.edges.map((edge, idx) => ({
        id: `edge-${idx}`,
        fromNode: edge.source.id.replace(/[^A-Za-z0-9_-]/g, '_'),
        toNode: edge.target.id.replace(/[^A-Za-z0-9_-]/g, '_'),
        label: edge.relation,
        color: edge.isCrossPaper ? '#818cf8' : undefined,
      }))

      const canvasDoc: CsLabCanvasDocument = {
        nodes: docNodes,
        edges: docEdges,
      }

      const beijing = getBeijingTimeInfo()
      const dateStr = `${beijing.year}-${String(beijing.month).padStart(2, '0')}-${String(beijing.day).padStart(2, '0')}`
      const title = `文献智脑串联思维导图-${dateStr}`
      const created = await window.electronAPI.cslab.createCanvas({ labId, title })
      await window.electronAPI.cslab.writeCanvas({
        labId,
        relPath: created.relPath,
        document: canvasDoc,
      })

      onToast?.('success', `导图已成功导出为 Obsidian 标准画布：${created.relPath}`)
      onOpenCanvas?.(created.relPath)
    } catch (err) {
      onToast?.('error', err instanceof Error ? err.message : '导出画布失败')
    } finally {
      setExporting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 text-cslab-muted">
        <Loader2 size={18} className="animate-spin text-cslab-accent" />
        <p className="text-[11px]">正在构建多论文串联思维导图…</p>
      </div>
    )
  }

  if (!layout || layout.nodes.length === 0) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-cslab-border px-4 py-8 text-center text-cslab-muted">
        <Network size={20} className="text-cslab-muted/60" />
        <p className="font-serif text-sm text-cslab-text">暂无多论文串联导图数据</p>
        <p className="text-[10px] leading-relaxed max-w-xs">
          请先在「学术检索」或「资产」中入库论文，系统将自动解析章节脉络并构建交错思维导图。
        </p>
      </div>
    )
  }

  const filteredNodes = filterText
    ? layout.nodes.filter((n) => n.label.toLowerCase().includes(filterText.toLowerCase()))
    : layout.nodes
  const filteredNodeIds = new Set(filteredNodes.map((n) => n.id))

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative flex flex-col overflow-hidden rounded-xl border border-cslab-border bg-cslab-bg transition-all',
        maximized ? 'fixed inset-x-0 bottom-0 top-[40px] z-50 rounded-none border-0' : 'h-[360px]',
      )}
    >
      {/* 顶部工具条 */}
      <div className="flex items-center justify-between border-b border-cslab-border/70 bg-cslab-elevated/85 px-3 py-1.5 backdrop-blur-sm z-10">
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1 font-serif text-[11px] font-semibold text-cslab-text">
            <Layers size={12} className="text-cslab-accent" />
            多论文串联思维导图
          </span>
          <span className="rounded-full border border-cslab-border bg-cslab-surface px-1.5 py-0.2 text-[9px] text-cslab-muted">
            {layout.nodes.filter((n) => n.type === 'paper').length} 篇论文 · {layout.nodes.length} 气泡节点 · {layout.edges.length} 关联
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {/* 关键词快速定位 */}
          <div className="relative">
            <Search size={10} className="absolute left-2 top-1/2 -translate-y-1/2 text-cslab-muted" />
            <input
              type="text"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder="过滤节点…"
              className="w-28 rounded border border-cslab-border bg-cslab-surface/80 py-0.5 pl-5 pr-2 text-[10px] text-cslab-text outline-none focus:border-cslab-accent/50"
            />
          </div>

          <button
            type="button"
            title="放大"
            onClick={() => setView((v) => ({ ...v, scale: Math.min(4, v.scale * 1.25) }))}
            className="rounded p-1 text-cslab-muted hover:bg-cslab-surface hover:text-cslab-text"
          >
            <ZoomIn size={12} />
          </button>
          <button
            type="button"
            title="缩小"
            onClick={() => setView((v) => ({ ...v, scale: Math.max(0.2, v.scale / 1.25) }))}
            className="rounded p-1 text-cslab-muted hover:bg-cslab-surface hover:text-cslab-text"
          >
            <ZoomOut size={12} />
          </button>
          <button
            type="button"
            title="复位视区"
            onClick={resetView}
            className="rounded p-1 text-cslab-muted hover:bg-cslab-surface hover:text-cslab-text"
          >
            <RotateCcw size={12} />
          </button>

          <span className="mx-0.5 h-3.5 w-px bg-cslab-border" />

          {/* 导出为 Obsidian .canvas */}
          <button
            type="button"
            disabled={exporting}
            onClick={() => void exportToCanvas()}
            title="导出为 Prove2Me / Obsidian 画布 (.canvas)"
            className="inline-flex items-center gap-1 rounded bg-cslab-accent/15 px-2 py-0.5 text-[10px] font-medium text-cslab-accent hover:bg-cslab-accent/25 disabled:opacity-50 transition-colors"
          >
            {exporting ? <Loader2 size={10} className="animate-spin" /> : <Workflow size={10} />}
            导出画布
          </button>

          {/* 全屏切换 */}
          {onToggleMaximize && (
            <button
              type="button"
              title={maximized ? '退出全屏 (Esc)' : '放大全屏查看'}
              onClick={onToggleMaximize}
              className="rounded p-1 text-cslab-muted hover:bg-cslab-surface hover:text-cslab-text"
            >
              {maximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
            </button>
          )}
        </div>
      </div>

      {/* SVG 画布视口 */}
      <div className="relative flex-1 min-h-0 bg-cslab-bg">
        <svg
          ref={svgRef}
          role="img"
          aria-label="文献智脑大型串联思维导图"
          className="h-full w-full cursor-grab touch-none select-none active:cursor-grabbing"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          <defs>
            <linearGradient id="mindmap-edge-grad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#818cf8" stopOpacity="0.8" />
              <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.4" />
            </linearGradient>
            <marker
              id="mindmap-arrow"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M 0 2 L 7 5 L 0 8 z" fill="rgba(100, 116, 139, 0.4)" />
            </marker>
            <marker
              id="mindmap-arrow-cross"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M 0 2 L 7 5 L 0 8 z" fill="#818cf8" />
            </marker>
          </defs>

          <g
            transform={`translate(${containerSize.width / 2} ${containerSize.height / 2}) scale(${view.scale}) translate(${-view.cx} ${-view.cy})`}
          >
            {/* 连线层：采用水平 S 型流线贝塞尔曲线 */}
            {layout.edges.map((edge) => {
              const isRight = edge.target.x >= edge.source.x
              // 锚点对齐边缘：从起点卡片的侧边中点射出，进入目标卡片的对应侧边中点
              const startX = isRight ? edge.source.x + edge.source.width / 2 : edge.source.x - edge.source.width / 2
              const startY = edge.source.y
              const endX = isRight ? edge.target.x - edge.target.width / 2 : edge.target.x + edge.target.width / 2
              const endY = edge.target.y

              const dx = endX - startX
              const cOffset = Math.max(30, Math.abs(dx) * 0.5)
              const cx1 = startX + (isRight ? cOffset : -cOffset)
              const cy1 = startY
              const cx2 = endX - (isRight ? cOffset : -cOffset)
              const cy2 = endY

              const pathData = `M ${startX} ${startY} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${endX} ${endY}`
              const isHighlighted =
                selectedNode &&
                (edge.source.id === selectedNode.id || edge.target.id === selectedNode.id)

              return (
                <g key={edge.id}>
                  <path
                    d={pathData}
                    fill="none"
                    stroke={
                      edge.isCrossPaper
                        ? '#818cf8'
                        : isHighlighted
                          ? '#6366f1'
                          : 'rgba(148, 163, 184, 0.45)'
                    }
                    strokeWidth={edge.isCrossPaper ? 1.8 : isHighlighted ? 2.2 : 1.4}
                    strokeDasharray={edge.isCrossPaper ? '4 3' : undefined}
                    opacity={isHighlighted ? 1 : edge.isCrossPaper ? 0.85 : 0.75}
                    markerEnd={edge.isCrossPaper ? 'url(#mindmap-arrow-cross)' : undefined}
                  />
                  {edge.isCrossPaper && (
                    <text
                      x={(startX + endX) / 2}
                      y={(startY + endY) / 2 - 4}
                      fill="#818cf8"
                      fontSize="9"
                      textAnchor="middle"
                      className="font-mono select-none"
                    >
                      {edge.relation}
                    </text>
                  )}
                </g>
              )
            })}

            {/* 节点胶囊层 */}
            {layout.nodes.map((node) => {
              const isSelected = selectedNode?.id === node.id
              const isMatch = filteredNodeIds.has(node.id)
              const cfg = TYPE_CONFIG[node.type] ?? TYPE_CONFIG.concept!
              const isPaper = node.type === 'paper'

              return (
                <g
                  key={node.id}
                  transform={`translate(${node.x - node.width / 2} ${node.y - node.height / 2})`}
                  className="cursor-pointer transition-all duration-150"
                  opacity={isMatch ? 1 : 0.2}
                  onClick={(e) => {
                    e.stopPropagation()
                    setSelectedNode(node)
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    if (node.paperUri) {
                      onOpenLiterature(
                        node.paperUri,
                        node.page ?? 1,
                        undefined,
                      )
                    }
                  }}
                >
                  <title>{`${cfg.label}: ${node.label} (双击在阅读器中定位)`}</title>
                  {/* 外层优雅微阴影与现代圆角卡片 */}
                  <rect
                    width={node.width}
                    height={node.height}
                    rx={isPaper ? 14 : 8}
                    className={cn(
                      'transition-colors duration-150',
                      isPaper
                        ? 'fill-indigo-600/10 stroke-indigo-500/80 shadow-md'
                        : 'fill-card/90 stroke-border/70 hover:stroke-foreground/40',
                    )}
                    fill={isPaper ? undefined : undefined}
                    stroke={isSelected ? '#6366f1' : isPaper ? '#6366f1' : undefined}
                    strokeWidth={isSelected ? 2 : isPaper ? 1.6 : 1}
                    filter={isPaper ? 'drop-shadow(0 4px 8px rgba(99, 102, 241, 0.15))' : 'drop-shadow(0 1px 3px rgba(0,0,0,0.06))'}
                  />
                  <foreignObject width={node.width} height={node.height} className="overflow-hidden px-2 pointer-events-none">
                    <div className="flex h-full items-center justify-between gap-1.5">
                      <div className="flex items-center gap-1.5 min-w-0 flex-1">
                        <span className="shrink-0 text-[11px]">{cfg.icon}</span>
                        <span
                          className={cn(
                            'truncate font-medium text-left leading-tight',
                            isPaper ? 'text-[12px] font-semibold text-foreground' : 'text-[11px] text-foreground/90',
                          )}
                        >
                          {node.label}
                        </span>
                      </div>
                      {node.page ? (
                        <span className="shrink-0 rounded bg-muted/80 px-1 py-0.2 text-[8px] font-mono text-muted-foreground">
                          P.{node.page}
                        </span>
                      ) : null}
                    </div>
                  </foreignObject>
                </g>
              )
            })}
          </g>
        </svg>

        {/* 选定节点操作浮层 */}
        {selectedNode && (
          <div className="absolute bottom-3 left-3 right-3 max-w-md rounded-xl border border-cslab-border/90 bg-cslab-elevated/95 p-3 shadow-lg backdrop-blur-md z-20 space-y-1.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="rounded bg-cslab-surface px-1.5 py-0.5 text-[9px] uppercase font-bold text-cslab-accent">
                    {TYPE_CONFIG[selectedNode.type]?.label ?? selectedNode.type}
                  </span>
                  {selectedNode.page && (
                    <span className="text-[9px] text-cslab-muted">第 {selectedNode.page} 页</span>
                  )}
                  {selectedNode.paperTitle && (
                    <span className="truncate text-[9px] text-cslab-muted/80 max-w-[180px]">
                      来自《{selectedNode.paperTitle}》
                    </span>
                  )}
                </div>
                <h5 className="mt-1 font-serif text-[12px] font-semibold text-cslab-text">
                  {selectedNode.label}
                </h5>
              </div>
              <button
                type="button"
                onClick={() => setSelectedNode(null)}
                className="text-cslab-muted hover:text-cslab-text text-[12px] p-0.5"
              >
                ✕
              </button>
            </div>

            {selectedNode.details?.definition ? (
              <p className="text-[10px] leading-relaxed text-cslab-muted line-clamp-2">
                {String(selectedNode.details?.definition)}
              </p>
            ) : null}

            {selectedNode.paperUri && (
              <div className="pt-1 flex justify-end">
                <button
                  type="button"
                  onClick={() => {
                    if (selectedNode.paperUri) {
                      onOpenLiterature(selectedNode.paperUri, selectedNode.page ?? 1, undefined)
                    }
                  }}
                  className="inline-flex items-center gap-1 rounded bg-cslab-accent px-2 py-1 text-[10px] font-medium text-white hover:bg-cslab-accentHover transition-colors"
                >
                  <BookOpen size={10} /> 在阅读器中查看对应章节
                </button>
              </div>
            )}
          </div>
        )}

        {/* 底部交互指引 */}
        <div className="absolute bottom-2 right-2 rounded-md bg-cslab-elevated/80 px-2 py-1 text-[9px] text-cslab-muted backdrop-blur-sm pointer-events-none">
          滚轮以光标缩放 · 拖拽平移 · 双击气泡跳转原文
        </div>
      </div>
    </div>
  )
}
