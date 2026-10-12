/**
 * Vite dev 时 renderer 位于 http://localhost:5174/index.html，打包后位于
 * file:///.../renderer/index.html。必须相对页面而非本 TS 模块路径解析，否则
 * 动态 import 会错误命中 /src/.../office-preview/vendor，触发旧 HTML fallback。
 * 延迟读取 location，使路由/缩放纯函数也能在 Node 测试环境中加载。
 */
function vendorBase(): string {
  if (typeof window === 'undefined') return './vendor/ooxml'
  return new URL('./vendor/ooxml', window.location.href).href.replace(/\/$/, '')
}

export type OfficeFormat = 'docx' | 'xlsx' | 'pptx'

interface WasmManifest {
  docx?: string
  xlsx?: string
  pptx?: string
}

interface ZoomableViewer {
  load(source: string | ArrayBuffer): Promise<void>
  destroy(): void
  getScale?: () => number
  setScale?: (scale: number) => void
  fitWidth?: () => void
  fitPage?: () => void
  scrollToSlide?: (index: number, options?: { behavior?: 'auto' | 'smooth' }) => void
  scrollToPage?: (index: number, options?: { behavior?: 'auto' | 'smooth' }) => void
  goToSheet?: (index: number) => Promise<void>
  select?: (ref: string) => void
  setSelectionColor?: (color: string) => void
  sheetNames?: string[]
  slideCount?: number
  pageCount?: number
  sheetCount?: number
}

interface ScrollViewerOptions {
  wasmUrl?: string
  enableTextSelection?: boolean
  zoomMin?: number
  zoomMax?: number
  onError?: (error: Error) => void
  onScaleChange?: (scale: number) => void
  onVisibleSlideChange?: (index: number, total: number) => void
}

interface ViewerModule {
  new (container: HTMLElement, options?: ScrollViewerOptions): ZoomableViewer
}

interface OoxmlModule {
  DocxScrollViewer?: ViewerModule
  PptxScrollViewer?: ViewerModule
  XlsxViewer?: ViewerModule
}

let manifestPromise: Promise<WasmManifest> | null = null
const modulePromises = new Map<OfficeFormat, Promise<OoxmlModule>>()

function modulePath(format: OfficeFormat): string {
  return `${vendorBase()}/${format}.mjs`
}

function rawWasmName(format: OfficeFormat): string {
  return `${format}_parser_bg.wasm`
}

const DOCX_FAMILY_EXTS = new Set(['docx', 'docm', 'dotx', 'dotm'])
const XLSX_FAMILY_EXTS = new Set(['xlsx', 'xlsm', 'xltx', 'xltm'])
const PPTX_FAMILY_EXTS = new Set(['pptx', 'pptm', 'potx', 'potm', 'ppsx', 'ppsm'])

export function normalizeOfficeFormat(fileName: string): OfficeFormat | null {
  const extension = fileName.split('.').pop()?.toLowerCase() ?? ''
  if (DOCX_FAMILY_EXTS.has(extension)) return 'docx'
  if (XLSX_FAMILY_EXTS.has(extension)) return 'xlsx'
  if (PPTX_FAMILY_EXTS.has(extension)) return 'pptx'
  return null
}

export function clampOfficeScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1
  return Math.min(4, Math.max(0.25, scale))
}

async function loadManifest(): Promise<WasmManifest> {
  if (!manifestPromise) {
    manifestPromise = import(/* @vite-ignore */ `${vendorBase()}/wasm-manifest.mjs`)
      .then((module) => (module.default ?? {}) as WasmManifest)
      .catch(() => ({}))
  }
  return manifestPromise
}

async function loadModule(format: OfficeFormat): Promise<OoxmlModule> {
  let promise = modulePromises.get(format)
  if (!promise) {
    promise = import(/* @vite-ignore */ modulePath(format)).catch((error: unknown) => {
      modulePromises.delete(format)
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`加载 Silurus ${format.toUpperCase()} 模块失败: ${message}`)
    })
    modulePromises.set(format, promise)
  }
  return promise
}

function getViewerConstructor(format: OfficeFormat, module: OoxmlModule): ViewerModule {
  const Viewer = format === 'docx' ? module.DocxScrollViewer : format === 'pptx' ? module.PptxScrollViewer : module.XlsxViewer
  if (!Viewer) throw new Error(`Silurus 未提供 ${format.toUpperCase()} viewer`)
  return Viewer
}

export async function createOfficeViewer(
  format: OfficeFormat,
  container: HTMLElement,
  source: string,
  onScaleChange?: (scale: number) => void,
  onError?: (error: Error) => void,
  onVisibleSlideChange?: (index: number, total: number) => void,
): Promise<ZoomableViewer> {
  const [module, manifest] = await Promise.all([loadModule(format), loadManifest()])
  const Viewer = getViewerConstructor(format, module)
  let loadError: Error | null = null
  const viewer = new Viewer(container, {
    wasmUrl: `${vendorBase()}/${manifest[format] ?? rawWasmName(format)}`,
    enableTextSelection: true,
    // XLSX 的原生 slider 支持连续 input；放宽范围以便精细查看大表或概览。
    ...(format === 'xlsx' ? { zoomMin: 0.1, zoomMax: 8 } : {}),
    onScaleChange,
    onError: (error) => {
      loadError = error
      onError?.(error)
    },
    onVisibleSlideChange,
  })
  await viewer.load(source)
  if (loadError) {
    viewer.destroy()
    throw loadError
  }
  return viewer
}

export function destroyOfficeViewer(viewer: ZoomableViewer | null): void {
  try {
    viewer?.destroy()
  } catch {
    // Viewer teardown is best effort; an already detached worker must not break unmount.
  }
}

interface RenderedPptxSlot {
  canvas?: HTMLCanvasElement
  renderedSlide?: number
  renderedScale?: number
}

/**
 * 返回当前正式 PptxScrollViewer 中已经完成像素渲染的目标页 canvas。
 * Silurus 0.71 暂无公开 capture/wait API；访问 `_slots` 被严格封装在此桥接层，
 * 并同时验证 renderedSlide/renderedScale，避免虚拟列表复用 canvas 时抓到上一页旧帧。
 */
export function getRenderedPptxSlideCanvas(viewer: ZoomableViewer, slideIndex: number): HTMLCanvasElement | null {
  const slots = (viewer as unknown as { _slots?: Map<number, RenderedPptxSlot> })._slots
  const slot = slots?.get(slideIndex)
  if (!slot?.canvas || slot.renderedSlide !== slideIndex || (slot.renderedScale ?? -1) < 0) return null
  return slot.canvas.isConnected ? slot.canvas : null
}

export interface OfficeSpotlightTarget {
  format: OfficeFormat
  pageNumber: number
  bbox?: [number, number, number, number]
  cellRef?: string
  label?: string
}

const SPOTLIGHT_STYLE_ID = 'profer-office-spotlight-style'

function ensureSpotlightStyle(): void {
  if (typeof document === 'undefined' || document.getElementById(SPOTLIGHT_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = SPOTLIGHT_STYLE_ID
  style.textContent = `
    @keyframes proferOfficeSpotlightPulse {
      0% {
        box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.55), 0 4px 18px rgba(245, 158, 11, 0.25);
        background-color: rgba(245, 158, 11, 0.24);
      }
      50% {
        box-shadow: 0 0 0 6px rgba(245, 158, 11, 0), 0 6px 22px rgba(245, 158, 11, 0.32);
        background-color: rgba(245, 158, 11, 0.14);
      }
      100% {
        box-shadow: 0 0 0 0 rgba(245, 158, 11, 0), 0 4px 14px rgba(245, 158, 11, 0.18);
        background-color: rgba(245, 158, 11, 0.16);
      }
    }
    .office-bbox-spotlight {
      position: absolute;
      pointer-events: none;
      z-index: 25;
      border: 2px solid #f59e0b;
      border-radius: 6px;
      background-color: rgba(245, 158, 11, 0.16);
      animation: proferOfficeSpotlightPulse 1.6s ease-out 3;
      transition: all 0.2s ease-out;
    }
    .office-bbox-spotlight-badge {
      position: absolute;
      top: -22px;
      left: -2px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 1px 8px;
      border-radius: 9999px;
      background: #f59e0b;
      color: #ffffff;
      font-size: 11px;
      font-weight: 600;
      line-height: 18px;
      white-space: nowrap;
      box-shadow: 0 2px 6px rgba(245, 158, 11, 0.35);
    }
  `
  document.head.appendChild(style)
}

function parseA1CellAddress(ref: string): { row: number; col: number } | null {
  const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(ref.trim())
  if (!m) return null
  const letters = m[1]!.toUpperCase()
  const row = Number.parseInt(m[2]!, 10)
  if (!Number.isFinite(row) || row < 1) return null
  let col = 0
  for (let i = 0; i < letters.length; i++) {
    col = col * 26 + (letters.charCodeAt(i) - 64)
  }
  return { row, col }
}

/** 等待下一帧（rAF 优先，无 rAF 环境回退 setTimeout）。 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve())
    } else {
      setTimeout(resolve, 16)
    }
  })
}

/** 等待指定毫秒（用于 Silurus 异步布局/虚拟渲染的多帧递增轮询）。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 多帧递增轮询：按给定毫秒间隔依次等待，直到 `predicate` 返回非空值。
 *
 * Silurus 的 XLSX 虚拟化表格在复杂样式或多行数据下，网格 DOM/Canvas 测量需要
 * 2~3 帧，单次 `await nextFrame()` 常返回 `null` 或 `width=0`，导致高亮框被静默丢弃。
 */
async function pollFrames<T>(predicate: () => T | null, delaysMs: readonly number[]): Promise<T | null> {
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    const value = predicate()
    if (value) return value
    if (attempt < delaysMs.length) await delay(delaysMs[attempt]!)
  }
  return null
}

/** 将元素的定位上下文设为 relative（仅在当前为 static 时，避免覆盖已有的 absolute/relative）。 */
function ensurePositioned(el: HTMLElement): void {
  if (typeof window !== 'undefined' && window.getComputedStyle(el).position === 'static') {
    el.style.position = 'relative'
  }
}

/**
 * 测量目标页 canvas 相对其槽 wrapper 的布局偏移与页面尺寸（均为 layout px，
 * 不受 InteractivePreviewViewport 外层 CSS transform 缩放影响）。
 * 归一化 bbox 必须落到页面画布上，而不是被当作 wrapper 的百分比——
 * 当 wrapper 与页之间存在 padding / 居中留白时，百分比会让高亮框跑偏。
 */
function measureSlotPageBox(
  wrapper: HTMLElement,
  canvas: HTMLCanvasElement | undefined,
): { left: number; top: number; width: number; height: number } {
  const wrapperWidth = wrapper.clientWidth
  const wrapperHeight = wrapper.clientHeight
  if (!canvas) {
    return { left: 0, top: 0, width: wrapperWidth, height: wrapperHeight }
  }
  // 外层可能带 transform scale：rect 宽度 / offsetWidth 即当前缩放系数，用于还原为 layout px。
  const wrapperOffsetWidth = wrapper.offsetWidth
  const rawScale = wrapperOffsetWidth > 0 ? wrapper.getBoundingClientRect().width / wrapperOffsetWidth : 1
  const scale = rawScale > 0 ? rawScale : 1
  const wrapperRect = wrapper.getBoundingClientRect()
  const canvasRect = canvas.getBoundingClientRect()
  return {
    left: (canvasRect.left - wrapperRect.left) / scale,
    top: (canvasRect.top - wrapperRect.top) / scale,
    width: canvas.clientWidth || wrapperWidth,
    height: canvas.clientHeight || wrapperHeight,
  }
}

/**
 * Silurus 滚动型 viewer 采用虚拟列表：目标页的 slot 只有在滚动/挂载后才进入 DOM，
 * 像素渲染还可能异步完成。这里轮询等待目标页 wrapper 与 canvas 就绪（最多 timeoutMs），
 * 否则会出现「已翻到该页却没有任何圈选框」的现象。
 */
async function waitForMountedPage(
  slots: Map<number, { canvas?: HTMLCanvasElement; wrapper?: HTMLElement }> | undefined,
  pageIndex: number,
  timeoutMs = 1500,
): Promise<{ wrapper: HTMLElement; canvas?: HTMLCanvasElement } | null> {
  const resolveSlot = (): { wrapper: HTMLElement; canvas?: HTMLCanvasElement } | null => {
    const slot = slots?.get(pageIndex)
    const canvas = slot?.canvas
    const wrapper = slot?.wrapper ?? canvas?.parentElement ?? null
    if (!wrapper || !wrapper.isConnected) return null
    // canvas 像素可能尚未渲染完成（尺寸为 0），量到 0 会把框画成 0 尺寸，继续等待。
    if (canvas && (canvas.clientWidth <= 0 || canvas.clientHeight <= 0)) return null
    return { wrapper, canvas }
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const mounted = resolveSlot()
    if (mounted) return mounted
    await nextFrame()
  }
  // 超时兜底：即便 canvas 尺寸尚未就绪，只要 wrapper 已挂载也先画出框。
  const slot = slots?.get(pageIndex)
  const canvas = slot?.canvas
  const wrapper = slot?.wrapper ?? canvas?.parentElement ?? null
  return wrapper && wrapper.isConnected ? { wrapper, canvas } : null
}

/** Silurus XLSX 内部可见的几何 API（版本私有，集中封装于此桥接层）。 */
interface XlsxViewerInternals {
  _scrollCellIntoView?: (row: number, col: number) => void
  getCellRect?: (row: number, col: number) => { x: number; y: number; width: number; height: number } | null
  canvasElement?: HTMLCanvasElement
}

/** 圈选框几何（相对定位父节点的 layout px，不含外层 CSS transform 缩放）。 */
interface SpotlightGeometry {
  parent: HTMLElement
  left: number
  top: number
  width: number
  height: number
}

/** 读取 XLSX 单元格区域几何；虚拟网格未测量完成时返回 null（交给多帧轮询）。 */
function readXlsxGeometry(
  internals: XlsxViewerInternals,
  startAddr: { row: number; col: number } | null,
  endAddr: { row: number; col: number } | null,
): SpotlightGeometry | null {
  if (!startAddr || !endAddr || typeof internals.getCellRect !== 'function') return null
  const start = internals.getCellRect(startAddr.row, startAddr.col)
  const end = internals.getCellRect(endAddr.row, endAddr.col)
  if (!start || !end) return null
  if (start.width <= 0 || start.height <= 0) return null
  const parent = internals.canvasElement?.parentElement
  if (!parent) return null
  const left = Math.min(start.x, end.x)
  const top = Math.min(start.y, end.y)
  const right = Math.max(start.x + start.width, end.x + end.width)
  const bottom = Math.max(start.y + start.height, end.y + end.height)
  return { parent, left, top, width: Math.max(24, right - left), height: Math.max(18, bottom - top) }
}

/** DOCX/PPTX：按页面画布真实布局尺寸把归一化 bbox 换算为圈选框几何。 */
function readPageGeometry(
  wrapper: HTMLElement,
  canvas: HTMLCanvasElement | undefined,
  bbox: [number, number, number, number] | undefined,
): SpotlightGeometry {
  const layout = measureSlotPageBox(wrapper, canvas)
  const [x0, y0, x1, y1] = bbox ?? [0.06, 0.08, 0.94, 0.24]
  return {
    parent: wrapper,
    left: layout.left + x0 * layout.width,
    top: layout.top + y0 * layout.height,
    width: Math.max(24, (x1 - x0) * layout.width),
    height: Math.max(12, (y1 - y0) * layout.height),
  }
}

/**
 * 在 Silurus OfficeViewer 中执行页码/幻灯片/工作表跳转，并渲染琥珀色脉冲聚光灯高亮框。
 *
 * 与 PDF 预览一致，高亮框需要精确贴合「页面画布」：
 * - DOCX / PPTX：等待目标页 slot 挂载后，按页面 canvas 的真实布局尺寸换算归一化 bbox；
 * - XLSX：使用 viewer 原生单元格选择高亮，并在多帧轮询确认几何稳定后补画圈选框。
 *
 * 高韧性自愈：挂载后监听视口 resize 与 DOM 变更，当外层重绘/虚拟列表复用导致
 * 高亮节点被清理或错位时，自动重新测量并重新锚定，直至淡出计时结束。
 */
export async function applyOfficeCitationSpotlight(
  viewer: ZoomableViewer,
  hostContainer: HTMLElement,
  target: OfficeSpotlightTarget,
): Promise<() => void> {
  ensureSpotlightStyle()
  hostContainer.querySelectorAll('.office-bbox-spotlight').forEach((el) => el.remove())

  const pageIndex = Math.max(0, (target.pageNumber || 1) - 1)
  const disposers: Array<() => void> = []
  let active = true
  let faded = false
  let fadeTimer: ReturnType<typeof setTimeout> | null = null
  let spotlightEl: HTMLDivElement | null = null
  let labelText = target.label ?? ''
  let computeGeometry: () => SpotlightGeometry | null = () => null

  /** 依据当前几何挂载 / 重新定位高亮框（幂等，可被观察器反复调用）。 */
  const mountBox = (geom: SpotlightGeometry): void => {
    if (!active) return
    ensurePositioned(geom.parent)
    if (!spotlightEl) {
      const box = document.createElement('div')
      box.className = 'office-bbox-spotlight'
      const badge = document.createElement('div')
      badge.className = 'office-bbox-spotlight-badge'
      badge.textContent = labelText
      box.appendChild(badge)
      spotlightEl = box
    }
    spotlightEl.style.left = `${Math.max(0, geom.left - 2)}px`
    spotlightEl.style.top = `${Math.max(0, geom.top - 2)}px`
    spotlightEl.style.width = `${geom.width + 4}px`
    spotlightEl.style.height = `${geom.height + 4}px`
    if (spotlightEl.parentElement !== geom.parent) geom.parent.appendChild(spotlightEl)
  }

  let scrollHost: HTMLElement | undefined

  if (target.format === 'xlsx') {
    await viewer.goToSheet?.(pageIndex)
    viewer.setSelectionColor?.('#f59e0b')

    const parts = (target.cellRef ?? '').trim().split(':').map((part) => part.trim()).filter(Boolean)
    const startRef = parts[0] || 'A1'
    const endRef = parts[1] || startRef
    const startAddr = parseA1CellAddress(startRef)
    const endAddr = parseA1CellAddress(endRef) ?? startAddr
    labelText = target.label || `${startRef}${endRef !== startRef ? `:${endRef}` : ''}`

    if (parts[0]) viewer.select?.(startRef)

    const internals = viewer as unknown as XlsxViewerInternals
    if (startAddr && typeof internals._scrollCellIntoView === 'function') {
      try {
        internals._scrollCellIntoView(startAddr.row, startAddr.col)
      } catch {
        // 忽略内部滚动方法异常
      }
    }

    computeGeometry = () => readXlsxGeometry(internals, startAddr, endAddr)
    // 切换工作表 / 滚动单元格后几何异步更新：多帧递增轮询直到网格测量稳定，避免量到旧位置。
    await pollFrames(computeGeometry, [16, 48, 120, 240])
  } else {
    if (target.format === 'docx') {
      viewer.scrollToPage?.(pageIndex, { behavior: 'auto' })
    } else {
      viewer.scrollToSlide?.(pageIndex, { behavior: 'auto' })
    }

    const internalScrollViewer = viewer as unknown as {
      _slots?: Map<number, { canvas?: HTMLCanvasElement; wrapper?: HTMLElement }>
      _scrollHost?: HTMLElement
    }
    scrollHost = internalScrollViewer._scrollHost
    labelText =
      target.label || (target.format === 'pptx' ? `幻灯片 ${target.pageNumber}` : `第 ${target.pageNumber} 页`)

    // 每次重锚都重新解析「当前活跃 slot」：虚拟列表复用会把旧 wrapper 从 DOM 摘除，
    // 若沿用首次捕获的 wrapper，重锚会落到已分离节点上而永远不可见。
    const resolveLiveSlot = (): { wrapper: HTMLElement; canvas?: HTMLCanvasElement } | null => {
      const slot = internalScrollViewer._slots?.get(pageIndex)
      const canvasRaw = slot?.canvas
      const wrapper = slot?.wrapper ?? canvasRaw?.parentElement ?? null
      if (!wrapper || !wrapper.isConnected) return null
      const canvas = canvasRaw && canvasRaw.clientWidth > 0 && canvasRaw.clientHeight > 0 ? canvasRaw : undefined
      return { wrapper, canvas }
    }
    computeGeometry = () => {
      const live = resolveLiveSlot()
      return live ? readPageGeometry(live.wrapper, live.canvas, target.bbox) : null
    }

    // 等待目标页首次挂载（未挂载时后续观察器仍会重试）
    await waitForMountedPage(internalScrollViewer._slots, pageIndex)
  }

  // ---- 高韧性自适应重锚：几何或 DOM 变化时重新解析活跃 slot 并重新定位 ----
  let resizeObserver: ResizeObserver | null = null
  let observedParent: HTMLElement | null = null

  const reposition = (): void => {
    if (!active || faded) return
    const geometry = computeGeometry()
    if (!geometry) return
    mountBox(geometry)
    if (geometry.parent !== observedParent) {
      if (observedParent) resizeObserver?.unobserve(observedParent)
      observedParent = geometry.parent
      resizeObserver?.observe(geometry.parent)
    }
  }

  // 首次挂载
  reposition()

  // DOCX 页面较高时，将目标块垂直居中到可视区（仅一次）
  if (target.format === 'docx' && scrollHost) {
    const geometry = computeGeometry()
    if (geometry && geometry.parent.offsetHeight > 0) {
      const blockCenterY = geometry.parent.offsetTop + geometry.top + geometry.height / 2
      const desiredTop = Math.max(0, blockCenterY - scrollHost.clientHeight * 0.42)
      scrollHost.scrollTo?.({ top: desiredTop, behavior: 'smooth' })
    }
  }

  // 视口 resize / 缩放重绘时重新测量并定位
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => reposition())
    resizeObserver = observer
    observer.observe(hostContainer)
    if (observedParent && observedParent !== hostContainer) observer.observe(observedParent)
    disposers.push(() => observer.disconnect())
  }

  // 自愈重锚：外层重绘 / 虚拟列表复用导致高亮节点被清理或所在 wrapper 被替换时，自动重新挂载
  if (typeof MutationObserver === 'function') {
    const observer = new MutationObserver(() => {
      if (!active || faded) return
      if (!spotlightEl || !spotlightEl.isConnected) reposition()
    })
    observer.observe(hostContainer, { childList: true, subtree: true })
    disposers.push(() => observer.disconnect())
  }

  fadeTimer = setTimeout(() => {
    faded = true
    if (spotlightEl) {
      const el = spotlightEl
      el.style.opacity = '0'
      setTimeout(() => el.remove(), 300)
    }
  }, 6500)

  return () => {
    active = false
    if (fadeTimer) clearTimeout(fadeTimer)
    for (const dispose of disposers) dispose()
    spotlightEl?.remove()
  }
}

export type OfficeViewerHandle = ZoomableViewer
