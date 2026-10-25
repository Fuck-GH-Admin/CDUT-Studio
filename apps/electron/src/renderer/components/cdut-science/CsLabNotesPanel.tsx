/**
 * CsLabNotesPanel — Vault 笔记与 JSON Canvas 浏览
 *
 * Markdown 只读预览（Obsidian 是唯一事实源）；Canvas 直接交给 DAG 舞台打开。
 * 支持节点点击直达高亮滚动、气泡内原位拉出反向链接、反向链接自动跳转及系统程序打开。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import {
  BookOpen,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileText,
  GitBranch,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Workflow,
} from 'lucide-react'
import type { CsLabVaultNoteSummary } from '@profer/shared'
import { cn } from '@/lib/utils'
import {
  cslabNotesAtom,
  cslabSelectedNoteRelPathAtom,
  cslabVaultIndexAtom,
} from '@/atoms/cslab-atoms'

interface CsLabNotesPanelProps {
  labId: string
  onOpenCanvas: (relPath: string) => void
  onToast: (kind: 'info' | 'success' | 'error', text: string) => void
}

export function CsLabNotesPanel({
  labId,
  onOpenCanvas,
  onToast,
}: CsLabNotesPanelProps): React.ReactElement {
  const [notes] = useAtom(cslabNotesAtom)
  const [status] = useAtom(cslabVaultIndexAtom)
  const [selectedNoteRelPath, setSelectedNoteRelPath] = useAtom(cslabSelectedNoteRelPathAtom)

  const [query, setQuery] = React.useState('')
  const [results, setResults] = React.useState<CsLabVaultNoteSummary[] | null>(null)
  const [selected, setSelected] = React.useState<CsLabVaultNoteSummary | null>(null)
  const [content, setContent] = React.useState('')
  const [backlinks, setBacklinks] = React.useState<CsLabVaultNoteSummary[]>([])
  const [loadingNote, setLoadingNote] = React.useState(false)
  const [rebuilding, setRebuilding] = React.useState(false)
  const [creating, setCreating] = React.useState(false)
  const [canvasTitle, setCanvasTitle] = React.useState('新推演画布')
  const [creatingBusy, setCreatingBusy] = React.useState(false)
  const [visibleLimit, setVisibleLimit] = React.useState(200)
  /** 笔记气泡 Tab：正文 / 反向链接。 */
  const [noteTab, setNoteTab] = React.useState<'body' | 'backlinks'>('body')
  const [openingVault, setOpeningVault] = React.useState(false)

  const itemRefs = React.useRef<Map<string, HTMLLIElement>>(new Map())

  React.useEffect(() => {
    if (!query.trim()) {
      setResults(null)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void window.electronAPI.cslab
        .searchVaultNotes({ labId, query: query.trim(), limit: 40 })
        .then((items) => {
          if (!cancelled) setResults(items)
        })
        .catch(() => {
          if (!cancelled) setResults([])
        })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [labId, query])

  React.useEffect(() => {
    setSelected(null)
    setContent('')
    setBacklinks([])
    setResults(null)
    setQuery('')
    setNoteTab('body')
  }, [labId])

  const visibleNotes = results ?? notes
  const shownNotes = visibleNotes.slice(0, visibleLimit)
  const hiddenCount = Math.max(0, visibleNotes.length - shownNotes.length)

  React.useEffect(() => {
    setVisibleLimit(200)
  }, [query, labId])

  const openNote = React.useCallback(
    async (note: CsLabVaultNoteSummary, preferredTab?: 'body' | 'backlinks'): Promise<void> => {
      if (note.kind === 'canvas') {
        onOpenCanvas(note.relPath)
        return
      }
      setSelected(note)
      setSelectedNoteRelPath(note.relPath)
      setNoteTab(preferredTab ?? 'body')
      setLoadingNote(true)
      try {
        const [read, links] = await Promise.all([
          window.electronAPI.cslab.readVaultNote({ labId, relPath: note.relPath }),
          window.electronAPI.cslab.getNoteBacklinks({ labId, relPath: note.relPath }),
        ])
        setContent(read.content)
        setBacklinks(links)
      } catch (error) {
        onToast('error', error instanceof Error ? error.message : '笔记读取失败')
        setContent('')
      } finally {
        setLoadingNote(false)
      }
    },
    [labId, onOpenCanvas, onToast, setSelectedNoteRelPath],
  )

  // 响应来自画布或其他视图的笔记直达请求：自动选中并平滑滚动高亮
  React.useEffect(() => {
    if (!selectedNoteRelPath) return
    const match = notes.find((n) => n.relPath === selectedNoteRelPath)
    if (match) {
      void openNote(match)
      window.setTimeout(() => {
        const el = itemRefs.current.get(selectedNoteRelPath)
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        }
      }, 80)
    }
  }, [selectedNoteRelPath, notes, openNote])

  const rebuild = async (): Promise<void> => {
    setRebuilding(true)
    try {
      const result = await window.electronAPI.cslab.rebuildVaultIndex({ labId, force: true })
      onToast('success', `索引已重建：解析 ${result.parsed}，复用 ${result.reused}，移除 ${result.removed}`)
    } catch (error) {
      onToast('error', error instanceof Error ? error.message : '索引重建失败')
    } finally {
      setRebuilding(false)
    }
  }

  const createCanvas = async (): Promise<void> => {
    if (creatingBusy) return
    setCreatingBusy(true)
    try {
      const created = await window.electronAPI.cslab.createCanvas({
        labId,
        title: canvasTitle.trim() || '新推演画布',
      })
      setCreating(false)
      onOpenCanvas(created.relPath)
      onToast('success', '画布已创建')
    } catch (error) {
      onToast('error', error instanceof Error ? error.message : '画布创建失败')
    } finally {
      setCreatingBusy(false)
    }
  }

  const openObsidianVault = async (relPath?: string): Promise<void> => {
    if (openingVault) return
    setOpeningVault(true)
    try {
      const result = await window.electronAPI.cslab.openObsidianVault({ labId, relPath })
      if (result.ok) {
        onToast('success', `已在外部打开：${result.path ?? ''}`)
      } else {
        onToast('error', result.message ?? '打开失败')
      }
    } catch (error) {
      onToast('error', error instanceof Error ? error.message : '打开失败')
    } finally {
      setOpeningVault(false)
    }
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => void openObsidianVault()}
        disabled={openingVault}
        className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-cslab-accent px-3 py-2 text-[11px] font-medium text-white transition-colors hover:bg-cslab-accentHover disabled:opacity-50"
      >
        {openingVault ? <Loader2 size={12} className="animate-spin" /> : <BookOpen size={12} />}
        在 Obsidian 中打开完整 Vault
      </button>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-cslab-muted" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索笔记标题、正文、标签…"
            className="w-full rounded-lg border border-cslab-border bg-cslab-elevated/70 py-1.5 pl-7 pr-3 text-[11px] text-cslab-text placeholder:text-cslab-muted outline-none focus:border-cslab-accent/50"
          />
        </div>
        <button
          type="button"
          onClick={() => setCreating((value) => !value)}
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11px] transition-colors',
            creating
              ? 'border-cslab-accent/40 bg-cslab-surface text-cslab-accent'
              : 'border-cslab-border bg-cslab-elevated/70 text-cslab-muted hover:text-cslab-text',
          )}
          title="新建推演画布"
        >
          <Plus size={11} /> 画布
        </button>
        <button
          type="button"
          disabled={rebuilding}
          onClick={() => void rebuild()}
          className="rounded-lg border border-cslab-border bg-cslab-elevated/70 p-1.5 text-cslab-muted hover:text-cslab-text disabled:opacity-50"
          title="重建索引"
        >
          <RefreshCw size={12} className={rebuilding ? 'animate-spin' : undefined} />
        </button>
      </div>

      {creating && (
        <div className="rounded-xl border border-cslab-accent/30 bg-cslab-elevated/90 p-3 space-y-2">
          <p className="text-[11px] font-medium text-cslab-text">新建 Prove2Me JSON Canvas</p>
          <input
            type="text"
            value={canvasTitle}
            onChange={(event) => setCanvasTitle(event.target.value)}
            placeholder="画布名称（如：泥石流启动机制推演）"
            className="w-full rounded-lg border border-cslab-border bg-cslab-bg px-2.5 py-1 text-[11px] text-cslab-text outline-none focus:border-cslab-accent/50"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void createCanvas()
            }}
          />
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setCreating(false)}
              className="rounded-md border border-cslab-border px-2 py-1 text-[10px] text-cslab-muted hover:text-cslab-text"
            >
              取消
            </button>
            <button
              type="button"
              disabled={creatingBusy}
              onClick={() => void createCanvas()}
              className="inline-flex items-center gap-1 rounded-md bg-cslab-accent px-2.5 py-1 text-[10px] font-medium text-white hover:bg-cslab-accentHover disabled:opacity-50"
            >
              {creatingBusy && <Loader2 size={10} className="animate-spin" />}
              创建
            </button>
          </div>
        </div>
      )}

      {/* 笔记与导图列表 */}
      <div className="space-y-1.5">
        {shownNotes.length === 0 ? (
          <div className="rounded-xl border border-dashed border-cslab-border px-4 py-8 text-center">
            <FileText size={18} className="mx-auto text-cslab-muted/60" />
            <p className="mt-2 font-serif text-sm text-cslab-text">
              {query ? '未检索到匹配笔记' : 'Vault 暂无笔记'}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-cslab-muted">
              {query
                ? '尝试更换关键词。'
                : '把 Obsidian 仓库里的 .md / .canvas 复制到实验室 vault/notes，索引会自动登记。'}
            </p>
          </div>
        ) : (
          <>
            <ul className="space-y-1.5">
              {shownNotes.map((note) => {
                const active = selected?.relPath === note.relPath
                return (
                  <li
                    key={note.relPath}
                    ref={(el) => {
                      if (el) itemRefs.current.set(note.relPath, el)
                      else itemRefs.current.delete(note.relPath)
                    }}
                    className={cn(
                      'rounded-xl border transition-all duration-200 overflow-hidden',
                      active
                        ? 'border-cslab-accent/60 bg-cslab-surface shadow-sm ring-1 ring-cslab-accent/30'
                        : 'border-cslab-border/70 bg-cslab-elevated/60 hover:border-cslab-border hover:bg-cslab-elevated',
                    )}
                  >
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => void openNote(note)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void openNote(note)
                      }}
                      className="cursor-pointer px-3 py-2"
                    >
                      <div className="flex items-center gap-1.5">
                        {note.kind === 'canvas' ? (
                          <Workflow size={12} className="shrink-0 text-cslab-accent" />
                        ) : (
                          <FileText size={12} className="shrink-0 text-cslab-muted" />
                        )}
                        <span className="min-w-0 flex-1 truncate font-medium text-[12px] text-cslab-text">
                          {note.title}
                        </span>

                        {/* 反向链接徽标 */}
                        {note.backlinkCount > 0 && (
                          <button
                            type="button"
                            title="查看反向链接"
                            onClick={(e) => {
                              e.stopPropagation()
                              void openNote(note, 'backlinks')
                            }}
                            className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-cslab-border bg-cslab-bg px-1.5 py-0.5 text-[9px] tabular-nums text-cslab-muted hover:border-cslab-accent/50 hover:text-cslab-accent"
                          >
                            <Link2 size={9} /> {note.backlinkCount}
                          </button>
                        )}

                        {/* 使用系统默认软件打开按钮 */}
                        <button
                          type="button"
                          title="用系统默认软件打开（Obsidian / Typora / VS Code）"
                          aria-label="用系统默认程序打开"
                          onClick={(e) => {
                            e.stopPropagation()
                            void openObsidianVault(note.relPath)
                          }}
                          className="shrink-0 rounded p-1 text-cslab-muted/80 transition-colors hover:bg-cslab-surface hover:text-cslab-accent"
                        >
                          <ExternalLink size={12} />
                        </button>
                      </div>

                      {note.excerpt && (
                        <p className="mt-1 line-clamp-2 text-[10px] leading-relaxed text-cslab-muted">
                          {note.excerpt}
                        </p>
                      )}

                      {note.tags.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {note.tags.slice(0, 4).map((tag) => (
                            <span
                              key={tag}
                              className="rounded-full border border-cslab-border bg-cslab-bg px-1.5 py-0.2 text-[9px] text-cslab-muted"
                            >
                              #{tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* 气泡下方原位拉出详情与反向链接抽屉 */}
                    {active && note.kind === 'md' && (
                      <div className="border-t border-cslab-border/70 bg-cslab-bg/75 p-2.5 space-y-2">
                        <div className="flex items-center justify-between border-b border-cslab-border/50 pb-1.5">
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => setNoteTab('body')}
                              className={cn(
                                'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
                                noteTab === 'body'
                                  ? 'bg-cslab-accent/15 text-cslab-accent'
                                  : 'text-cslab-muted hover:text-cslab-text',
                              )}
                            >
                              正文预览
                            </button>
                            <button
                              type="button"
                              onClick={() => setNoteTab('backlinks')}
                              className={cn(
                                'inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
                                noteTab === 'backlinks'
                                  ? 'bg-cslab-accent/15 text-cslab-accent'
                                  : 'text-cslab-muted hover:text-cslab-text',
                              )}
                            >
                              <Link2 size={10} /> 反向链接 ({backlinks.length})
                            </button>
                          </div>
                          <span className="truncate text-[9px] font-mono text-cslab-muted/70 max-w-[140px]" title={note.relPath}>
                            {note.relPath.replace(/^vault\/notes\//, '')}
                          </span>
                        </div>

                        {noteTab === 'body' ? (
                          loadingNote ? (
                            <div className="flex items-center justify-center gap-2 py-4 text-[11px] text-cslab-muted">
                              <Loader2 size={12} className="animate-spin" /> 正在读取…
                            </div>
                          ) : (
                            <div className="max-h-[38vh] overflow-y-auto px-1 py-1 cs-lab-markdown text-[11px] leading-relaxed text-cslab-text">
                              <ReactMarkdown
                                remarkPlugins={[remarkGfm, remarkMath]}
                                rehypePlugins={[rehypeKatex]}
                                components={{
                                  h1: ({ children }) => (
                                    <h1 className="mb-2 mt-1 font-serif text-base font-bold text-cslab-text">{children}</h1>
                                  ),
                                  h2: ({ children }) => (
                                    <h2 className="mb-1.5 mt-2 font-serif text-sm font-semibold text-cslab-text">{children}</h2>
                                  ),
                                  h3: ({ children }) => (
                                    <h3 className="mb-1 mt-1.5 font-serif text-xs font-semibold text-cslab-text">{children}</h3>
                                  ),
                                  p: ({ children }) => <p className="mb-1.5 last:mb-0">{children}</p>,
                                  ul: ({ children }) => (
                                    <ul className="mb-1.5 list-disc space-y-0.5 pl-4">{children}</ul>
                                  ),
                                  ol: ({ children }) => (
                                    <ol className="mb-1.5 list-decimal space-y-0.5 pl-4">{children}</ol>
                                  ),
                                  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                                  code: ({ children }) => (
                                    <code className="rounded bg-cslab-surface px-1 py-0.5 font-mono text-[10px]">
                                      {children}
                                    </code>
                                  ),
                                  pre: ({ children }) => (
                                    <pre className="mb-1.5 overflow-x-auto rounded border border-cslab-border bg-cslab-surface p-1.5 font-mono text-[10px] leading-relaxed">
                                      {children}
                                    </pre>
                                  ),
                                  blockquote: ({ children }) => (
                                    <blockquote className="mb-1.5 border-l-2 border-cslab-accent/50 pl-2 text-cslab-muted italic">
                                      {children}
                                    </blockquote>
                                  ),
                                  table: ({ children }) => (
                                    <div className="mb-1.5 overflow-x-auto">
                                      <table className="w-full border-collapse text-[10px]">{children}</table>
                                    </div>
                                  ),
                                  th: ({ children }) => (
                                    <th className="border-b border-cslab-border px-1.5 py-0.5 text-left font-medium text-cslab-muted">
                                      {children}
                                    </th>
                                  ),
                                  td: ({ children }) => (
                                    <td className="border-b border-cslab-border/60 px-1.5 py-0.5 align-top">
                                      {children}
                                    </td>
                                  ),
                                  a: ({ children, href }) => (
                                    <a
                                      href={href}
                                      className="text-cslab-accent underline underline-offset-2"
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      {children}
                                    </a>
                                  ),
                                }}
                              >
                                {content || '（空白笔记）'}
                              </ReactMarkdown>
                            </div>
                          )
                        ) : (
                          <div className="max-h-[30vh] overflow-y-auto space-y-1">
                            {backlinks.length > 0 ? (
                              <ul className="space-y-1">
                                {backlinks.map((link) => (
                                  <li key={link.relPath}>
                                    <button
                                      type="button"
                                      onClick={() => void openNote(link)}
                                      className="w-full flex items-center justify-between rounded-lg border border-cslab-border/70 bg-cslab-elevated/70 px-2 py-1.5 text-left text-[11px] text-cslab-text transition-colors hover:border-cslab-accent/40 hover:bg-cslab-surface hover:text-cslab-accent"
                                    >
                                      <div className="flex items-center gap-1.5 min-w-0 flex-1">
                                        {link.kind === 'canvas' ? (
                                          <Workflow size={11} className="shrink-0 text-cslab-accent" />
                                        ) : (
                                          <FileText size={11} className="shrink-0 text-cslab-muted" />
                                        )}
                                        <span className="truncate">{link.title}</span>
                                      </div>
                                      <span className="shrink-0 text-[9px] text-cslab-muted/70 font-mono">
                                        点击跳转
                                      </span>
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p className="py-4 text-center text-[10px] text-cslab-muted">当前笔记暂无反向链接引用</p>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>

            {hiddenCount > 0 && (
              <button
                type="button"
                onClick={() => setVisibleLimit((limit) => limit + 200)}
                className="mt-2 w-full rounded-lg border border-dashed border-cslab-border px-2 py-1.5 text-[10px] text-cslab-muted hover:border-cslab-accent/40 hover:text-cslab-accent"
              >
                继续显示剩余 {hiddenCount} 篇
              </button>
            )}

            {!results && status && status.noteCount > visibleNotes.length && (
              <p className="mt-2 text-center text-[10px] leading-relaxed text-cslab-muted/80">
                仅列出最近 {visibleNotes.length} 篇（共 {status.noteCount} 篇），更早笔记请使用搜索定位
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
