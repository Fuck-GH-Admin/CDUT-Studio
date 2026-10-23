/**
 * AiClassView — CDUT 专区「AI速课堂」专属业务界面
 *
 * 视口约束型布局（h-full overflow-hidden flex），禁止全局滚动条，内部按区域自适应：
 *   - 左栏（w-80）：课程资料拖拽上传 + 已上传资料（最大高度自适应）+ 现代节点图「资料树」；
 *   - 中栏（flex-1）：速课堂专属对话面板（AiClassChatPanel），剥离热力图与通用技术提示；
 *   - 右栏（w-72，默认展开）：预留扩展区。
 *
 * 各模块标题统一居中排版并搭配微胶囊底色；状态全量走 Jotai 原子。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  FileText,
  Loader2,
  Trash2,
  Upload,
} from 'lucide-react'
import { toast } from 'sonner'
import type { StudyDocumentOutline } from '@profer/shared'
import { ALLOWED_STUDY_EXTENSIONS } from '@profer/shared'
import { cn } from '@/lib/utils'
import { activeSessionIdAtom } from '@/atoms/tab-atoms'
import {
  studyActiveDocumentIdAtom,
  studyDocumentsAtom,
  studyIngestingAtom,
  studyLeftPanelCollapsedAtom,
  studyRightPanelCollapsedAtom,
  studyRightPanelWidthAtom,
} from '@/atoms/study-atoms'
import { useOpenPreview } from '@/components/diff/preview-opener'
import { AiClassChatPanel } from './AiClassChatPanel'
import { AiClassKnowledgeTree } from './AiClassKnowledgeTree'
import { AiClassStudyOverview } from './AiClassStudyOverview'
import { AiClassCognitionButton } from './AiClassCognitionButton'
import { AiClassCognitionModal } from './AiClassCognitionModal'
import { AiClassRightTabs } from './ai-class-tabs/AiClassRightTabs'

/** 支持上传的资料扩展名（与白名单同源，用于 file input accept 提示） */
const ACCEPT_EXTENSIONS = ALLOWED_STUDY_EXTENSIONS.join(',')

export function AiClassView(): React.ReactElement {
  const sessionId = useAtomValue(activeSessionIdAtom)
  const [documents, setDocuments] = useAtom(studyDocumentsAtom)
  const [activeDocumentId, setActiveDocumentId] = useAtom(studyActiveDocumentIdAtom)
  const [leftCollapsed, setLeftCollapsed] = useAtom(studyLeftPanelCollapsedAtom)
  const [rightCollapsed, setRightCollapsed] = useAtom(studyRightPanelCollapsedAtom)
  const [rightWidth, setRightWidth] = useAtom(studyRightPanelWidthAtom)
  const setIngesting = useSetAtom(studyIngestingAtom)
  const ingesting = useAtomValue(studyIngestingAtom)
  const openPreview = useOpenPreview()

  // 右栏左边缘拖拽调宽（320px ~ 60vw），松手后持久化
  const startRightPanelResize = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = rightWidth
    const maxWidth = Math.max(320, Math.floor(window.innerWidth * 0.6))
    const onMove = (ev: MouseEvent): void => {
      const next = Math.min(maxWidth, Math.max(320, startWidth - (ev.clientX - startX)))
      setRightWidth(next)
    }
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [rightWidth, setRightWidth])

  const [dragging, setDragging] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  const activeDocument = React.useMemo(
    () => documents.find((doc) => doc.documentId === activeDocumentId) ?? documents[0] ?? null,
    [documents, activeDocumentId],
  )

  // 挂载时加载当前会话已索引的学习资料
  React.useEffect(() => {
    if (!sessionId) return
    let alive = true
    window.electronAPI.study
      .listDocuments(sessionId)
      .then((outlines) => {
        if (!alive) return
        setDocuments(outlines)
        setActiveDocumentId((current) => current ?? outlines[0]?.documentId ?? null)
      })
      .catch((error) => console.warn('[AI速课堂] 加载学习资料失败:', error))
    return () => {
      alive = false
    }
  }, [sessionId, setActiveDocumentId, setDocuments])

  /** 导入并解析一批资料文件 */
  const ingestPaths = React.useCallback(
    async (filePaths: string[]): Promise<void> => {
      if (!sessionId || filePaths.length === 0) return
      setIngesting(true)
      try {
        const outlines = await window.electronAPI.study.ingestDocuments({ sessionId, filePaths })
        if (outlines.length > 0) {
          setDocuments((prev) => [
            ...prev,
            ...outlines.filter((doc: StudyDocumentOutline) => !prev.some((item) => item.documentId === doc.documentId)),
          ])
          setActiveDocumentId(outlines[0]!.documentId)
        }
      } catch (error) {
        console.error('[AI速课堂] 解析学习资料失败:', error)
      } finally {
        setIngesting(false)
      }
    },
    [sessionId, setActiveDocumentId, setDocuments, setIngesting],
  )

  /**
   * 上传前置拦截：
   *   - 仅保留白名单格式纯化（非白名单直接过滤并告警）；
   *   - 资料份数与单文件体积限制已全量解除，支持无上限批量导入超大文件。
   */
  const validateIncomingFiles = React.useCallback((files: File[]): string[] => {
    if (files.length === 0) return []
    const accepted: File[] = []
    let invalidCount = 0
    for (const file of files) {
      const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
      if (!(ALLOWED_STUDY_EXTENSIONS as readonly string[]).includes(ext)) {
        invalidCount++
        continue
      }
      accepted.push(file)
    }
    if (invalidCount > 0) toast.error(`已过滤 ${invalidCount} 个不支持的文件格式`)

    return accepted
      .map((file) => window.electronAPI.getPathForFile(file))
      .filter((path): path is string => Boolean(path))
  }, [])

  const handleDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setDragging(false)
    const paths = validateIncomingFiles(Array.from(event.dataTransfer.files))
    void ingestPaths(paths)
  }

  const handleFilePick = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const paths = validateIncomingFiles(Array.from(event.target.files ?? []))
    event.target.value = ''
    void ingestPaths(paths)
  }

  const handleRemove = async (documentId: string): Promise<void> => {
    if (!sessionId) return
    try {
      await window.electronAPI.study.removeDocument({ sessionId, documentId })
    } catch (error) {
      console.warn('[AI速课堂] 移除资料失败:', error)
    }
    setDocuments((prev) => prev.filter((doc) => doc.documentId !== documentId))
    setActiveDocumentId((current) => (current === documentId ? null : current))
  }

  /**
   * 切换单份资料的激活（勾选）状态。
   * 采用乐观更新即时反馈，失败时回滚；激活状态由主进程落盘持久化，
   * 未勾选的资料将被静默排除在 RAG 检索与提示词注入之外。
   */
  const handleToggleActive = async (document: StudyDocumentOutline): Promise<void> => {
    if (!sessionId) return
    const nextEnabled = document.enabled === false
    const applyState = (enabled: boolean): void => {
      setDocuments((prev) =>
        prev.map((doc) => (doc.documentId === document.documentId ? { ...doc, enabled } : doc)),
      )
    }
    applyState(nextEnabled)
    try {
      await window.electronAPI.study.toggleDocumentActive({
        sessionId,
        documentId: document.documentId,
        enabled: nextEnabled,
      })
    } catch (error) {
      console.warn('[AI速课堂] 切换资料激活状态失败:', error)
      applyState(!nextEnabled)
    }
  }

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden">
      {/* ===== 左栏：课程资料与资料树 =====
          收起时保留 44px 可见窄轨（含醒目的竖向「展开」按钮），
          杜绝「收起后整栏消失、用户再也找不到入口」的历史问题。 */}
      <aside
        className={cn(
          'flex shrink-0 flex-col overflow-hidden border-r border-border/60 bg-card/40 transition-[width] duration-300',
          leftCollapsed ? 'w-11' : 'w-80',
        )}
      >
        {leftCollapsed ? (
          <div className="flex h-full flex-col items-center gap-3 py-3">
            <button
              type="button"
              onClick={() => setLeftCollapsed(false)}
              title="展开「课程资料与大纲向导」"
              aria-label="展开课程资料与大纲向导"
              className="flex flex-col items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-1.5 py-2.5 text-primary transition-all hover:border-primary/50 hover:bg-primary/20 active:scale-95"
            >
              <ChevronRight size={16} />
              <span className="text-[10px] font-semibold leading-tight [writing-mode:vertical-rl]">展开向导</span>
            </button>
          </div>
        ) : (
          <>
        {/* 标题行：左侧醒目的收起按钮（常驻可见，配文字说明） */}
        <div className="flex shrink-0 items-center gap-2 px-3 py-2.5">
          <button
            type="button"
            onClick={() => setLeftCollapsed(true)}
            title="收起「课程资料与大纲向导」"
            aria-label="收起课程资料与大纲向导"
            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border/60 bg-background/70 px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
          >
            <ChevronLeft size={14} />
            <span>收起</span>
          </button>
          <span className="inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold tracking-tight text-primary">
            <BookOpen size={14} />
            <span className="truncate">课程资料与大纲向导</span>
          </span>
        </div>

        {/* 拖拽上传区 */}
        <div className="shrink-0 px-3">
          <div
            onDragOver={(event) => {
              event.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={cn(
              'flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed px-3 py-5 text-center transition-colors',
              dragging ? 'border-primary bg-primary/5' : 'border-border/70 hover:border-primary/50 hover:bg-muted/40',
            )}
          >
            {ingesting ? (
              <Loader2 size={18} className="animate-spin text-primary" />
            ) : (
              <Upload size={18} className="text-muted-foreground" />
            )}
            <p className="text-[11px] font-medium text-foreground">
              {ingesting ? '正在解析资料大纲…' : '拖拽或点击上传学习资料'}
            </p>
            <p className="text-[10px] leading-normal text-muted-foreground">
              PPT / PDF / Word / Excel / MD / 图片均支持
            </p>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPT_EXTENSIONS}
              className="hidden"
              onChange={handleFilePick}
            />
          </div>
        </div>

        {/* ===== 侧边栏下半部内容区：已上传资料 1 份 / 资料树 2 份垂直弹性分割 =====
            资料树享有更大展示面积（历史反馈：资料树区域过小），
            已上传资料列表改为固定上限高度 + 内部滚动，不再与资料树平分高度。 */}
        <div className="mt-3 flex min-h-0 flex-1 flex-col gap-3 px-3">
          {/* 已上传资料列表（弹性权重 1，最高 240px，超出内部滚动） */}
          <div data-tour="ai-class-documents" className="flex max-h-[240px] min-h-0 flex-[1] flex-col">
            <div className="mb-1.5 flex shrink-0 items-center justify-center gap-2">
              <span className="inline-flex items-center rounded-full bg-muted/60 px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                已上传资料
              </span>
              <span className="text-[10px] text-muted-foreground/70">{documents.length}</span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-0.5">
              {documents.length === 0 ? (
                <p className="rounded-lg bg-muted/40 px-2 py-2 text-[11px] text-muted-foreground">暂无资料，先上传课件或教材。</p>
              ) : (
                documents.map((doc) => {
                  const docEnabled = doc.enabled !== false
                  return (
                    <div
                      key={doc.documentId}
                      className={cn(
                        'group/doc flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors',
                        activeDocument?.documentId === doc.documentId
                          ? 'bg-primary/10 ring-1 ring-primary/30'
                          : 'hover:bg-muted/60',
                        !docEnabled && 'opacity-45',
                      )}
                    >
                      {/* 激活记忆勾选框：未勾选资料静默排除出检索与上下文注入 */}
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={docEnabled}
                        title={docEnabled ? '已激活：参与检索与讲解（点击停用）' : '已停用：排除出检索与讲解（点击激活）'}
                        onClick={() => void handleToggleActive(doc)}
                        className={cn(
                          'flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors',
                          docEnabled
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-border bg-background text-transparent hover:border-primary/60',
                        )}
                      >
                        <Check size={11} strokeWidth={3} />
                      </button>
                      <button
                        type="button"
                        data-document-name={doc.fileName}
                        onClick={() => {
                          setActiveDocumentId(doc.documentId)
                          // 点击课件同时在其右侧预览栏打开高保真只读预览
                          if (sessionId && doc.sourcePath) {
                            openPreview(sessionId, { filePath: doc.sourcePath, previewOnly: true, readOnly: true })
                          }
                        }}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <FileText size={14} className="shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[11px] font-medium text-foreground">{doc.fileName}</span>
                          <span className="block text-[10px] text-muted-foreground">
                            {doc.totalSections} 章 · {doc.totalChars} 字
                            {docEnabled ? '' : ' · 已停用'}
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleRemove(doc.documentId)}
                        title="移除该资料"
                        className="shrink-0 rounded p-1 text-muted-foreground/60 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover/doc:opacity-100"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  )
                })
              )}
            </div>
          </div>

          {/* 「学习情况速览」卡片：严格位于「已上传资料」与「资料树」之间 */}
          {sessionId && <AiClassStudyOverview sessionId={sessionId} />}

          {/* 资料树（弹性权重 2：占据剩余主要面积，标题自然落在侧边栏纵向中部） */}
          <div className="flex min-h-0 flex-[2] flex-col pb-3">
            {sessionId ? (
              <AiClassKnowledgeTree sessionId={sessionId} />
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-dashed border-border/60 bg-muted/20 p-3 text-center">
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  新建或选择课堂后，此处将生成现代节点风格资料树。
                </p>
              </div>
            )}
          </div>
        </div>
          </>
        )}
      </aside>

      {/* ===== 中栏：速课堂专属对话面板 ===== */}
      <section className="relative flex min-w-0 flex-1 flex-col bg-content-area">
        {/* 右上角：认知底座双引擎快捷入口胶囊 */}
        <AiClassCognitionButton />
        <AiClassCognitionModal />
        {sessionId ? (
          <AiClassChatPanel sessionId={sessionId} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
            <BookOpen size={28} className="text-muted-foreground/50" />
            <p className="text-sm font-medium text-foreground">还没有进入任何课堂</p>
            <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
              点击顶栏【切换课堂】新建或选择一节课堂，即可开启沉浸式带教。
            </p>
          </div>
        )}
      </section>

      {/* ===== 右栏：可折叠留白边栏（默认展开） =====
          背景采用与底部输入框一致的「半透明 + 背景模糊」毛玻璃质感，
          使其对左下角落款立绘（恐龙娘）的遮挡观感与输入框保持一致 */}
      <aside
        className={cn(
          'relative flex shrink-0 flex-col border-l border-border/60 bg-background/70 backdrop-blur-sm',
          rightCollapsed ? 'w-11 transition-[width] duration-300' : '',
        )}
        style={rightCollapsed ? undefined : { width: rightWidth }}
      >
        {/* 左边缘拖拽调宽把手（仅展开态；开关按钮已移入面板内部，避免碰撞） */}
        {!rightCollapsed && (
          <div
            onMouseDown={startRightPanelResize}
            role="separator"
            aria-orientation="vertical"
            aria-label="调整课程资料预览栏宽度"
            className="absolute -left-1 top-0 bottom-0 z-20 w-2 cursor-col-resize"
          />
        )}
        {rightCollapsed ? (
          /* 折叠态：竖向窄轨垂直居中放置**醒目**展开按钮（带竖向文字，杜绝找不到入口） */
          <div className="flex min-h-0 flex-1 items-start justify-center pt-3">
            <button
              type="button"
              onClick={() => setRightCollapsed((value) => !value)}
              title="展开「学习工作台」"
              aria-label="展开学习工作台"
              className="flex flex-col items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-1.5 py-2.5 text-primary transition-all hover:border-primary/50 hover:bg-primary/20 active:scale-95"
            >
              <ChevronLeft size={16} />
              <span className="text-[10px] font-semibold leading-tight [writing-mode:vertical-rl]">展开工作台</span>
            </button>
          </div>
        ) : (
          <>
            {/* 展开态：面板头部常驻「收起」按钮（带文字说明，不再是隐蔽的单个箭头） */}
            <div className="flex shrink-0 items-center justify-between gap-2 px-2 pt-2">
              <span className="inline-flex items-center rounded-full bg-muted/60 px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                学习工作台
              </span>
              <button
                type="button"
                onClick={() => setRightCollapsed((value) => !value)}
                title="收起「学习工作台」"
                aria-label="收起学习工作台"
                className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border/60 bg-background/70 px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
              >
                <span>收起</span>
                <ChevronRight size={14} />
              </button>
            </div>
            {sessionId ? (
              <AiClassRightTabs sessionId={sessionId} />
            ) : (
              <div className="flex min-h-0 flex-1 flex-col p-3">
                <div className="mt-2 flex min-h-0 flex-1 items-center justify-center rounded-xl border border-dashed border-border/60 bg-muted/20 text-center">
                  <p className="px-4 text-[11px] leading-relaxed text-muted-foreground">
                    进入课堂后，右侧将呈现 Chrome 风格多标签工作台（导图 / 预览 / 抽认卡 / 测验）。
                  </p>
                </div>
              </div>
            )}
          </>
        )}
      </aside>
    </div>
  )
}
