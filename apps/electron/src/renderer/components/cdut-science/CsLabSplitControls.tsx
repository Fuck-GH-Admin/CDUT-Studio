/**
 * CsLabSplitControls — 单屏 / 左右 / 上下 / 田字格 布局切换
 */

import * as React from 'react'
import { Columns2, Grid2x2, Rows2, Square } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CsLabSplitLayout } from '@/atoms/cslab-atoms'

interface CsLabSplitControlsProps {
  layout: CsLabSplitLayout
  onChange: (layout: CsLabSplitLayout) => void
}

const OPTIONS: Array<{
  layout: CsLabSplitLayout
  label: string
  shortcut: string
  Icon: typeof Square
}> = [
  { layout: 'single', label: '单屏', shortcut: 'Alt+1', Icon: Square },
  { layout: 'split-vertical', label: '左右分屏', shortcut: 'Alt+2', Icon: Columns2 },
  { layout: 'split-horizontal', label: '上下分屏', shortcut: 'Alt+3', Icon: Rows2 },
  { layout: 'grid-4', label: '田字格四分屏', shortcut: 'Alt+4', Icon: Grid2x2 },
]

export function CsLabSplitControls({
  layout,
  onChange,
}: CsLabSplitControlsProps): React.ReactElement {
  return (
    <div
      role="group"
      aria-label="舞台分屏布局"
      className="flex items-center gap-0.5 rounded-lg border border-cslab-border bg-cslab-bg px-0.5 py-0.5"
    >
      {OPTIONS.map(({ layout: value, label, shortcut, Icon }) => {
        const active = layout === value
        return (
          <button
            key={value}
            type="button"
            onClick={() => onChange(value)}
            title={`${label}（${shortcut}）`}
            aria-label={`${label}（${shortcut}）`}
            aria-pressed={active}
            className={cn(
              'rounded-md p-1.5 transition-colors',
              active
                ? 'bg-cslab-accent/12 text-cslab-accent'
                : 'text-cslab-muted hover:bg-cslab-surface hover:text-cslab-text',
            )}
          >
            <Icon size={13} />
          </button>
        )
      })}
    </div>
  )
}
