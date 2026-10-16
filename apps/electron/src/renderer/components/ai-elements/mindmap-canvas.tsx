/**
 * 思维导图通用画布与全屏视窗（MindMapCanvas / MindMapFullscreenModal）
 *
 * 为「AI 速课堂导图 Tab」与「对话流 ```mindmap 代码块」共用同一套渲染与视口引擎：
 *   - 场景几何：双曲 Poincaré 布局（按叶子占比切分扇区）+ 用户拖拽坐标覆盖；
 *   - 连线：径向弧线三次贝塞尔（互不相交）；
 *   - 视口：滚轮（以光标为锚点）/ 按钮缩放 + 背景拖拽平移 + 自适应复位；
 *   - 全屏大图：现代点阵毛玻璃视窗 + 悬浮胶囊工具条 + 鸟瞰小地图（支持拖拽平移）+ 气泡自由拖拽。
 */

import * as React from 'react'
import { Download, Eraser, Minus, Plus, RotateCcw, X } from 'lucide-react'
import {
  buildBezierPath,
  computeAnchorZoomPan,
  estimateMindMapNodeSize,
  flattenMindMap,
  layoutMindMap,
  type MindMapNode,
} from '@profer/shared'
import { Dialog, DialogContent, DialogTitle } from '@profer/ui/primitives/dialog'
import { cn } from '@/lib/utils'
import { useGlobalOverlay } from '@/atoms/overlay-atoms'

export const MINDMAP_ZOOM_MIN = 0.2
export const MINDMAP_ZOOM_MAX = 3

/** 画布四周留白（气泡尺寸已单独计入包围盒，此处仅作视觉呼吸区） */
const SCENE_PAD = 56

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

/** 节点半尺寸（布局估算口径，与气泡实际样式对齐） */
function halfSizeOf(label: string): { w: number; h: number } {
  const size = estimateMindMapNodeSize(label)
  return { w: size.width / 2, h: size.height / 2 }
}

/**
 * 构建场景几何：径向布局 → 归一化到左上角原点（含留白）→ 应用用户拖拽覆盖。
 *
 * 三个关键点（均为历史 Bug 的根治措施）：
 *   1. **包围盒计入气泡实际尺寸**：不能只按节点中心取 min/max，否则最外侧气泡会被画布裁切；
 *   2. **圆心取根节点实际位置**：径向切线基准必须是根气泡中心，而非布局原点（根被拖拽后仍正确）；
 *   3. **拖拽坐标夹取在画布内**：避免用户把气泡拖出画布后被裁切（同时保持偏移量稳定，不会因
 *      拖拽反过来改变其它节点位置而产生抖动反馈）。
 *
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
    // 环距与圆盘上限交由 layoutMindMap 的双约束自适应推算（线性环距，杜绝同环重叠）
    diskRadius: options.diskRadius ?? 720,
    baseRadius: options.baseRadius ?? 150,
  })

  const nodes = flattenMindMap(root)
  const halfById = new Map<string, { w: number; h: number }>()
  for (const node of nodes) halfById.set(node.id, halfSizeOf(node.label))

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [id, point] of layout) {
    const half = halfById.get(id) ?? { w: 48, h: 18 }
    minX = Math.min(minX, point.x - half.w)
    minY = Math.min(minY, point.y - half.h)
    maxX = Math.max(maxX, point.x + half.w)
    maxY = Math.max(maxY, point.y + half.h)
  }
  const offsetX = -minX + pad
  const offsetY = -minY + pad
  const width = Math.max(360, maxX - minX + pad * 2)
  const height = Math.max(280, maxY - minY + pad * 2)

  const positions = new Map<string, MindMapPt>()
  for (const [id, point] of layout) {
    const half = halfById.get(id) ?? { w: 48, h: 18 }
    const override = overrides[id]
    positions.set(
      id,
      override
        ? {
            // 夹取到画布内（保证气泡永不越界被裁切）
            x: Math.min(Math.max(override.x, half.w), Math.max(half.w, width - half.w)),
            y: Math.min(Math.max(override.y, half.h), Math.max(half.h, height - half.h)),
          }
        : { x: point.x + offsetX, y: point.y + offsetY },
    )
  }
  // 圆心 = 根节点在场景中的实际位置（径向切线基准必须跟随根气泡，而非布局原点）
  const rootPos = positions.get(root.id) ?? { x: offsetX, y: offsetY }
  return {
    positions,
    width,
    height,
    center: rootPos,
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

/**
 * 节点尺寸保底估算：首帧 DOM 尚未测量完成时使用共享口径（与布局同源），
 * 杜绝连线锚点从气泡中心 (0,0) 半径瞬间跳变到外边缘的刺眼抖动。
 */
function estimateNodeSize(text: string): BubbleHalf {
  const size = estimateMindMapNodeSize(text)
  return { w: size.width / 2, h: size.height / 2 }
}

/** 画布：连线层（SVG 径向弧线） + 气泡层（可拖拽或只读） */
export function MindMapCanvas({ root, scene, interactive, onNodePointerDown }: MindMapCanvasProps): React.ReactElement {
  const nodes = React.useMemo(() => flattenMindMap(root), [root])
  /** id → label 索引（避免连线计算时对节点数组做 O(n²) 线性查找） */
  const labelById = React.useMemo(() => {
    const map = new Map<string, string>()
    for (const node of nodes) map.set(node.id, node.label)
    return map
  }, [nodes])
  // 实测每个气泡的渲染尺寸（offsetWidth/Height 不受外层 transform 缩放影响），
  // 使连线锚点能精确落在气泡外边缘，且随文案换行自适应。
  const bubbleRefs = React.useRef<Map<string, HTMLDivElement>>(new Map())
  const sizesRef = React.useRef<Map<string, BubbleHalf>>(new Map())
  const [sizes, setSizes] = React.useState<Map<string, BubbleHalf>>(() => new Map())

  React.useLayoutEffect(() => {
    const next = new Map<string, BubbleHalf>()
    let changed = false
    for (const node of nodes) {
      const el = bubbleRefs.current.get(node.id)
      if (!el) continue
      const w = el.offsetWidth
      const h = el.offsetHeight
      next.set(node.id, { w: w / 2, h: h / 2 })
      const prev = sizesRef.current.get(node.id)
      if (!prev || prev.w !== w / 2 || prev.h !== h / 2) changed = true
    }
    // 节点数量变化（新增/删除节点）同样需要刷新
    if (next.size !== sizesRef.current.size) changed = true
    if (changed) {
      sizesRef.current = next
      setSizes(next)
    }
  }, [nodes])

  const links = React.useMemo(() => {
    const out: Array<{ key: string; d: string }> = []
    // 优先使用实测尺寸，未测量时回退到与布局同源的估算值，保证首帧锚点即接近最终位置
    const half = (id: string): BubbleHalf => sizes.get(id) ?? estimateNodeSize(labelById.get(id) ?? '')
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
              'absolute flex max-w-[160px] -translate-x-1/2 -translate-y-1/2 select-none items-center rounded-xl border px-2.5 py-1.5 text-left text-[11px] shadow-sm',
              isRoot ? 'border-primary/50 bg-primary/10 font-semibold text-primary' : 'border-border/70 bg-card text-foreground',
              interactive ? 'cursor-grab touch-none active:cursor-grabbing hover:shadow-md' : 'pointer-events-none',
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
  /** 以指定屏幕锚点（默认视口中心）为基准按倍率缩放 */
  zoomBy: (deltaFactor: number, anchorScreenPt?: { x: number; y: number }) => void
  fit: (padding?: number) => void
  onWheel: (event: React.WheelEvent) => void
  beginPan: (event: React.PointerEvent) => void
  movePan: (event: React.PointerEvent) => void
  endPan: () => void
}

/**
 * 视口控制：测量容器尺寸、首帧自适应、滚轮以光标为锚点缩放、背景拖拽平移。
 * 变换采用「左上角原点 + translate/scale」，便于精确的坐标换算。
 * zoom 与 pan 合并于单一 state（原子更新），杜绝 React 18 批处理导致的缩放漂移。
 */
export function useMindMapViewport(sceneWidth: number, sceneHeight: number, enabled = true): ViewportApi {
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const [size, setSize] = React.useState({ w: 0, h: 0 })
  const [view, setView] = React.useState<{ zoom: number; pan: MindMapPt }>({ zoom: 1, pan: { x: 0, y: 0 } })
  const panRef = React.useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null)
  const fittedRef = React.useRef(false)

  const zoom = view.zoom
  const pan = view.pan

  const setZoom = React.useCallback((valueOrUpdater: React.SetStateAction<number>) => {
    setView((prev) => ({
      ...prev,
      zoom: typeof valueOrUpdater === 'function' ? valueOrUpdater(prev.zoom) : valueOrUpdater,
    }))
  }, [])

  const setPan = React.useCallback((valueOrUpdater: React.SetStateAction<MindMapPt>) => {
    setView((prev) => ({
      ...prev,
      pan: typeof valueOrUpdater === 'function' ? valueOrUpdater(prev.pan) : valueOrUpdater,
    }))
  }, [])

  React.useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    observer.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => observer.disconnect()
  }, [])

  /** 自适应复位：按内容区留白 padding 计算等比缩放因子并居中平移 */
  const fit = React.useCallback(
    (padding = 40): void => {
      // size 尚未测量时回退到视口实测尺寸，杜绝「按钮点了没反应」
      const el = viewportRef.current
      const w = size.w > 0 ? size.w : el?.clientWidth ?? 0
      const h = size.h > 0 ? size.h : el?.clientHeight ?? 0
      if (w <= 0 || h <= 0 || sceneWidth <= 0 || sceneHeight <= 0) return
      const innerW = Math.max(1, w - padding * 2)
      const innerH = Math.max(1, h - padding * 2)
      const nextZoom = Math.min(MINDMAP_ZOOM_MAX, Math.max(MINDMAP_ZOOM_MIN, Math.min(innerW / sceneWidth, innerH / sceneHeight)))
      setView({
        zoom: nextZoom,
        pan: { x: (w - sceneWidth * nextZoom) / 2, y: (h - sceneHeight * nextZoom) / 2 },
      })
    },
    [size, sceneWidth, sceneHeight],
  )

  /** 以指定屏幕锚点（默认视口中心）为基准按倍率缩放：t' = P_anchor - (s'/s)(P_anchor - t) */
  const zoomBy = React.useCallback(
    (deltaFactor: number, anchorScreenPt?: { x: number; y: number }): void => {
      if (!enabled) return
      const rect = viewportRef.current?.getBoundingClientRect()
      const w = rect?.width ?? size.w
      const h = rect?.height ?? size.h
      const anchor = anchorScreenPt ?? { x: w / 2, y: h / 2 }
      setView((prev) => {
        const rawNext = prev.zoom * deltaFactor
        const nextZoom = Math.min(MINDMAP_ZOOM_MAX, Math.max(MINDMAP_ZOOM_MIN, rawNext))
        return computeAnchorZoomPan(prev, anchor, nextZoom)
      })
    },
    [enabled, size.w, size.h],
  )

  // 首帧（或场景尺寸变化时）自适应一次：仅在容器尺寸非零（ready）后触发
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
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12
      setView((prev) => {
        const rawNext = prev.zoom * factor
        const nextZoom = Math.min(MINDMAP_ZOOM_MAX, Math.max(MINDMAP_ZOOM_MIN, rawNext))
        return computeAnchorZoomPan(prev, { x: cx, y: cy }, nextZoom)
      })
    },
    [enabled],
  )

  const beginPan = React.useCallback(
    (event: React.PointerEvent): void => {
      if (!enabled) return
      panRef.current = { startX: event.clientX, startY: event.clientY, originX: view.pan.x, originY: view.pan.y }
    },
    [enabled, view.pan.x, view.pan.y],
  )

  const movePan = React.useCallback((event: React.PointerEvent): void => {
    const state = panRef.current
    if (!state) return
    setView((prev) => ({
      ...prev,
      pan: { x: state.originX + (event.clientX - state.startX), y: state.originY + (event.clientY - state.startY) },
    }))
  }, [])

  const endPan = React.useCallback((): void => {
    panRef.current = null
  }, [])

  return {
    viewportRef,
    zoom,
    pan,
    size,
    ready: size.w > 0 && size.h > 0,
    setZoom,
    setPan,
    zoomBy,
    fit,
    onWheel,
    beginPan,
    movePan,
    endPan,
  }
}

/** 全屏工具条按钮统一样式（毛玻璃悬浮胶囊内） */
const PILL_BUTTON =
  'flex items-center justify-center rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground'

interface FullscreenModalProps {
  root: MindMapNode
  sceneWidth: number
  sceneHeight: number
  overrides: Record<string, MindMapPt>
  scene: MindMapScene
  onOverridesChange: (next: Record<string, MindMapPt>) => void
  onPersist: (next: Record<string, MindMapPt>) => void
  onNodeClick?: (node: MindMapNode) => void
  /** 还原为自动布局（清空全部拖拽覆盖坐标）；未提供时隐藏按钮 */
  onResetOverrides?: () => void
  /** 导出 OPML 2.0 文档；未提供时隐藏按钮 */
  onExportOpml?: () => void
  onClose: () => void
}

/** 鸟瞰小地图固定尺寸 */
const MINI_W = 176
const MINI_H = 128

/**
 * 全屏大图视窗：现代点阵背景 + 悬浮胶囊工具条 + 鸟瞰小地图（拖拽红框平移视口）+ 气泡自由拖拽。
 * 点击气泡仅在「非拖拽」时触发 onNodeClick（对话流模式不传该回调 → 禁止点击副作用）。
 *
 * 关键修复：视口容器必须挂载 `ref={viewport.viewportRef}`——此前缺失导致 size 恒为 {0,0}，
 * 自适应复位 / 首帧居中 / 小地图红框 / 光标锚定缩放四大几何能力全部瘫痪。
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
  onResetOverrides,
  onExportOpml,
  onClose,
}: FullscreenModalProps): React.ReactElement {
  useGlobalOverlay(true)
  const viewport = useMindMapViewport(sceneWidth, sceneHeight)
  const dragRef = React.useRef<{ id: string; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null)
  const miniDragRef = React.useRef(false)
  const nodes = React.useMemo(() => flattenMindMap(root), [root])

  /** 原生滚轮监听清理句柄（随视口 DOM 节点挂载/卸载精确绑定解绑） */
  const wheelCleanupRef = React.useRef<(() => void) | null>(null)
  /** 以视口归一化坐标（相对视口左上角）为锚点缩放 */
  const zoomAt = React.useCallback(
    (anchor: { x: number; y: number }, deltaFactor: number): void => {
      viewport.zoomBy(deltaFactor, anchor)
    },
    [viewport.zoomBy],
  )

  /**
   * 视口节点回调 ref：DOM 落地即绑定 `{ passive: false }` 的原生滚轮监听。
   *
   * 之所以不用 useEffect 绑定：Radix Dialog 的 Portal 内容挂载时机与 effect 执行顺序
   * 存在竞态，曾出现监听未挂上导致「全屏导图完全不支持滚轮缩放」的顽固回归；
   * 回调 ref 在节点真正进入 DOM 的同一时刻执行，时序上不可能落空。
   */
  const setViewportNode = React.useCallback(
    (el: HTMLDivElement | null): void => {
      wheelCleanupRef.current?.()
      wheelCleanupRef.current = null
      // 同步写回 hook 内部 ref（其类型标注为只读，实际为可变 ref 对象）
      ;(viewport.viewportRef as React.MutableRefObject<HTMLDivElement | null>).current = el
      if (!el) return
      const handler = (event: WheelEvent): void => {
        // 必须 preventDefault：全屏视窗内滚轮只应缩放画布，不得连带滚动底层会话列表
        event.preventDefault()
        const rect = el.getBoundingClientRect()
        const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12
        zoomAt({ x: event.clientX - rect.left, y: event.clientY - rect.top }, factor)
      }
      el.addEventListener('wheel', handler, { passive: false })
      wheelCleanupRef.current = () => el.removeEventListener('wheel', handler)
    },
    [viewport.viewportRef, zoomAt],
  )

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
    if (miniDragRef.current) {
      panToMiniPoint(event)
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
    miniDragRef.current = false
    viewport.endPan()
  }

  /** 小地图 → 场景坐标换算（红框拖拽 / 点击定位共用） */
  const miniScale = Math.min(MINI_W / sceneWidth, MINI_H / sceneHeight)
  const miniOffsetX = (MINI_W - sceneWidth * miniScale) / 2
  const miniOffsetY = (MINI_H - sceneHeight * miniScale) / 2
  const panToMiniPoint = (event: React.PointerEvent): void => {
    const el = viewport.viewportRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    // 小地图容器锚定在视口右下角（right/bottom-16 + p-1 内边距 4px），相对视口求出小地图原点
    const miniLeft = rect.width - (MINI_W + 20) + miniOffsetX
    const miniTop = rect.height - (MINI_H + 20) + miniOffsetY
    const sceneX = (event.clientX - rect.left - miniLeft) / miniScale
    const sceneY = (event.clientY - rect.top - miniTop) / miniScale
    viewport.setPan({
      x: rect.width / 2 - sceneX * viewport.zoom,
      y: rect.height / 2 - sceneY * viewport.zoom,
    })
  }

  // 鸟瞰小地图可视矩形：严格由视口 size/pan/zoom 反投影到小地图坐标系
  const viewW = viewport.size.w
  const viewH = viewport.size.h
  const viewRect = {
    x: miniOffsetX + (-viewport.pan.x / viewport.zoom) * miniScale,
    y: miniOffsetY + (-viewport.pan.y / viewport.zoom) * miniScale,
    w: (viewW / viewport.zoom) * miniScale,
    h: (viewH / viewport.zoom) * miniScale,
  }

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose() }}>
      {/* 严禁追加 `relative`：会覆盖基类 `fixed` 定位，使弹窗脱离视口居中而漂到屏幕外
          （历史 Bug：全屏导图窗口错位、默认不居中、自适应复位看似失效） */}
      <DialogContent
        hideClose
        overlayClassName="bg-black/70 backdrop-blur-sm"
        className="grid h-[88vh] w-[90vw] max-w-none grid-rows-[minmax(0,1fr)] gap-0 overflow-hidden rounded-2xl border-border/60 bg-card/95 p-0 shadow-2xl backdrop-blur-xl"
      >
        <DialogTitle className="sr-only">思维导图大图：{root.label}</DialogTitle>

        {/* 视口容器：ref 由回调 ref 接管（同步写回 viewportRef 并绑定原生滚轮监听）。
            滚轮为双保险：原生非被动监听负责 preventDefault，React onWheel 作为兜底，
            后者据 defaultPrevented 跳过以避免双重缩放。 */}
        <div
          ref={setViewportNode}
          className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden overscroll-contain bg-content-area select-none active:cursor-grabbing"
          onWheel={(event) => {
            if (event.nativeEvent.defaultPrevented) return
            const rect = event.currentTarget.getBoundingClientRect()
            const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12
            zoomAt({ x: event.clientX - rect.left, y: event.clientY - rect.top }, factor)
          }}
          onPointerDown={viewport.beginPan}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        >
          {/* 现代点阵网格底层（主题自适应） */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 text-muted-foreground opacity-[0.25] dark:opacity-[0.18]"
            style={{
              backgroundImage: 'radial-gradient(circle, currentColor 1px, transparent 1px)',
              backgroundSize: '24px 24px',
            }}
          />

          {/* 变换层：思维导图画布 */}
          <div
            className="absolute left-0 top-0 origin-top-left text-foreground"
            style={{ transform: `translate(${viewport.pan.x}px, ${viewport.pan.y}px) scale(${viewport.zoom})` }}
          >
            <MindMapCanvas root={root} scene={scene} interactive onNodePointerDown={onBubblePointerDown} />
          </div>

          {/* 悬浮标题胶囊（左上角） */}
          <div className="pointer-events-none absolute left-4 top-3 max-w-[40%]">
            <span className="inline-flex max-w-full items-center gap-1.5 truncate rounded-full border border-border/50 bg-background/80 px-3 py-1 text-[11px] font-medium text-foreground shadow-sm backdrop-blur-sm">
              🗺️ <span className="truncate">{root.label}</span>
            </span>
          </div>

          {/* 悬浮胶囊工具条（顶部居中，替代传统生硬顶栏） */}
          <div className="absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-0.5 rounded-xl border border-border/50 bg-background/85 p-1 shadow-lg backdrop-blur-md">
            <button
              type="button"
              title="点击重置为 100%"
              onClick={() => {
                // 以视口中心为锚点精确回到 100%（zoomBy 的倍率换算保证锚点画面稳定）
                viewport.zoomBy(1 / viewport.zoom)
              }}
              className="min-w-[46px] rounded-lg px-1.5 py-1 text-center text-[11px] tabular-nums text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
            >
              {Math.round(viewport.zoom * 100)}%
            </button>
            <button type="button" className={PILL_BUTTON} title="缩小" onClick={() => viewport.zoomBy(1 / 1.15)}>
              <Minus size={15} />
            </button>
            <button type="button" className={PILL_BUTTON} title="放大" onClick={() => viewport.zoomBy(1.15)}>
              <Plus size={15} />
            </button>
            <button type="button" className={PILL_BUTTON} title="自适应居中" onClick={() => viewport.fit()}>
              <RotateCcw size={15} />
            </button>
            {onResetOverrides && (
              <button type="button" className={PILL_BUTTON} title="重置节点布局" onClick={onResetOverrides}>
                <Eraser size={15} />
              </button>
            )}
            {onExportOpml && (
              <button type="button" className={PILL_BUTTON} title="导出 OPML" onClick={onExportOpml}>
                <Download size={15} />
              </button>
            )}
            <button type="button" className={PILL_BUTTON} title="关闭（ESC）" onClick={onClose}>
              <X size={15} />
            </button>
          </div>

          {/* 鸟瞰小地图：红框严格对应可视区域，支持拖拽红框双向平移 */}
          <div
            className="absolute bottom-4 right-4 cursor-pointer rounded-lg border border-border/70 bg-card/85 p-1 shadow-md backdrop-blur-sm"
            style={{ width: MINI_W + 8, height: MINI_H + 8 }}
            onPointerDown={(event) => {
              event.stopPropagation()
              miniDragRef.current = true
              panToMiniPoint(event)
            }}
            onPointerUp={() => {
              miniDragRef.current = false
            }}
          >
            <svg width={MINI_W} height={MINI_H} className="pointer-events-none block">
              <g transform={`translate(${miniOffsetX} ${miniOffsetY}) scale(${miniScale})`}>
                {nodes.map((node) => {
                  const point = scene.positions.get(node.id)
                  if (!point) return null
                  return <circle key={node.id} cx={point.x} cy={point.y} r={7} className="fill-primary/60" />
                })}
              </g>
              <rect
                x={viewRect.x}
                y={viewRect.y}
                width={Math.max(4, viewRect.w)}
                height={Math.max(4, viewRect.h)}
                className="fill-primary/10 stroke-foreground/70"
                strokeWidth={1}
                rx={2}
              />
            </svg>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
