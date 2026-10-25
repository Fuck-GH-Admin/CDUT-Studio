/**
 * CsLabManuscriptEditor — Canvas Word 级论文编辑器外壳
 *
 * 纸张渲染与分页由 CsLabCanvasEditor 负责；本组件只承载：
 * 1. Word Ribbon（开始 / 插入 / 审稿 / 排版与视图）；
 * 2. 标题输入（位于工作区标头，不再占用 A4 纸面）；
 * 3. AI 审稿 → 原生批注注入；
 * 4. 真实页码/字数状态栏与保存/另存为。
 */

import * as React from 'react'
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Minus,
  Save,
  Download,
  Ruler as RulerIcon,
  ZoomIn,
  ZoomOut,
  Sparkles,
  Loader2,
  CheckCircle2,
  FileText,
  ChevronDown,
  Link2,
  MessageSquare,
  Eraser,
  ImagePlus,
  Sigma,
  Hand,
  MousePointer2,
  X,
} from 'lucide-react'
import katex from 'katex'
import DOMPurify from 'dompurify'
import type { CsLabCapsule, CsLabManuscript } from '@profer/shared'
import { cn } from '@/lib/utils'
import { getFileBaseName } from '@/lib/file-utils'
import { CSLAB_CELL_MIME, hasDragType } from './cslab-dnd'
import { CsLabCanvasEditor } from './canvas-manuscript/CsLabCanvasEditor'
import {
  extractCanvasText,
  legacyTipTapToCanvasWithComments,
} from './canvas-manuscript/cslab-canvas-adapter'
import { buildLocalCanvasSuggestions } from './canvas-manuscript/cslab-canvas-comments'
import type {
  CsLabCanvasHandle,
  CsLabCanvasSnapshot,
  CsLabRangeStyle,
} from './canvas-manuscript/cslab-canvas-types'
import {
  CSLAB_PERSONA_META,
  CSLAB_REVIEWER_PERSONAS,
  buildReviewerPromptText,
  parseReviewerJson,
  personaTitle,
} from './cslab-review-personas'
import type { CsLabSuggestionPersona } from '@profer/shared'

interface CsLabManuscriptEditorProps {
  labId: string
  manuscript: CsLabManuscript
  staleCapsuleIds: Set<string>
  saving: boolean
  onEditorReady: (handle: CsLabCanvasHandle | null) => void
  onCapsuleClick: (capsuleId: string) => void
  onSave: (snapshot: CsLabCanvasSnapshot, title: string) => Promise<void>
  onSaveAs?: (snapshot: CsLabCanvasSnapshot, title: string) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  onTitleChange?: (title: string) => void
  onToast?: (kind: 'info' | 'success' | 'error', text: string) => void
  /** 划词右键「检索关联学术文献」反向打开学术检索弹窗。 */
  onSearchLiterature?: (query: string) => void
}

type RibbonTab = 'home' | 'insert' | 'review' | 'view'

const EMPTY_STYLE: CsLabRangeStyle = {
  bold: false,
  italic: false,
  underline: false,
  strikeout: false,
  level: null,
  listType: null,
  undo: false,
  redo: false,
}

function RibbonButton({
  active,
  onClick,
  title,
  shortcut,
  disabled,
  children,
}: {
  active?: boolean
  onClick: () => void
  title: string
  shortcut?: string
  disabled?: boolean
  children: React.ReactNode
}): React.ReactElement {
  return (
    <button
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      title={shortcut ? `${title} (${shortcut})` : title}
      aria-label={title}
      className={cn(
        'flex h-7 items-center justify-center rounded px-2 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        active
          ? 'bg-cslab-accent/15 text-cslab-accent shadow-xs'
          : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100',
      )}
    >
      {children}
    </button>
  )
}

function RibbonDivider(): React.ReactElement {
  return <div className="mx-1 h-5 w-px self-center bg-zinc-200 dark:bg-zinc-800" />
}

/** 常用 LaTeX 公式模板（点击填入输入框，可在其上改写）。 */
const FORMULA_TEMPLATES: Array<{ label: string; latex: string }> = [
  { label: '分式', latex: '\\frac{a}{b}' },
  { label: '积分', latex: '\\int_{a}^{b} f(x)\\,\\mathrm{d}x' },
  { label: '根号', latex: '\\sqrt{x}' },
  { label: '上下标', latex: 'x^{2}_{i}' },
]

/** KaTeX 预览（复用仓库既有 KaTeX + DOMPurify 组合，与 CsLabFormulaPanel 同款写法）。 */
function LatexPreview({ latex }: { latex: string }): React.ReactElement {
  const html = React.useMemo(() => {
    if (!latex.trim()) return ''
    try {
      const rendered = katex.renderToString(latex, {
        throwOnError: false,
        displayMode: true,
        strict: 'ignore',
      })
      return DOMPurify.sanitize(rendered, {
        USE_PROFILES: { html: true, svg: true, mathMl: true },
      })
    } catch {
      return ''
    }
  }, [latex])

  if (!html) {
    return <p className="py-2 text-center text-[10px] text-cslab-muted/70">公式预览</p>
  }
  return (
    <div
      className="overflow-x-auto py-1 text-center text-[13px] text-cslab-text"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

/** 解码 dataURL 的像素尺寸，并等比收敛到正文可用框（794 - 2×96 页边距内）。 */
function measureImage(dataUrl: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => {
      const maxWidth = 560
      const maxHeight = 720
      const scale = Math.min(
        1,
        maxWidth / (image.naturalWidth || 1),
        maxHeight / (image.naturalHeight || 1),
      )
      resolve({
        width: Math.max(1, Math.round((image.naturalWidth || 1) * scale)),
        height: Math.max(1, Math.round((image.naturalHeight || 1) * scale)),
      })
    }
    image.onerror = () => resolve(null)
    image.src = dataUrl
  })
}

export function CsLabManuscriptEditor({
  labId,
  manuscript,
  staleCapsuleIds,
  saving,
  onEditorReady,
  onCapsuleClick,
  onSave,
  onSaveAs,
  onDirtyChange,
  onTitleChange,
  onToast,
  onSearchLiterature,
}: CsLabManuscriptEditorProps): React.ReactElement {
  const [activeTab, setActiveTab] = React.useState<RibbonTab>('home')
  const [title, setTitle] = React.useState(manuscript.title)
  const [dirty, setDirty] = React.useState(false)
  const [showRuler, setShowRuler] = React.useState(true)
  const [zoom, setZoom] = React.useState(100)
  const [lastSavedTime, setLastSavedTime] = React.useState<number | null>(
    manuscript.updatedAt || null,
  )
  const [rangeStyle, setRangeStyle] = React.useState<CsLabRangeStyle>(EMPTY_STYLE)
  const [page, setPage] = React.useState({ current: 1, total: 1 })
  const [metrics, setMetrics] = React.useState({
    words: 0,
    chars: 0,
    capsules: 0,
    comments: 0,
  })
  const [reviewPersona, setReviewPersona] =
    React.useState<Exclude<CsLabSuggestionPersona, 'human'>>('Methodology_Reviewer')
  const [reviewBusy, setReviewBusy] = React.useState(false)
  const [reviewMenuOpen, setReviewMenuOpen] = React.useState(false)
  const [capsuleMenuOpen, setCapsuleMenuOpen] = React.useState(false)
  const [ready, setReady] = React.useState(false)
  const [formulaOpen, setFormulaOpen] = React.useState(false)
  const [formulaText, setFormulaText] = React.useState('E=mc^2')
  const [handTool, setHandTool] = React.useState(false)

  const handleRef = React.useRef<CsLabCanvasHandle | null>(null)
  const lastDirtyRef = React.useRef<boolean | null>(null)
  const lastTitleRef = React.useRef<string | null>(null)
  const handToolRef = React.useRef(false)

  const initial = React.useMemo(() => {
    if (manuscript.canvasData) {
      return {
        canvasData: manuscript.canvasData,
        comments: manuscript.comments ?? [],
      }
    }
    return legacyTipTapToCanvasWithComments(manuscript.docJson)
  }, [manuscript.uri, manuscript.canvasData, manuscript.comments, manuscript.docJson])

  const handleReady = React.useCallback(
    (handle: CsLabCanvasHandle | null): void => {
      handleRef.current = handle
      setReady(!!handle)
      // 文稿切换重建编辑器后恢复抓手态，保持 UI 与引擎一致。
      if (handle && handToolRef.current) handle.setHandTool(true)
      onEditorReady(handle)
    },
    [onEditorReady],
  )

  const handleDirtyChange = React.useCallback((next: boolean): void => {
    setDirty(next)
  }, [])

  React.useEffect(() => {
    if (lastDirtyRef.current === dirty) return
    lastDirtyRef.current = dirty
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  React.useEffect(() => {
    if (lastTitleRef.current === title) return
    lastTitleRef.current = title
    onTitleChange?.(title)
  }, [title, onTitleChange])

  React.useEffect(() => {
    setTitle(manuscript.title)
    setDirty(false)
    setLastSavedTime(manuscript.updatedAt || null)
  }, [manuscript.uri, manuscript.title, manuscript.updatedAt])

  // ===== 保存 =====

  const handleSave = React.useCallback(async (): Promise<void> => {
    const handle = handleRef.current
    if (!handle || saving) return
    const snapshot = handle.getSnapshot()
    await onSave(snapshot, title.trim() || '未命名文稿')
    setDirty(false)
    setLastSavedTime(Date.now())
  }, [onSave, saving, title])

  const handleSaveAs = React.useCallback(async (): Promise<void> => {
    const handle = handleRef.current
    if (!handle || saving) return
    const snapshot = handle.getSnapshot()
    if (onSaveAs) {
      await onSaveAs(snapshot, title.trim() || '未命名文稿')
    } else {
      await onSave(snapshot, title.trim() || '未命名文稿')
    }
    setDirty(false)
    setLastSavedTime(Date.now())
  }, [onSave, onSaveAs, saving, title])

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const isSave = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's'
      if (!isSave) return
      event.preventDefault()
      event.stopPropagation()
      if (event.shiftKey) void handleSaveAs()
      else void handleSave()
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [handleSave, handleSaveAs])

  // ===== 审稿 =====

  const runReview = React.useCallback(
    async (persona: Exclude<CsLabSuggestionPersona, 'human'>): Promise<void> => {
      const handle = handleRef.current
      if (!handle || reviewBusy) return
      const snapshot = handle.getSnapshot()
      const text = extractCanvasText(snapshot.canvasData)
      if (!text.trim()) {
        onToast?.('error', '正文为空，无法审阅')
        return
      }
      setReviewBusy(true)
      try {
        const result = await window.electronAPI.cslab.reviewManuscript({
          labId,
          manuscriptUri: manuscript.uri,
          persona,
          text,
        })
        if (!result.ok) {
          onToast?.('error', result.message)
          return
        }
        if (result.suggestions.length === 0) {
          onToast?.('info', result.message)
          return
        }
        const applied = handle.applyReview(
          result.suggestions.map((suggestion) => ({
            kind: suggestion.kind,
            quote: suggestion.quote,
            replacement: suggestion.replacement,
            comment: suggestion.comment,
            personaTitle: personaTitle(suggestion.persona),
          })),
        )
        if (applied.applied > 0) setDirty(true)
        if (applied.applied === 0) {
          onToast?.(
            'error',
            `${applied.skipped} 条建议未定位到原文片段，已全部收入审阅报告侧栏（不做盲目替换）`,
          )
        } else if (applied.skipped > 0) {
          onToast?.(
            'success',
            `已为 ${applied.applied} 处生成正文批注${applied.fuzzy > 0 ? `（其中 ${applied.fuzzy} 处为模糊定位）` : ''}，${applied.skipped} 处建议已收入审阅报告侧栏`,
          )
        } else {
          onToast?.('success', `已为 ${applied.applied} 处生成正文批注${applied.fuzzy > 0 ? `（其中 ${applied.fuzzy} 处为模糊定位）` : ''}，可在右侧批注轨查看`)
        }
      } catch (error) {
        onToast?.('error', error instanceof Error ? error.message : 'AI 审稿失败')
      } finally {
        setReviewBusy(false)
      }
    },
    [labId, manuscript.uri, onToast, reviewBusy],
  )

  const handleLocalCheck = React.useCallback((): void => {
    const handle = handleRef.current
    if (!handle) return
    const snapshot = handle.getSnapshot()
    const items = buildLocalCanvasSuggestions(
      snapshot.canvasData.main as Parameters<typeof buildLocalCanvasSuggestions>[0],
    )
    if (items.length === 0) {
      onToast?.('success', '本地规则体检未发现明显问题')
      return
    }
    const applied = handle.applyReview(items)
    if (applied.applied > 0) setDirty(true)
    onToast?.(
      applied.applied > 0 ? 'success' : 'error',
      applied.applied > 0
        ? `已生成 ${applied.applied} 条体检批注${applied.skipped > 0 ? `（跳过 ${applied.skipped} 条）` : ''}`
        : '未定位到可批注片段',
    )
  }, [onToast])

  const handleCopyPrompt = React.useCallback(async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(buildReviewerPromptText(reviewPersona))
      onToast?.('success', '审稿指令已复制，可粘贴到任意对话窗口执行')
    } catch {
      onToast?.('error', '剪贴板不可用，请手动复制')
    }
  }, [onToast, reviewPersona])

  const handlePasteSuggestions = React.useCallback(async (): Promise<void> => {
    const handle = handleRef.current
    if (!handle) return
    try {
      const raw = await navigator.clipboard.readText()
      const items = parseReviewerJson(raw, reviewPersona)
      if (items.length === 0) {
        onToast?.('error', '剪贴板中没有可解析的审稿 JSON')
        return
      }
      const applied = handle.applyReview(
        items.map((item) => ({
          kind: item.kind,
          quote: item.quote,
          replacement: item.replacement,
          comment: item.comment,
          personaTitle: personaTitle(item.persona),
        })),
      )
      if (applied.applied > 0) setDirty(true)
      onToast?.(
        applied.applied > 0 ? 'success' : 'error',
        applied.applied > 0
          ? `已生成 ${applied.applied} 条批注${applied.skipped > 0 ? `（跳过 ${applied.skipped} 条）` : ''}`
          : '未定位到原文片段，未产生批注',
      )
    } catch {
      onToast?.('error', '读取剪贴板失败')
    }
  }, [onToast, reviewPersona])

  const handleClearComments = React.useCallback((): void => {
    const handle = handleRef.current
    if (!handle) return
    handle.clearComments()
    setMetrics((previous) => ({ ...previous, comments: 0 }))
    setDirty(true)
    onToast?.('success', '已清空全部批注')
  }, [onToast])

  // ===== 插入：图片 / LaTeX 公式 / 抓手平移 =====

  /** 插入图片：复用全局文件选择通道（openFileDialog）→ base64 dataURL → 引擎 image 元素。 */
  const handleInsertImage = React.useCallback(async (): Promise<void> => {
    const handle = handleRef.current
    if (!handle) return
    try {
      const result = await window.electronAPI.openFileDialog()
      const images = (result.files ?? []).filter((file) => file.mediaType.startsWith('image/'))
      if (images.length === 0) {
        onToast?.('info', '未选择图片文件（支持 png / jpg / jpeg / gif / webp）')
        return
      }
      let inserted = 0
      for (const file of images) {
        const dataUrl = `data:${file.mediaType};base64,${file.data}`
        const size = await measureImage(dataUrl)
        if (!size) continue
        handle.insertImage({ value: dataUrl, width: size.width, height: size.height })
        inserted += 1
      }
      if (inserted > 0) {
        setDirty(true)
        onToast?.('success', `已插入 ${inserted} 张图片`)
      } else {
        onToast?.('error', '图片解码失败，未插入')
      }
    } catch {
      onToast?.('error', '打开文件选择器失败')
    }
  }, [onToast])

  const handleInsertFormula = React.useCallback((): void => {
    const handle = handleRef.current
    const latex = formulaText.trim()
    if (!handle || !latex) return
    handle.insertLatex(latex)
    setFormulaOpen(false)
    setDirty(true)
  }, [formulaText])

  const toggleHandTool = React.useCallback((enabled: boolean): void => {
    handToolRef.current = enabled
    setHandTool(enabled)
    handleRef.current?.setHandTool(enabled)
  }, [])

  // ===== 胶囊 =====

  const handleClickInPaper = (event: React.MouseEvent<HTMLDivElement>): void => {
    const target = (event.target as HTMLElement).closest('[data-capsule-id]')
    const capsuleId = target?.getAttribute('data-capsule-id')
    if (capsuleId) onCapsuleClick(capsuleId)
  }

  const formatLastSaved = (time: number | null): string => {
    if (!time) return '未保存'
    const date = new Date(time)
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    return `${hours}:${minutes}`
  }

  const style = rangeStyle

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#F3F2EE] select-text dark:bg-[#151518]">
      {/* ===== Word Ribbon ===== */}
      <header className="flex shrink-0 flex-col border-b border-[#DDDCD5] bg-[#FBFBFA] shadow-xs dark:border-[#2A2A2E] dark:bg-[#1E1E22]">
        <div className="flex h-9 items-center justify-between gap-3 border-b border-zinc-200/80 px-3 dark:border-zinc-800">
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <span className="mr-1 inline-flex shrink-0 items-center gap-1 font-serif text-[12px] font-semibold tracking-wider text-cslab-accent uppercase">
              <FileText size={13} />
              CSLab Word
            </span>
            <input
              value={title}
              onChange={(event) => {
                setTitle(event.target.value)
                setDirty(true)
              }}
              placeholder="键入论文标题…"
              aria-label="论文标题"
              className="h-7 min-w-0 max-w-[420px] flex-1 rounded border border-transparent bg-transparent px-2 font-serif text-[13px] font-semibold text-zinc-900 transition-colors placeholder:text-zinc-300 hover:border-zinc-200 focus:border-cslab-accent/40 focus:bg-white focus:outline-none dark:text-zinc-100 dark:placeholder:text-zinc-600 dark:hover:border-zinc-700 dark:focus:bg-zinc-900"
            />
            <span className="ml-1 hidden shrink-0 font-mono text-[10px] text-zinc-400 sm:inline">
              {getFileBaseName(manuscript.uri)}
            </span>
            <div className="ml-2 flex items-center gap-1">
              {(['home', 'insert', 'review', 'view'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveTab(tab)}
                  className={cn(
                    'relative h-9 px-3 text-[12px] font-medium transition-colors',
                    activeTab === tab
                      ? 'font-semibold text-zinc-900 after:absolute after:bottom-0 after:left-0 after:h-[2px] after:w-full after:bg-cslab-accent dark:text-zinc-100'
                      : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200',
                  )}
                >
                  {{ home: '开始', insert: '插入', review: '审稿', view: '排版' }[tab]}
                </button>
              ))}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <div className="relative">
              <button
                type="button"
                disabled={!ready || reviewBusy}
                onClick={() => {
                  setCapsuleMenuOpen(false)
                  setReviewMenuOpen((value) => !value)
                }}
                className="inline-flex h-6 items-center gap-1 rounded border border-cslab-accent/40 bg-cslab-accent/10 px-2 text-[11px] font-medium text-cslab-accent transition-colors hover:bg-cslab-accent/15 disabled:cursor-not-allowed disabled:opacity-50"
                title="选择 AI 审稿专家，对正文生成原生批注"
              >
                {reviewBusy ? (
                  <Loader2 size={10} className="animate-spin" />
                ) : (
                  <Sparkles size={10} />
                )}
                AI 审稿专家体检
                <ChevronDown size={10} />
              </button>
              {reviewMenuOpen && (
                <div className="absolute right-0 top-full z-40 mt-1 w-56 rounded-lg border border-cslab-border bg-cslab-elevated py-1 shadow-subtle">
                  {CSLAB_REVIEWER_PERSONAS.map((persona) => {
                    const meta = CSLAB_PERSONA_META[persona]
                    return (
                      <button
                        key={persona}
                        type="button"
                        onClick={() => {
                          setReviewMenuOpen(false)
                          setReviewPersona(persona)
                          void runReview(persona)
                        }}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
                      >
                        <span
                          className="inline-block size-2 rounded-full"
                          style={{ background: meta.color }}
                        />
                        {meta.title}
                      </button>
                    )
                  })}
                  <div className="my-1 h-px bg-cslab-border" />
                  <button
                    type="button"
                    onClick={() => {
                      setReviewMenuOpen(false)
                      handleLocalCheck()
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-zinc-600 transition-colors hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  >
                    <CheckCircle2 size={10} />
                    本地确定性体检
                  </button>
                </div>
              )}
            </div>

            <div className="relative">
              <button
                type="button"
                disabled={manuscript.capsules.length === 0}
                onClick={() => {
                  setReviewMenuOpen(false)
                  setCapsuleMenuOpen((value) => !value)
                }}
                className="inline-flex h-6 items-center gap-1 rounded border border-zinc-300 bg-white px-2 text-[11px] font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                title="查看已保存胶囊的数据血缘"
              >
                <Link2 size={10} />
                胶囊血缘
                <ChevronDown size={10} />
              </button>
              {capsuleMenuOpen && (
                <div className="absolute right-0 top-full z-40 mt-1 max-h-64 w-60 overflow-auto rounded-lg border border-cslab-border bg-cslab-elevated py-1 shadow-subtle">
                  {manuscript.capsules.map((capsule: CsLabCapsule) => (
                    <button
                      key={capsule.id}
                      type="button"
                      onClick={() => {
                        setCapsuleMenuOpen(false)
                        onCapsuleClick(capsule.id)
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
                    >
                      <Link2 size={10} className="shrink-0 text-cslab-accent" />
                      <span className="min-w-0 flex-1 truncate">{capsule.label}</span>
                      <span className="shrink-0 font-mono tabular-nums text-cslab-muted">
                        {capsule.value}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving || !ready}
              title="保存到工作区 (Ctrl+S)"
              className="inline-flex h-6 items-center gap-1.5 rounded bg-cslab-accent px-2.5 text-[11px] font-medium text-white shadow-xs transition-colors hover:bg-cslab-accentHover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
              保存
            </button>
            <button
              type="button"
              onClick={() => void handleSaveAs()}
              disabled={saving || !ready}
              title="另存为外部文件 (.docx / .md) (Ctrl+Shift+S)"
              className="inline-flex h-6 items-center gap-1.5 rounded border border-zinc-300 bg-white px-2.5 text-[11px] font-medium text-zinc-700 shadow-2xs transition-colors hover:bg-zinc-50 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
            >
              <Download size={11} />
              另存为…
            </button>
          </div>
        </div>

        {/* Ribbon 工具操作台 */}
        <div className="flex h-10 items-center gap-1 overflow-x-auto px-3 py-1 text-zinc-700 dark:text-zinc-300">
          {activeTab === 'home' && (
            <>
              <RibbonButton
                title="加粗"
                shortcut="Ctrl+B"
                active={style.bold}
                onClick={() => handleRef.current?.bold()}
              >
                <Bold size={13} />
              </RibbonButton>
              <RibbonButton
                title="斜体"
                shortcut="Ctrl+I"
                active={style.italic}
                onClick={() => handleRef.current?.italic()}
              >
                <Italic size={13} />
              </RibbonButton>
              <RibbonButton
                title="下划线"
                shortcut="Ctrl+U"
                active={style.underline}
                onClick={() => handleRef.current?.underline()}
              >
                <Underline size={13} />
              </RibbonButton>
              <RibbonButton
                title="删除线"
                active={style.strikeout}
                onClick={() => handleRef.current?.strikeout()}
              >
                <Strikethrough size={13} />
              </RibbonButton>

              <RibbonDivider />

              <RibbonButton
                title="正文段落"
                active={style.level === null}
                onClick={() => handleRef.current?.title(null)}
              >
                <span className="text-[11px]">正文</span>
              </RibbonButton>
              <RibbonButton
                title="一级标题 (Heading 1)"
                active={style.level === 'first'}
                onClick={() => handleRef.current?.title('first')}
              >
                <Heading1 size={13} />
              </RibbonButton>
              <RibbonButton
                title="二级标题 (Heading 2)"
                active={style.level === 'second'}
                onClick={() => handleRef.current?.title('second')}
              >
                <Heading2 size={13} />
              </RibbonButton>
              <RibbonButton
                title="三级标题 (Heading 3)"
                active={style.level === 'third'}
                onClick={() => handleRef.current?.title('third')}
              >
                <Heading3 size={13} />
              </RibbonButton>

              <RibbonDivider />

              <RibbonButton
                title="无序列表"
                active={style.listType === 'ul'}
                onClick={() => handleRef.current?.list('ul')}
              >
                <List size={13} />
              </RibbonButton>
              <RibbonButton
                title="有序列表"
                active={style.listType === 'ol'}
                onClick={() => handleRef.current?.list('ol')}
              >
                <ListOrdered size={13} />
              </RibbonButton>
              <RibbonButton
                title="分割线"
                onClick={() => handleRef.current?.separator()}
              >
                <Minus size={13} />
              </RibbonButton>
            </>
          )}

          {activeTab === 'insert' && (
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded bg-cslab-accent/10 px-2.5 py-1 text-[11px] font-medium text-cslab-accent">
                <Sparkles size={12} />
                活体数据胶囊：直接从右侧数据表拖入任意单元格即可插入
              </span>
              <RibbonDivider />
              <RibbonButton
                title="插入图片（本地文件 → 正文）"
                disabled={!ready}
                onClick={() => void handleInsertImage()}
              >
                <ImagePlus size={13} />
                <span className="ml-1 text-[11px]">图片</span>
              </RibbonButton>
              <div className="relative">
                <RibbonButton
                  title="插入 LaTeX 公式"
                  disabled={!ready}
                  active={formulaOpen}
                  onClick={() => setFormulaOpen((value) => !value)}
                >
                  <Sigma size={13} />
                  <span className="ml-1 text-[11px]">公式</span>
                </RibbonButton>
                {formulaOpen && (
                  <div className="absolute left-0 top-full z-40 mt-1 w-80 rounded-lg border border-cslab-border bg-cslab-elevated p-2.5 shadow-subtle">
                    <div className="flex items-center justify-between">
                      <p className="text-[11px] font-medium text-cslab-text">插入 LaTeX 公式</p>
                      <button
                        type="button"
                        aria-label="关闭公式面板"
                        onClick={() => setFormulaOpen(false)}
                        className="rounded p-0.5 text-cslab-muted transition-colors hover:bg-cslab-surface hover:text-cslab-text"
                      >
                        <X size={11} />
                      </button>
                    </div>
                    <textarea
                      value={formulaText}
                      onChange={(event) => setFormulaText(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault()
                          handleInsertFormula()
                        }
                      }}
                      rows={2}
                      placeholder="输入 LaTeX，例如 E=mc^2"
                      aria-label="LaTeX 公式"
                      className="mt-2 w-full resize-none rounded-md border border-cslab-border bg-cslab-bg px-2 py-1.5 font-mono text-[11px] text-cslab-text outline-none focus:border-cslab-accent/40"
                    />
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      {FORMULA_TEMPLATES.map((template) => (
                        <button
                          key={template.label}
                          type="button"
                          title={`填入 ${template.latex}`}
                          onClick={() => setFormulaText(template.latex)}
                          className="rounded-md border border-cslab-border px-1.5 py-0.5 text-[10px] text-cslab-muted transition-colors hover:bg-cslab-surface hover:text-cslab-text"
                        >
                          {template.label}
                        </button>
                      ))}
                    </div>
                    <div className="mt-2 rounded-md border border-cslab-border bg-cslab-bg px-2 py-1">
                      <LatexPreview latex={formulaText} />
                    </div>
                    <div className="mt-2 flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => setFormulaOpen(false)}
                        className="h-6 rounded border border-cslab-border px-2 text-[11px] text-cslab-muted transition-colors hover:bg-cslab-surface hover:text-cslab-text"
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        disabled={!formulaText.trim()}
                        onClick={handleInsertFormula}
                        className="h-6 rounded bg-cslab-accent px-2.5 text-[11px] font-medium text-white transition-colors hover:bg-cslab-accentHover disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        插入
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <RibbonDivider />
              <RibbonButton
                title="插入横向分割线"
                onClick={() => handleRef.current?.separator()}
              >
                <Minus size={13} />
                <span className="ml-1 text-[11px]">横线</span>
              </RibbonButton>
              <RibbonButton
                title="插入分页符"
                onClick={() => handleRef.current?.pageBreak()}
              >
                <FileText size={13} />
                <span className="ml-1 text-[11px]">分页符</span>
              </RibbonButton>
            </div>
          )}

          {activeTab === 'review' && (
            <div className="flex items-center gap-1.5">
              <div className="flex items-center gap-1">
                {CSLAB_REVIEWER_PERSONAS.map((persona) => {
                  const meta = CSLAB_PERSONA_META[persona]
                  const selected = reviewPersona === persona
                  return (
                    <button
                      key={persona}
                      type="button"
                      onClick={() => setReviewPersona(persona)}
                      className={cn(
                        'h-6 rounded px-2 text-[11px] transition-colors',
                        selected
                          ? 'text-white'
                          : 'text-cslab-muted hover:bg-cslab-surface hover:text-cslab-text',
                      )}
                      style={selected ? { background: meta.color } : undefined}
                      title={meta.title}
                    >
                      {meta.title}
                    </button>
                  )
                })}
              </div>
              <RibbonDivider />
              <button
                type="button"
                disabled={reviewBusy || !ready}
                onClick={() => void runReview(reviewPersona)}
                className="inline-flex h-6 items-center gap-1 rounded bg-cslab-accent px-2 text-[11px] font-medium text-white transition-colors hover:bg-cslab-accentHover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {reviewBusy ? (
                  <Loader2 size={10} className="animate-spin" />
                ) : (
                  <Sparkles size={10} />
                )}
                AI 审稿
              </button>
              <button
                type="button"
                onClick={handleLocalCheck}
                className="inline-flex h-6 items-center gap-1 rounded border border-cslab-border px-2 text-[11px] text-cslab-muted transition-colors hover:bg-cslab-surface hover:text-cslab-text"
                title="确定性的重复标点/重复字/超长句检查"
              >
                本地体检
              </button>
              <button
                type="button"
                onClick={() => void handleCopyPrompt()}
                className="inline-flex h-6 items-center gap-1 rounded border border-cslab-border px-2 text-[11px] text-cslab-muted transition-colors hover:bg-cslab-surface hover:text-cslab-text"
                title="复制审稿指令，粘贴到任意对话窗口执行"
              >
                复制指令
              </button>
              <button
                type="button"
                onClick={() => void handlePasteSuggestions()}
                className="inline-flex h-6 items-center gap-1 rounded border border-cslab-border px-2 text-[11px] text-cslab-muted transition-colors hover:bg-cslab-surface hover:text-cslab-text"
                title="从剪贴板读取 AI 返回的审稿 JSON 并施加"
              >
                粘贴建议
              </button>
              <RibbonDivider />
              <RibbonButton
                title="清空全部批注"
                disabled={metrics.comments === 0}
                onClick={handleClearComments}
              >
                <Eraser size={12} />
                <span className="ml-1 text-[11px]">清空批注</span>
              </RibbonButton>
              <span className="inline-flex items-center gap-1 rounded bg-rose-50 px-2 py-1 text-[10px] font-medium text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
                <MessageSquare size={10} />
                {metrics.comments} 条批注
              </span>
            </div>
          )}

          {activeTab === 'view' && (
            <div className="flex items-center gap-2">
              <div
                className="inline-flex items-center gap-0.5 rounded border border-cslab-border p-0.5"
                role="group"
                aria-label="画布工具"
              >
                <button
                  type="button"
                  disabled={!ready}
                  onClick={() => toggleHandTool(false)}
                  title="选择工具（默认）"
                  className={cn(
                    'flex h-6 items-center gap-1 rounded px-2 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                    !handTool
                      ? 'bg-cslab-accent/15 text-cslab-accent'
                      : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800',
                  )}
                >
                  <MousePointer2 size={12} />
                  选择
                </button>
                <button
                  type="button"
                  disabled={!ready}
                  onClick={() => toggleHandTool(true)}
                  title="抓手工具：按住拖动平移画布视口"
                  className={cn(
                    'flex h-6 items-center gap-1 rounded px-2 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                    handTool
                      ? 'bg-cslab-accent/15 text-cslab-accent'
                      : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800',
                  )}
                >
                  <Hand size={12} />
                  抓手
                </button>
              </div>
              <RibbonDivider />
              <button
                type="button"
                onClick={() => setShowRuler(!showRuler)}
                className={cn(
                  'flex h-7 items-center gap-1.5 rounded px-2 text-[12px] transition-colors',
                  showRuler
                    ? 'bg-cslab-accent/15 text-cslab-accent'
                    : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800',
                )}
              >
                <RulerIcon size={13} />
                <span>标尺显示</span>
              </button>
              <RibbonDivider />
              <span className="text-[11px] text-zinc-500">页面缩放：</span>
              {[75, 90, 100, 110, 125].map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setZoom(preset)}
                  className={cn(
                    'h-6 rounded px-2 text-[11px] font-medium transition-colors',
                    zoom === preset
                      ? 'bg-zinc-200 text-zinc-900 dark:bg-zinc-700 dark:text-zinc-100'
                      : 'text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800',
                  )}
                >
                  {preset}%
                </button>
              ))}
            </div>
          )}
        </div>
      </header>

      {/* ===== Canvas A4 纸面 ===== */}
      <div
        data-cslab-scroll
        className="min-h-0 flex-1 overflow-hidden"
        onClick={handleClickInPaper}
        onDragOver={(event) => {
          if (!hasDragType(event.dataTransfer, CSLAB_CELL_MIME)) return
          event.preventDefault()
        }}
      >
        <CsLabCanvasEditor
          key={manuscript.uri}
          labId={labId}
          canvasData={initial.canvasData}
          initialComments={initial.comments}
          staleCapsuleIds={staleCapsuleIds}
          zoom={zoom}
          showRuler={showRuler}
          onReady={handleReady}
          onDirtyChange={handleDirtyChange}
          onRangeStyleChange={setRangeStyle}
          onPageChange={(currentPage, totalPages) =>
            setPage({ current: currentPage, total: totalPages })
          }
          onZoomChange={setZoom}
          onCapsuleClick={onCapsuleClick}
          onMetricsChange={setMetrics}
          onToast={onToast}
          onSearchLiterature={onSearchLiterature}
        />
      </div>

      {/* ===== Word 状态栏 ===== */}
      <footer className="flex h-6 shrink-0 items-center justify-between border-t border-[#DDDCD5] bg-[#F7F6F2] px-4 text-[11px] text-zinc-500 select-none dark:border-[#2A2A2E] dark:bg-[#1A1A1D] dark:text-zinc-400">
        <div className="flex items-center gap-4">
          <span>
            第 {page.current} 页，共 {page.total} 页
          </span>
          <span className="h-3 w-px bg-zinc-300 dark:bg-zinc-700" />
          <span>{metrics.words.toLocaleString()} 词</span>
          <span>{metrics.chars.toLocaleString()} 字符</span>
          <span className="h-3 w-px bg-zinc-300 dark:bg-zinc-700" />
          <span className="inline-flex items-center gap-1 font-medium text-cslab-accent">
            <Sparkles size={11} />
            {metrics.capsules} 个活体胶囊
          </span>
          {metrics.comments > 0 && (
            <>
              <span className="h-3 w-px bg-zinc-300 dark:bg-zinc-700" />
              <span className="tabular-nums text-[10px] text-cslab-muted">
                {metrics.comments} 条审稿批注
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            {saving ? (
              <>
                <Loader2 size={11} className="animate-spin text-cslab-accent" />
                <span className="text-cslab-accent">正在保存…</span>
              </>
            ) : dirty ? (
              <>
                <span className="size-1.5 animate-pulse rounded-full bg-amber-500" />
                <span className="text-amber-600 dark:text-amber-400">
                  有未保存修改 (Ctrl+S)
                </span>
              </>
            ) : (
              <>
                <CheckCircle2 size={11} className="text-emerald-600" />
                <span className="text-zinc-400">
                  已保存至沙箱 ({formatLastSaved(lastSavedTime)})
                </span>
              </>
            )}
          </div>

          <span className="h-3 w-px bg-zinc-300 dark:bg-zinc-700" />

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setZoom((value) => Math.max(50, value - 10))}
              title="缩小"
              className="rounded p-0.5 hover:bg-zinc-200 dark:hover:bg-zinc-800"
            >
              <ZoomOut size={12} />
            </button>
            <span className="w-9 text-center font-mono text-[10px]">{zoom}%</span>
            <button
              type="button"
              onClick={() => setZoom((value) => Math.min(150, value + 10))}
              title="放大"
              className="rounded p-0.5 hover:bg-zinc-200 dark:hover:bg-zinc-800"
            >
              <ZoomIn size={12} />
            </button>
          </div>
        </div>
      </footer>
    </div>
  )
}
