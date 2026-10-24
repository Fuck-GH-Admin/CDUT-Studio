/**
 * CsLabPdfViewer — 社论式 PDF 阅读器
 *
 * 评审加固：
 * - 11.3 Worker 失效时自动降级为主线程（fake worker）渲染；
 * - 11.4 批注按 position.rotation 四向仿射投影；
 * - 11.6 页面滑出 ±1 缓冲立即释放 Canvas 位图、取消渲染任务并 page.cleanup()。
 */

import * as React from 'react'
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Hand,
  Highlighter,
  Loader2,
  MessagesSquare,
  Minus,
  MousePointer2,
  Plus,
  Sparkles,
} from 'lucide-react'
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import {
  zoteroRectToViewport,
  type CsLabLiteratureItem,
  type CsLabZoteroAnnotation,
} from '@profer/shared'
import { cn } from '@/lib/utils'
import type { CsLabPdfSelection } from '@/atoms/cslab-atoms'
import { detectIsWindows } from '@profer/ui'
import { CsLabLiteratureGuidePanel } from './CsLabLiteratureGuidePanel'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc

interface CsLabPdfViewerProps {
  labId: string
  literature: CsLabLiteratureItem
  initialPage?: number
  /** 文献智脑命中联动：跳转到指定页并高亮归一化 bbox 选框。 */
  focusHighlight?: { page: number; bbox: [number, number, number, number] }
  onSelection: (selection: CsLabPdfSelection) => void
}

interface PageDimensions {
  /** 已含页面旋转的显示尺寸（PDF 点）。 */
  width: number
  height: number
  /** 未旋转的用户空间尺寸，用于 Zotero 批注四向仿射。 */
  pageWidth: number
  pageHeight: number
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('PDF Worker 初始化超时')), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export function CsLabPdfViewer({
  labId,
  literature,
  initialPage,
  focusHighlight,
  onSelection,
}: CsLabPdfViewerProps): React.ReactElement {
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const pageRefs = React.useRef<Map<number, HTMLDivElement>>(new Map())
  const [document, setDocument] = React.useState<PDFDocumentProxy | null>(null)
  const [pageCount, setPageCount] = React.useState(0)
  const [scale, setScale] = React.useState(1.1)
  const [currentPage, setCurrentPage] = React.useState(1)
  const [annotations, setAnnotations] = React.useState<CsLabZoteroAnnotation[]>([])
  const [showAnnotations, setShowAnnotations] = React.useState(true)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [workerFallback, setWorkerFallback] = React.useState(false)
  /** 指针模式：scroll 只读浏览（默认，滚轮翻页）；hand 抓手平移画布。 */
  const [pointerMode, setPointerMode] = React.useState<'scroll' | 'hand'>('scroll')
  const [panning, setPanning] = React.useState(false)
  const panRef = React.useRef<{ pointerId: number; startX: number; startY: number; scrollLeft: number; scrollTop: number } | null>(null)
  /** 「在对话中研讨」发送状态与一次性提示。 */
  const [discussing, setDiscussing] = React.useState(false)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [showGuide, setShowGuide] = React.useState(false)

  /** 把导读提示词预填到实验室研讨助理输入框（不自动发送）。 */
  const discussInAgentWindow = async (sectionTitle?: string, page?: number): Promise<void> => {
    setDiscussing(true)
    setNotice(null)
    try {
      const focus = sectionTitle
        ? `当前聚焦章节：「${sectionTitle}」${page ? `（第 ${page} 页）` : ''}。`
        : ''
      const result = await window.electronAPI.cslab.sendToAgentWindow({
        labId,
        source: 'asset',
        assetUri: literature.uri,
        prompt: [
          `我正在研读《${literature.title}》。${focus}请优先基于客户端内核文档引擎已预解析的全文证据（<attached_documents> 的 clean_markdown 与自动注入的 <document_evidence>）直接作答：`,
          '1. 先给全文结构、核心贡献与关键公式导引（全局导读）；',
          '2. 仅在我针对具体段落追问时，再局部精读对应章节。',
          '禁止逐页翻阅 PDF、扫描文件系统或重复调用文档解析。',
        ].join('\n'),
        createdAt: Date.now(),
      })
      setNotice(result.delivered ? '已预填到科学助理输入框' : '科学助理未就绪，请稍后重试')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '发送至科学助理失败')
    } finally {
      setDiscussing(false)
    }
  }

  // ===== 文档加载（Worker 失败自动降级） =====
  React.useEffect(() => {
    let cancelled = false
    let loaded: PDFDocumentProxy | null = null

    const load = async (): Promise<void> => {
      setLoading(true)
      setError(null)
      setWorkerFallback(false)
      try {
        const resolved = await window.electronAPI.cslab.getLiteratureUrl({
          labId,
          uri: literature.uri,
        })
        const loadingTask = pdfjsLib.getDocument({
          url: resolved.url,
          isEvalSupported: false,
          useWorkerFetch: false,
        })
        try {
          loaded = await withTimeout(loadingTask.promise, 6000)
        } catch (workerError) {
          // Worker 被 CSP/协议阻断时，导入 worker 模块并使用主线程 fake worker。
          await loadingTask.destroy().catch(() => undefined)
          const workerModule = await import('pdfjs-dist/build/pdf.worker.min.mjs')
          ;(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = workerModule
          const retryTask = pdfjsLib.getDocument({
            url: resolved.url,
            isEvalSupported: false,
            useWorkerFetch: false,
          })
          loaded = await retryTask.promise
          if (!cancelled) setWorkerFallback(true)
          console.warn('[CSLab] PDF Worker 不可用，已降级主线程渲染:', workerError)
        }

        if (cancelled) {
          await loaded.destroy()
          return
        }
        setDocument(loaded)
        setPageCount(loaded.numPages)
        setLoading(false)
      } catch (loadError) {
        if (cancelled) return
        setError(loadError instanceof Error ? loadError.message : 'PDF 加载失败')
        setLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
      void loaded?.destroy().catch(() => undefined)
    }
  }, [labId, literature.uri])

  // ===== 批注加载 =====
  React.useEffect(() => {
    let cancelled = false
    void window.electronAPI.cslab
      .listZoteroAnnotations({ labId, literatureUri: literature.uri })
      .then((list) => {
        if (!cancelled) setAnnotations(list)
      })
      .catch(() => {
        if (!cancelled) setAnnotations([])
      })
    return () => {
      cancelled = true
    }
  }, [labId, literature.uri])

  // ===== 适合宽度 =====
  const fitWidth = React.useCallback(async (): Promise<void> => {
    if (!document || !scrollRef.current) return
    try {
      const page = await document.getPage(1)
      const viewport = page.getViewport({ scale: 1 })
      const available = Math.max(320, scrollRef.current.clientWidth - 56)
      setScale(Math.max(0.4, Math.min(3, available / viewport.width)))
    } catch {
      // 忽略尺寸读取失败，保持当前缩放。
    }
  }, [document])

  React.useEffect(() => {
    if (!document) return
    void fitWidth()
  }, [document, fitWidth])

  // ===== 初始页码跳转 =====
  React.useEffect(() => {
    if (!initialPage || !document) return
    const target = Math.max(1, Math.min(pageCount, initialPage))
    const wrapper = pageRefs.current.get(target)
    wrapper?.scrollIntoView({ block: 'start', behavior: 'auto' })
  }, [initialPage, document, pageCount])

  // ===== 智脑命中联动：跳页 + bbox 聚焦高亮 =====
  React.useEffect(() => {
    if (!focusHighlight || !document) return
    const target = Math.max(1, Math.min(pageCount, focusHighlight.page))
    const wrapper = pageRefs.current.get(target)
    wrapper?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [focusHighlight, document, pageCount])

  const registerPage = React.useCallback((page: number, element: HTMLDivElement | null): void => {
    if (element) pageRefs.current.set(page, element)
    else pageRefs.current.delete(page)
  }, [])

  const goPage = (delta: number): void => {
    const next = Math.max(1, Math.min(pageCount, currentPage + delta))
    pageRefs.current.get(next)?.scrollIntoView({ block: 'start', behavior: 'auto' })
  }

  const goToPageAbsolute = React.useCallback((page: number): void => {
    const next = Math.max(1, Math.min(pageCount || page, page))
    pageRefs.current.get(next)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [pageCount])

  // ===== 外层容器：抓手平移 + Ctrl+滚轮缩放（全模式一致） =====
  const handleContainerPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (pointerMode !== 'hand' || event.button !== 0) return
    const el = event.currentTarget
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
    }
    setPanning(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handleContainerPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const pan = panRef.current
    if (!pan || pan.pointerId !== event.pointerId) return
    const el = event.currentTarget
    el.scrollLeft = pan.scrollLeft - (event.clientX - pan.startX)
    el.scrollTop = pan.scrollTop - (event.clientY - pan.startY)
  }

  const handleContainerPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (panRef.current?.pointerId === event.pointerId) {
      panRef.current = null
      setPanning(false)
    }
  }

  // Ctrl+滚轮缩放：wheel 在 React 根节点为 passive，需原生非 passive 监听才能 preventDefault。
  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      // 普通滚轮保持原生滚动翻页；Ctrl+滚轮在所有模式下统一缩放。
      event.preventDefault()
      setScale((value) => Math.max(0.4, Math.min(3, value + (event.deltaY > 0 ? -0.1 : 0.1))))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col bg-cslab-bg">
      <div
        className="flex h-9 shrink-0 items-center gap-1.5 border-b border-cslab-border px-2.5"
        style={{ paddingRight: isWindows ? 132 : 10 }}
      >
        <BookOpen size={12} className="shrink-0 text-cslab-muted" />
        <span
          className="min-w-0 flex-1 truncate font-serif text-[12px] text-cslab-text"
          title={literature.title}
        >
          {literature.title}
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-cslab-muted">
          {currentPage} / {pageCount || '—'}
        </span>
        <button
          type="button"
          onClick={() => goPage(-1)}
          className="rounded p-1 text-cslab-muted transition-colors hover:bg-cslab-surface hover:text-cslab-text"
          aria-label="上一页"
        >
          <ChevronLeft size={12} />
        </button>
        <button
          type="button"
          onClick={() => goPage(1)}
          className="rounded p-1 text-cslab-muted transition-colors hover:bg-cslab-surface hover:text-cslab-text"
          aria-label="下一页"
        >
          <ChevronRight size={12} />
        </button>
        <button
          type="button"
          onClick={() => setScale((value) => Math.max(0.4, value - 0.15))}
          className="rounded p-1 text-cslab-muted transition-colors hover:bg-cslab-surface hover:text-cslab-text"
          aria-label="缩小"
        >
          <Minus size={12} />
        </button>
        <button
          type="button"
          onClick={() => setScale((value) => Math.min(3, value + 0.15))}
          className="rounded p-1 text-cslab-muted transition-colors hover:bg-cslab-surface hover:text-cslab-text"
          aria-label="放大"
        >
          <Plus size={12} />
        </button>
        <button
          type="button"
          onClick={() => setShowAnnotations((value) => !value)}
          className={cn(
            'rounded p-1 transition-colors',
            showAnnotations
              ? 'bg-cslab-surface text-cslab-accent'
              : 'text-cslab-muted hover:bg-cslab-surface hover:text-cslab-text',
          )}
          aria-label={showAnnotations ? '隐藏批注' : '显示批注'}
          title={showAnnotations ? '隐藏批注' : '显示批注'}
        >
          <Highlighter size={12} />
        </button>
        <span className="mx-0.5 h-4 w-px shrink-0 bg-cslab-border" />
        <button
          type="button"
          onClick={() => setPointerMode('scroll')}
          className={cn(
            'rounded p-1 transition-colors',
            pointerMode === 'scroll'
              ? 'bg-cslab-surface text-cslab-accent'
              : 'text-cslab-muted hover:bg-cslab-surface hover:text-cslab-text',
          )}
          aria-label="浏览模式"
          title="浏览模式：滚轮翻页，按住 Ctrl 拖动框选"
        >
          <MousePointer2 size={12} />
        </button>
        <button
          type="button"
          onClick={() => setPointerMode('hand')}
          className={cn(
            'rounded p-1 transition-colors',
            pointerMode === 'hand'
              ? 'bg-cslab-surface text-cslab-accent'
              : 'text-cslab-muted hover:bg-cslab-surface hover:text-cslab-text',
          )}
          aria-label="抓手模式"
          title="抓手模式：按住拖动平移画布；Ctrl+滚轮缩放"
        >
          <Hand size={12} />
        </button>
        <span className="mx-0.5 h-4 w-px shrink-0 bg-cslab-border" />
        <button
          type="button"
          onClick={() => setShowGuide((value) => !value)}
          className={cn(
            'inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] transition-colors',
            showGuide
              ? 'bg-cslab-surface text-cslab-accent'
              : 'text-cslab-muted hover:bg-cslab-surface hover:text-cslab-text',
          )}
          aria-pressed={showGuide}
          title="打开结构化智能导读"
        >
          <Sparkles size={11} />
          智能导读
        </button>
        <button
          type="button"
          disabled={discussing}
          onClick={() => void discussInAgentWindow()}
          className={cn(
            'rounded p-1 transition-colors',
            'text-cslab-muted hover:bg-cslab-surface hover:text-cslab-text disabled:opacity-50',
          )}
          aria-label="在对话中研讨"
          title="在对话中研讨：把全局导读提示词预填到科学助理输入框"
        >
          {discussing ? <Loader2 size={12} className="animate-spin" /> : <MessagesSquare size={12} />}
        </button>
      </div>

      {workerFallback && (
        <p className="shrink-0 border-b border-cslab-border bg-cslab-surface px-3 py-1 text-[10px] text-cslab-muted">
          PDF Worker 不可用，已切换主线程渲染（功能不受影响）
        </p>
      )}

      {notice && (
        <p className="shrink-0 border-b border-cslab-border bg-cslab-accent/10 px-3 py-1 text-[10px] text-cslab-accent">
          {notice}
        </p>
      )}

      <div className="flex min-h-0 flex-1">
      <div
        ref={scrollRef}
        data-cslab-pdf-scroll
        onPointerDown={handleContainerPointerDown}
        onPointerMove={handleContainerPointerMove}
        onPointerUp={handleContainerPointerUp}
        onPointerCancel={handleContainerPointerUp}
        className={cn(
          'min-h-0 min-w-0 flex-1 overflow-auto bg-cslab-surface px-5 py-4',
          pointerMode === 'hand' && !panning && 'cursor-grab',
          pointerMode === 'hand' && panning && 'cursor-grabbing',
        )}
      >
        {loading && (
          <div className="flex h-full items-center justify-center gap-2 text-[11px] text-cslab-muted">
            <Loader2 size={14} className="animate-spin" />
            正在载入 PDF…
          </div>
        )}
        {error && (
          <div className="mx-auto max-w-md rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[11px] leading-relaxed text-red-600">
            {error}
          </div>
        )}
        {document && (
          <div className="mx-auto flex w-fit flex-col gap-4">
            {Array.from({ length: pageCount }, (_, index) => index + 1).map((pageNumber) => (
              <PdfPageView
                key={pageNumber}
                pdfDocument={document}
                pageNumber={pageNumber}
                scale={scale}
                literatureUri={literature.uri}
                annotations={showAnnotations ? annotations : []}
                focusBbox={focusHighlight?.page === pageNumber ? focusHighlight.bbox : undefined}
                onSelection={onSelection}
                onVisible={setCurrentPage}
                registerRef={registerPage}
              />
            ))}
          </div>
        )}
      </div>
      {showGuide && (
        <CsLabLiteratureGuidePanel
          labId={labId}
          literature={literature}
          onJumpToPage={goToPageAbsolute}
          onDiscuss={(sectionTitle, page) => void discussInAgentWindow(sectionTitle, page)}
          onClose={() => setShowGuide(false)}
        />
      )}
      </div>
    </div>
  )
}

interface PdfPageViewProps {
  pdfDocument: PDFDocumentProxy
  pageNumber: number
  scale: number
  literatureUri: string
  annotations: CsLabZoteroAnnotation[]
  /** 智脑命中聚焦：页内归一化 bbox [x0, y0, x1, y1]；4s 渐隐或点击消除。 */
  focusBbox?: [number, number, number, number]
  onSelection: (selection: CsLabPdfSelection) => void
  onVisible: (page: number) => void
  registerRef: (page: number, element: HTMLDivElement | null) => void
}

interface SelectionRect {
  x: number
  y: number
  width: number
  height: number
}

function PdfPageView({
  pdfDocument,
  pageNumber,
  scale,
  literatureUri,
  annotations,
  focusBbox,
  onSelection,
  onVisible,
  registerRef,
}: PdfPageViewProps): React.ReactElement {
  const wrapperRef = React.useRef<HTMLDivElement | null>(null)
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const overlayRef = React.useRef<HTMLDivElement | null>(null)
  const pageRef = React.useRef<PDFPageProxy | null>(null)
  const renderTaskRef = React.useRef<RenderTask | null>(null)
  const dragRef = React.useRef<{ x: number; y: number } | null>(null)
  const selectionRef = React.useRef<SelectionRect | null>(null)
  const [dimensions, setDimensions] = React.useState<PageDimensions | null>(null)
  const [visible, setVisible] = React.useState(false)
  const [selection, setSelection] = React.useState<SelectionRect | null>(null)
  /** 按住 Ctrl（或 Cmd）时显示十字光标 —— 框选的唯一起动条件。 */
  const [ctrlHeld, setCtrlHeld] = React.useState(false)
  /** 智脑聚焦选框：4s 渐隐，任意按下立即消除。 */
  const [focusBox, setFocusBox] = React.useState<[number, number, number, number] | null>(null)

  React.useEffect(() => {
    if (!focusBbox) {
      setFocusBox(null)
      return
    }
    setFocusBox(focusBbox)
    const timer = setTimeout(() => setFocusBox(null), 4000)
    return () => clearTimeout(timer)
  }, [focusBbox])

  React.useEffect(() => {
    const update = (event: KeyboardEvent): void => setCtrlHeld(event.ctrlKey || event.metaKey)
    const clear = (): void => setCtrlHeld(false)
    window.addEventListener('keydown', update)
    window.addEventListener('keyup', update)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', update)
      window.removeEventListener('keyup', update)
      window.removeEventListener('blur', clear)
    }
  }, [])

  React.useEffect(() => {
    registerRef(pageNumber, wrapperRef.current)
    return () => registerRef(pageNumber, null)
  }, [pageNumber, registerRef])

  React.useEffect(() => {
    let cancelled = false
    void pdfDocument.getPage(pageNumber).then((page) => {
      if (cancelled) return
      pageRef.current = page
      const viewport = page.getViewport({ scale: 1 })
      const view = Array.isArray(page.view) && page.view.length === 4 ? page.view : null
      setDimensions({
        width: viewport.width,
        height: viewport.height,
        pageWidth: view ? Math.abs(view[2]! - view[0]!) : viewport.width,
        pageHeight: view ? Math.abs(view[3]! - view[1]!) : viewport.height,
      })
    })
    return () => {
      cancelled = true
    }
  }, [pdfDocument, pageNumber])

  // ===== 可视区探测（±1 页缓冲） =====
  React.useEffect(() => {
    const element = wrapperRef.current
    if (!element) return
    const root = element.closest('[data-cslab-pdf-scroll]') as Element | null
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        const nextVisible = !!entry?.isIntersecting
        setVisible(nextVisible)
        if (nextVisible) onVisible(pageNumber)
      },
      { root, rootMargin: '600px 0px', threshold: 0.01 },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [pageNumber, onVisible])

  // ===== 渲染与显存释放（评审加固 11.6） =====
  React.useEffect(() => {
    if (!visible || !dimensions) return
    let cancelled = false
    const canvas = canvasRef.current
    const page = pageRef.current
    if (!canvas || !page) return

    renderTaskRef.current?.cancel()
    const dpr = window.devicePixelRatio || 1
    const viewport = page.getViewport({ scale: scale * dpr })
    canvas.width = Math.max(1, Math.floor(viewport.width))
    canvas.height = Math.max(1, Math.floor(viewport.height))
    canvas.style.width = `${dimensions.width * scale}px`
    canvas.style.height = `${dimensions.height * scale}px`

    const context = canvas.getContext('2d')
    if (!context) return
    const task = page.render({ canvasContext: context, viewport })
    renderTaskRef.current = task
    task.promise.catch((renderError: unknown) => {
      if (cancelled) return
      if ((renderError as { name?: string } | null)?.name === 'RenderingCancelledException') return
      console.warn('[CSLab] PDF 页面渲染失败:', renderError)
    })

    return () => {
      cancelled = true
      renderTaskRef.current?.cancel()
      renderTaskRef.current = null
      canvas.width = 0
      canvas.height = 0
      page.cleanup()
    }
  }, [visible, dimensions, scale])

  const pageAnnotations = React.useMemo(
    () => annotations.filter((annotation) => annotation.pageIndex === pageNumber - 1),
    [annotations, pageNumber],
  )

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    // 智脑聚焦选框：任何按下立即消除。
    setFocusBox((current) => (current ? null : current))
    // 仅 Ctrl/Cmd + 左键启动框选；普通拖动完全放行（浏览/抓手模式由外层容器接管）。
    if (!event.ctrlKey && !event.metaKey) return
    if (event.button !== 0) return
    if (!canvasRef.current || canvasRef.current.width === 0) return
    const overlay = overlayRef.current
    if (!overlay) return
    const rect = overlay.getBoundingClientRect()
    dragRef.current = { x: event.clientX - rect.left, y: event.clientY - rect.top }
    const initial = { x: dragRef.current.x, y: dragRef.current.y, width: 0, height: 0 }
    selectionRef.current = initial
    setSelection(initial)
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragRef.current) return
    const start = dragRef.current
    const overlay = overlayRef.current
    if (!overlay) return
    const rect = overlay.getBoundingClientRect()
    const currentX = Math.max(0, Math.min(rect.width, event.clientX - rect.left))
    const currentY = Math.max(0, Math.min(rect.height, event.clientY - rect.top))
    const next = {
      x: Math.min(start.x, currentX),
      y: Math.min(start.y, currentY),
      width: Math.abs(currentX - start.x),
      height: Math.abs(currentY - start.y),
    }
    selectionRef.current = next
    setSelection(next)
  }

  const finishSelection = (): void => {
    const start = dragRef.current
    dragRef.current = null
    const overlay = overlayRef.current
    const canvas = canvasRef.current
    if (!start || !overlay || !canvas || !dimensions) {
      selectionRef.current = null
      setSelection(null)
      return
    }
    const current = selectionRef.current
    selectionRef.current = null
    if (!current || current.width < 16 || current.height < 16) {
      setSelection(null)
      return
    }

    const ratioX = canvas.width / (dimensions.width * scale)
    const ratioY = canvas.height / (dimensions.height * scale)
    const cropWidth = Math.max(1, Math.round(current.width * ratioX))
    const cropHeight = Math.max(1, Math.round(current.height * ratioY))
    const offscreen = document.createElement('canvas')
    offscreen.width = cropWidth
    offscreen.height = cropHeight
    const context = offscreen.getContext('2d')
    if (!context) {
      setSelection(null)
      return
    }
    context.drawImage(
      canvas,
      Math.round(current.x * ratioX),
      Math.round(current.y * ratioY),
      cropWidth,
      cropHeight,
      0,
      0,
      cropWidth,
      cropHeight,
    )

    onSelection({
      literatureUri,
      pageIndex: pageNumber - 1,
      pageWidth: dimensions.pageWidth,
      pageHeight: dimensions.pageHeight,
      rect: current,
      cropDataUrl: offscreen.toDataURL('image/png'),
    })
    setSelection(null)
  }

  const width = dimensions ? dimensions.width * scale : 480
  const height = dimensions ? dimensions.height * scale : 640

  return (
    <div
      ref={wrapperRef}
      className={cn(
        'relative shrink-0 rounded-sm bg-cslab-elevated shadow-subtle',
        ctrlHeld && 'cursor-crosshair',
      )}
      style={{ width, height }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishSelection}
      onPointerCancel={() => {
        dragRef.current = null
        selectionRef.current = null
        setSelection(null)
      }}
    >
      <canvas ref={canvasRef} className="block h-full w-full select-none" />
      <div ref={overlayRef} className="pointer-events-none absolute inset-0">
        {focusBox && dimensions && (
          <div
            className="pointer-events-none absolute rounded-[3px] border-2 border-amber-400 bg-amber-300/30"
            style={{
              left: focusBox[0] * width,
              top: focusBox[1] * height,
              width: Math.max(10, (focusBox[2] - focusBox[0]) * width),
              height: Math.max(8, (focusBox[3] - focusBox[1]) * height),
              boxShadow: '0 0 0 3px rgba(251, 191, 36, 0.25)',
              transition: 'opacity 0.6s ease 3.2s',
              opacity: 1,
            }}
          />
        )}
        {pageAnnotations.map((annotation) => {
          const rects = annotation.position?.rects ?? annotation.rects
          const rotation = annotation.position?.rotation ?? 0
          return rects.map((rect, index) => {
            const mapped = zoteroRectToViewport(
              rect,
              {
                width: dimensions?.pageWidth ?? 1,
                height: dimensions?.pageHeight ?? 1,
              },
              scale,
              rotation,
            )
            const color = annotation.color || '#ffd400'
            return (
              <div
                key={`${annotation.key}-${index}`}
                className="pointer-events-none absolute rounded-[2px]"
                title={[annotation.text, annotation.comment].filter(Boolean).join(' · ')}
                style={{
                  left: mapped.left,
                  top: mapped.top,
                  width: mapped.width,
                  height: mapped.height,
                  backgroundColor: `${color}2e`,
                  border: `1px solid ${color}88`,
                }}
              />
            )
          })
        })}

        {selection && (
          <>
            <div
              className="pointer-events-none absolute border border-dashed border-cslab-accent bg-cslab-accent/5"
              style={{
                left: selection.x,
                top: selection.y,
                width: selection.width,
                height: selection.height,
              }}
            />
            <span
              className="pointer-events-none absolute bg-cslab-accent"
              style={{ left: selection.x - 4, top: selection.y - 4, width: 8, height: 1 }}
            />
            <span
              className="pointer-events-none absolute bg-cslab-accent"
              style={{ left: selection.x - 4, top: selection.y - 4, width: 1, height: 8 }}
            />
          </>
        )}
      </div>
    </div>
  )
}
