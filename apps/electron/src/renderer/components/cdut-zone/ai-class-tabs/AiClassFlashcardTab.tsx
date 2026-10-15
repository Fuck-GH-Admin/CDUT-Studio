/**
 * AiClassFlashcardTab — AI 速课堂抽认卡视图（FSRS-7 记忆调度）
 *
 * 双面翻转卡片（正面问题 / 背面解析），背面对应 4 挡评分（Again / Hard / Good / Easy），
 * 每次评分经主进程 FSRS-7 引擎推进记忆状态并落盘，随后自动跳转下一张。
 */

import * as React from 'react'
import { Loader2, RotateCw } from 'lucide-react'
import { toast } from 'sonner'
import type { FlashcardDeck, FlashcardRating } from '@profer/shared'
import { cn } from '@/lib/utils'

interface AiClassFlashcardTabProps {
  sessionId: string
  deckId: string
}

const RATINGS: Array<{ rating: FlashcardRating; label: string; hint: string; className: string }> = [
  { rating: 'again', label: '重来', hint: '10 分钟后', className: 'border-rose-400/60 text-rose-500 hover:bg-rose-500/10' },
  { rating: 'hard', label: '困难', hint: '较小间隔', className: 'border-amber-400/60 text-amber-600 hover:bg-amber-500/10' },
  { rating: 'good', label: '良好', hint: '期望间隔', className: 'border-emerald-400/60 text-emerald-600 hover:bg-emerald-500/10' },
  { rating: 'easy', label: '轻松', hint: '大幅拉长', className: 'border-sky-400/60 text-sky-600 hover:bg-sky-500/10' },
]

export function AiClassFlashcardTab({ sessionId, deckId }: AiClassFlashcardTabProps): React.ReactElement {
  const [deck, setDeck] = React.useState<FlashcardDeck | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [index, setIndex] = React.useState(0)
  const [flipped, setFlipped] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)

  React.useEffect(() => {
    let alive = true
    if (!deckId) {
      setDeck(null)
      setLoading(false)
      return
    }
    setLoading(true)
    window.electronAPI.study
      .getFlashcards({ sessionId, deckId })
      .then((data) => {
        if (!alive) return
        setDeck(data)
        setIndex(0)
        setFlipped(false)
      })
      .catch(() => setDeck(null))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [sessionId, deckId])

  const cards = deck?.cards ?? []
  const card = cards[index] ?? null

  const rate = async (rating: FlashcardRating): Promise<void> => {
    if (!deck || !card || submitting) return
    setSubmitting(true)
    try {
      const updated = await window.electronAPI.study.updateCardRating({
        sessionId,
        deckId: deck.id,
        cardId: card.id,
        rating,
      })
      if (updated) {
        setDeck((prev) => (prev ? { ...prev, cards: prev.cards.map((c) => (c.id === updated.id ? updated : c)) } : prev))
        toast.success(`「${card.front.slice(0, 12)}…」已评分（${rating}）`)
      }
      setFlipped(false)
      setIndex((i) => (i + 1 < cards.length ? i + 1 : 0))
    } catch {
      toast.error('评分失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 size={18} className="animate-spin" />
      </div>
    )
  }
  if (!deck || cards.length === 0) {
    return <div className="flex h-full items-center justify-center p-6 text-center text-[11px] text-muted-foreground">尚未生成抽认卡，请回到学习主页创建。</div>
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <div className="flex shrink-0 items-center justify-between text-[10px] text-muted-foreground">
        <span className="truncate font-medium text-foreground">{deck.title}</span>
        <span>
          {index + 1} / {cards.length} · 已复习 {card?.fsrs.reps ?? 0} 次
        </span>
      </div>

      {/* 双面翻转卡片 */}
      <button
        type="button"
        onClick={() => setFlipped((value) => !value)}
        className="flex min-h-0 flex-1 flex-col items-center justify-center rounded-2xl border border-border/60 bg-card p-5 text-center shadow-sm transition-colors hover:border-primary/40"
      >
        <span className="mb-3 inline-flex items-center gap-1 rounded-full bg-muted/60 px-2 py-0.5 text-[10px] text-muted-foreground">
          <RotateCw size={10} />
          {flipped ? '背面 · 解析' : '正面 · 问题'}（点击翻转）
        </span>
        {!flipped ? (
          <p className="text-base font-semibold leading-relaxed text-foreground">{card?.front}</p>
        ) : (
          <p className="text-sm leading-relaxed text-foreground/90">{card?.back}</p>
        )}
        {flipped && card?.sourceAnchor && (
          <span className="mt-3 text-[10px] text-muted-foreground">出处：{card.sourceAnchor}</span>
        )}
      </button>

      {/* 四挡评分 */}
      <div className={cn('grid shrink-0 grid-cols-4 gap-2 transition-opacity', flipped ? 'opacity-100' : 'pointer-events-none opacity-40')}>
        {RATINGS.map((item) => (
          <button
            key={item.rating}
            type="button"
            disabled={!flipped || submitting}
            onClick={() => void rate(item.rating)}
            className={cn('flex flex-col items-center gap-0.5 rounded-xl border bg-background/60 px-2 py-2 text-center transition-colors disabled:opacity-60', item.className)}
          >
            <span className="text-xs font-semibold">{item.label}</span>
            <span className="text-[9px] opacity-80">{item.hint}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
