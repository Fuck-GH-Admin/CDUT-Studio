/**
 * AiClassKnowledgeTree — AI 速课堂「资料树」（现代简约节点图）
 *
 * 设计：
 *   - 本地毫秒级解析完成后立即渲染「卡片流 + 平滑贝塞尔曲线」节点拓扑，无阻塞感；
 *   - 跨资料关联恒定由用户点击【开始生成】/【重新生成】后，在方案弹窗中主动选择模式生成，
 *     绝不在资料变更或会话加载时自动偷跑消耗 Token；
 *   - 提供【开始生成】方案选择弹窗与【全屏图谱】近全屏（92% 视口）大型星图窗口；
 *   - 画布统一为单一 SVG 坐标系（节点卡走 foreignObject），从结构上根除
 *     HTML 卡片层与 SVG 连线层分离导致的亚像素错位；两个视图共用一套
 *     滚轮缩放、拖拽平移、缩放控件与「适应全图」镜头。
 *
 * 状态全量走 Jotai 原子：资料列表、知识图谱边、推演中标记与当前聚焦节点。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  Expand,
  Loader2,
  Maximize2,
  RotateCcw,
  Search,
  Sparkles,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { toast } from 'sonner'
import type {
  KnowledgeGraphEdge,
  KnowledgeGraphGenerationMode,
  KnowledgeRelationType,
  StudyDocumentOutline,
  StudyDocumentSection,
} from '@profer/shared'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@profer/ui/primitives/dialog'
import { cn } from '@/lib/utils'
import {
  studyDocumentsAtom,
  studyGraphModalOpenAtom,
  studyGraphProgressAtom,
  studyGraphUpdatingAtom,
  studyKnowledgeGraphAtom,
} from '@/atoms/study-atoms'
import { AiClassGraphGenerateModal } from './AiClassGraphGenerateModal'

// ===== 布局常量 =====

const PAD = 40
const COL_W = 250
const NODE_W = 200
const NODE_H = 58
const ROW_H = 84
const HEADER_H = 46
const HEADER_GAP = 20
/** 列标题胶囊的高度（foreignObject 尺寸） */
const HEADER_BOX_H = 30
/** 单文件长文触发「大章矩阵」多列拆分的章节数阈值 */
const SINGLE_MATRIX_THRESHOLD = 6
/** 单文件扁平长文矩阵：每列最大行数 */
const SINGLE_COL_ROWS = 14

// 视图缩放范围
const MIN_SCALE = 0.2
const MAX_SCALE = 2.5

/** 关联类型的视觉样式（曲线颜色 / 图例胶囊底色） */
const RELATION_STYLE: Record<KnowledgeRelationType, { stroke: string; chip: string }> = {
  prerequisite: { stroke: '#6366f1', chip: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400' },
  exercise: { stroke: '#f59e0b', chip: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
  extension: { stroke: '#10b981', chip: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
  reference: { stroke: '#64748b', chip: 'bg-slate-500/15 text-slate-600 dark:text-slate-400' },
}

interface GraphNode {
  sectionId: string
  docId: string
  docName: string
  title: string
  summary: string
  section: StudyDocumentSection
  x: number
  y: number
}

interface GraphColumn {
  /** 列标题（多文件为文件名，单文件矩阵为大章标题） */
  title: string
  docId: string
  /** 本列自上而下排布的节点 sectionId */
  nodeIds: string[]
}

interface GraphLayout {
  nodes: GraphNode[]
  nodeMap: Map<string, GraphNode>
  columns: GraphColumn[]
  width: number
  height: number
}

/**
 * 单文件长文列拆分：
 *   - 存在多级标题：按最浅层「一级大章」聚合，每个大章独立为一列；
 *   - 扁平长文（仅单一层级）：按固定行数均衡分列，形成规整大章矩阵，避免单列超长纵向滚动。
 */
function computeSingleDocColumns(sections: StudyDocumentSection[]): StudyDocumentSection[][] {
  const levels = new Set(sections.map((section) => section.level))
  if (levels.size > 1) {
    const minLevel = Math.min(...levels)
    const groups: StudyDocumentSection[][] = []
    let current: StudyDocumentSection[] | null = null
    for (const section of sections) {
      if (section.level === minLevel && current) {
        groups.push(current)
        current = null
      }
      if (!current) current = []
      current.push(section)
    }
    if (current) groups.push(current)
    if (groups.length >= 2) return groups
  }
  const cols: StudyDocumentSection[][] = []
  for (let i = 0; i < sections.length; i += SINGLE_COL_ROWS) {
    cols.push(sections.slice(i, i + SINGLE_COL_ROWS))
  }
  return cols.length > 0 ? cols : [sections]
}

/**
 * 自适应多列矩阵布局引擎：
 *   - 模式 A（单文件长文，章节数 > 6）：按一级大章聚合为多列矩阵，每列宽 250px；
 *   - 模式 B（多文件组合）：每份文件独立为一列。
 */
function computeLayout(documents: StudyDocumentOutline[]): GraphLayout {
  const nodes: GraphNode[] = []
  const nodeMap = new Map<string, GraphNode>()
  const columns: GraphColumn[] = []

  const singleDoc = documents.length === 1 ? documents[0]! : null
  const isSingleLongDoc = singleDoc !== null && singleDoc.sections.length > SINGLE_MATRIX_THRESHOLD

  const pushColumn = (doc: StudyDocumentOutline, columnSections: StudyDocumentSection[], colIndex: number, title: string): void => {
    const x = PAD + colIndex * COL_W
    const nodeIds: string[] = []
    columnSections.forEach((section, rowIndex) => {
      const node: GraphNode = {
        sectionId: section.sectionId,
        docId: doc.documentId,
        docName: doc.fileName,
        title: section.title,
        summary: section.summary,
        section,
        x,
        y: PAD + HEADER_H + HEADER_GAP + rowIndex * ROW_H,
      }
      nodes.push(node)
      nodeMap.set(section.sectionId, node)
      nodeIds.push(section.sectionId)
    })
    columns.push({ title, docId: doc.documentId, nodeIds })
  }

  if (isSingleLongDoc && singleDoc) {
    const groups = computeSingleDocColumns(singleDoc.sections)
    groups.forEach((group, colIndex) => {
      pushColumn(singleDoc, group, colIndex, group[0]?.title ?? `第 ${colIndex + 1} 部分`)
    })
  } else {
    documents.forEach((doc, colIndex) => {
      pushColumn(doc, doc.sections, colIndex, doc.fileName)
    })
  }

  const maxRows = columns.reduce((max, column) => Math.max(max, column.nodeIds.length), 0)
  const width = PAD * 2 + Math.max(1, columns.length) * COL_W
  const height = PAD * 2 + HEADER_H + HEADER_GAP + Math.max(1, maxRows) * ROW_H
  return { nodes, nodeMap, columns, width, height }
}

/** 同列相邻章节的竖向平滑曲线 */
function verticalCurve(node: GraphNode): string {
  const cx = node.x + NODE_W / 2
  const y1 = node.y + NODE_H
  const y2 = node.y + ROW_H
  const dy = (y2 - y1) / 2
  return `M ${cx} ${y1} C ${cx} ${y1 + dy}, ${cx} ${y2 - dy}, ${cx} ${y2}`
}

/** 跨资料边几何数据（曲线路径与贝塞尔中点） */
interface CrossEdgeGeometry {
  path: string
  labelX: number
  labelY: number
}

/**
 * 跨资料平滑贝塞尔关联弧线与中点几何计算
 *
 * 彻底解决旧算法三大 Bug：
 *   1. 智能端口（Anchor Port）：不再机械假设从左往右。
 *      - 若 source 在左、target 在右：从 source 右中点连入 target 左中点（正向）；
 *      - 若 source 在右、target 在左：从 source 左中点连入 target 右中点（反向），
 *        杜绝线从外侧甩出并在反面刺穿卡片和箭头反插的问题；
 *      - 若 source 与 target 同列：从右侧向外形成优美回路弧线（Loop）；
 *   2. 微拱弧度：当两节点水平同行（y 几乎相等）时，施加轻微拱起弧度，
 *      彻底告别生硬死板的水平穿透铁棍感；双向边则上下错开，避免重叠；
 *   3. 真实贝塞尔中点（t = 0.5）：气泡微标签 100% 严丝合缝贴在曲线上。
 */
function computeCrossEdgeGeometry(source: GraphNode, target: GraphNode): CrossEdgeGeometry {
  const isForward = source.x < target.x
  const isBackward = source.x > target.x

  // 场景 1：同列内跳转（同文档跨章节前后关联）
  if (!isForward && !isBackward) {
    const p0x = source.x + NODE_W
    const p0y = source.y + NODE_H / 2
    const p3x = target.x + NODE_W
    const p3y = target.y + NODE_H / 2
    const loopOffset = Math.max(48, Math.abs(p3y - p0y) * 0.35)
    const p1x = p0x + loopOffset
    const p1y = p0y
    const p2x = p3x + loopOffset
    const p2y = p3y
    const path = `M ${p0x} ${p0y} C ${p1x} ${p1y}, ${p2x} ${p2y}, ${p3x} ${p3y}`
    const labelX = 0.125 * p0x + 0.375 * p1x + 0.375 * p2x + 0.125 * p3x
    const labelY = 0.125 * p0y + 0.375 * p1y + 0.375 * p2y + 0.125 * p3y
    return { path, labelX, labelY }
  }

  // 场景 2：反向跨列（右侧列连向左侧列）
  if (isBackward) {
    const p0x = source.x
    const p0y = source.y + NODE_H / 2
    const p3x = target.x + NODE_W
    const p3y = target.y + NODE_H / 2
    const gapX = p0x - p3x
    const dx = Math.max(38, gapX * 0.5)
    // 同行时向下微弯拱起（+20），与正向的向上拱起形成上下对称美感
    const arcBump = Math.abs(p3y - p0y) < 16 ? 20 : 0
    const p1x = p0x - dx
    const p1y = p0y + arcBump
    const p2x = p3x + dx
    const p2y = p3y + arcBump
    const path = `M ${p0x} ${p0y} C ${p1x} ${p1y}, ${p2x} ${p2y}, ${p3x} ${p3y}`
    const labelX = 0.125 * p0x + 0.375 * p1x + 0.375 * p2x + 0.125 * p3x
    const labelY = 0.125 * p0y + 0.375 * p1y + 0.375 * p2y + 0.125 * p3y
    return { path, labelX, labelY }
  }

  // 场景 3：正向跨列（左侧列连向右侧列）
  const p0x = source.x + NODE_W
  const p0y = source.y + NODE_H / 2
  const p3x = target.x
  const p3y = target.y + NODE_H / 2
  const gapX = p3x - p0x
  const dx = Math.max(42, gapX * 0.5)
  // 同行时向上微弯拱起（-20），彻底消除死板横线穿刺感
  const arcBump = Math.abs(p3y - p0y) < 16 ? -20 : 0
  const p1x = p0x + dx
  const p1y = p0y + arcBump
  const p2x = p3x - dx
  const p2y = p3y + arcBump
  const path = `M ${p0x} ${p0y} C ${p1x} ${p1y}, ${p2x} ${p2y}, ${p3x} ${p3y}`
  const labelX = 0.125 * p0x + 0.375 * p1x + 0.375 * p2x + 0.125 * p3x
  const labelY = 0.125 * p0y + 0.375 * p1y + 0.375 * p2y + 0.125 * p3y
  return { path, labelX, labelY }
}

/** 复制「以此节提问」模板到剪贴板 */
async function copySectionPrompt(node: GraphNode): Promise<void> {
  const prompt = `请为我讲解《${node.title}》（资料：${node.docName}，章节 ${node.sectionId}），并结合原文例题直击考点。`
  try {
    await navigator.clipboard.writeText(prompt)
    toast.success('已复制该知识点的提问模板，粘贴到中栏即可向导师提问')
  } catch {
    toast.error('复制失败，请手动选择文本')
  }
}

// ===== 相机（滚轮缩放 / 拖拽平移 / 适应全图） =====

interface CameraState {
  scale: number
  tx: number
  ty: number
}

interface PointerHandlers {
  onPointerDown: React.PointerEventHandler<HTMLDivElement>
  onPointerMove: React.PointerEventHandler<HTMLDivElement>
  onPointerUp: React.PointerEventHandler<HTMLDivElement>
  onPointerCancel: React.PointerEventHandler<HTMLDivElement>
}

interface StarMapCamera {
  view: CameraState
  /** 回调 ref：视口元素可能延迟挂载（如全屏弹窗），挂载后方可绑定滚轮监听 */
  setViewportRef: (node: HTMLDivElement | null) => void
  isDragging: boolean
  zoomBy: (factor: number, anchor?: { x: number; y: number }) => void
  reset: () => void
  fit: () => void
  handlers: PointerHandlers
}

const clampScale = (scale: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))

/**
 * 星图视口相机：两个视图（内嵌 / 全屏）共用同一套交互。
 * 所有坐标以视口左上角为原点，采用 `translate(tx,ty) scale(scale)` 变换。
 */
function useStarMapViewport(graphWidth: number, graphHeight: number): StarMapCamera {
  const [view, setView] = React.useState<CameraState>({ scale: 1, tx: 0, ty: 0 })
  const [isDragging, setIsDragging] = React.useState(false)
  const [viewportEl, setViewportEl] = React.useState<HTMLDivElement | null>(null)
  const viewportRef = React.useRef<HTMLDivElement | null>(null)
  const setViewportRef = React.useCallback((node: HTMLDivElement | null): void => {
    viewportRef.current = node
    setViewportEl(node)
  }, [])
  const viewRef = React.useRef(view)
  viewRef.current = view
  const dragRef = React.useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null)

  /** 以视口内某点为锚点缩放（默认视口中心） */
  const zoomBy = React.useCallback((factor: number, anchor?: { x: number; y: number }): void => {
    const rect = viewportRef.current?.getBoundingClientRect()
    const ax = anchor?.x ?? (rect ? rect.width / 2 : 0)
    const ay = anchor?.y ?? (rect ? rect.height / 2 : 0)
    setView((prev) => {
      const nextScale = clampScale(prev.scale * factor)
      const k = nextScale / prev.scale
      return { scale: nextScale, tx: ax - k * (ax - prev.tx), ty: ay - k * (ay - prev.ty) }
    })
  }, [])

  /** 自适应：缩放到整图可见并居中 */
  const fit = React.useCallback((): void => {
    const rect = viewportRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0 || graphWidth <= 0 || graphHeight <= 0) return
    const margin = 24
    const scale = clampScale(
      Math.min((rect.width - margin * 2) / graphWidth, (rect.height - margin * 2) / graphHeight),
    )
    setView({
      scale,
      tx: (rect.width - graphWidth * scale) / 2,
      ty: (rect.height - graphHeight * scale) / 2,
    })
  }, [graphWidth, graphHeight])

  /** 重置为 100% 并居中 */
  const reset = React.useCallback((): void => {
    const rect = viewportRef.current?.getBoundingClientRect()
    if (!rect) {
      setView({ scale: 1, tx: 0, ty: 0 })
      return
    }
    setView({ scale: 1, tx: (rect.width - graphWidth) / 2, ty: (rect.height - graphHeight) / 2 })
  }, [graphWidth, graphHeight])

  // 滚轮缩放（非被动监听，确保可 preventDefault；默认直接滚轮即缩放）
  // 依赖 viewportEl：全屏弹窗打开时才挂载视口，需在其挂载后重新绑定。
  React.useEffect(() => {
    if (!viewportEl) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = viewportEl.getBoundingClientRect()
      const delta = event.deltaMode === 1 ? event.deltaY * 33 : event.deltaY
      zoomBy(Math.exp(-delta * 0.001), { x: event.clientX - rect.left, y: event.clientY - rect.top })
    }
    viewportEl.addEventListener('wheel', onWheel, { passive: false })
    return () => viewportEl.removeEventListener('wheel', onWheel)
  }, [zoomBy, viewportEl])

  const onPointerDown: React.PointerEventHandler<HTMLDivElement> = (event) => {
    if ((event.target as HTMLElement).closest('button')) return
    event.preventDefault() // 阻止拖动时选中画布文本（全选文本 / 拖动文字）
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { x: event.clientX, y: event.clientY, tx: viewRef.current.tx, ty: viewRef.current.ty, moved: false }
  }
  const onPointerMove: React.PointerEventHandler<HTMLDivElement> = (event) => {
    const drag = dragRef.current
    if (!drag) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (!drag.moved) {
      if (Math.hypot(dx, dy) <= 3) return
      drag.moved = true
      setIsDragging(true)
    }
    setView((prev) => ({ ...prev, tx: drag.tx + dx, ty: drag.ty + dy }))
  }
  const endDrag = (): void => {
    dragRef.current = null
    setIsDragging(false)
  }

  return {
    view,
    setViewportRef,
    isDragging,
    zoomBy,
    reset,
    fit,
    handlers: { onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag },
  }
}

// ===== 缩放控件（两视图共用） =====

interface StarMapZoomControlsProps {
  scale: number
  onZoomIn: () => void
  onZoomOut: () => void
  onFit: () => void
  onReset: () => void
}

function StarMapZoomControls({ scale, onZoomIn, onZoomOut, onFit, onReset }: StarMapZoomControlsProps): React.ReactElement {
  const iconButton =
    'flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground'
  return (
    <div className="absolute bottom-3 right-3 z-10 flex items-center gap-0.5 rounded-full border border-border/60 bg-card/90 p-0.5 shadow-md backdrop-blur-sm">
      <button type="button" onClick={onZoomOut} aria-label="缩小" title="缩小" className={iconButton}>
        <ZoomOut size={13} />
      </button>
      <span className="min-w-11 text-center text-[10px] font-medium tabular-nums text-muted-foreground">
        {Math.round(scale * 100)}%
      </span>
      <button type="button" onClick={onZoomIn} aria-label="放大" title="放大" className={iconButton}>
        <ZoomIn size={13} />
      </button>
      <span className="mx-0.5 h-4 w-px bg-border/60" />
      <button type="button" onClick={onFit} aria-label="适应全图" title="适应全图" className={iconButton}>
        <Maximize2 size={13} />
      </button>
      <button type="button" onClick={onReset} aria-label="重置视图" title="重置为 100%" className={iconButton}>
        <RotateCcw size={13} />
      </button>
    </div>
  )
}

// ===== 面布（视口 + 变换层 + 缩放控件） =====

interface StarMapSurfaceProps {
  camera: StarMapCamera
  className?: string
  children: React.ReactNode
}

function StarMapSurface({ camera, className, children }: StarMapSurfaceProps): React.ReactElement {
  const { view, setViewportRef, isDragging, zoomBy, reset, fit, handlers } = camera
  return (
    <div className={cn('relative min-h-0 flex-1 overflow-hidden', className)}>
      <div
        ref={setViewportRef}
        className={cn('absolute inset-0 touch-none select-none', isDragging ? 'cursor-grabbing' : 'cursor-grab')}
        style={{
          backgroundImage:
            'radial-gradient(circle, hsl(var(--muted-foreground)/0.08) 0.5px, transparent 0.5px),' +
            'radial-gradient(circle, hsl(var(--muted-foreground)/0.12) 1px, transparent 1px)',
          backgroundSize: '6px 6px, 30px 30px',
        }}
        {...handlers}
      >
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}
        >
          {children}
        </div>
      </div>
      <StarMapZoomControls
        scale={view.scale}
        onZoomIn={() => zoomBy(1.2)}
        onZoomOut={() => zoomBy(1 / 1.2)}
        onFit={fit}
        onReset={reset}
      />
    </div>
  )
}

// ===== 画布（常规视图与全屏星图共用，单一 SVG 坐标系） =====

interface GraphCanvasProps {
  edges: KnowledgeGraphEdge[]
  layout: GraphLayout
  selectedId: string | null
  onSelect: (node: GraphNode) => void
  highlightQuery: string
}

function GraphCanvas({ edges, layout, selectedId, onSelect, highlightQuery }: GraphCanvasProps): React.ReactElement {
  const { nodes, nodeMap, columns, width, height } = layout
  const query = highlightQuery.trim().toLowerCase()

  // 同列相邻章节的竖向连接（单文件矩阵下每列均独立连接）
  const intraPaths: string[] = []
  for (const column of columns) {
    for (let i = 0; i < column.nodeIds.length - 1; i++) {
      const node = nodeMap.get(column.nodeIds[i]!)
      if (node) intraPaths.push(verticalCurve(node))
    }
  }

  return (
    <svg width={width} height={height} className="block" style={{ overflow: 'visible' }}>
      <defs>
        {(Object.keys(RELATION_STYLE) as KnowledgeRelationType[]).map((type) => (
          <marker
            key={type}
            id={`ai-class-arrow-${type}`}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={RELATION_STYLE[type].stroke} />
          </marker>
        ))}
      </defs>

      {/* 同一坐标系第一层：连线 */}
      {intraPaths.map((path, index) => (
        <path
          key={`intra-${index}`}
          d={path}
          fill="none"
          stroke="currentColor"
          className="text-border/70"
          strokeWidth={1.5}
          strokeDasharray="4 4"
        />
      ))}
      {edges.map((edge) => {
        const source = nodeMap.get(edge.sourceSectionId)
        const target = nodeMap.get(edge.targetSectionId)
        if (!source || !target) return null
        const style = RELATION_STYLE[edge.relationType]
        const active = selectedId === source.sectionId || selectedId === target.sectionId
        const { path } = computeCrossEdgeGeometry(source, target)
        return (
          <path
            key={edge.edgeId}
            d={path}
            fill="none"
            stroke={style.stroke}
            strokeWidth={active ? 2.4 : 1.6}
            strokeOpacity={active ? 1 : 0.65}
            markerEnd={`url(#ai-class-arrow-${edge.relationType})`}
          />
        )
      })}

      {/* 第二层：资料列 / 大章列标题胶囊 */}
      {columns.map((column, colIndex) => (
        <foreignObject
          key={`header-${colIndex}`}
          x={PAD + colIndex * COL_W}
          y={PAD}
          width={NODE_W}
          height={HEADER_BOX_H}
          className="overflow-visible"
        >
          <div
            className="flex h-full w-full items-center gap-1.5 rounded-full border border-primary/25 bg-primary/10 px-3 text-[11px] font-semibold text-primary shadow-sm"
            title={column.title}
          >
            <span className="size-1.5 shrink-0 rounded-full bg-primary" />
            <span className="min-w-0 flex-1 truncate">{column.title}</span>
          </div>
        </foreignObject>
      ))}

      {/* 第三层：章节节点卡片 */}
      {nodes.map((node) => {
        const selected = selectedId === node.sectionId
        const matched = query.length > 0 && node.title.toLowerCase().includes(query)
        return (
          <foreignObject
            key={node.sectionId}
            x={node.x}
            y={node.y}
            width={NODE_W}
            height={NODE_H}
            className="overflow-visible"
          >
            <button
              type="button"
              data-document-name={node.docName}
              onClick={() => onSelect(node)}
              className={cn(
                'flex h-full w-full flex-col justify-center gap-0.5 rounded-xl border bg-card px-3 py-2 text-left shadow-sm transition-[box-shadow,border-color]',
                'hover:border-primary/50 hover:shadow-md',
                selected ? 'border-primary ring-2 ring-primary/30' : 'border-border/60',
                matched && !selected && 'ring-2 ring-amber-400/60',
              )}
              title={node.summary}
            >
              <span className="w-full min-w-0 truncate text-[11px] font-medium text-foreground">{node.title}</span>
              <span className="w-full min-w-0 truncate text-[10px] text-muted-foreground">{node.summary}</span>
            </button>
          </foreignObject>
        )
      })}

      {/* 第四层：跨资料微标签（落在贝塞尔弧线精确中点，实心背景杜绝穿透） */}
      {edges.map((edge) => {
        const source = nodeMap.get(edge.sourceSectionId)
        const target = nodeMap.get(edge.targetSectionId)
        if (!source || !target) return null
        const style = RELATION_STYLE[edge.relationType]
        const { labelX, labelY } = computeCrossEdgeGeometry(source, target)
        const labelWidth = Math.min(100, Math.max(36, edge.label.length * 11 + 18))
        const labelHeight = 20
        return (
          <g key={`label-${edge.edgeId}`} className="pointer-events-none">
            {/* 实心卡片背景药丸：确保 100% 遮挡下方的连接线 */}
            <rect
              x={labelX - labelWidth / 2}
              y={labelY - labelHeight / 2}
              width={labelWidth}
              height={labelHeight}
              rx={10}
              className="fill-card drop-shadow-sm"
              stroke={style.stroke}
              strokeWidth={1.2}
              strokeOpacity={0.5}
            />
            {/* 微标签文字 */}
            <text
              x={labelX}
              y={labelY + 0.5}
              textAnchor="middle"
              dominantBaseline="central"
              style={{ fill: style.stroke, fontSize: 9.5, fontWeight: 600 }}
            >
              {edge.label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

// ===== 近全屏星图弹窗 =====

interface KnowledgeTreeLargeModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  edges: KnowledgeGraphEdge[]
  layout: GraphLayout
}

function KnowledgeTreeLargeModal({ open, onOpenChange, edges, layout }: KnowledgeTreeLargeModalProps): React.ReactElement {
  const [query, setQuery] = React.useState('')
  const [selected, setSelected] = React.useState<GraphNode | null>(null)
  const camera = useStarMapViewport(layout.width, layout.height)
  const { fit } = camera

  // 打开时重置搜索 / 选中，并自适应整图
  React.useEffect(() => {
    if (!open) return
    setQuery('')
    setSelected(null)
    const raf = requestAnimationFrame(() => fit())
    return () => cancelAnimationFrame(raf)
  }, [open, fit])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideClose
        className="grid h-[92vh] w-[92vw] max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-3xl border-border/60 bg-card p-0 shadow-2xl"
      >
        <DialogTitle className="sr-only">资料树全屏星图</DialogTitle>

        {/* 紧凑顶栏 */}
        <div className="relative z-20 flex h-12 shrink-0 items-center gap-3 border-b border-border/50 px-5">
          <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Sparkles size={15} />
          </span>
          <span className="text-sm font-semibold tracking-tight">资料树 · 知识星图</span>
          <div className="relative ml-1 w-56">
            <Search className="absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索知识点节点…"
              className="h-8 w-full rounded-lg border border-border/60 bg-background/60 pl-8 pr-3 text-xs outline-none focus:border-primary/50"
            />
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="关闭全屏图谱"
            className="ml-auto flex size-7 items-center justify-center rounded-full bg-foreground/5 text-foreground/70 transition-all hover:bg-foreground/15 hover:text-foreground active:scale-95"
          >
            <X size={15} />
          </button>
        </div>

        <div className="relative flex min-h-0 flex-1">
          {/* 星图画布视口 */}
          <StarMapSurface camera={camera} className="rounded-none border-0">
            <GraphCanvas
              edges={edges}
              layout={layout}
              selectedId={selected?.sectionId ?? null}
              onSelect={setSelected}
              highlightQuery={query}
            />
          </StarMapSurface>

          {/* 节点聚焦侧栏 */}
          {selected ? (
            <aside className="flex w-72 shrink-0 flex-col gap-3 border-l border-border/50 bg-card/70 p-4">
              <div className="flex items-start justify-between gap-2">
                <h4 className="text-sm font-semibold text-foreground">{selected.title}</h4>
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted"
                >
                  <X size={13} />
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground">资料：{selected.docName}</p>
              <p className="flex-1 overflow-y-auto text-xs leading-relaxed text-muted-foreground">
                {selected.summary}
              </p>
              <button
                type="button"
                onClick={() => void copySectionPrompt(selected)}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <Sparkles size={13} />
                <span>以此节向导师提问</span>
              </button>
            </aside>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ===== 主组件 =====

interface AiClassKnowledgeTreeProps {
  sessionId: string
}

export function AiClassKnowledgeTree({ sessionId }: AiClassKnowledgeTreeProps): React.ReactElement {
  const documents = useAtomValue(studyDocumentsAtom)
  const graph = useAtomValue(studyKnowledgeGraphAtom)
  const updating = useAtomValue(studyGraphUpdatingAtom)
  const progress = useAtomValue(studyGraphProgressAtom)
  const setGraph = useSetAtom(studyKnowledgeGraphAtom)
  const setUpdating = useSetAtom(studyGraphUpdatingAtom)
  const setProgress = useSetAtom(studyGraphProgressAtom)

  const [selected, setSelected] = React.useState<GraphNode | null>(null)
  const [largeOpen, setLargeOpen] = React.useState(false)
  const [modalOpen, setModalOpen] = useAtom(studyGraphModalOpenAtom)

  const layout = React.useMemo(() => computeLayout(documents), [documents])
  const edges = graph?.edges ?? []
  const camera = useStarMapViewport(layout.width, layout.height)
  const { fit } = camera

  // 资料变化 / 首次挂载后自适应整图
  React.useEffect(() => {
    const raf = requestAnimationFrame(() => fit())
    return () => cancelAnimationFrame(raf)
  }, [fit])

  // 订阅图谱推演实时进度（主进程逐批广播），驱动顶部进度胶囊
  React.useEffect(() => {
    const unsubscribe = window.electronAPI.cdutAiClass.onGraphProgress((data) => {
      if (data.sessionId && data.sessionId !== sessionId) return
      setProgress(data)
    })
    return () => unsubscribe()
  }, [sessionId, setProgress])

  // 推演结束后短暂展示 100% 再淡出进度胶囊
  React.useEffect(() => {
    if (updating) return
    const timer = window.setTimeout(() => setProgress(null), 600)
    return () => window.clearTimeout(timer)
  }, [updating, setProgress])

  const sessionIdRef = React.useRef(sessionId)
  sessionIdRef.current = sessionId

  // 用户确认方案后按选定模式生成关联（恒定用户主动触发，绝不自动偷跑 Token）
  const generate = React.useCallback(
    async (mode: KnowledgeGraphGenerationMode): Promise<void> => {
      const targetSessionId = sessionId
      setUpdating(true)
      setProgress(null)
      try {
        const data = await window.electronAPI.cdutAiClass.generateGraphRelations({ sessionId: targetSessionId, mode })
        if (sessionIdRef.current === targetSessionId) {
          setGraph(data)
        }
      } catch (error) {
        console.warn('[AI速课堂] 生成资料树关联失败:', error)
      } finally {
        if (sessionIdRef.current === targetSessionId) {
          setUpdating(false)
        }
      }
    },
    [sessionId, setGraph, setUpdating, setProgress],
  )

  // 会话切换时清空图谱缓存与聚焦节点，避免残留上一课堂的关联边；
  // 同时复位全局生成态（updating/progress 为跨会话共享原子），否则切换课堂后
  // 旧课堂遗留的「生成中」标记会让新课堂永久显示加载骨架并禁用生成按钮。
  React.useEffect(() => {
    setSelected(null)
    setGraph(null)
    setUpdating(false)
    setProgress(null)
  }, [sessionId, setGraph, setUpdating, setProgress])

  return (
    <div data-tour="ai-class-knowledge-tree" className="flex min-h-0 flex-1 flex-col">
      {/* 居中标题 + 操作区 */}
      <div className="mb-2 flex shrink-0 flex-col items-center gap-2">
        <div className="flex items-center gap-1.5 rounded-full bg-muted/60 px-3 py-1">
          <span className="text-[11px] font-semibold tracking-tight text-foreground">资料树</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            disabled={updating || documents.length === 0}
            title="选择生成方式并构建资料树知识网络"
            className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:opacity-40"
          >
            {updating ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            <span>{edges.length > 0 ? '重新生成' : '开始生成'}</span>
          </button>
          <button
            type="button"
            onClick={() => setLargeOpen(true)}
            disabled={documents.length === 0}
            title="打开全屏知识星图"
            className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:opacity-40"
          >
            <Expand size={12} />
            <span>全屏图谱</span>
          </button>
        </div>
      </div>

      {/* 推演进度胶囊（主进程逐批广播，平滑进度条） */}
      {updating && progress ? (
        <div className="mx-auto mb-2 w-full max-w-md shrink-0 px-1">
          <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Loader2 size={11} className="animate-spin" />
              {progress.phase}
            </span>
            <span className="tabular-nums">
              {progress.percent}%（第 {progress.current}/{progress.total} 批）
            </span>
          </div>
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
        </div>
      ) : null}

      {edges.length > 0 ? (
        <div className="mb-2 flex shrink-0 flex-wrap items-center justify-center gap-1.5">
          {(Object.keys(RELATION_STYLE) as KnowledgeRelationType[]).map((type) => (
            <span key={type} className={cn('rounded-full px-1.5 py-0.5 text-[9px] font-medium', RELATION_STYLE[type].chip)}>
              {type === 'prerequisite' ? '前置' : type === 'exercise' ? '题型' : type === 'extension' ? '延伸' : '关联'}
            </span>
          ))}
          {updating ? <span className="text-[9px] text-muted-foreground">正在生成知识网络…</span> : null}
        </div>
      ) : updating ? (
        <div className="mb-2 flex shrink-0 items-center justify-center gap-1.5 text-[10px] text-muted-foreground">
          <Loader2 size={11} className="animate-spin" />
          <span>正在生成跨资料知识网络…</span>
        </div>
      ) : null}

      {/* 节点图画布（常规视图：拖拽平移 + 滚轮缩放 + 缩放控件） */}
      {documents.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-border/50 bg-muted/15 px-4 text-center">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            上传资料后，此处自动生成现代节点知识图谱；上传多份资料还将推演跨文档关联。
          </p>
        </div>
      ) : (
        <StarMapSurface camera={camera} className="rounded-xl border border-border/50 bg-muted/15">
          <GraphCanvas
            edges={edges}
            layout={layout}
            selectedId={selected?.sectionId ?? null}
            onSelect={setSelected}
            highlightQuery=""
          />
        </StarMapSurface>
      )}

      {/* 聚焦节点精要卡 */}
      {selected ? (
        <div className="mt-2 shrink-0 rounded-xl border border-primary/25 bg-primary/5 p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold text-foreground">{selected.title}</p>
              <p className="truncate text-[10px] text-muted-foreground">{selected.docName}</p>
            </div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X size={12} />
            </button>
          </div>
          <p className="mt-1.5 line-clamp-3 text-[11px] leading-relaxed text-muted-foreground">
            {selected.summary}
          </p>
          <button
            type="button"
            onClick={() => void copySectionPrompt(selected)}
            className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Sparkles size={12} />
            <span>以此节向导师提问</span>
          </button>
        </div>
      ) : null}

      <KnowledgeTreeLargeModal
        open={largeOpen}
        onOpenChange={setLargeOpen}
        edges={edges}
        layout={layout}
      />

      {/* 「开始生成」方案选择弹窗（含动态 Token 与费用测算） */}
      <AiClassGraphGenerateModal
        sessionId={sessionId}
        updating={updating}
        onConfirm={(mode) => void generate(mode)}
      />
    </div>
  )
}
