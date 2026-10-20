/**
 * AiClassFlashcardTab — AI 速课堂抽认卡视图（FSRS-7 记忆调度）
 *
 * 本轮复习模型（替代旧版「评分后永远 +1 循环」的鸡肋设计）：
 *   1. 进入即按**本轮队列**（一次性 Fisher-Yates 打乱）逐张推进，队列消费完即结束，
 *      **绝不静默无限循环**——旧版评分到末尾会回到第 1 张，用户误以为「卡片太多」；
 *   2. 本轮结束展示结算页（评分分布 / 掌握率 / 卡组整体进度），并给出
 *      「再来一轮（重新打乱）」与「只重练薄弱卡（重来 / 困难）」；
 *   3. 提供**题号导航面板**：网格列出全部卡片，按状态着色（未学 / 已复习 / 待复习 /
 *      本轮已评），点击任意题号即可跳转，支持快速预览与定位。
 *
 * 每次评分经主进程 FSRS-7 引擎推进记忆状态并落盘，同时通知「学习情况速览」刷新。
 */

import * as React from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Layers,
  LayoutGrid,
  Loader2,
  RotateCw,
  Shuffle,
  Trophy,
} from 'lucide-react'
import { toast } from 'sonner'
import type { FlashcardDeck, FlashcardItem, FlashcardRating } from '@profer/shared'
import { cn } from '@/lib/utils'
import { useBumpStudyRevision } from '@/atoms/study-atoms'

interface AiClassFlashcardTabProps {
  sessionId: string
  deckId: string
}

/** 本轮复习模式：全部卡片 / 仅上一轮薄弱卡 */
type RoundMode = 'all' | 'weak'

const RATINGS: Array<{ rating: FlashcardRating; label: string; hint: string; className: string }> = [
  { rating: 'again', label: '重来', hint: '10 分钟后', className: 'border-rose-400/60 text-rose-500 hover:bg-rose-500/10' },
  { rating: 'hard', label: '困难', hint: '较小间隔', className: 'border-amber-400/60 text-amber-600 hover:bg-amber-500/10' },
  { rating: 'good', label: '良好', hint: '期望间隔', className: 'border-emerald-400/60 text-emerald-600 hover:bg-emerald-500/10' },
  { rating: 'easy', label: '轻松', hint: '大幅拉长', className: 'border-sky-400/60 text-sky-600 hover:bg-sky-500/10' },
]

const RATING_TONE: Record<FlashcardRating, string> = {
  again: 'bg-rose-500 text-white',
  hard: 'bg-amber-500 text-white',
  good: 'bg-emerald-500 text-white',
  easy: 'bg-sky-500 text-white',
}

/** Fisher-Yates 洗牌（返回新数组） */
function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const a = out[i]!
    out[i] = out[j]!
    out[j] = a
  }
  return out
}

/** 卡片在本轮之外的历史状态（用于导航面板着色） */
type CardHistoryState = 'new' | 'reviewing' | 'due'

function historyStateOf(card: FlashcardItem, now: number): CardHistoryState {
  if (card.fsrs.reps === 0) return 'new'
  if (card.fsrs.nextReview <= now) return 'due'
  return 'reviewing'
}

export function AiClassFlashcardTab({ sessionId, deckId }: AiClassFlashcardTabProps): React.ReactElement {
  const [deck, setDeck] = React.useState<FlashcardDeck | null>(null)
  const [loading, setLoading] = React.useState(true)
  /** 本轮卡片 id 顺序（进入/重开时一次性打乱，消费完即结束） */
  const [queue, setQueue] = React.useState<string[]>([])
  /** 本轮评分记录（cardId → 评分） */
  const [roundRatings, setRoundRatings] = React.useState<Record<string, FlashcardRating>>({})
  const [cursor, setCursor] = React.useState(0)
  const [flipped, setFlipped] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [navOpen, setNavOpen] = React.useState(true)
  // 评分后自增学习数据版本号，驱动「学习情况速览」实时刷新
  const bumpStudyRevision = useBumpStudyRevision(sessionId)

  /** 开一轮新练习：打乱队列顺序并清空本轮评分 */
  const startRound = React.useCallback((cards: FlashcardItem[], mode: RoundMode, ratings: Record<string, FlashcardRating>): void => {
    const weakIds = cards.filter((c) => ratings[c.id] === 'again' || ratings[c.id] === 'hard').map((c) => c.id)
    if (mode === 'weak' && weakIds.length === 0) {
      toast.info('本轮没有「重来 / 困难」的卡片，已改为复习全部卡片')
    }
    const sourceIds = mode === 'weak' && weakIds.length > 0 ? weakIds : cards.map((c) => c.id)
    setQueue(shuffle(sourceIds))
    setRoundRatings({})
    setCursor(0)
    setFlipped(false)
  }, [])

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
        const cards = data?.cards ?? []
        setQueue(shuffle(cards.map((c) => c.id)))
        setRoundRatings({})
        setCursor(0)
        setFlipped(false)
      })
      .catch(() => setDeck(null))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [sessionId, deckId])

  const cards = React.useMemo(() => deck?.cards ?? [], [deck])
  const now = Date.now()
  const roundFinished = queue.length > 0 && cursor >= queue.length
  const currentCard = roundFinished ? null : (cards.find((c) => c.id === queue[cursor]) ?? null)

  const rate = async (rating: FlashcardRating): Promise<void> => {
    if (!deck || !currentCard || submitting) return
    setSubmitting(true)
    try {
      const updated = await window.electronAPI.study.updateCardRating({
        sessionId,
        deckId: deck.id,
        cardId: currentCard.id,
        rating,
      })
      if (updated) {
        setDeck((prev) => (prev ? { ...prev, cards: prev.cards.map((c) => (c.id === updated.id ? updated : c)) } : prev))
        setRoundRatings((prev) => ({ ...prev, [updated.id]: rating }))
        // 评分推进 FSRS 状态（reps / nextReview 变化）→ 通知速览卡重算复习进度
        bumpStudyRevision()
      }
      setFlipped(false)
      // 顺序推进；队列尽头即结束（不回到第 1 张，杜绝「无限循环」观感）
      setCursor((value) => Math.min(value + 1, queue.length))
    } catch {
      toast.error('评分失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  /** 跳转到指定题号 */
  const jumpTo = (index: number): void => {
    setCursor(Math.min(Math.max(index, 0), queue.length))
    setFlipped(false)
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

  const ratedCount = Object.keys(roundRatings).length
  const progress = queue.length > 0 ? Math.round((ratedCount / queue.length) * 100) : 0
  const reviewStats = (['again', 'hard', 'good', 'easy'] as FlashcardRating[]).map((rating) => ({
    rating,
    count: Object.values(roundRatings).filter((value) => value === rating).length,
  }))
  const masteredCount = reviewStats
    .filter((stat) => stat.rating === 'good' || stat.rating === 'easy')
    .reduce((sum, stat) => sum + stat.count, 0)
  const masteredRate = ratedCount > 0 ? Math.round((masteredCount / ratedCount) * 100) : 0
  const deckReviewed = cards.filter((c) => c.fsrs.reps > 0).length
  const weakCount = reviewStats.filter((s) => s.rating === 'again' || s.rating === 'hard').reduce((sum, s) => sum + s.count, 0)

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      {/* ===== 顶部：标题 + 本轮进度 + 工具按钮 ===== */}
      <div className="flex shrink-0 items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <span className="truncate font-medium text-foreground">{deck.title}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="rounded-md bg-muted/60 px-1.5 py-0.5 font-mono">
            {Math.min(ratedCount + (roundFinished ? 0 : 1), queue.length)} / {queue.length}
          </span>
          <span>· 卡组已复习 {deckReviewed}/{cards.length}</span>
        </span>
      </div>

      {/* 本轮进度条 */}
      <div className="h-1.5 w-full shrink-0 overflow-hidden rounded-full bg-muted/60">
        <div
          className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-primary transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>

      {roundFinished ? (
        /* ===== 本轮结算页（不再无限循环） ===== */
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-2xl border border-border/60 bg-card p-5 text-center shadow-sm">
          <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Trophy size={22} />
          </span>
          <div>
            <p className="text-sm font-semibold text-foreground">本轮复习完成</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              本轮共复习 {queue.length} 张 · 掌握率 {masteredRate}%（良好 + 轻松）
            </p>
          </div>
          <div className="grid w-full max-w-xs grid-cols-4 gap-1.5">
            {reviewStats.map((item) => (
              <div key={item.rating} className="rounded-lg bg-muted/40 px-1 py-1.5">
                <div className="text-[10px] text-muted-foreground">
                  {RATINGS.find((r) => r.rating === item.rating)?.label}
                </div>
                <div className={cn('font-mono text-xs font-bold', item.rating === 'again' ? 'text-rose-500' : item.rating === 'hard' ? 'text-amber-500' : item.rating === 'good' ? 'text-emerald-500' : 'text-sky-500')}>
                  {item.count}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => startRound(cards, 'all', {})}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-sm transition-opacity hover:opacity-90"
            >
              <Shuffle size={13} />
              再来一轮（重新打乱）
            </button>
            <button
              type="button"
              disabled={weakCount === 0}
              onClick={() => startRound(cards, 'weak', roundRatings)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-primary/40 disabled:opacity-40"
            >
              <AlertTriangle size={13} />
              只重练薄弱卡（{weakCount}）
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* ===== 双面翻转卡片 ===== */}
          <button
            type="button"
            onClick={() => setFlipped((value) => !value)}
            className="flex min-h-0 flex-1 flex-col items-center justify-center rounded-2xl border border-border/60 bg-card p-5 text-center shadow-sm transition-colors hover:border-primary/40"
          >
            <span className="mb-3 inline-flex items-center gap-1 rounded-full bg-muted/60 px-2 py-0.5 text-[10px] text-muted-foreground">
              <RotateCw size={10} />
              第 {cursor + 1} / {queue.length} 张 · {flipped ? '背面 · 解析' : '正面 · 问题'}（点击翻转）
            </span>
            {!flipped ? (
              <p className="text-base font-semibold leading-relaxed text-foreground">{currentCard?.front}</p>
            ) : (
              <p className="text-sm leading-relaxed text-foreground/90">{currentCard?.back}</p>
            )}
            {flipped && currentCard?.sourceAnchor && (
              <span className="mt-3 text-[10px] text-muted-foreground">出处：{currentCard.sourceAnchor}</span>
            )}
          </button>

          {/* ===== 四挡评分 ===== */}
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

          {/* ===== 上一张 / 下一张 ===== */}
          <div className="flex shrink-0 items-center justify-between gap-2">
            <button
              type="button"
              disabled={cursor <= 0}
              onClick={() => jumpTo(cursor - 1)}
              className="inline-flex items-center gap-1 rounded-lg border border-border/60 bg-background px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
            >
              <ChevronLeft size={13} />
              上一张
            </button>
            <button
              type="button"
              onClick={() => setNavOpen((value) => !value)}
              className="inline-flex items-center gap-1 rounded-lg border border-border/60 bg-background/70 px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
            >
              <LayoutGrid size={13} />
              题号导航{navOpen ? '（收起）' : `（${queue.length}）`}
            </button>
            <button
              type="button"
              onClick={() => jumpTo(cursor + 1)}
              className="inline-flex items-center gap-1 rounded-lg border border-border/60 bg-background px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              下一张
              <ChevronRight size={13} />
            </button>
          </div>
        </>
      )}

      {/* ===== 题号导航面板：全部卡片网格，按状态着色，点击跳转 ===== */}
      {navOpen && (
        <div className="shrink-0 rounded-xl border border-border/60 bg-card/60 p-2.5">
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Layers size={11} /> 共 {queue.length} 张
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="size-2 rounded-sm bg-muted-foreground/40" /> 未学
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="size-2 rounded-sm bg-emerald-500/70" /> 已复习
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="size-2 rounded-sm bg-amber-500/80" /> 待复习
            </span>
            <span className="inline-flex items-center gap-1">
              <CheckCircle2 size={11} className="text-primary" /> 本轮已评
            </span>
          </div>
          <div className="grid max-h-40 grid-cols-10 gap-1 overflow-y-auto pr-0.5">
            {queue.map((cardId, index) => {
              const card = cards.find((c) => c.id === cardId)
              if (!card) return null
              const roundRating = roundRatings[cardId]
              const historyState = historyStateOf(card, now)
              const isCurrent = index === cursor && !roundFinished
              return (
                <button
                  key={cardId}
                  type="button"
                  title={`第 ${index + 1} 张 · ${card.front.slice(0, 24)}${roundRating ? ` · 本轮已评（${roundRating}）` : historyState === 'new' ? ' · 未学' : historyState === 'due' ? ' · 待复习' : ' · 已复习'}`}
                  onClick={() => jumpTo(index)}
                  className={cn(
                    'flex h-6 items-center justify-center rounded-md border font-mono text-[10px] font-semibold transition-all',
                    isCurrent && 'ring-2 ring-primary/60',
                    roundRating
                      ? `${RATING_TONE[roundRating]} border-transparent`
                      : historyState === 'reviewing'
                        ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                        : historyState === 'due'
                          ? 'border-amber-500/40 bg-amber-500/15 text-amber-600 dark:text-amber-400'
                          : 'border-border/60 bg-muted/40 text-muted-foreground hover:border-primary/40',
                  )}
                >
                  {index + 1}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
