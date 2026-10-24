/**
 * CsLabLiteratureFilterBar — 学术检索来源与条件筛选栏
 *
 * Editorial Minimalism：低饱和胶囊标签 + 赤陶橙选中态，细线切分，无高饱和高亮。
 */

import * as React from 'react'
import type { CsLabAcademicSearchFilters, CsLabAcademicSource } from '@profer/shared'
import { cn } from '@/lib/utils'

const SOURCE_OPTIONS: Array<{ key: CsLabAcademicSource; label: string }> = [
  { key: 'openalex', label: 'OpenAlex' },
  { key: 'semantic-scholar', label: 'Semantic Scholar' },
  { key: 'arxiv', label: 'arXiv' },
  { key: 'crossref', label: 'Crossref' },
]

export interface CsLabLiteratureFilterBarProps {
  filters: CsLabAcademicSearchFilters
  onChange: (filters: CsLabAcademicSearchFilters) => void
}

export function CsLabLiteratureFilterBar({
  filters,
  onChange,
}: CsLabLiteratureFilterBarProps): React.ReactElement {
  const activeSources = filters.sources ?? []

  const toggleSource = (source: CsLabAcademicSource): void => {
    const next = activeSources.includes(source)
      ? activeSources.filter((item) => item !== source)
      : [...activeSources, source]
    onChange({ ...filters, sources: next.length > 0 && next.length < SOURCE_OPTIONS.length ? next : undefined })
  }

  const setYear = (key: 'yearFrom' | 'yearTo', raw: string): void => {
    const value = raw.trim() ? Number(raw.trim()) : undefined
    onChange({ ...filters, [key]: value && Number.isFinite(value) ? value : undefined })
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-y border-cslab-border/70 px-6 py-2">
      <span className="text-[9px] uppercase tracking-[0.18em] text-cslab-muted">来源</span>
      {SOURCE_OPTIONS.map((option) => {
        const active = activeSources.length === 0 || activeSources.includes(option.key)
        return (
          <button
            key={option.key}
            type="button"
            onClick={() => toggleSource(option.key)}
            className={cn(
              'select-none rounded-full border px-2.5 py-0.5 text-[10px] transition-colors',
              active
                ? 'border-cslab-accent/60 bg-cslab-accent/10 text-cslab-accent'
                : 'border-cslab-border bg-cslab-surface text-cslab-muted hover:text-cslab-text',
            )}
          >
            {option.label}
          </button>
        )
      })}

      <span className="mx-1 h-3 w-px bg-cslab-border" aria-hidden />

      <button
        type="button"
        onClick={() => onChange({ ...filters, openAccessOnly: !filters.openAccessOnly })}
        className={cn(
          'select-none rounded-full border px-2.5 py-0.5 text-[10px] transition-colors',
          filters.openAccessOnly
            ? 'border-cslab-accent/60 bg-cslab-accent/10 text-cslab-accent'
            : 'border-cslab-border bg-cslab-surface text-cslab-muted hover:text-cslab-text',
        )}
      >
        仅开放获取
      </button>

      <span className="mx-1 h-3 w-px bg-cslab-border" aria-hidden />

      <span className="text-[9px] uppercase tracking-[0.18em] text-cslab-muted">年份</span>
      <input
        type="number"
        value={filters.yearFrom ?? ''}
        onChange={(event) => setYear('yearFrom', event.target.value)}
        placeholder="起始"
        className="w-16 rounded-lg border border-cslab-border bg-cslab-surface px-2 py-0.5 text-[10px] text-cslab-text placeholder:text-cslab-muted focus:outline-none focus:ring-1 focus:ring-cslab-accent/40"
      />
      <span className="text-[10px] text-cslab-muted">至</span>
      <input
        type="number"
        value={filters.yearTo ?? ''}
        onChange={(event) => setYear('yearTo', event.target.value)}
        placeholder="截止"
        className="w-16 rounded-lg border border-cslab-border bg-cslab-surface px-2 py-0.5 text-[10px] text-cslab-text placeholder:text-cslab-muted focus:outline-none focus:ring-1 focus:ring-cslab-accent/40"
      />
    </div>
  )
}
