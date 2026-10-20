/**
 * CsLabNotesPanel — Vault 笔记与 JSON Canvas 浏览
 *
 * Markdown 只读预览（Obsidian 是唯一事实源）；Canvas 直接交给 DAG 舞台打开。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  BookOpen,
  FileText,
  GitBranch,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Workflow,
} from 'lucide-react'
import type { CsLabVaultNoteSummary } from '@profer/shared'
import { cn } from '@/lib/utils'
import { cslabNotesAtom, cslabVaultIndexAtom } from '@/atoms/cslab-atoms'

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
  }, [labId])

  const visibleNotes = results ?? notes
  const shownNotes = visibleNotes.slice(0, visibleLimit)
  const hiddenCount = Math.max(0, visibleNotes.length - shownNotes.length)

  React.useEffect(() => {
    setVisibleLimit(200)
  }, [query, labId])

  const openNote = async (note: CsLabVaultNoteSummary): Promise<void> => {
    if (note.kind === 'canvas') {
      onOpenCanvas(note.relPath)
      return
    }
    setSelected(note)
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
  }

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

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 rounded-xl border border-cslab-border bg-cslab-elevated px-2.5 py-1.5">
        <Search size={12} className="shrink-0 text-cslab-muted" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索笔记、标签或双链…"
          className="w-full bg-transparent text-xs text-cslab-text placeholder:text-cslab-muted/60 focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void rebuild()}
          disabled={rebuilding}
          title="重建索引"
          className="shrink-0 rounded p-1 text-cslab-muted hover:bg-cslab-surface hover:text-cslab-text disabled:opacity-50"
        >
          <RefreshCw size={12} className={rebuilding ? 'animate-spin' : undefined} />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-cslab-muted">
        <span className="inline-flex items-center gap-1">
          <FileText size={10} /> {status?.noteCount ?? 0} 笔记
        </span>
        <span className="inline-flex items-center gap-1">
          <Workflow size={10} /> {status?.canvasCount ?? 0} 画布
        </span>
        <span className="inline-flex items-center gap-1">
          <GitBranch size={10} /> {status?.linkCount ?? 0} 双链
        </span>
        <span className="ml-auto tabular-nums">缓存 {status?.cachedRows ?? 0}</span>
        <button
          type="button"
          onClick={() => setCreating((open) => !open)}
          className="inline-flex items-center gap-1 rounded-full border border-cslab-border px-2 py-0.5 text-[10px] text-cslab-muted hover:border-cslab-accent/40 hover:text-cslab-accent"
        >
          <Plus size={9} /> 新建画布
        </button>
      </div>

      {creating && (
        <div className="flex items-center gap-1.5 rounded-xl border border-cslab-border bg-cslab-surface/60 p-2">
          <input
            value={canvasTitle}
            onChange={(event) => setCanvasTitle(event.target.value)}
            placeholder="画布名称"
            className="min-w-0 flex-1 rounded-lg border border-cslab-border bg-cslab-elevated px-2 py-1 text-[11px] text-cslab-text outline-none focus:border-cslab-accent/50"
          />
          <button
            type="button"
            disabled={creatingBusy}
            onClick={() => void createCanvas()}
            className="rounded-lg bg-cslab-accent px-2 py-1 text-[10px] font-medium text-white hover:bg-cslab-accentHover disabled:opacity-50"
          >
            {creatingBusy ? '创建中…' : '创建'}
          </button>
        </div>
      )}

      <div className="min-h-0">
        {visibleNotes.length === 0 ? (
          <div className="rounded-xl border border-dashed border-cslab-border px-4 py-8 text-center">
            <BookOpen size={18} className="mx-auto text-cslab-muted/60" />
            <p className="mt-2 font-serif text-sm text-cslab-text">
              {query ? '没有匹配的笔记' : 'Vault 还是空的'}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-cslab-muted">
              {query
                ? '尝试更换关键词。'
                : '把 Obsidian 仓库里的 .md / .canvas 复制到实验室 vault/notes，索引会自动登记。'}
            </p>
          </div>
        ) : (
          <>
            <ul className="space-y-1">
              {shownNotes.map((note) => {
              const active = selected?.relPath === note.relPath
              return (
                <li key={note.relPath}>
                  <button
                    type="button"
                    onClick={() => void openNote(note)}
                    className={cn(
                      'w-full rounded-lg border px-2.5 py-2 text-left transition-colors',
                      active
                        ? 'border-cslab-accent/40 bg-cslab-surface'
                        : 'border-transparent hover:bg-cslab-surface/70',
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      {note.kind === 'canvas' ? (
                        <Workflow size={11} className="shrink-0 text-cslab-accent" />
                      ) : (
                        <FileText size={11} className="shrink-0 text-cslab-muted" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-[12px] text-cslab-text">
                        {note.title}
                      </span>
                      {note.backlinkCount > 0 && (
                        <span className="shrink-0 rounded-full border border-cslab-border px-1.5 text-[9px] tabular-nums text-cslab-muted">
                          ↩ {note.backlinkCount}
                        </span>
                      )}
                    </div>
                    {note.excerpt && (
                      <p className="mt-0.5 line-clamp-2 text-[10px] leading-relaxed text-cslab-muted">
                        {note.excerpt}
                      </p>
                    )}
                    {note.tags.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {note.tags.slice(0, 4).map((tag) => (
                          <span
                            key={tag}
                            className="rounded-full border border-cslab-border px-1.5 text-[9px] text-cslab-muted"
                          >
                            #{tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </button>
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

      {selected && selected.kind === 'md' && (
        <section className="rounded-xl border border-cslab-border bg-cslab-elevated">
          <header className="flex items-center gap-2 border-b border-cslab-border px-3 py-2">
            <span className="min-w-0 flex-1 truncate font-serif text-[13px] text-cslab-text">
              {selected.title}
            </span>
            <span className="shrink-0 text-[9px] uppercase tracking-wide text-cslab-muted">
              {selected.relPath.split('/').pop()}
            </span>
          </header>
          <div className="max-h-[46vh] overflow-y-auto px-3 py-2.5">
            {loadingNote ? (
              <div className="flex items-center gap-2 text-[11px] text-cslab-muted">
                <Loader2 size={11} className="animate-spin" /> 正在读取…
              </div>
            ) : (
              <div className="cs-lab-markdown text-[12px] leading-relaxed text-cslab-text">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    h1: ({ children }) => (
                      <h1 className="mb-2 mt-1 font-serif text-lg text-cslab-text">{children}</h1>
                    ),
                    h2: ({ children }) => (
                      <h2 className="mb-1.5 mt-3 font-serif text-base text-cslab-text">{children}</h2>
                    ),
                    h3: ({ children }) => (
                      <h3 className="mb-1 mt-2 font-serif text-sm text-cslab-text">{children}</h3>
                    ),
                    p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                    ul: ({ children }) => (
                      <ul className="mb-2 list-disc space-y-0.5 pl-5">{children}</ul>
                    ),
                    ol: ({ children }) => (
                      <ol className="mb-2 list-decimal space-y-0.5 pl-5">{children}</ol>
                    ),
                    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                    code: ({ children }) => (
                      <code className="rounded bg-cslab-bg px-1 py-0.5 font-mono text-[11px]">
                        {children}
                      </code>
                    ),
                    pre: ({ children }) => (
                      <pre className="mb-2 overflow-x-auto rounded-lg border border-cslab-border bg-cslab-bg p-2 font-mono text-[10px] leading-relaxed">
                        {children}
                      </pre>
                    ),
                    blockquote: ({ children }) => (
                      <blockquote className="mb-2 border-l-2 border-cslab-accent/40 pl-3 text-cslab-muted">
                        {children}
                      </blockquote>
                    ),
                    table: ({ children }) => (
                      <div className="mb-2 overflow-x-auto">
                        <table className="w-full border-collapse text-[11px]">{children}</table>
                      </div>
                    ),
                    th: ({ children }) => (
                      <th className="border-b border-cslab-border px-1.5 py-1 text-left font-medium text-cslab-muted">
                        {children}
                      </th>
                    ),
                    td: ({ children }) => (
                      <td className="border-b border-cslab-border/60 px-1.5 py-1 align-top">
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
                  {content}
                </ReactMarkdown>
              </div>
            )}

            {backlinks.length > 0 && (
              <div className="mt-3 border-t border-cslab-border pt-2">
                <p className="text-[10px] uppercase tracking-[0.14em] text-cslab-muted">
                  反向链接（{backlinks.length}）
                </p>
                <ul className="mt-1 space-y-0.5">
                  {backlinks.map((link) => (
                    <li key={link.relPath}>
                      <button
                        type="button"
                        onClick={() => void openNote(link)}
                        className="w-full truncate rounded px-1 py-0.5 text-left text-[11px] text-cslab-text hover:bg-cslab-surface hover:text-cslab-accent"
                      >
                        {link.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
