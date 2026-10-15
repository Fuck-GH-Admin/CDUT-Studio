/**
 * SidebarFilePreview — 右侧边栏中的文件预览宿主（Agent 模式 / AI 速课堂共用）
 *
 * 数据源：会话级 previewFileMapAtom（sessionId → PreviewFile | null）。
 * 内容统一由只读的 DiffTabContent 渲染（PDF / Silurus Office / 图片 / Markdown / 代码 / Diff）。
 * 顶部提供紧凑的文件名、路径复制、外部默认应用打开、在文件夹中显示、全屏预览与关闭预览按钮。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { ArrowLeft, FolderOpen, Maximize2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@profer/ui/primitives/tooltip'
import { Dialog, DialogContent, DialogTitle } from '@profer/ui/primitives/dialog'
import { toast } from 'sonner'
import { activeViewAtom } from '@/atoms/active-view'
import { cdutSubViewAtom } from '@/atoms/cdut-account-atoms'
import { agentDiffPanelTabAtom, agentSessionPathMapAtom } from '@/atoms/agent-atoms'
import { previewFileMapAtom, previewViewportMemoryKey } from '@/atoms/preview-atoms'
import { getFileBaseName } from '@/lib/file-utils'
import { IMAGE_PREVIEW_EXTS } from '@/lib/preview-extension-sets'
import { cn } from '@/lib/utils'
import { DefaultAppOpenButton } from './DefaultAppOpenButton'
import { DiffTabContent } from './DiffTabContent'
import { InteractivePreviewViewport } from './InteractivePreviewViewport'
import { getDefaultAppTargetPath, getPreviewFileAccess, resolvePreviewDirPath } from './preview-open-path'

interface SidebarFilePreviewProps {
  sessionId: string
  /** 关闭预览时切换到的目标边栏 Tab（默认回文件列表） */
  closeToTab?: 'session' | 'workspace' | 'changes'
}

/**
 * PreviewFullscreenModal — 近全屏比例居中预览弹窗。
 *
 * 深色模糊半透明遮罩 + 88vh/90vw 卡片，内嵌与侧栏同构的高保真查看器
 * （缩放 / 平移 / 搜索 / 工具栏完整保留），ESC 或右上角按钮关闭。
 */
function PreviewFullscreenModal({
  open,
  onOpenChange,
  sessionId,
  filePath,
  dirPath,
  gitRoot,
  previewOnly,
  basePaths,
  baseRef,
  initialTargetLine,
  agentPreviewSession,
  fileName,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionId: string
  filePath: string
  dirPath: string
  gitRoot?: string
  previewOnly?: boolean
  basePaths?: string[]
  baseRef?: string
  initialTargetLine?: number
  agentPreviewSession?: { requestId: string; revision: string }
  fileName: string
}): React.ReactElement {
  // 关闭弹窗即卸载内容，释放大文件预览占用的内存
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent
          hideClose
          overlayClassName="bg-black/70 backdrop-blur-sm"
          className="grid h-[88vh] w-[90vw] max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-2xl border-border/60 bg-card/95 p-0 shadow-2xl backdrop-blur-xl"
        >
          <DialogTitle className="sr-only">文件全屏预览：{fileName}</DialogTitle>
          {/* 顶部悬浮工具条 */}
          <div className="relative z-20 flex h-11 shrink-0 items-center gap-2 border-b border-border/50 px-4">
            <span className="min-w-0 truncate text-xs font-semibold text-foreground" title={filePath}>
              {fileName}
            </span>
            <span className="text-[11px] text-muted-foreground">全屏预览</span>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="ml-auto flex items-center justify-center rounded-full bg-foreground/5 p-1.5 text-foreground/70 transition-colors hover:bg-foreground/15 hover:text-foreground"
              title="关闭（ESC）"
              aria-label="关闭全屏预览"
            >
              <svg viewBox="0 0 24 24" className="size-4 stroke-[2.2] stroke-current fill-none">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          {/* 高保真查看器：完整工具栏（缩放 / 平移 / 搜索） */}
          <div className="min-h-0 overflow-hidden">
            <DiffTabContent
              filePath={filePath}
              dirPath={dirPath}
              sessionId={sessionId}
              gitRoot={gitRoot}
              previewOnly={previewOnly}
              readOnly
              basePaths={basePaths}
              baseRef={baseRef}
              initialTargetLine={initialTargetLine}
              agentPreviewSession={agentPreviewSession}
            />
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  )
}

export function SidebarFilePreview({ sessionId, closeToTab = 'changes' }: SidebarFilePreviewProps): React.ReactElement {
  const [previewFileMap, setPreviewFileMap] = useAtom(previewFileMapAtom)
  const sessionPathMap = useAtomValue(agentSessionPathMapAtom)
  const setDiffPanelTabMap = useSetAtom(agentDiffPanelTabAtom)
  const activeView = useAtomValue(activeViewAtom)
  const cdutSubView = useAtomValue(cdutSubViewAtom)
  const [fullscreenOpen, setFullscreenOpen] = React.useState(false)

  const currentFile = previewFileMap.get(sessionId) ?? null
  const sessionPath = sessionPathMap.get(sessionId) ?? ''
  const inAiClass = activeView === 'cdut-zone' && cdutSubView === 'ai-class'

  const closePreview = React.useCallback(() => {
    if (inAiClass) {
      setPreviewFileMap((prev) => {
        if (!prev.get(sessionId)) return prev
        const next = new Map(prev)
        next.set(sessionId, null)
        return next
      })
      return
    }
    setDiffPanelTabMap((prev) => {
      if (prev.get(sessionId) === closeToTab) return prev
      const next = new Map(prev)
      next.set(sessionId, closeToTab)
      return next
    })
  }, [closeToTab, inAiClass, sessionId, setDiffPanelTabMap, setPreviewFileMap])

  if (!currentFile) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted-foreground">
        <p className="text-[13px] font-medium text-foreground/80">尚未打开任何文件</p>
        <p className="text-muted-foreground/70">
          点击左侧文件、已上传课件，或对话中的引用胶囊，即可在此处对照原文并高亮定位
        </p>
      </div>
    )
  }

  const fileName = getFileBaseName(currentFile.filePath)
  const dirPath = currentFile.dirPath || sessionPath || resolvePreviewDirPath(currentFile.filePath, sessionPath)
  const defaultAppTargetPath = getDefaultAppTargetPath(currentFile, sessionPath)
  const defaultAppAccess = getPreviewFileAccess(sessionId, currentFile, sessionPath)
  const ext = currentFile.filePath.includes('.')
    ? currentFile.filePath.slice(currentFile.filePath.lastIndexOf('.')).toLowerCase()
    : ''
  const isImagePreview = IMAGE_PREVIEW_EXTS.has(ext)

  return (
    <div className={cn('flex h-full flex-col overflow-hidden', !isImagePreview && 'bg-content-area')}>
      <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-border/30 px-2 titlebar-no-drag">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={closePreview}
              className="flex items-center justify-center size-6 shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded transition-colors"
              aria-label="关闭预览"
            >
              <ArrowLeft className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom"><p>{inAiClass ? '关闭预览' : '返回文件列表'}</p></TooltipContent>
        </Tooltip>
        <span className="min-w-0 max-w-[30%] truncate text-xs font-medium text-muted-foreground" title={currentFile.filePath}>
          {fileName}
        </span>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(currentFile.filePath)
              .then(() => toast.success('文件路径复制成功'))
              .catch(() => toast.error('文件路径复制失败'))
          }}
          className="min-w-0 flex-1 truncate text-left text-[11px] text-muted-foreground/65 hover:text-foreground hover:underline underline-offset-2"
          title={`${currentFile.filePath}（点击复制完整路径）`}
        >
          {currentFile.filePath}
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          <DefaultAppOpenButton filePath={defaultAppTargetPath} access={defaultAppAccess} />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setFullscreenOpen(true)}
                className="flex items-center justify-center size-6 shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded transition-colors"
                aria-label="全屏预览"
              >
                <Maximize2 className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p>全屏预览</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => {
                  window.electronAPI.showItemInFolder(defaultAppTargetPath, currentFile.basePaths)
                    .catch((err) => console.error('[SidebarFilePreview] 打开文件位置失败:', err))
                }}
                className="flex items-center justify-center size-6 shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded transition-colors"
                aria-label="打开文件所在位置"
              >
                <FolderOpen className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p>在文件管理器中显示</p></TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <InteractivePreviewViewport
          key={`${sessionId}:${currentFile.filePath}:${currentFile.previewRevision ?? ''}`}
          memoryKey={previewViewportMemoryKey(sessionId, currentFile.filePath)}
        >
          <DiffTabContent
            filePath={currentFile.filePath}
            dirPath={dirPath}
            sessionId={sessionId}
            gitRoot={currentFile.gitRoot}
            previewOnly={currentFile.previewOnly}
            readOnly
            basePaths={currentFile.basePaths}
            baseRef={currentFile.baseRef}
            initialTargetLine={currentFile.initialTargetLine}
            agentPreviewSession={currentFile.previewRequestId && currentFile.previewRevision
              ? { requestId: currentFile.previewRequestId, revision: currentFile.previewRevision }
              : undefined}
            hideToolbar
          />
        </InteractivePreviewViewport>
      </div>

      <PreviewFullscreenModal
        open={fullscreenOpen}
        onOpenChange={setFullscreenOpen}
        sessionId={sessionId}
        filePath={currentFile.filePath}
        dirPath={dirPath}
        gitRoot={currentFile.gitRoot}
        previewOnly={currentFile.previewOnly}
        basePaths={currentFile.basePaths}
        baseRef={currentFile.baseRef}
        initialTargetLine={currentFile.initialTargetLine}
        agentPreviewSession={currentFile.previewRequestId && currentFile.previewRevision
          ? { requestId: currentFile.previewRequestId, revision: currentFile.previewRevision }
          : undefined}
        fileName={fileName}
      />
    </div>
  )
}
