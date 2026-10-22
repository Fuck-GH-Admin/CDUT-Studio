/**
 * CsLabReviewMarginalia — 审稿旁注（Marginalia）
 *
 * 性能红线：
 * - 位置只用 `transform: translateY()` 调整（GPU 合成层），绝不改 top/margin；
 * - 一维重力松弛避障由 @profer/shared 的纯函数计算；
 * - 接受/拒绝后卡片先淡出位移，再由 ProseMirror 状态驱动卸载。
 */

import * as React from 'react'
import { Check, X } from 'lucide-react'
import {
  buildConnectorPath,
  calculateMarginaliaLayout,
  type CsLabPositionedComment,
} from '@profer/shared'
import { cn } from '@/lib/utils'
import {
  CSLAB_PERSONA_META,
  type CsLabCollectedSuggestion,
} from './cslab-track-changes-extension'
import type { Editor } from '@tiptap/core'

interface CsLabReviewMarginaliaProps {
  editor: Editor | null
  suggestions: CsLabCollectedSuggestion[]
  active: boolean
  onAccept: (id: string) => void
  onReject: (id: string) => void
}

interface ExitingCard {
  suggestion: CsLabCollectedSuggestion
  top: number
}

export function CsLabReviewMarginalia({
  editor,
  suggestions,
  active,
  onAccept,
  onReject,
}: CsLabReviewMarginaliaProps): React.ReactElement | null {
  const columnRef = React.useRef<HTMLDivElement | null>(null)
  const cardRefs = React.useRef(new Map<string, HTMLDivElement>())
  const layoutRef = React.useRef<CsLabPositionedComment[]>([])
  const previousSuggestions = React.useRef<CsLabCollectedSuggestion[]>([])
  const [layout, setLayout] = React.useState<CsLabPositionedComment[]>([])
  const [measureTick, setMeasureTick] = React.useState(0)
  const [exiting, setExiting] = React.useState<ExitingCard[]>([])

  const recompute = React.useCallback((): void => {
    const column = columnRef.current
    const view = editor?.view
    if (!column || !view) {
      setLayout([])
      layoutRef.current = []
      return
    }
    const columnRect = column.getBoundingClientRect()
    const anchors = suggestions.map((suggestion) => {
      let targetTop = 0
      try {
        const coords = view.coordsAtPos(suggestion.from)
        targetTop = Math.max(0, coords.top - columnRect.top)
      } catch {
        targetTop = Math.max(
          0,
          layoutRef.current.find((item) => item.id === suggestion.id)?.targetTop ?? 0,
        )
      }
      return {
        id: suggestion.id,
        targetTop,
        cardHeight: cardRefs.current.get(suggestion.id)?.offsetHeight ?? 92,
      }
    })
    const next = calculateMarginaliaLayout(anchors, 14)
    layoutRef.current = next
    setLayout(next)
  }, [editor, suggestions])

  // 初次渲染后测量真实高度，再进行第二轮排程（避免使用估算高度）。
  React.useLayoutEffect(() => {
    if (!active) return
    const timer = window.setTimeout(() => setMeasureTick((value) => value + 1), 0)
    return () => window.clearTimeout(timer)
  }, [active, suggestions])

  React.useLayoutEffect(() => {
    if (!active) return
    recompute()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, suggestions, measureTick])

  React.useEffect(() => {
    if (!active) return
    const view = editor?.view
    const scrollParent = view?.dom.closest('[data-cslab-scroll]') as HTMLElement | null
    const handle = (): void => recompute()
    view?.dom.addEventListener('scroll', handle, true)
    scrollParent?.addEventListener('scroll', handle, { passive: true })
    window.addEventListener('resize', handle)
    editor?.on('update', handle)
    return () => {
      view?.dom.removeEventListener('scroll', handle, true)
      scrollParent?.removeEventListener('scroll', handle)
      window.removeEventListener('resize', handle)
      editor?.off('update', handle)
    }
  }, [active, editor, recompute])

  // 建议消失（接受/拒绝）时先播淡出位移，再卸载。
  React.useEffect(() => {
    const currentIds = new Set(suggestions.map((item) => item.id))
    const missing = previousSuggestions.current.filter((item) => !currentIds.has(item.id))
    previousSuggestions.current = suggestions
    if (missing.length === 0) return
    const cards: ExitingCard[] = []
    for (const suggestion of missing) {
      const previous = layoutRef.current.find((entry) => entry.id === suggestion.id)
      cards.push({ suggestion, top: previous?.actualTop ?? 0 })
    }
    setExiting((previous) => [...previous, ...cards])
    const timer = window.setTimeout(() => {
      setExiting((previous) => previous.filter((card) => !cards.includes(card)))
    }, 260)
    return () => window.clearTimeout(timer)
  }, [suggestions])

  if (!active) return null

  const cardById = new Map(suggestions.map((item) => [item.id, item]))
  const svgHeight = Math.max(
    900,
    ...layout.map((item) => item.actualTop + 120),
    ...exiting.map((item) => item.top + 120),
  )

  return (
    <aside
      ref={columnRef}
      className="relative ml-6 w-[268px] shrink-0 select-text"
      aria-label="审稿旁注"
    >
      <div className="sticky top-0 mb-2 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-[0.16em] text-cslab-muted">
          Review Marginalia
        </span>
        <span className="text-[10px] tabular-nums text-cslab-muted/70">
          {suggestions.length}
        </span>
      </div>

      <div className="relative" style={{ minHeight: 860 }}>
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox={`0 0 268 ${svgHeight}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {layout.map((item) => {
            const suggestion = cardById.get(item.id)
            if (!suggestion) return null
            return (
              <path
                key={`connector-${item.id}`}
                d={buildConnectorPath(0, item.targetTop + 14, 14, item.actualTop + 14)}
                fill="none"
                className="stroke-cslab-accent"
                strokeWidth={1}
                strokeDasharray="3 3"
                vectorEffect="non-scaling-stroke"
                opacity={0.65}
              />
            )
          })}
        </svg>

        {layout.map((item) => {
          const suggestion = cardById.get(item.id)
          if (!suggestion) return null
          return (
            <ReviewCard
              key={suggestion.id}
              suggestion={suggestion}
              top={item.actualTop}
              offset={item.connectorOffset}
              onAccept={onAccept}
              onReject={onReject}
              registerRef={(element) => {
                if (element) cardRefs.current.set(suggestion.id, element)
                else cardRefs.current.delete(suggestion.id)
              }}
            />
          )
        })}

        {exiting.map((item, index) => (
          <div
            key={`exiting-${item.suggestion.id}-${index}`}
            style={{ top: item.top }}
            className="pointer-events-none absolute left-0 right-0 translate-x-[50px] rounded-lg border border-cslab-border bg-cslab-elevated p-2 opacity-0 shadow-subtle transition-all duration-200"
          >
            <p className="truncate text-[10px] text-cslab-muted">{item.suggestion.quote}</p>
          </div>
        ))}

        {suggestions.length === 0 && (
          <p className="mt-10 text-[10px] leading-relaxed text-cslab-muted">
            暂无审稿意见。召唤一位 AI 审稿专家，或在正文中选中文字添加批注。
          </p>
        )}
      </div>
    </aside>
  )
}

interface ReviewCardProps {
  suggestion: CsLabCollectedSuggestion
  top: number
  offset: number
  onAccept: (id: string) => void
  onReject: (id: string) => void
  registerRef: (element: HTMLDivElement | null) => void
}

function ReviewCard({
  suggestion,
  top,
  offset,
  onAccept,
  onReject,
  registerRef,
}: ReviewCardProps): React.ReactElement {
  const meta = CSLAB_PERSONA_META[suggestion.persona] ?? CSLAB_PERSONA_META.human
  const label =
    suggestion.kind === 'insertion'
      ? '建议插入'
      : suggestion.kind === 'deletion'
        ? '建议删除'
        : suggestion.kind === 'block'
          ? '段落级建议'
          : '批注'

  return (
    <div
      ref={registerRef}
      style={{
        top,
        transform: `translateY(${offset}px)`,
        borderColor: meta.border,
        background: meta.background,
      }}
      className={cn(
        'pointer-events-auto absolute left-0 right-0 rounded-lg border p-2 shadow-subtle transition-transform duration-150',
      )}
    >
      <div className="flex items-center gap-1.5">
        <span
          className="rounded px-1 py-0.5 text-[9px] font-medium text-white"
          style={{ background: meta.color }}
        >
          {meta.title}
        </span>
        <span className="text-[9px] text-cslab-muted">{label}</span>
        <span className="ml-auto max-w-[80px] truncate text-[9px] text-cslab-muted">
          {suggestion.authorName}
        </span>
      </div>
      {suggestion.quote && (
        <p className="mt-1 line-clamp-3 font-serif text-[11px] leading-relaxed text-cslab-text">
          “{suggestion.quote}”
        </p>
      )}
      {suggestion.comment && (
        <p className="mt-1 text-[10px] leading-relaxed text-cslab-muted">{suggestion.comment}</p>
      )}
      <div className="mt-1.5 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onAccept(suggestion.id)}
          className="inline-flex items-center gap-1 rounded bg-cslab-accent px-2 py-0.5 text-[9px] font-medium text-white transition-colors hover:bg-cslab-accentHover"
        >
          <Check size={9} /> 接受
        </button>
        <button
          type="button"
          onClick={() => onReject(suggestion.id)}
          className="inline-flex items-center gap-1 rounded border border-cslab-border bg-cslab-elevated px-2 py-0.5 text-[9px] text-cslab-muted transition-colors hover:bg-cslab-surface hover:text-cslab-text"
        >
          <X size={9} /> 拒绝
        </button>
      </div>
    </div>
  )
}
