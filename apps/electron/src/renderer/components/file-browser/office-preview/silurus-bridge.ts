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
        opacity: 0;
        transform: scale(0.96);
        box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.65), 0 4px 12px rgba(245, 158, 11, 0.25);
      }
      12% {
        opacity: 1;
        transform: scale(1.012);
        box-shadow: 0 0 0 8px rgba(245, 158, 11, 0.28), 0 10px 28px rgba(245, 158, 11, 0.45);
      }
      26% {
        opacity: 0.94;
        transform: scale(0.996);
        box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.18), 0 6px 16px rgba(245, 158, 11, 0.3);
      }
      42% {
        opacity: 1;
        transform: scale(1.008);
        box-shadow: 0 0 0 7px rgba(245, 158, 11, 0.25), 0 10px 26px rgba(245, 158, 11, 0.4);
      }
      100% {
        opacity: 1;
        transform: scale(1);
        box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.22), 0 8px 24px -4px rgba(245, 158, 11, 0.35);
      }
    }
    .office-bbox-spotlight {
      position: absolute;
      pointer-events: none;
      z-index: 35;
      border-radius: 6px;
      background: linear-gradient(135deg, rgba(245, 158, 11, 0.22), rgba(59, 130, 246, 0.18));
      border: 2px solid rgba(245, 158, 11, 0.92);
      box-shadow:
        0 0 0 4px rgba(245, 158, 11, 0.24),
        0 8px 24px -4px rgba(245, 158, 11, 0.35),
        inset 0 0 12px rgba(255, 255, 255, 0.35);
      animation: proferOfficeSpotlightPulse 1.8s cubic-bezier(0.22, 1, 0.36, 1) forwards;
      transform-origin: center center;
      transition: opacity 0.25s ease-out;
    }
    .office-bbox-spotlight-badge {
      position: absolute;
      top: -24px;
      left: -2px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 9999px;
      background: linear-gradient(135deg, #f59e0b, #ea580c);
      color: #ffffff;
      font: 600 11px/1.4 system-ui, -apple-system, sans-serif;
      white-space: nowrap;
      box-shadow: 0 4px 10px rgba(234, 88, 12, 0.35);
      letter-spacing: 0.02em;
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

interface SilurusPageSlot {
  canvas?: HTMLCanvasElement
  wrapper?: HTMLElement
  textLayer?: HTMLElement | null
  renderedPage?: number
  renderedSlide?: number
  renderedScale?: number
}

/**
 * 测量目标页槽 wrapper 的页面尺寸（layout px，不受外层 CSS transform 缩放影响）。
 *
 * 注意：Silurus `DocxScrollViewer` 与 `PptxScrollViewer` 在 `_positionSlot` 中同步将
 * `wrapper.style.width / height` 设为真实页面像素尺寸（`_pageWidthPx × _pageHeightPx`），
 * 而未完成异步渲染的 `<canvas>` 默认是 HTML 原生 `300×150`！
 * 因此必须优先信任 `wrapper.clientWidth / clientHeight`，仅在已渲染完成且尺寸一致时参考 canvas。
 */
function measureSlotPageBox(
  wrapper: HTMLElement,
  canvas: HTMLCanvasElement | undefined,
): { left: number; top: number; width: number; height: number } {
  const wrapperWidth = wrapper.clientWidth || wrapper.offsetWidth
  const wrapperHeight = wrapper.clientHeight || wrapper.offsetHeight

  // 页面盒原点偏移：边框（clientLeft/Top）+ 内边距（computed style），
  // 修正槽位容器 margin/padding 导致的聚光灯整体平移误差
  let originLeft = wrapper.clientLeft
  let originTop = wrapper.clientTop
  try {
    const cs = window.getComputedStyle(wrapper)
    originLeft += Number.parseFloat(cs.paddingLeft) || 0
    originTop += Number.parseFloat(cs.paddingTop) || 0
  } catch {
    // computed style 读取失败时退化为仅边框偏移
  }

  if (canvas) {
    const canvasWidth = canvas.clientWidth || 0
    const canvasHeight = canvas.clientHeight || 0
    const isDefaultUnrendered = canvasWidth === 300 && canvasHeight === 150
    // 画布已渲染但与槽位尺寸不一致（居中/留白 letterbox）：
    // 采用画布真实占位与相对偏移，而非整槽尺寸
    if (
      !isDefaultUnrendered
      && canvasWidth > 0
      && canvasHeight > 0
      && (Math.abs(canvasWidth - wrapperWidth) > 1 || Math.abs(canvasHeight - wrapperHeight) > 1)
    ) {
      const innerOffset = measureOffsetWithin(wrapper, canvas)
      return {
        left: originLeft + innerOffset.left,
        top: originTop + innerOffset.top,
        width: Math.max(1, Math.min(canvasWidth, wrapperWidth || canvasWidth)),
        height: Math.max(1, Math.min(canvasHeight, wrapperHeight || canvasHeight)),
      }
    }
  }

  if (wrapperWidth > 0) {
    return { left: originLeft, top: originTop, width: wrapperWidth, height: wrapperHeight }
  }
  return {
    left: originLeft,
    top: originTop,
    width: canvas?.clientWidth || wrapperWidth,
    height: canvas?.clientHeight || wrapperHeight,
  }
}

/**
 * 沿 offsetParent 链累积元素相对 wrapper 的布局偏移。
 * 若链条越过 wrapper（中间存在 static 定位截断）则回退零偏移，避免叠加越界祖先偏移。
 */
function measureOffsetWithin(
  wrapper: HTMLElement,
  element: HTMLElement,
): { left: number; top: number } {
  let left = 0
  let top = 0
  let node: HTMLElement | null = element
  while (node && node !== wrapper) {
    left += node.offsetLeft
    top += node.offsetTop
    const parent = node.offsetParent as HTMLElement | null
    if (!parent || (parent !== wrapper && !wrapper.contains(parent))) {
      return { left: 0, top: 0 }
    }
    node = parent
  }
  return { left, top }
}

/**
 * Silurus 滚动型 viewer 采用虚拟列表：目标页的 slot 只有在滚动/挂载后才进入 DOM，
 * 且 WASM 像素渲染与 `textLayer` span 注入在 `renderedScale > 0` 后才就绪。
 */
async function waitForMountedPage(
  slots: Map<number, SilurusPageSlot> | undefined,
  pageIndex: number,
  timeoutMs = 1500,
): Promise<SilurusPageSlot | null> {
  const resolveSlot = (requireRendered: boolean): SilurusPageSlot | null => {
    const slot = slots?.get(pageIndex)
    const canvas = slot?.canvas
    const wrapper = slot?.wrapper ?? canvas?.parentElement ?? undefined
    if (!wrapper || !wrapper.isConnected) return null
    if (wrapper.clientWidth <= 0 || wrapper.clientHeight <= 0) return null
    if (requireRendered && (slot?.renderedScale ?? -1) <= 0) return null
    return { ...slot, wrapper, canvas }
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const mounted = resolveSlot(true)
    if (mounted) return mounted
    await nextFrame()
  }
  // 超时兜底：即便 WASM 异步渲染尚未完成，只要 wrapper 已就绪也先按 wrapper 尺寸画框
  return resolveSlot(false)
}

/** Silurus XLSX 内部可见的几何与选区 API（注意：`getCellRect` 返回 `{ x, y, w, h }`）。 */
interface XlsxCellRect {
  x: number
  y: number
  w?: number
  h?: number
  width?: number
  height?: number
}

interface XlsxViewerInternals {
  _scrollCellIntoView?: (row: number, col: number) => void
  getCellRect?: (row: number, col: number) => XlsxCellRect | null
  canvasElement?: HTMLCanvasElement
  canvasArea?: HTMLElement
  selectionOverlay?: HTMLElement
  anchorCell?: { row: number; col: number }
  activeCell?: { row: number; col: number }
  selectionMode?: string
  updateSelectionOverlay?: () => void
  renderCurrentSheet?: () => void
}

/** 圈选框几何（相对定位父节点的 layout px，不含外层 CSS transform 缩放）。 */
interface SpotlightGeometry {
  parent: HTMLElement
  left: number
  top: number
  width: number
  height: number
}

/** 读取 XLSX 单元格区域几何；兼容 Silurus `{ x, y, w, h }` 与 `{ x, y, width, height }`。 */
export function readXlsxGeometry(
  internals: XlsxViewerInternals,
  startAddr: { row: number; col: number } | null,
  endAddr: { row: number; col: number } | null,
): SpotlightGeometry | null {
  if (!startAddr || !endAddr || typeof internals.getCellRect !== 'function') return null
  const start = internals.getCellRect(startAddr.row, startAddr.col)
  const end = internals.getCellRect(endAddr.row, endAddr.col)
  if (!start || !end) return null
  const startW = start.w ?? start.width ?? 0
  const startH = start.h ?? start.height ?? 0
  const endW = end.w ?? end.width ?? startW
  const endH = end.h ?? end.height ?? startH
  if (startW <= 0 || startH <= 0) return null
  const parent = internals.canvasArea ?? internals.canvasElement?.parentElement
  if (!parent) return null
  const left = Math.min(start.x, end.x)
  const top = Math.min(start.y, end.y)
  const right = Math.max(start.x + startW, end.x + endW)
  const bottom = Math.max(start.y + startH, end.y + endH)
  return { parent, left, top, width: Math.max(28, right - left), height: Math.max(20, bottom - top) }
}

/**
 * 从 `label` 中提取用于匹配 Silurus `textLayer` 真实渲染 span 的检索词。
 */
function extractSpotlightKeywords(label: string | undefined): string[] {
  if (!label) return []
  return label
    .replace(/第\s*\d+\s*[页张行]/g, ' ')
    .replace(/幻灯片\s*\d+/g, ' ')
    .replace(/\bf\d+[:·]p\d+(?:-b\d+)?\b/gi, ' ')
    .replace(/[·•|()（）\[\]【】：:，,、]/g, ' ')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && s !== '正文' && s !== '表格' && s !== '插图' && s !== '公式')
}

/**
 * 在 Silurus `DocxScrollViewer` / `PptxScrollViewer` 的 `textLayer` 中匹配目标文本行，
 * 直接读取 WASM 引擎渲染出的 `<span>` 精确像素坐标，彻底消除估算重排与真实渲染之间的行高累积误差。
 */
export function matchTextLayerGeometry(
  wrapper: HTMLElement,
  textLayer: HTMLElement | null | undefined,
  label: string | undefined,
  hintBbox?: [number, number, number, number],
): SpotlightGeometry | null {
  if (!textLayer || !textLayer.isConnected) return null
  const keywords = extractSpotlightKeywords(label)
  if (keywords.length === 0) return null

  const spans = Array.from(textLayer.querySelectorAll<HTMLElement>('span'))
  if (spans.length === 0) return null

  interface LineGroup {
    top: number
    bottom: number
    left: number
    right: number
    text: string
  }

  const lines: LineGroup[] = []
  for (const span of spans) {
    const txt = (span.textContent ?? '').trim()
    if (!txt) continue
    const left = Number.parseFloat(span.style.left) || span.offsetLeft || 0
    const top = Number.parseFloat(span.style.top) || span.offsetTop || 0
    const h = Number.parseFloat(span.style.lineHeight) || span.offsetHeight || 18
    const w = Math.max(12, span.offsetWidth || txt.length * (h * 0.55))

    const existing = lines.find((line) => Math.abs(line.top - top) <= Math.max(6, h * 0.55))
    if (existing) {
      existing.left = Math.min(existing.left, left)
      existing.right = Math.max(existing.right, left + w)
      existing.top = Math.min(existing.top, top)
      existing.bottom = Math.max(existing.bottom, top + h)
      existing.text += ` ${txt}`
    } else {
      lines.push({ top, bottom: top + h, left, right: left + w, text: txt })
    }
  }

  if (lines.length === 0) return null

  const pageHeight = Math.max(1, wrapper.clientHeight || wrapper.offsetHeight || 1)
  const hintCenterY = hintBbox ? ((hintBbox[1] + hintBbox[3]) / 2) * pageHeight : null

  let bestLine: LineGroup | null = null
  let bestScore = 0

  for (const line of lines) {
    const normalizedLine = line.text.replace(/\s+/g, '')
    let score = 0
    for (const kw of keywords) {
      const cleanKw = kw.replace(/\s+/g, '')
      if (cleanKw && normalizedLine.includes(cleanKw)) {
        score += cleanKw.length * 10
      }
    }
    if (score > 0 && hintCenterY !== null) {
      const distRatio = Math.abs((line.top + line.bottom) / 2 - hintCenterY) / pageHeight
      score += Math.max(0, 5 - distRatio * 5)
    }
    if (score > bestScore) {
      bestScore = score
      bestLine = line
    }
  }

  if (!bestLine) return null

  const padX = 6
  const padY = 4
  return {
    parent: wrapper,
    left: Math.max(0, bestLine.left - padX),
    top: Math.max(0, bestLine.top - padY),
    width: Math.max(36, bestLine.right - bestLine.left + padX * 2),
    height: Math.max(18, bestLine.bottom - bestLine.top + padY * 2),
  }
}

/** DOCX/PPTX：优先采用 `textLayer` 像素级精确匹配，未命中时回退至归一化 bbox 换算。 */
function readPageGeometry(
  wrapper: HTMLElement,
  canvas: HTMLCanvasElement | undefined,
  textLayer: HTMLElement | null | undefined,
  bbox: [number, number, number, number] | undefined,
  label: string | undefined,
): SpotlightGeometry {
  const exactFromTextLayer = matchTextLayerGeometry(wrapper, textLayer, label, bbox)
  if (exactFromTextLayer) return exactFromTextLayer

  const layout = measureSlotPageBox(wrapper, canvas)
  const [x0, y0, x1, y1] = bbox ?? [0.06, 0.08, 0.94, 0.24]
  const padX = 0.008
  const padY = 0.005
  const sx0 = Math.max(0, Math.min(0.98, x0 - padX))
  const sy0 = Math.max(0, Math.min(0.98, y0 - padY))
  const sx1 = Math.max(sx0 + 0.02, Math.min(1, x1 + padX))
  const sy1 = Math.max(sy0 + 0.015, Math.min(1, y1 + padY))
  return {
    parent: wrapper,
    left: layout.left + sx0 * layout.width,
    top: layout.top + sy0 * layout.height,
    width: Math.max(24, (sx1 - sx0) * layout.width),
    height: Math.max(16, (sy1 - sy0) * layout.height),
  }
}

/**
 * 在 Silurus OfficeViewer 中执行页码/幻灯片/工作表跳转，并渲染与 PDF 完全同构的琥珀色脉冲聚光灯高亮框。
 */
export async function applyOfficeCitationSpotlight(
  viewer: ZoomableViewer,
  hostContainer: HTMLElement,
  target: OfficeSpotlightTarget,
): Promise<() => void> {
  ensureSpotlightStyle()
  hostContainer.querySelectorAll('.office-bbox-spotlight').forEach((el) => el.remove())

  const totalCount =
    target.format === 'docx'
      ? viewer.pageCount
      : target.format === 'pptx'
        ? viewer.slideCount
        : viewer.sheetCount
  const rawPageIndex = Math.max(0, (target.pageNumber || 1) - 1)
  let activePageIndex =
    typeof totalCount === 'number' && totalCount > 0
      ? Math.min(rawPageIndex, totalCount - 1)
      : rawPageIndex

  const disposers: Array<() => void> = []
  let active = true
  let faded = false
  let fadeTimer: ReturnType<typeof setTimeout> | null = null
  let spotlightEl: HTMLDivElement | null = null
  let badgeEl: HTMLDivElement | null = null
  let labelText = target.label ?? ''
  let computeGeometry: () => SpotlightGeometry | null = () => null

  /** 依据当前几何挂载 / 重新定位高亮框（幂等，可被观察器反复调用）。 */
  const mountBox = (geom: SpotlightGeometry): void => {
    if (!active) return
    ensurePositioned(geom.parent)
    const formattedLabel = labelText.startsWith('📍') ? labelText : `📍 ${labelText}`
    if (!spotlightEl) {
      const box = document.createElement('div')
      box.className = 'office-bbox-spotlight'
      const badge = document.createElement('div')
      badge.className = 'office-bbox-spotlight-badge'
      badge.textContent = formattedLabel
      box.appendChild(badge)
      spotlightEl = box
      badgeEl = badge
    } else if (badgeEl && badgeEl.textContent !== formattedLabel) {
      badgeEl.textContent = formattedLabel
    }
    const boxLeft = Math.max(0, geom.left - 2)
    const boxTop = Math.max(0, geom.top - 2)
    spotlightEl.style.left = `${boxLeft}px`
    spotlightEl.style.top = `${boxTop}px`
    spotlightEl.style.width = `${geom.width + 4}px`
    spotlightEl.style.height = `${geom.height + 4}px`
    if (badgeEl) {
      // 若高亮框紧贴画布顶部（如 Excel 第 1 行），将胶囊标签置于框下方，防止被父容器 overflow:hidden 裁切
      badgeEl.style.top = boxTop < 26 ? `${geom.height + 6}px` : '-24px'
    }
    if (spotlightEl.parentElement !== geom.parent) geom.parent.appendChild(spotlightEl)
  }

  let scrollHost: HTMLElement | undefined

  if (target.format === 'xlsx') {
    await viewer.goToSheet?.(activePageIndex)
    viewer.setSelectionColor?.('#f59e0b')

    const parts = (target.cellRef ?? '').trim().split(':').map((part) => part.trim()).filter(Boolean)
    const startRef = parts[0] || 'A1'
    const endRef = parts[1] || startRef
    const startAddr = parseA1CellAddress(startRef)
    const endAddr = parseA1CellAddress(endRef) ?? startAddr
    const rangeLabel = `${startRef}${endRef !== startRef ? `:${endRef}` : ''}`
    labelText = target.label
      ? target.label.includes(startRef)
        ? target.label
        : `${target.label} · ${rangeLabel}`
      : rangeLabel

    if (parts[0]) viewer.select?.(startRef)

    const internals = viewer as unknown as XlsxViewerInternals
    if (startAddr && endAddr) {
      internals.anchorCell = { row: startAddr.row, col: startAddr.col }
      internals.activeCell = { row: endAddr.row, col: endAddr.col }
      internals.selectionMode = 'cells'
      try {
        internals.updateSelectionOverlay?.()
        internals.renderCurrentSheet?.()
      } catch {
        // 忽略内部选区同步异常
      }
    }
    if (startAddr && typeof internals._scrollCellIntoView === 'function') {
      try {
        internals._scrollCellIntoView(startAddr.row, startAddr.col)
      } catch {
        // 忽略内部滚动方法异常
      }
    }

    computeGeometry = () => readXlsxGeometry(internals, startAddr, endAddr)
    // 切换工作表 / 滚动单元格后几何异步更新：多帧递增轮询直到网格测量稳定
    await pollFrames(computeGeometry, [16, 48, 120, 240, 400])
  } else {
    if (target.format === 'docx') {
      viewer.scrollToPage?.(activePageIndex, { behavior: 'auto' })
    } else {
      viewer.scrollToSlide?.(activePageIndex, { behavior: 'auto' })
    }

    const internalScrollViewer = viewer as unknown as {
      _slots?: Map<number, SilurusPageSlot>
      _scrollHost?: HTMLElement
    }
    scrollHost = internalScrollViewer._scrollHost
    labelText =
      target.label || (target.format === 'pptx' ? `幻灯片 ${activePageIndex + 1}` : `第 ${activePageIndex + 1} 页`)

    // 等待目标页完成 WASM 渲染与 textLayer 注入
    await waitForMountedPage(internalScrollViewer._slots, activePageIndex)

    // 跨页自适应校准：若 DOCX 估算页与 WASM 实际分页相差 1 页，在已挂载相邻页的 textLayer 中自动寻址
    if (target.format === 'docx' && internalScrollViewer._slots) {
      const currentSlot = internalScrollViewer._slots.get(activePageIndex)
      const matchedOnCurrent =
        currentSlot?.wrapper &&
        matchTextLayerGeometry(currentSlot.wrapper, currentSlot.textLayer, labelText, target.bbox)
      if (!matchedOnCurrent) {
        for (const [candidateIdx, candidateSlot] of internalScrollViewer._slots.entries()) {
          if (candidateIdx === activePageIndex || !candidateSlot.wrapper) continue
          const matchedOnCandidate = matchTextLayerGeometry(
            candidateSlot.wrapper,
            candidateSlot.textLayer,
            labelText,
          )
          if (matchedOnCandidate) {
            activePageIndex = candidateIdx
            viewer.scrollToPage?.(activePageIndex, { behavior: 'auto' })
            break
          }
        }
      }
    }

    const resolveLiveSlot = (): SilurusPageSlot | null => {
      const slot = internalScrollViewer._slots?.get(activePageIndex)
      const canvasRaw = slot?.canvas
      const wrapper = slot?.wrapper ?? canvasRaw?.parentElement ?? undefined
      if (!wrapper || !wrapper.isConnected) return null
      const canvas = canvasRaw && canvasRaw.clientWidth > 0 && canvasRaw.clientHeight > 0 ? canvasRaw : undefined
      return { ...slot, wrapper, canvas }
    }
    computeGeometry = () => {
      const live = resolveLiveSlot()
      return live
        ? readPageGeometry(live.wrapper!, live.canvas, live.textLayer, target.bbox, labelText)
        : null
    }
  }

  // ---- 高韧性自适应重锚：几何、滚动或 DOM 变化时重新解析活跃 slot 并重新定位 ----
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

  // 将目标高亮框平滑滚动至视口中央（与 PDF 行为一致）
  if (target.format === 'docx' && scrollHost) {
    const geometry = computeGeometry()
    if (geometry && geometry.parent.offsetHeight > 0) {
      const blockCenterY = geometry.parent.offsetTop + geometry.top + geometry.height / 2
      const desiredTop = Math.max(0, blockCenterY - scrollHost.clientHeight * 0.42)
      scrollHost.scrollTo?.({ top: desiredTop, behavior: 'smooth' })
    }
  } else if (spotlightEl) {
    requestAnimationFrame(() => {
      spotlightEl?.scrollIntoView?.({ behavior: 'smooth', block: 'center', inline: 'nearest' })
    })
  }

  // XLSX 滚轮/滚动时单元格相对 canvasArea 偏移会实时变化，需同步刷新圈选框位置
  if (target.format === 'xlsx') {
    const onWheelOrScroll = () => {
      if (!active || faded) return
      requestAnimationFrame(() => reposition())
    }
    hostContainer.addEventListener('wheel', onWheelOrScroll, { passive: true })
    hostContainer.addEventListener('scroll', onWheelOrScroll, { passive: true, capture: true })
    disposers.push(() => {
      hostContainer.removeEventListener('wheel', onWheelOrScroll)
      hostContainer.removeEventListener('scroll', onWheelOrScroll, { capture: true })
    })
  }

  // 视口 resize / 缩放重绘时重新测量并定位
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => reposition())
    resizeObserver = observer
    observer.observe(hostContainer)
    if (observedParent && observedParent !== hostContainer) observer.observe(observedParent)
    disposers.push(() => observer.disconnect())
  }

  // 自愈重锚：外层重绘 / WASM textLayer 注入 / 虚拟列表复用时，自动重新测量并挂载
  if (typeof MutationObserver === 'function') {
    const observer = new MutationObserver((mutations) => {
      if (!active || faded) return
      const hasExternalMutation = mutations.some((m) => {
        if (spotlightEl && (m.target === spotlightEl || m.target === badgeEl)) return false
        const addedNonSpotlight = Array.from(m.addedNodes).some((n) => n !== spotlightEl && n !== badgeEl)
        const removedNonSpotlight = Array.from(m.removedNodes).some((n) => n !== spotlightEl && n !== badgeEl)
        return addedNonSpotlight || removedNonSpotlight || !spotlightEl || !spotlightEl.isConnected
      })
      if (hasExternalMutation) reposition()
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
