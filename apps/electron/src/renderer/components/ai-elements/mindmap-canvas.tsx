/**
 * 思维导图通用画布与全屏视窗（MindMapCanvas / MindMapFullscreenModal）
 *
 * 为「AI 速课堂导图 Tab」与「对话流 ```mindmap 代码块」共用同一套渲染与视口引擎：
 *   - 场景几何：双曲 Poincaré 布局（按叶子占比切分扇区）+ 用户拖拽坐标覆盖；
 *   - 连线：径向弧线三次贝塞尔（互不相交）；
 *   - 视口：滚轮（以光标为锚点）/ 按钮缩放 + 背景拖拽平移 + 自适应复位；
 *   - 全屏大图：鸟瞰小地图（Bird's-Eye View Minimap）+ 气泡自由拖拽。
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { Minus, Plus, RotateCcw, X } from 'lucide-react'
import { buildBezierPath, flattenMindMap, layoutMindMap, type MindMapNode } from '@profer/shared'
import { Z_LAYER } from '@profer/ui'
import { cn } from '@/lib/utils'
import { useGlobalOverlay } from '@/atoms/overlay-atoms'

export const MINDMAP_ZOOM_MIN = 0.2
export const MINDMAP_ZOOM_MAX = 3

const SCENE_PAD = 150

export interface MindMapPt {
  x: number
  y: number
}

/** 场景几何：归一化画布尺寸 + 节点坐标 + 圆盘中心（径向连线基准） */
export interface MindMapScene {
  positions: Map<string, MindMapPt>
  width: number
  height: number
  center: MindMapPt
}

/**
 * 构建场景几何：双曲布局 → 归一化到左上角原点（含留白）→ 应用用户拖拽覆盖。
 * `overrides` 使用场景绝对坐标（与拖拽落点一致）。
 */
export function buildMindMapScene(
  root: MindMapNode,
  overrides: Record<string, MindMapPt>,
  options: { diskRadius?: number; baseRadius?: number; scale?: number; pad?: number } = {},
): MindMapScene {
  const pad = options.pad ?? SCENE_PAD
  const layout = layoutMindMap(root, {
    centerX: 0,
    centerY: 0,
    // 增大首环半径与压缩尺度：保证第一层子分支有足够弧长排布宽气泡，避免紧密堆叠
    diskRadius: options.diskRadius ?? 460,
    baseRadius: options.baseRadius ?? 300,
    scale: options.scale ?? 1000,
  })
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of layout.values()) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }
  const offsetX = -minX + pad
  const offsetY = -minY + pad
  const positions = new Map<string, MindMapPt>()
  for (const [id, point] of layout) {
    const override = overrides[id]
    positions.set(id, override ?? { x: point.x + offsetX, y: point.y + offsetY })
  }
  return {
    positions,
    width: Math.max(360, maxX - minX + pad * 2),
    height: Math.max(280, maxY - minY + pad * 2),
    center: { x: offsetX, y: offsetY },
  }
}

interface MindMapCanvasProps {
  root: MindMapNode
  scene: MindMapScene
  /** 是否可交互（拖拽气泡）。false 时整层 pointer-events:none 只读 */
  interactive: boolean
  onNodePointerDown?: (event: React.PointerEvent, nodeId: string) => void
}

/** 气泡半尺寸（用于连线锚点：由中心外移到气泡边缘） */
interface BubbleHalf {
  w: number
  h: number
}

/**
 * 计算连线在气泡外边缘的锚点：沿「气泡中心 → 对方中心」方向求与气泡外接矩形的交点，
 * 即该方向上距离对方最近的外边缘点，天然自适应且不侵入气泡，避免与气泡内文字重叠。
 */
function edgeAnchor(center: MindMapPt, half: BubbleHalf, toward: MindMapPt): MindMapPt {
  const dx = toward.x - center.x
  const dy = toward.y - center.y
  const adx = Math.abs(dx)
  const ady = Math.abs(dy)
  if (adx < 0.5 && ady < 0.5) return center
  const tx = adx > 0.001 ? half.w / adx : Number.POSITIVE_INFINITY
  const ty = ady > 0.001 ? half.h / ady : Number.POSITIVE_INFINITY
  const t = Math.min(tx, ty)
  if (!Number.isFinite(t) || t <= 0) return center
  return { x: center.x + dx * t, y: center.y + dy * t }
}

/** 画布：连线层（SVG 径向弧线） + 气泡层（可拖拽或只读） */
export function MindMapCanvas({ root, scene, interactive, onNodePointerDown }: MindMapCanvasProps): React.ReactElement {
  const nodes = React.useMemo(() => flattenMindMap(root), [root])
  // 实测每个气泡的渲染尺寸（offsetWidth/Height 不受外层 transform 缩放影响），
  // 使连线锚点能精确落在气泡外边缘，且随文案换行自适应。
  const bubbleRefs = React.useRef<Map<string, HTMLDivElement>>(new Map())
  const sizesRef = React.useRef<Map<string, BubbleHalf>>(new Map())
  const [sizes, setSizes] = React.useState<Map<string, BubbleHalf>>(() => new Map())

  React.useLayoutEffect(() => {
    const next = new Map<string, BubbleHalf>()
    let changed = next.size !== sizesRef.current.size
    for (const node of nodes) {
      const el = bubbleRefs.current.get(node.id)
      if (!el) continue
      const w = el.offsetWidth
      const h = el.offsetHeight
      next.set(node.id, { w: w / 2, h: h / 2 })
      const prev = sizesRef.current.get(node.id)
      if (!prev || prev.w !== w / 2 || prev.h !== h / 2) changed = true
    }
    if (changed) {
      sizesRef.current = next
      setSizes(next)
    }
  }, [nodes])

  const links = React.useMemo(() => {
    const out: Array<{ key: string; d: string }> = []
    const half = (id: string): BubbleHalf => sizes.get(id) ?? { w: 0, h: 0 }
    const walk = (node: MindMapNode): void => {
      const from = scene.positions.get(node.id)
      if (from) {
        for (const child of node.children ?? []) {
          const to = scene.positions.get(child.id)
          if (to) {
            // 端点由气泡中心外移到外边缘锚点（最短距离、无交叉的自适应切线）
            const start = edgeAnchor(from, half(node.id), to)
            const end = edgeAnchor(to, half(child.id), from)
            out.push({
              key: `${node.id}->${child.id}`,
              d: buildBezierPath({ ...start, depth: 0, angle: 0 }, { ...end, depth: 1, angle: 0 }, scene.center),
            })
          }
        }
      }
      for (const child of node.children ?? []) walk(child)
    }
    walk(root)
    return out
  }, [root, scene, sizes])

  return (
    <div className="relative" style={{ width: scene.width, height: scene.height }}>
      <svg width={scene.width} height={scene.height} className="pointer-events-none absolute inset-0">
        {links.map((link) => (
          <path key={link.key} d={link.d} fill="none" stroke="currentColor" strokeWidth={1.5} className="text-primary/35" />
        ))}
      </svg>
      {nodes.map((node) => {
        const point = scene.positions.get(node.id)
        if (!point) return null
        const isRoot = node.id === root.id
        return (
          <div
            key={node.id}
            ref={(el) => {
              if (el) bubbleRefs.current.set(node.id, el)
              else bubbleRefs.current.delete(node.id)
            }}
            onPointerDown={interactive && onNodePointerDown ? (event) => onNodePointerDown(event, node.id) : undefined}
            className={cn(
              'absolute flex max-w-[160px] -translate-x-1/2 -translate-y-1/2 items-center rounded-xl border px-2.5 py-1.5 text-left text-[11px] shadow-sm',
              isRoot ? 'border-primary/50 bg-primary/10 font-semibold text-primary' : 'border-border/70 bg-card text-foreground',
              interactive ? 'cursor-grab touch-none select-none active:cursor-grabbing hover:shadow-md' : 'pointer-events-none',
            )}
            style={{ left: point.x, top: point.y }}
            title={node.notes || node.label}
          >
            <span className="whitespace-normal leading-snug">{node.label}</span>
          </div>
        )
      })}
    </div>
  )
}

export interface ViewportApi {
  viewportRef: React.RefObject<HTMLDivElement>
  zoom: number
  pan: MindMapPt
  size: { w: number; h: number }
  ready: boolean
  setZoom: React.Dispatch<React.SetStateAction<number>>
  setPan: React.Dispatch<React.SetStateAction<MindMapPt>>
  fit: () => void
  onWheel: (event: React.WheelEvent) => void
  beginPan: (event: React.PointerEvent) => void
  movePan: (event: React.PointerEvent) => void
  endPan: () => void
}

/**
 * 视口控制：测量容器尺寸、首帧自适应、滚轮以光标为锚点缩放、背景拖拽平移。
 * 变换采用「左上角原点 + translate/scale」，便于精确的坐标换算。
 */
export function useMindMapViewport(sceneWidth: number, sceneHeight: number, enabled = true): ViewportApi {
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const [size, setSize] = React.useState({ w: 0, h: 0 })
  const [zoom, setZoom] = React.useState(1)
  const [pan, setPan] = React.useState<MindMapPt>({ x: 0, y: 0 })
  const panRef = React.useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null)
  const fittedRef = React.useRef(false)

  React.useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    observer.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => observer.disconnect()
  }, [])

  const fit = React.useCallback(() => {
    if (size.w <= 0 || size.h <= 0 || sceneWidth <= 0 || sceneHeight <= 0) return
    const nextZoom = Math.min(size.w / sceneWidth, size.h / sceneHeight) * 0.92
    const clamped = Math.min(MINDMAP_ZOOM_MAX, Math.max(MINDMAP_ZOOM_MIN, nextZoom))
    setZoom(clamped)
    setPan({ x: (size.w - sceneWidth * clamped) / 2, y: (size.h - sceneHeight * clamped) / 2 })
  }, [size, sceneWidth, sceneHeight])

  // 首帧（或场景尺寸变化时）自适应一次
  React.useEffect(() => {
    fittedRef.current = false
  }, [sceneWidth, sceneHeight])

  React.useEffect(() => {
    if (size.w > 0 && size.h > 0 && !fittedRef.current) {
      fittedRef.current = true
      fit()
    }
  }, [size, fit])

  const onWheel = React.useCallback(
    (event: React.WheelEvent): void => {
      if (!enabled) return
      event.preventDefault()
      const rect = viewportRef.current?.getBoundingClientRect()
      const cx = rect ? event.clientX - rect.left : 0
      const cy = rect ? event.clientY - rect.top : 0
      setZoom((prevZoom) => {
        const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12
        const nextZoom = Math.min(MINDMAP_ZOOM_MAX, Math.max(MINDMAP_ZOOM_MIN, prevZoom * factor))
        const k = nextZoom / prevZoom
        setPan((prevPan) => ({ x: cx - k * (cx - prevPan.x), y: cy - k * (cy - prevPan.y) }))
        return nextZoom
      })
    },
    [enabled],
  )

  const beginPan = React.useCallback(
    (event: React.PointerEvent): void => {
      if (!enabled) return
      panRef.current = { startX: event.clientX, startY: event.clientY, originX: pan.x, originY: pan.y }
    },
    [enabled, pan.x, pan.y],
  )

  const movePan = React.useCallback((event: React.PointerEvent): void => {
    const state = panRef.current
    if (!state) return
    setPan({ x: state.originX + (event.clientX - state.startX), y: state.originY + (event.clientY - state.startY) })
  }, [])

  const endPan = React.useCallback((): void => {
    panRef.current = null
  }, [])

  return { viewportRef, zoom, pan, size, ready: size.w > 0 && size.h > 0, setZoom, setPan, fit, onWheel, beginPan, movePan, endPan }
}

interface FullscreenModalProps {
  root: MindMapNode
  sceneWidth: number
  sceneHeight: number
  overrides: Record<string, MindMapPt>
  scene: MindMapScene
  onOverridesChange: (next: Record<string, MindMapPt>) => void
  onPersist: (next: Record<string, MindMapPt>) => void
  onNodeClick?: (node: MindMapNode) => void
  onClose: () => void
}

/**
 * 全屏大图视窗：滚轮/按钮平移缩放 + 鸟瞰小地图 + 气泡自由拖拽。
 * 点击气泡仅在「非拖拽」时触发 onNodeClick（对话流模式不传该回调 → 禁止点击副作用）。
 */
export function MindMapFullscreenModal({
  root,
  sceneWidth,
  sceneHeight,
  overrides,
  scene,
  onOverridesChange,
  onPersist,
  onNodeClick,
  onClose,
}: FullscreenModalProps): React.ReactElement {
  useGlobalOverlay(true)
  const viewport = useMindMapViewport(sceneWidth, sceneHeight)
  const dragRef = React.useRef<{ id: string; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null)
  const nodes = React.useMemo(() => flattenMindMap(root), [root])

  const onBubblePointerDown = (event: React.PointerEvent, nodeId: string): void => {
    event.stopPropagation()
    const origin = scene.positions.get(nodeId) ?? { x: 0, y: 0 }
    dragRef.current = { id: nodeId, startX: event.clientX, startY: event.clientY, originX: origin.x, originY: origin.y, moved: false }
    ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent): void => {
    if (dragRef.current) {
      const drag = dragRef.current
      const dx = (event.clientX - drag.startX) / viewport.zoom
      const dy = (event.clientY - drag.startY) / viewport.zoom
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true
      onOverridesChange({ ...overrides, [drag.id]: { x: Math.round(drag.originX + dx), y: Math.round(drag.originY + dy) } })
      return
    }
    viewport.movePan(event)
  }

  const onPointerUp = (): void => {
    if (dragRef.current) {
      const drag = dragRef.current
      dragRef.current = null
      if (drag.moved) onPersist(overrides)
      else if (onNodeClick) onNodeClick(nodes.find((n) => n.id === drag.id) ?? root)
      return
    }
    viewport.endPan()
  }

  // 鸟瞰小地图几何
  const MINI_W = 176
  const MINI_H = 128
  const miniScale = Math.min(MINI_W / sceneWidth, MINI_H / sceneHeight)
  const miniOffsetX = (MINI_W - sceneWidth * miniScale) / 2
  const miniOffsetY = (MINI_H - sceneHeight * miniScale) / 2
  const viewW = viewport.size.w
  const viewH = viewport.size.h
  const viewRect = {
    x: miniOffsetX + (-viewport.pan.x / viewport.zoom) * miniScale,
    y: miniOffsetY + (-viewport.pan.y / viewport.zoom) * miniScale,
    w: (viewW / viewport.zoom) * miniScale,
    h: (viewH / viewport.zoom) * miniScale,
  }

  return createPortal(
    <div className={`fixed inset-0 ${Z_LAYER.fullscreen} flex flex-col bg-background/95 backdrop-blur-md`} role="dialog" aria-modal="true" aria-label="思维导图大图">
      <div className="flex shrink-0 items-center justify-between border-b border-border/50 px-4 py-2 text-foreground">
        <span className="truncate text-xs font-medium">{root.label}</span>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => viewport.setZoom((z) => Math.max(MINDMAP_ZOOM_MIN, z / 1.15))} className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" title="缩小">
            <Minus size={15} />
          </button>
          <span className="w-12 text-center text-[11px] text-muted-foreground">{Math.round(viewport.zoom * 100)}%</span>
          <button type="button" onClick={() => viewport.setZoom((z) => Math.min(MINDMAP_ZOOM_MAX, z * 1.15))} className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" title="放大">
            <Plus size={15} />
          </button>
          <button type="button" onClick={viewport.fit} className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" title="自适应复位">
            <RotateCcw size={15} />
          </button>
          <button type="button" onClick={onClose} className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" title="关闭">
            <X size={15} />
          </button>
        </div>
      </div>

      <div
        className="relative min-h-0 flex-1 cursor-grab overflow-hidden bg-content-area active:cursor-grabbing"
        onWheel={viewport.onWheel}
        onPointerDown={viewport.beginPan}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <div className="absolute left-0 top-0 origin-top-left text-foreground" style={{ transform: `translate(${viewport.pan.x}px, ${viewport.pan.y}px) scale(${viewport.zoom})` }}>
          <MindMapCanvas root={root} scene={scene} interactive onNodePointerDown={onBubblePointerDown} />
        </div>

        <div className="pointer-events-none absolute bottom-4 right-4 rounded-lg border border-border/70 bg-card/85 p-1 shadow-sm" style={{ width: MINI_W + 8, height: MINI_H + 8 }}>
          <svg width={MINI_W} height={MINI_H}>
            <g transform={`translate(${miniOffsetX} ${miniOffsetY}) scale(${miniScale})`}>
              {nodes.map((node) => {
                const point = scene.positions.get(node.id)
                if (!point) return null
                return <circle key={node.id} cx={point.x} cy={point.y} r={7} className="fill-primary/60" />
              })}
            </g>
            <rect x={viewRect.x} y={viewRect.y} width={Math.max(4, viewRect.w)} height={Math.max(4, viewRect.h)} className="fill-none stroke-foreground/70" strokeWidth={1} rx={2} />
          </svg>
        </div>
      </div>
    </div>,
    document.body,
  )
}
