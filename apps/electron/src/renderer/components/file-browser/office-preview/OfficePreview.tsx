import * as React from 'react'
import { useAtom } from 'jotai'
import { AlertCircle, Loader2, RefreshCw } from 'lucide-react'
import type { AgentFilePreviewReport, FileAccessOptions } from '@profer/shared'
import { Button } from '@profer/ui/primitives/button'
import { documentHighlightTargetAtom } from '@/atoms/preview-atoms'
import { getFileBaseName } from '@/lib/file-utils'
import { usePreviewViewport } from '@/components/diff/preview-viewport-context'
import {
  applyOfficeCitationSpotlight,
  clampOfficeScale,
  createOfficeViewer,
  destroyOfficeViewer,
  normalizeOfficeFormat,
  type OfficeFormat,
  type OfficeViewerHandle,
} from './silurus-bridge'
import { registerOfficialPptxPreview } from './official-preview-session'

interface OfficePreviewProps {
  filePath: string
  fileName?: string
  access?: FileAccessOptions
  className?: string
  /** Silurus 失败后的旧 HTML 预览。组件会在回退前销毁 viewer。 */
  fallback?: React.ReactNode
  onError?: (error: Error) => void
  onReady?: () => void
  /** 仅由 Agent 正式 PPTX 预览请求传入；绑定同一用户可见 viewer 的回执与观察。 */
  agentPreviewSession?: { sessionId: string; requestId: string; revision: string }
}

type Status = 'loading' | 'ready' | 'error'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Office 文件解析失败'
}

export function OfficePreview({
  filePath,
  fileName = filePath,
  access,
  className,
  fallback,
  onError,
  onReady,
  agentPreviewSession,
}: OfficePreviewProps): React.ReactElement {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const viewerHostRef = React.useRef<HTMLDivElement>(null)
  const viewerRef = React.useRef<OfficeViewerHandle | null>(null)
  const [status, setStatus] = React.useState<Status>('loading')
  const [error, setError] = React.useState('')
  const [sourceUrl, setSourceUrl] = React.useState('')
  const [retryVersion, setRetryVersion] = React.useState(0)
  const [highlightTarget, setHighlightTarget] = useAtom(documentHighlightTargetAtom)
  // 右侧栏预览视口上下文：把缩放/平移代理给 Silurus viewer 原生实现，
  // 避免视口对整屏做 CSS 缩放（会把 Excel 行列号栏、底部缩放条一起缩放）。
  const previewViewport = usePreviewViewport()
  const previewViewportRef = React.useRef(previewViewport)
  previewViewportRef.current = previewViewport
  const format = normalizeOfficeFormat(fileName)
  const previewSessionId = agentPreviewSession?.sessionId
  const previewRequestId = agentPreviewSession?.requestId
  const previewRevision = agentPreviewSession?.revision
  const callbacksRef = React.useRef({ onError, onReady })
  callbacksRef.current = { onError, onReady }
  const registrationCleanupRef = React.useRef<(() => void) | null>(null)
  const currentSlideRef = React.useRef(1)
  const scaleRef = React.useRef<number | undefined>(undefined)
  /** 当前已挂载圈选框的销毁句柄（含 ResizeObserver/MutationObserver 清理） */
  const spotlightDisposeRef = React.useRef<(() => void) | null>(null)

  const reportPreview = React.useCallback((partial: Pick<AgentFilePreviewReport, 'status'> & Partial<AgentFilePreviewReport>) => {
    if (!previewSessionId || !previewRequestId || !previewRevision || format !== 'pptx') return
    void window.electronAPI.reportAgentFilePreview({
      requestId: previewRequestId,
      sessionId: previewSessionId,
      filePath,
      revision: previewRevision,
      currentSlide: currentSlideRef.current,
      scale: scaleRef.current,
      ...partial,
    }).catch((reportError) => console.error('[OfficePreview] 正式预览回执失败:', reportError))
  }, [filePath, format, previewRequestId, previewRevision, previewSessionId])

  const destroyViewer = React.useCallback(() => {
    registrationCleanupRef.current?.()
    registrationCleanupRef.current = null
    destroyOfficeViewer(viewerRef.current)
    viewerRef.current = null
  }, [])

  const load = React.useCallback(async (signal: AbortSignal, officeFormat: OfficeFormat): Promise<void> => {
    destroyViewer()
    setStatus('loading')
    setError('')
    setSourceUrl('')

    if (officeFormat === 'pptx' && previewRevision) {
      const beforeRevision = await window.electronAPI.getAgentFilePreviewRevision(filePath, access)
      if (beforeRevision !== previewRevision) throw new Error('正式 PPTX 预览已过期：加载前磁盘 revision 与请求不一致')
    }
    const resolved = await window.electronAPI.resolveFilePath(filePath, access)
    if (signal.aborted) return
    if (!resolved?.url) throw new Error('无法读取 Office 文件')
    setSourceUrl(resolved.url)

    const container = viewerHostRef.current
    if (!container) return
    const viewer = await createOfficeViewer(
      officeFormat,
      container,
      resolved.url,
      (scale) => { scaleRef.current = scale; previewViewportRef.current?.reportScale(scale) },
      (viewerError) => {
        // load 阶段的错误会由 createOfficeViewer 抛给外层 catch；这里只处理 ready 后的异步渲染错误。
        if (!signal.aborted && viewerRef.current) {
          registrationCleanupRef.current?.()
          registrationCleanupRef.current = null
          setStatus('error')
          setError(viewerError.message)
          callbacksRef.current.onError?.(viewerError)
          reportPreview({ status: 'error', error: viewerError.message })
        }
      },
      (index) => { currentSlideRef.current = index + 1 },
    )
    if (signal.aborted) {
      destroyOfficeViewer(viewer)
      return
    }
    if (officeFormat === 'pptx' && previewRevision) {
      const afterRevision = await window.electronAPI.getAgentFilePreviewRevision(filePath, access)
      if (afterRevision !== previewRevision) {
        destroyOfficeViewer(viewer)
        throw new Error('正式 PPTX 预览已过期：viewer 加载期间磁盘文件发生变化')
      }
    }
    viewerRef.current = viewer
    scaleRef.current = viewer.getScale?.()
    currentSlideRef.current = 1
    if (officeFormat === 'pptx' && previewSessionId && previewRevision) {
      registrationCleanupRef.current = registerOfficialPptxPreview(previewSessionId, {
        filePath,
        revision: previewRevision,
        viewer,
        host: container,
        getCurrentSlide: () => currentSlideRef.current,
      })
    }
    // 表格以实际已使用区域适配可视空间，避免“适应宽度”仍留下横向滚动条。
    // 随后的 ResizeObserver 会在面板尺寸变化时重新适配。
    if (officeFormat === 'xlsx') viewer.fitPage?.()
    setStatus('ready')
    callbacksRef.current.onReady?.()
    reportPreview({ status: 'ready', slideCount: viewer.slideCount })
  }, [access, destroyViewer, filePath, previewRevision, previewSessionId, reportPreview])

  React.useEffect(() => {
    const controller = new AbortController()
    if (!format) {
      setStatus('error')
      setError('暂不支持此 Office 文件格式')
      return () => controller.abort()
    }

    void load(controller.signal, format).catch((caught: unknown) => {
      if (controller.signal.aborted) return
      destroyViewer()
      const nextError = caught instanceof Error ? caught : new Error(errorMessage(caught))
      setStatus('error')
      setError(nextError.message)
      callbacksRef.current.onError?.(nextError)
      reportPreview({ status: 'error', error: nextError.message })
    })

    return () => {
      controller.abort()
      destroyViewer()
    }
  }, [destroyViewer, filePath, format, load, reportPreview, retryVersion])

  React.useEffect(() => {
    if (format !== 'xlsx' || status !== 'ready' || !containerRef.current) return
    const observer = new ResizeObserver(() => viewerRef.current?.fitPage?.())
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [format, status])

  // 响应聊天中的引用胶囊点击（#f1:p1-b11），自动翻页/切换工作表并渲染琥珀色聚光灯高亮
  React.useEffect(() => {
    if (status !== 'ready' || !format || !highlightTarget) return
    const viewer = viewerRef.current
    const host = viewerHostRef.current
    if (!viewer || !host) return

    const target = highlightTarget
    const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase()
    const isSameFile =
      norm(target.filePath) === norm(filePath) ||
      getFileBaseName(target.filePath).toLowerCase() === getFileBaseName(filePath).toLowerCase()
    if (!isSameFile) return

    let cancelled = false

    const timer = setTimeout(() => {
      if (cancelled || !viewerRef.current || !viewerHostRef.current) return
      // 先销毁上一枚圈选框（含其观察器），再挂载新的，避免 observer 泄漏
      spotlightDisposeRef.current?.()
      spotlightDisposeRef.current = null
      void applyOfficeCitationSpotlight(viewerRef.current, viewerHostRef.current, {
        format,
        pageNumber: target.pageNumber,
        bbox: target.bbox,
        cellRef: target.cellRef,
        label: target.label,
      }).then((dispose) => {
        if (cancelled) {
          dispose()
          return
        }
        spotlightDisposeRef.current = dispose
        // 仅在圈选框成功挂载后才消费本次请求：若提前消费会触发本 effect 清理，
        // 使刚挂载的高亮框被立即销毁（表现为“闪一下但看不到圈选框”）。
        setHighlightTarget((prev) => (prev?.requestId === target.requestId ? null : prev))
      })
    }, 80)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [filePath, format, highlightTarget, setHighlightTarget, status])

  // 组件卸载（切换文件/关闭预览）时销毁当前圈选框
  React.useEffect(() => () => {
    spotlightDisposeRef.current?.()
    spotlightDisposeRef.current = null
  }, [])

  // 向预览视口注册原生缩放控制器：调用 Silurus viewer 的 setScale/fitWidth，
  // 与 viewer 底部缩放条走同一条缩放路径（只有内容区缩放，固定 UI 不动）。
  const scaleViewer = React.useCallback((factor: number): void => {
    const viewer = viewerRef.current
    if (!viewer?.setScale) return
    const current = viewer.getScale?.() ?? scaleRef.current ?? 1
    viewer.setScale(clampOfficeScale(current * factor))
  }, [])

  React.useEffect(() => {
    if (!previewViewport || status !== 'ready') return
    return previewViewport.register({
      zoomIn: () => scaleViewer(1.2),
      zoomOut: () => scaleViewer(1 / 1.2),
      fit: () => {
        const viewer = viewerRef.current
        if (!viewer) return
        if (typeof viewer.fitWidth === 'function') viewer.fitWidth()
        else viewer.fitPage?.()
      },
      reset: () => viewerRef.current?.setScale?.(1),
      getScale: () => scaleRef.current ?? 1,
      setScale: (scale) => {
        const viewer = viewerRef.current
        if (!viewer?.setScale) return
        const clamped = clampOfficeScale(scale)
        viewer.setScale(clamped)
        scaleRef.current = viewer.getScale?.() ?? clamped
      },
    })
  }, [previewViewport, status, scaleViewer])

  if (status === 'error' && fallback) return <>{fallback}</>

  return (
    <div className={`relative flex h-full min-h-0 flex-col bg-surface-raised ${className ?? ''}`}>
      <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden" data-office-format={format ?? undefined} data-office-source={sourceUrl || undefined}>
        <div ref={viewerHostRef} className="relative h-full min-h-0 w-full [&>div]:h-full [&>div]:w-full">
          {status === 'loading' && (
            <div className="flex h-full min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />正在加载 {format?.toUpperCase() ?? 'Office'} 预览
            </div>
          )}
          {status === 'error' && (
            <div className="flex h-full min-h-32 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
              <AlertCircle className="size-5 text-destructive" />
              <span>高保真预览失败：{error}</span>
              <Button variant="outline" size="sm" onClick={() => setRetryVersion((version) => version + 1)}>
                <RefreshCw className="mr-1 size-3.5" />重新加载
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
