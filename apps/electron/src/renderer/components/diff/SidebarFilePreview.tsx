/**
 * SidebarFilePreview — 右侧边栏中的文件预览宿主（Agent 模式 / AI 速课堂共用）
 *
 * 数据源：会话级 previewFileMapAtom（sessionId → PreviewFile | null）。
 * 内容统一由只读的 DiffTabContent 渲染（PDF / Silurus Office / 图片 / Markdown / 代码 / Diff）。
 * 顶部提供紧凑的文件名、路径复制、外部默认应用打开、在文件夹中显示与关闭预览按钮。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { ArrowLeft, FolderOpen } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@profer/ui/primitives/tooltip'
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

export function SidebarFilePreview({ sessionId, closeToTab = 'changes' }: SidebarFilePreviewProps): React.ReactElement {
  const [previewFileMap, setPreviewFileMap] = useAtom(previewFileMapAtom)
  const sessionPathMap = useAtomValue(agentSessionPathMapAtom)
  const setDiffPanelTabMap = useSetAtom(agentDiffPanelTabAtom)
  const activeView = useAtomValue(activeViewAtom)
  const cdutSubView = useAtomValue(cdutSubViewAtom)

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
    </div>
  )
}
