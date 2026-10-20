/**
 * CsLabSlideDrawer — 智能上下文滑出抽屉
 *
 * 平常宽度 0 贴附右侧；打开时 250ms 平滑展开为 380px，承载资产详情、
 * 胶囊溯源与 Agent 工序推演。内容宽度固定，避免收起过程被挤压。
 */

import * as React from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface CsLabSlideDrawerProps {
  open: boolean
  title: string
  subtitle?: string
  wide?: boolean
  onClose: () => void
  children: React.ReactNode
}

export function CsLabSlideDrawer({
  open,
  title,
  subtitle,
  wide = false,
  onClose,
  children,
}: CsLabSlideDrawerProps): React.ReactElement {
  const widthClass = wide ? 'w-[520px]' : 'w-[380px]'
  return (
    <div
      aria-hidden={!open}
      className={cn(
        'relative shrink-0 overflow-hidden border-l bg-cslab-bg transition-[width] duration-[250ms] ease-out',
        open ? `${widthClass} border-cslab-border` : 'w-0 border-transparent',
      )}
    >
      <div className={cn('flex h-full flex-col', widthClass)}>
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-cslab-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate font-serif text-[15px] font-medium text-cslab-text">{title}</h2>
            {subtitle && (
              <p className="mt-0.5 truncate text-[10px] uppercase tracking-[0.14em] text-cslab-muted">
                {subtitle}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="收起抽屉"
            className="shrink-0 rounded-lg p-1.5 text-cslab-muted transition-colors hover:bg-cslab-surface hover:text-cslab-text"
          >
            <X size={14} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
      </div>
    </div>
  )
}
