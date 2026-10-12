/**
 * TabGroupItem — 顶栏里的「组合 tab」条目
 *
 * 组合的两个成员在顶栏折叠成这一个条目：单条目、双标题，并且必须一眼看出
 * "这不是普通标签，而是两个会话的组合"（用户明确要求特殊样式）。
 *
 * 宽度分配（不要改回 flex-1 各占一半）：
 * - 条目用 `w-fit` + min/max：宽度由两个标题的**实际内容**撑开，max 只兜住极端长标题；
 * - 两个标题各自按**自然宽度**排布（`min-w-0 shrink`，不设 flex-grow），
 *   因此中间那条竖线的位置由两个会话标题的真实长度决定，而不是钉在正中；
 * - 会话改名会通过 tabsAtom → title → 重新测量自然宽度，自动重新分配（无需额外逻辑）；
 * - 右标题之后放一个 `flex-1` 弹性空隙，把解散/关闭按钮稳定压到条目右缘。
 *
 * 交互约定：
 * - 点击左/右半区分别聚焦对应分屏（onActivateLeft / onActivateRight）；
 * - 内部按钮补齐 onMouseDown 冒泡拦截，避免误触发父按钮的拖动/激活；
 * - 两个成员各有自己的状态点与「需处理」琥珀色呼吸指示点。
 */

import * as React from 'react'
import { Columns2, Ungroup, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SessionIndicatorStatus } from '@/atoms/agent-atoms'
import { SESSION_STATUS_DOT_CLASS, SESSION_STATUS_LABEL } from '@/lib/session-status-visual'
import { Tooltip, TooltipContent, TooltipTrigger } from '@profer/ui/primitives/tooltip'
import type { TabGroupSide } from '@/atoms/tab-group-atoms'

export interface TabGroupItemProps {
  id: string
  /** 该栏标题；null = 空栏（等用户选择） */
  leftTitle: string | null
  rightTitle: string | null
  leftStatus: SessionIndicatorStatus
  rightStatus: SessionIndicatorStatus
  /** 左/右成员是否正在等待权限审批 / 提问回答（渲染琥珀色呼吸指示点） */
  leftNeedsAttention?: boolean
  rightNeedsAttention?: boolean
  isActive: boolean
  /** 当前焦点侧（焦点 = activeTabId 属于哪一侧） */
  focusedSide: TabGroupSide
  /** 点击左半区聚焦左分屏 */
  onActivateLeft: () => void
  /** 点击右半区聚焦右分屏 */
  onActivateRight: () => void
  /** 点击组合条目（回退到焦点成员） */
  onActivate: () => void
  /** 解散组合（两个标签都保留） */
  onDissolve: () => void
  /** 中键拆分组合（与解散按钮一致，不关闭成员标签） */
  onMiddleClick: () => void
  /** 关闭整组（两个标签都关闭） */
  onCloseGroup: () => void
  onDragStart: (e: React.PointerEvent) => void
}

function StatusDot({
  status,
  needsAttention,
}: {
  status: SessionIndicatorStatus
  needsAttention?: boolean
}): React.ReactElement | null {
  if (needsAttention) {
    return (
      <span
        className="size-1.5 shrink-0 rounded-full bg-amber-500 animate-pulse"
        title="等待你的处理"
        aria-hidden="true"
      />
    )
  }
  if (status === 'idle') return null
  return (
    <span
      className={cn('size-1.5 shrink-0 rounded-full', SESSION_STATUS_DOT_CLASS[status])}
      title={SESSION_STATUS_LABEL[status]}
      aria-hidden="true"
    />
  )
}

export function TabGroupItem({
  id,
  leftTitle,
  rightTitle,
  leftStatus,
  rightStatus,
  leftNeedsAttention,
  rightNeedsAttention,
  isActive,
  focusedSide,
  onActivateLeft,
  onActivateRight,
  onActivate,
  onDissolve,
  onMiddleClick,
  onCloseGroup,
  onDragStart,
}: TabGroupItemProps): React.ReactElement {
  const pointerStartRef = React.useRef<{ x: number; y: number } | null>(null)
  const suppressClickRef = React.useRef(false)
  const leftLabel = leftTitle ?? '选择会话…'
  const rightLabel = rightTitle ?? '选择会话…'

  const handleMouseDown = (e: React.MouseEvent): void => {
    if (e.button !== 1) return
    e.preventDefault()
    e.stopPropagation()
    onMiddleClick()
  }

  const handlePointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    pointerStartRef.current = { x: e.clientX, y: e.clientY }
    suppressClickRef.current = false
    e.currentTarget.setPointerCapture(e.pointerId)
    onDragStart(e)
  }

  const handleClick = (e: React.MouseEvent): void => {
    if (suppressClickRef.current) {
      e.preventDefault()
      e.stopPropagation()
      suppressClickRef.current = false
      return
    }
    onActivate()
  }

  const handlePointerMove = (e: React.PointerEvent): void => {
    const start = pointerStartRef.current
    if (!start) return
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5) {
      suppressClickRef.current = true
    }
  }

  const handlePointerUp = (e: React.PointerEvent): void => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    pointerStartRef.current = null
  }

  /** 点击左/右半区：聚焦对应分屏，避免拖动/中键误判 */
  const activateSide = (side: TabGroupSide) => (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (suppressClickRef.current) return
    if (side === 'left') (leftTitle ? onActivateLeft : onActivate)()
    else (rightTitle ? onActivateRight : onActivate)()
  }

  return (
    <div
      data-tab-id={id}
      data-tab-group="true"
      className={cn(
        // w-fit：宽度由两个标题内容决定；min-w 只保证图标+按钮的基本可用宽度，
        // max-w 防止超长标题把整条顶栏吃掉。中线位置由内容决定，见文件头说明。
        'relative w-fit flex-none titlebar-no-drag',
        isActive ? 'min-w-[168px] max-w-[420px]' : 'min-w-[152px] max-w-[400px] hover:min-w-[168px]',
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={isActive}
        aria-label={`组合标签页：${leftTitle ?? '空栏'} 与 ${rightTitle ?? '空栏'}（左右双栏）`}
        className={cn(
          'group relative flex h-[37px] w-full items-center gap-1.5 overflow-hidden rounded-[8px] px-2 pl-2.5 text-xs',
          'border border-transparent transition-colors select-none cursor-grab active:cursor-grabbing focus-visible:ring-0 focus-visible:ring-offset-0',
          isActive
            ? 'topbar-tab-active text-foreground'
            : 'topbar-tab-inactive text-muted-foreground hover:text-foreground',
        )}
        onClick={handleClick}
        onMouseDown={handleMouseDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {/* 组合色条：与普通标签的视觉分水岭，同时标示焦点侧 */}
        <span
          aria-hidden="true"
          className={cn(
            'absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full',
            isActive ? 'bg-tab/60' : focusedSide === 'left' ? 'bg-primary/70' : 'bg-primary/40',
          )}
        />
        <Columns2 className="size-3.5 shrink-0 opacity-80" aria-hidden="true" />

        {/* 左半区：点击聚焦左分屏 */}
        <span
          role="presentation"
          className="flex min-w-0 shrink items-center gap-1"
          onClick={activateSide('left')}
        >
          <span
            className={cn(
              'truncate',
              !leftTitle && 'italic text-muted-foreground/60',
              leftTitle && (focusedSide === 'left' ? 'font-medium' : 'text-muted-foreground'),
            )}
          >
            {leftLabel}
          </span>
          <StatusDot status={leftStatus} needsAttention={leftNeedsAttention} />
        </span>

        <span aria-hidden="true" className={cn('h-3 w-px shrink-0', isActive ? 'bg-tab/35' : 'bg-border/60')} />

        {/* 右半区：点击聚焦右分屏 */}
        <span
          role="presentation"
          className="flex min-w-0 shrink items-center gap-1"
          onClick={activateSide('right')}
        >
          <span
            className={cn(
              'truncate',
              !rightTitle && 'italic text-muted-foreground/60',
              rightTitle && (focusedSide === 'right' ? 'font-medium' : 'text-muted-foreground'),
            )}
          >
            {rightLabel}
          </span>
          <StatusDot status={rightStatus} needsAttention={rightNeedsAttention} />
        </span>

        {/* 弹性空隙：两个标题按自然宽度排完后剩余的宽度都给它（fit-content 下不占自然宽），
            这样解散/关闭按钮始终贴在条目右缘，而不是紧跟在右标题后面。 */}
        <span aria-hidden="true" className="min-w-0 flex-1" />

        {/* 解散组合：hover 才出现，避免与关闭按钮并排造成误点 */}
        <span
          role="button"
          tabIndex={-1}
          aria-label="解散组合"
          title="解散组合（两个标签都保留）"
          className="hidden size-4 shrink-0 items-center justify-center rounded-sm group-hover:flex hover:bg-muted-foreground/20"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            onDissolve()
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <Ungroup className="size-2.5" aria-hidden="true" />
        </span>

        <Tooltip>
          <TooltipTrigger asChild>
            <span
              role="button"
              tabIndex={-1}
              aria-label="关闭组合（关闭两个标签）"
              className="flex size-4 shrink-0 items-center justify-center rounded-sm opacity-60 transition-opacity hover:bg-muted-foreground/20 hover:opacity-100"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                onCloseGroup()
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <X className="size-3" aria-hidden="true" />
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>关闭组合（两个标签都关闭）</p>
          </TooltipContent>
        </Tooltip>
      </button>
    </div>
  )
}
