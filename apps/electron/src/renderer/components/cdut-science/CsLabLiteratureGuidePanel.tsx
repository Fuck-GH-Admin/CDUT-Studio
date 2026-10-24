/**
 * CsLabLiteratureGuidePanel — 结构化智能导读侧边栏
 *
 * 只展示后端解析出的证据（摘要/章节/公式/表格/局限），不臆造主观结论；
 * 语义综合交给“继续深入研讨”唤起科学助理完成。
 */

import * as React from 'react'
import {
  AlertTriangle,
  BookOpen,
  ChevronRight,
  Loader2,
  RefreshCw,
  Sigma,
  Sparkles,
  Table2,
} from 'lucide-react'
import type { CsLabLiteratureGuide, CsLabLiteratureItem } from '@profer/shared'
import { cn } from '@/lib/utils'

interface CsLabLiteratureGuidePanelProps {
  labId: string
  literature: CsLabLiteratureItem
  onJumpToPage: (page: number) => void
  onDiscuss: (sectionTitle?: string, page?: number) => void
  onClose: () => void
}

function SectionBlock({
  title,
  count,
  children,
}: {
  title: string
  count?: number
  children: React.ReactNode
}): React.ReactElement {
  return (
    <section className="space-y-1.5">
      <h4 className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-cslab-muted">
        {title}
        {count !== undefined && <span className="tabular-nums normal-case">({count})</span>}
      </h4>
      {children}
    </section>
  )
}

export function CsLabLiteratureGuidePanel({
  labId,
  literature,
  onJumpToPage,
  onDiscuss,
  onClose,
}: CsLabLiteratureGuidePanelProps): React.ReactElement {
  const [guide, setGuide] = React.useState<CsLabLiteratureGuide | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const result = await window.electronAPI.cslab.getLiteratureGuide({
        labId,
        literatureUri: literature.uri,
      })
      setGuide(result)
      if (!result.ok) setError(result.message ?? '导读生成失败')
    } catch (err) {
      setError(err instanceof Error ? err.message : '导读生成失败')
    } finally {
      setLoading(false)
    }
  }, [labId, literature.uri])

  React.useEffect(() => {
    void load()
  }, [load])

  return (
    <aside className="flex h-full w-[320px] shrink-0 flex-col border-l border-cslab-border bg-cslab-bg">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-cslab-border px-3">
        <Sparkles size={12} className="text-cslab-accent" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-cslab-text">智能导读</span>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="rounded p-1 text-cslab-muted transition-colors hover:bg-cslab-surface hover:text-cslab-text disabled:opacity-50"
          aria-label="重新解析"
          title="重新解析"
        >
          <RefreshCw size={12} className={cn(loading && 'animate-spin')} />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-cslab-muted transition-colors hover:bg-cslab-surface hover:text-cslab-text"
          aria-label="关闭导读"
          title="关闭"
        >
          ×
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3">
        {loading && (
          <div className="flex items-center gap-2 rounded-lg border border-cslab-border bg-cslab-surface px-3 py-2 text-[11px] text-cslab-muted">
            <Loader2 size={12} className="animate-spin" />
            正在解析全文结构…
          </div>
        )}

        {error && !loading && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-700">
            <div className="flex items-center gap-1.5 font-medium">
              <AlertTriangle size={12} />
              导读不可用
            </div>
            <p className="mt-1">{error}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-2 rounded-md border border-amber-300 px-2 py-1 text-[10px] hover:bg-amber-100"
            >
              重新解析
            </button>
          </div>
        )}

        {guide?.ok && !loading && (
          <>
            <div className="rounded-xl border border-cslab-border bg-cslab-elevated px-3 py-2.5">
              <p className="font-serif text-[13px] leading-snug text-cslab-text">{guide.title}</p>
              <p className="mt-1 text-[10px] leading-relaxed text-cslab-muted">
                {[guide.authors.slice(0, 4).join(', '), guide.year, guide.doi]
                  .filter(Boolean)
                  .join(' · ') || '未识别作者/年份'}
              </p>
              <p className="mt-1 text-[10px] tabular-nums text-cslab-muted">
                {guide.pageCount} 页 · {guide.outline.length} 章 · {guide.equations.length} 公式 ·{' '}
                {guide.tables.length} 表格
              </p>
            </div>

            {guide.abstract && (
              <SectionBlock title="摘要">
                <p className="rounded-lg border border-cslab-border bg-cslab-surface px-2.5 py-2 text-[11px] leading-relaxed text-cslab-text">
                  {guide.abstract}
                </p>
              </SectionBlock>
            )}

            {guide.keywords.length > 0 && (
              <SectionBlock title="关键词">
                <div className="flex flex-wrap gap-1">
                  {guide.keywords.map((keyword) => (
                    <span
                      key={keyword}
                      className="rounded-full border border-cslab-border px-1.5 py-0.5 text-[10px] text-cslab-muted"
                    >
                      {keyword}
                    </span>
                  ))}
                </div>
              </SectionBlock>
            )}

            <SectionBlock title="章节脉络" count={guide.outline.length}>
              <ol className="space-y-1">
                {guide.outline.map((section, index) => (
                  <li key={`${section.title}-${index}`}>
                    <button
                      type="button"
                      onClick={() => onJumpToPage(section.page)}
                      className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[11px] text-cslab-text transition-colors hover:bg-cslab-surface"
                      style={{ paddingLeft: `${Math.min(4, Math.max(0, section.level - 1)) * 10 + 6}px` }}
                    >
                      <BookOpen size={10} className="shrink-0 text-cslab-muted" />
                      <span className="min-w-0 flex-1 truncate">{section.title}</span>
                      <span className="shrink-0 text-[9px] tabular-nums text-cslab-muted">p.{section.page}</span>
                      <ChevronRight size={10} className="shrink-0 text-cslab-border" />
                    </button>
                  </li>
                ))}
              </ol>
            </SectionBlock>

            {guide.equations.length > 0 && (
              <SectionBlock title="关键公式" count={guide.equations.length}>
                <ul className="space-y-1">
                  {guide.equations.slice(0, 8).map((equation, index) => (
                    <li
                      key={`${equation.page}-${index}`}
                      className="rounded-md border border-cslab-border bg-cslab-surface px-2 py-1.5 text-[10px] leading-relaxed text-cslab-text"
                    >
                      <div className="flex items-center gap-1 text-cslab-muted">
                        <Sigma size={10} />
                        <span>p.{equation.page}{equation.tag ? ` · ${equation.tag}` : ''}</span>
                      </div>
                      <code className="mt-0.5 block break-all font-mono text-[10px]">{equation.latex}</code>
                    </li>
                  ))}
                </ul>
              </SectionBlock>
            )}

            {guide.tables.length > 0 && (
              <SectionBlock title="关键表格" count={guide.tables.length}>
                <ul className="space-y-1">
                  {guide.tables.slice(0, 6).map((table, index) => (
                    <li key={`${table.page}-${index}`} className="rounded-md border border-cslab-border bg-cslab-surface px-2 py-1.5 text-[10px] text-cslab-text">
                      <div className="flex items-center gap-1 text-cslab-muted">
                        <Table2 size={10} />
                        <span>p.{table.page}{table.caption ? ` · ${table.caption}` : ''}</span>
                      </div>
                      <p className="mt-0.5 line-clamp-2 break-words font-mono text-[9px] text-cslab-muted">
                        {table.markdownPreview}
                      </p>
                    </li>
                  ))}
                </ul>
              </SectionBlock>
            )}

            {(guide.limitations.length > 0 || guide.conclusion) && (
              <SectionBlock title="局限与结论（原文摘录）">
                {[...guide.limitations, ...(guide.conclusion ? [guide.conclusion] : [])].map((section, index) => (
                  <div
                    key={`${section.title}-${index}`}
                    className="rounded-lg border border-cslab-border bg-cslab-surface px-2.5 py-2"
                  >
                    <button
                      type="button"
                      onClick={() => onJumpToPage(section.page)}
                      className="text-[10px] font-medium text-cslab-accent hover:underline"
                    >
                      {section.title} · p.{section.page}
                    </button>
                    <p className="mt-1 line-clamp-4 text-[10px] leading-relaxed text-cslab-muted">
                      {section.excerpt}
                    </p>
                  </div>
                ))}
              </SectionBlock>
            )}

            <SectionBlock title="建议阅读路径">
              <ol className="list-decimal space-y-1 pl-4 text-[10px] leading-relaxed text-cslab-muted">
                {guide.readingPath.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </SectionBlock>
          </>
        )}
      </div>

      <footer className="shrink-0 border-t border-cslab-border p-2.5">
        <button
          type="button"
          onClick={() => onDiscuss()}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-cslab-accent px-3 py-2 text-[11px] font-medium text-white transition-colors hover:bg-cslab-accentHover"
        >
          <Sparkles size={12} />
          继续深入研讨
        </button>
        <p className="mt-1.5 text-center text-[9px] leading-relaxed text-cslab-muted/70">
          导读基于全文结构解析，不臆造结论；语义综合由科学助理完成。
        </p>
      </footer>
    </aside>
  )
}
