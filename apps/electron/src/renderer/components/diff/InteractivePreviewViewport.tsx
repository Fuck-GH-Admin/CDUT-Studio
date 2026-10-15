/**
 * InteractivePreviewViewport — 通用预览交互外壳（原生滚动平移 + 原生缩放代理）
 *
 * 与早期版本（整屏 CSS transform 缩放/平移）的关键区别：
 * - **不再对整屏做 CSS 缩放**：那会把 viewer 自带的工具栏、Excel 行列号栏、底部缩放条
 *   一起缩放，并把右/下滚动条推出视口。缩放一律代理给内容自身注册的原生实现
 *   （Office 的 setScale、PDF 的 pdf-zoom、图片的 useSmoothZoom…），保证只有内容区被缩放。
 * - **平移 = 原生滚动**：抓手 / 中键 / Space / Alt 拖拽时：
 *   1. 若内容注册了 `panBy`（PDF iframe 内滚动、图片平移），优先交给内容处理；
 *   2. 否则滚动「指针下最深可滚动元素」（Office/OFV 的内部滚动宿主、文本/代码外层滚动容器），
 *      表格行列号栏等固定 UI 保持不动。
 * - 内容通过 `PreviewViewportContext` 注册缩放/平移控制器；未注册的内容仅提供平移。
 *
 * 处在「选择模式」时左键不拦截事件，交给内部内容实现划词选中（引用到对话）；
 * 抓手模式下屏蔽子内容指针事件，避免拖拽时误触发内容自身的交互（如 Excel 单元格选择）。
 */

import * as React from 'react'
import { useStore } from 'jotai'
import { Hand, MousePointer2, Minus, Plus, Maximize, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { previewViewportStateMapAtom, type PreviewViewportState } from '@/atoms/preview-atoms'
import {
  PreviewViewportContext,
  type PreviewViewController,
  type PreviewViewportContextValue,
} from './preview-viewport-context'

export interface InteractivePreviewViewportProps {
  children: React.ReactNode
  className?: string
  /** 视口状态记忆键（`${sessionId}:${normalizedFilePath}`）；提供时记忆并恢复缩放与滚动 */
  memoryKey?: string
}

/**
 * 计算元素「用户可滚动手势」的两个轴各是否可滚动。
 *
 * `overflow: hidden/clip` 的元素同样是滚动容器（可编程设置 scrollTop/scrollLeft），
 * 但用户无法用手势滚动，且这类元素常是覆盖在真实滚动宿主之上的装饰层
 * （如 Excel 的 selectionOverlay / findOverlay）。若把它们当成平移目标，
 * 拖拽只会滚动装饰层自身（表现为“拖不动表格，反而拖动了选中框”）。
 * 因此仅当计算样式的 overflow 轴为 auto/scroll/overlay 且确实存在溢出时才计入。
 */
function scrollableAxes(el: HTMLElement): { x: boolean; y: boolean } {
  const style = window.getComputedStyle(el)
  const allowsUserScroll = (value: string): boolean =>
    value === 'auto' || value === 'scroll' || value === 'overlay'
  return {
    x: allowsUserScroll(style.overflowX) && el.scrollWidth > el.clientWidth + 1,
    y: allowsUserScroll(style.overflowY) && el.scrollHeight > el.clientHeight + 1,
  }
}

/** 在容器内查找「包含指定视口坐标、且最深层」的可滚动元素。 */
function findScrollableAt(container: HTMLElement, clientX: number, clientY: number): HTMLElement | null {
  let best: HTMLElement | null = null
  let bestDepth = -1
  let bestArea = Number.POSITIVE_INFINITY
  const nodes = container.querySelectorAll<HTMLElement>('*')
  for (const el of nodes) {
    const { x: canScrollX, y: canScrollY } = scrollableAxes(el)
    if (!canScrollY && !canScrollX) continue
    const rect = el.getBoundingClientRect()
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue
    let depth = 0
    for (let node: HTMLElement | null = el; node && node !== container; node = node.parentElement) depth++
    const area = rect.width * rect.height
    if (depth > bestDepth || (depth === bestDepth && area < bestArea)) {
      best = el
      bestDepth = depth
      bestArea = area
    }
  }
  return best
}

/**
 * 查找容器内「主内容滚动宿主」：可滚动且内容跨度最大者（外层包裹 > 虚拟列表内层），
 * 用于恢复上一次的滚动位置。
 */
function findPrimaryScrollable(container: HTMLElement): HTMLElement | null {
  let best: HTMLElement | null = null
  let bestSpan = 0
  const nodes = container.querySelectorAll<HTMLElement>('*')
  for (const el of nodes) {
    const { x: canScrollX, y: canScrollY } = scrollableAxes(el)
    if (!canScrollY && !canScrollX) continue
    const span = (canScrollY ? el.scrollHeight : 0) + (canScrollX ? el.scrollWidth : 0)
    if (span > bestSpan) {
      best = el
      bestSpan = span
    }
  }
  return best
}

export function InteractivePreviewViewport({
  children,
  className,
  memoryKey,
}: InteractivePreviewViewportProps): React.ReactElement {
  const store = useStore()
  const [tool, setTool] = React.useState<'select' | 'hand'>('select')
  const [spaceHeld, setSpaceHeld] = React.useState(false)
  const [isPanning, setIsPanning] = React.useState(false)
  const [controller, setController] = React.useState<PreviewViewController | null>(null)
  const [scale, setScale] = React.useState(1)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const isHoveredRef = React.useRef(false)
  const memoryKeyRef = React.useRef(memoryKey)
  memoryKeyRef.current = memoryKey
  const restoreStateRef = React.useRef<PreviewViewportState | null>(null)
  const restoredRef = React.useRef(false)
  const latestScaleRef = React.useRef(1)
  const lastScrollRef = React.useRef<{ top: number; left: number }>({ top: 0, left: 0 })
  const persistTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const panRef = React.useRef<{
    scrollEl: HTMLElement | null
    scrollLeft: number
    scrollTop: number
    startX: number
    startY: number
    lastX: number
    lastY: number
  } | null>(null)
  const toolRef = React.useRef(tool)
  toolRef.current = tool
  const controllerRef = React.useRef(controller)
  controllerRef.current = controller

  const syncScale = React.useCallback(() => {
    const next = controllerRef.current?.getScale?.()
    if (typeof next === 'number' && Number.isFinite(next)) setScale(next)
  }, [])
  const syncScaleRef = React.useRef(syncScale)
  syncScaleRef.current = syncScale

  const register = React.useCallback((next: PreviewViewController) => {
    setController(next)
    return () => setController((prev) => (prev === next ? null : prev))
  }, [])
  const reportScale = React.useCallback((value: number) => {
    if (Number.isFinite(value) && value > 0) setScale(value)
  }, [])
  const contextValue = React.useMemo<PreviewViewportContextValue>(
    () => ({ tool, register, reportScale }),
    [tool, register, reportScale],
  )

  // 控制器就绪后同步一次当前缩放
  React.useEffect(() => {
    syncScale()
  }, [controller, syncScale])

  // ===== 视口状态记忆（缩放 + 滚动）=====

  const persistState = React.useCallback(() => {
    const key = memoryKeyRef.current
    if (!key) return
    const next: PreviewViewportState = {
      scale: latestScaleRef.current,
      scrollTop: lastScrollRef.current.top,
      scrollLeft: lastScrollRef.current.left,
      updatedAt: Date.now(),
    }
    store.set(previewViewportStateMapAtom, (prev) => {
      const existing = prev.get(key)
      if (
        existing &&
        existing.scale === next.scale &&
        existing.scrollTop === next.scrollTop &&
        existing.scrollLeft === next.scrollLeft
      ) {
        return prev
      }
      const map = new Map(prev)
      map.set(key, next)
      return map
    })
  }, [store])

  const schedulePersist = React.useCallback(() => {
    if (!memoryKeyRef.current) return
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null
      persistState()
    }, 300)
  }, [persistState])

  // 切换文件时载入该文件的历史状态（滚动位置先行，缩放待控制器就绪后应用）
  React.useEffect(() => {
    restoredRef.current = false
    restoreStateRef.current = null
    if (memoryKey) {
      const saved = store.get(previewViewportStateMapAtom).get(memoryKey) ?? null
      restoreStateRef.current = saved
      lastScrollRef.current = { top: saved?.scrollTop ?? 0, left: saved?.scrollLeft ?? 0 }
    } else {
      lastScrollRef.current = { top: 0, left: 0 }
    }
  }, [memoryKey, store])

  // 内容控制器就绪后恢复缩放与滚动位置（每次挂载仅一次）
  React.useEffect(() => {
    if (!memoryKey || restoredRef.current || !controller) return
    restoredRef.current = true
    const saved = restoreStateRef.current
    if (saved && Number.isFinite(saved.scale) && saved.scale > 0) {
      controller.setScale?.(saved.scale)
      latestScaleRef.current = saved.scale
      setScale(saved.scale)
    }
    const el = containerRef.current
    if (!el || !saved || (saved.scrollTop === 0 && saved.scrollLeft === 0)) return
    let attempts = 0
    const tryRestoreScroll = (): void => {
      const target = findPrimaryScrollable(el)
      if (target) {
        target.scrollTop = saved.scrollTop
        target.scrollLeft = saved.scrollLeft
        return
      }
      if (attempts++ < 12) requestAnimationFrame(tryRestoreScroll)
    }
    requestAnimationFrame(tryRestoreScroll)
  }, [controller, memoryKey])

  // 缩放变化时记录并防抖落盘；恢复完成前不写，避免用默认 1 覆盖历史值
  React.useEffect(() => {
    latestScaleRef.current = scale
    if (memoryKey && !restoredRef.current) return
    schedulePersist()
  }, [scale, memoryKey, schedulePersist])

  // 捕获容器内任意滚动宿主的滚动事件，防抖落盘；卸载时落盘最终状态
  React.useEffect(() => {
    if (!memoryKey) return
    const el = containerRef.current
    if (!el) return
    const onScroll = (event: Event): void => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      lastScrollRef.current = { top: target.scrollTop, left: target.scrollLeft }
      schedulePersist()
    }
    el.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions)
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current)
        persistTimerRef.current = null
      }
      persistState()
    }
  }, [memoryKey, persistState, schedulePersist])

  // 空格键：仅当鼠标位于预览视口内时临时进入抓手平移，防止全局误拦截空格键
  React.useEffect(() => {
    const isEditableTarget = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null
      if (!el) return false
      const tag = el.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.code === 'Space' && isHoveredRef.current && !isEditableTarget(e.target)) {
        e.preventDefault()
        setSpaceHeld(true)
      }
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code === 'Space') setSpaceHeld(false)
    }
    const onBlur = (): void => {
      setSpaceHeld(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  const canPan = tool === 'hand' || spaceHeld

  // 抓手模式下滚轮 = 缩放（交给内容原生实现）。用原生 non-passive 监听以确保能 preventDefault。
  React.useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (event: WheelEvent): void => {
      if (toolRef.current !== 'hand') return
      const active = controllerRef.current
      if (!active) return
      event.preventDefault()
      if (event.deltaY < 0) active.zoomIn()
      else if (event.deltaY > 0) active.zoomOut()
      queueMicrotask(() => syncScaleRef.current())
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const handlePointerDown = (e: React.PointerEvent): void => {
    const isPanGesture = canPan || e.button === 1 || e.altKey
    if (!isPanGesture) return
    e.preventDefault()
    const useContentPan = Boolean(controllerRef.current?.panBy)
    const scrollEl = useContentPan ? null : findScrollableAt(e.currentTarget as HTMLElement, e.clientX, e.clientY)
    panRef.current = {
      scrollEl,
      scrollLeft: scrollEl?.scrollLeft ?? 0,
      scrollTop: scrollEl?.scrollTop ?? 0,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
    }
    setIsPanning(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const handlePointerMove = (e: React.PointerEvent): void => {
    const pan = panRef.current
    if (!pan) return
    if (controllerRef.current?.panBy) {
      const dx = e.clientX - pan.lastX
      const dy = e.clientY - pan.lastY
      pan.lastX = e.clientX
      pan.lastY = e.clientY
      if (dx !== 0 || dy !== 0) controllerRef.current.panBy(dx, dy)
      return
    }
    if (pan.scrollEl) {
      // 以「起始滚动位置 + 累计指针位移」的绝对值滚动，避免逐帧取整误差累积
      pan.scrollEl.scrollLeft = pan.scrollLeft - (e.clientX - pan.startX)
      pan.scrollEl.scrollTop = pan.scrollTop - (e.clientY - pan.startY)
    }
  }

  const handlePointerUp = (e: React.PointerEvent): void => {
    if (panRef.current) {
      panRef.current = null
      setIsPanning(false)
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  const cursorClass = isPanning ? 'cursor-grabbing' : canPan ? 'cursor-grab' : ''
  const hasZoom = Boolean(controller)

  return (
    <div
      className={cn('relative flex h-full min-h-0 flex-col overflow-hidden', className)}
      onMouseEnter={() => { isHoveredRef.current = true }}
      onMouseLeave={() => {
        isHoveredRef.current = false
        if (!panRef.current) setSpaceHeld(false)
      }}
    >
      {/* 顶部悬浮控制条 */}
      <div className="absolute right-2 top-2 z-30 flex items-center gap-0.5 rounded-lg border border-border/60 bg-background/85 px-1 py-0.5 shadow-sm backdrop-blur-sm">
        <button
          type="button"
          onClick={() => setTool((t) => (t === 'hand' ? 'select' : 'hand'))}
          className={cn('flex size-6 items-center justify-center rounded transition-colors hover:bg-muted', tool === 'hand' ? 'text-primary bg-primary/10' : 'text-muted-foreground')}
          title={tool === 'hand' ? '当前：抓手平移模式（左键拖拽滚动，滚轮缩放）' : '当前：文本选择模式（左键划选，按住 Space 或中键可拖拽平移）'}
          aria-label="切换抓手/选择模式"
        >
          {tool === 'hand' ? <Hand className="size-3.5" /> : <MousePointer2 className="size-3.5" />}
        </button>
        {hasZoom && (
          <>
            <span className="mx-0.5 h-4 w-px bg-border/70" aria-hidden="true" />
            <button
              type="button"
              onClick={() => { controller?.zoomOut(); queueMicrotask(syncScale) }}
              className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted"
              aria-label="缩小"
            >
              <Minus className="size-3.5" />
            </button>
            <span className="min-w-[38px] text-center text-[11px] tabular-nums text-muted-foreground">{Math.round(scale * 100)}%</span>
            <button
              type="button"
              onClick={() => { controller?.zoomIn(); queueMicrotask(syncScale) }}
              className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted"
              aria-label="放大"
            >
              <Plus className="size-3.5" />
            </button>
            {controller?.fit && (
              <>
                <span className="mx-0.5 h-4 w-px bg-border/70" aria-hidden="true" />
                <button
                  type="button"
                  onClick={() => { controller.fit?.(); queueMicrotask(syncScale) }}
                  className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted"
                  title="适应宽度"
                  aria-label="适应宽度"
                >
                  <Maximize className="size-3.5" />
                </button>
              </>
            )}
            {controller?.reset && (
              <button
                type="button"
                onClick={() => { controller.reset?.(); queueMicrotask(syncScale) }}
                className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted"
                title="复位视图 (100%)"
                aria-label="复位视图"
              >
                <RotateCcw className="size-3.5" />
              </button>
            )}
          </>
        )}
      </div>

      <PreviewViewportContext.Provider value={contextValue}>
        <div
          ref={containerRef}
          className={cn('relative min-h-0 flex-1 overflow-hidden touch-none', cursorClass)}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <div
            className={cn(
              'h-full w-full',
              // 平移手势进行中（或抓手模式）屏蔽子内容指针事件：既避免拖拽误触发内容自身交互
              // （如 Excel 单元格选择），也让事件落到容器上完成平移。
              (canPan || isPanning) && 'select-none pointer-events-none',
            )}
          >
            {children}
          </div>
        </div>
      </PreviewViewportContext.Provider>
    </div>
  )
}
