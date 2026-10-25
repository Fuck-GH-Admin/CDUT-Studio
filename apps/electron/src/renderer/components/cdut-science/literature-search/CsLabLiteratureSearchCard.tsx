/**
 * CsLabLiteratureSearchCard — 外显高阶元数据检索卡片
 *
 * Editorial Minimalism：衬线标题 + 无衬线元数据，羊皮纸次级容器，
 * 发丝边框与微弱 hover，绝不使用弥散厚阴影与高饱和强调色。
 */

import * as React from 'react'
import { BookmarkCheck, Loader2, Quote } from 'lucide-react'
import type { CsLabAcademicPaperMetadata, CsLabOaStatus } from '@profer/shared'
import { cn } from '@/lib/utils'

export type CsLabIngestState = 'idle' | 'ingesting' | 'ingested' | 'failed'

const OA_LABELS: Record<CsLabOaStatus, string> = {
  gold: 'Gold OA',
  green: 'Green OA',
  bronze: 'Bronze OA',
  diamond: 'Diamond OA',
  hybrid: 'Hybrid OA',
  preprint: '预印本',
  closed: '订阅',
}

export function formatPaperAuthors(paper: CsLabAcademicPaperMetadata, max = 3): string {
  const names = paper.authors.map((author) => author.name).filter(Boolean)
  if (names.length === 0) return '作者信息缺失'
  const shown = names.slice(0, max).join('、')
  return names.length > max ? `${shown} 等 ${names.length} 位作者` : shown
}

export function formatPaperCitation(paper: CsLabAcademicPaperMetadata): string {
  const authors = paper.authors.map((author) => author.name).filter(Boolean).join(', ')
  const venue = paper.publication ? ` ${paper.publication}.` : ''
  const doi = paper.doi ? ` https://doi.org/${paper.doi}` : ''
  return `${authors || 'Unknown authors'} (${paper.year ?? 'n.d.'}). ${paper.title}.${venue}${doi}`
}

export interface CsLabLiteratureSearchCardProps {
  paper: CsLabAcademicPaperMetadata
  selected: boolean
  onSelect: () => void
  onIngest: () => void
  onCopyCitation: () => void
  ingestState: CsLabIngestState
}

export function CsLabLiteratureSearchCard({
  paper,
  selected,
  onSelect,
  onIngest,
  onCopyCitation,
  ingestState,
}: CsLabLiteratureSearchCardProps): React.ReactElement {
  const canIngest = paper.isOpenAccess && (paper.openAccessPdfUrl || paper.doi || paper.arxivId || (paper.openAccessPdfUrls && paper.openAccessPdfUrls.length > 0))

  return (
    <article
      onClick={onSelect}
      className={cn(
        'cursor-pointer rounded-xl border border-cslab-border/80 bg-cslab-surface p-3.5 transition-colors',
        selected ? 'border-cslab-accent/60 bg-cslab-elevated' : 'hover:bg-cslab-elevated',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-serif text-base font-medium leading-relaxed text-cslab-text">
          {paper.title}
        </h3>
        {paper.lineage.isPreprint ? (
          <span className="mt-0.5 shrink-0 rounded-full border border-cslab-border px-2 py-0.5 text-[9px] text-cslab-muted">
            预印本
          </span>
        ) : paper.lineage.publishedVersionDoi ? (
          <span className="mt-0.5 shrink-0 rounded-full border border-cslab-accent/50 px-2 py-0.5 text-[9px] text-cslab-accent">
            已合并正式版
          </span>
        ) : null}
      </div>

      <p className="mt-1.5 text-xs leading-relaxed text-cslab-muted">
        {formatPaperAuthors(paper)}
        {paper.authors[0]?.institution ? ` · ${paper.authors[0].institution}` : ''}
      </p>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-cslab-muted">
        {paper.year != null && <span>{paper.year}</span>}
        {paper.publication && <span className="text-cslab-text/80">{paper.publication}</span>}
        {paper.doi && (
          <a
            href={`https://doi.org/${paper.doi}`}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="text-cslab-accent/90 transition-colors hover:text-cslab-accentHover hover:underline"
          >
            DOI: {paper.doi}
          </a>
        )}
        <span>被引 {paper.citationsCount}</span>
        {paper.oaStatus && (
          <span
            className={cn(
              'rounded-full border px-2 py-px',
              paper.isOpenAccess
                ? 'border-cslab-accent/40 text-cslab-accent'
                : 'border-cslab-border text-cslab-muted',
            )}
          >
            {OA_LABELS[paper.oaStatus]}
          </span>
        )}
      </div>

      {paper.tldr && (
        <p className="mt-2 rounded-lg border border-cslab-border/60 bg-cslab-bg/70 px-2.5 py-1.5 text-xs leading-relaxed text-cslab-text/90">
          <span className="mr-1.5 text-[9px] uppercase tracking-[0.14em] text-cslab-accent">TL;DR</span>
          {paper.tldr}
        </p>
      )}

      {paper.methodKeywords.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {paper.methodKeywords.slice(0, 6).map((keyword) => (
            <span
              key={keyword}
              className="rounded-md border border-cslab-border/70 bg-cslab-bg/60 px-1.5 py-0.5 text-[9px] text-cslab-muted"
            >
              {keyword}
            </span>
          ))}
        </div>
      )}

      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onIngest()
          }}
          disabled={!canIngest || ingestState === 'ingesting' || ingestState === 'ingested'}
          className={cn(
            'inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] transition-colors',
            ingestState === 'ingested'
              ? 'text-cslab-accent'
              : canIngest
                ? 'border border-cslab-accent/50 text-cslab-accent hover:bg-cslab-accent hover:text-cslab-bg'
                : 'cursor-not-allowed border border-cslab-border text-cslab-muted',
          )}
        >
          {ingestState === 'ingesting' ? (
            <Loader2 size={11} className="animate-spin" />
          ) : ingestState === 'ingested' ? (
            <BookmarkCheck size={11} />
          ) : null}
          {ingestState === 'ingested'
            ? '已入库'
            : ingestState === 'ingesting'
              ? '入库中…'
              : canIngest
                ? '一键入库'
                : '无 OA PDF'}
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onCopyCitation()
          }}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] text-cslab-muted transition-colors hover:bg-cslab-elevated hover:text-cslab-text"
        >
          <Quote size={11} />
          复制引用
        </button>
        <span className="ml-auto text-[9px] uppercase tracking-[0.12em] text-cslab-muted">
          {paper.sources.join(' · ')}
        </span>
      </div>
    </article>
  )
}
