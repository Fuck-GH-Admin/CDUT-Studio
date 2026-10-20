/**
 * AiClassStudyOverview — 左栏「学习情况速览」卡片
 *
 * 位于「已上传资料」与「资料树」之间的现代卡片，实时聚合 4 项核心学习指标：
 *   1. 学习总进度：抽认卡复习进度与测验作答完成度的加权合成（无数据时为 0%）；
 *   2. 核心概念：已生成思维导图的节点总数（导图节点即萃取的知识概念）；
 *   3. 自测答题评估：最近一次自测得分与 FIM 潜伏认知能力 θ 熟练度；
 *   4. 重点闪卡：已生成的复习卡片总数。
 *
 * 数据全量来自 Jotai 原子（aiClassArtifactsMapAtom）与 study IPC 实时查询，
 * 不引入任何本地缓存文件，遵循 AGENTS.md 轻量配置优先原则。
 */

import * as React from 'react'
import { Sparkles } from 'lucide-react'
import { describeTheta, type QuizSession } from '@profer/shared'
import { useAiClassArtifacts, useStudyDataRevision } from '@/atoms/study-atoms'

export function AiClassStudyOverview({ sessionId }: { sessionId: string }): React.ReactElement {
  const [artifacts] = useAiClassArtifacts(sessionId)
  // 学习数据版本号：测验作答 / 重置 / 闪卡评分等写操作后自增，驱动本卡片实时重拉
  const revision = useStudyDataRevision(sessionId)
  const [latestQuiz, setLatestQuiz] = React.useState<QuizSession | null>(null)
  const [flashcardStats, setFlashcardStats] = React.useState({ total: 0, reviewed: 0 })

  // 实时拉取最近一次测验与抽认卡复习进度
  // 依赖：sessionId（切换课堂）、artifacts（生成新工件）、revision（作答/评分等数据写操作）
  React.useEffect(() => {
    if (!sessionId) return
    let alive = true
    window.electronAPI.study
      .getQuiz({ sessionId })
      .then((quiz) => {
        if (alive) setLatestQuiz(quiz)
      })
      .catch(() => {})
    window.electronAPI.study
      .getFlashcards({ sessionId })
      .then((deck) => {
        if (!alive) return
        const cards = deck?.cards ?? []
        setFlashcardStats({
          total: cards.length,
          reviewed: cards.filter((card) => card.fsrs.reps > 0).length,
        })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [sessionId, artifacts, revision])

  // ===== 指标派生（纯计算，无副作用） =====
  const mindmapNodes = artifacts
    .filter((item) => item.kind === 'mindmap')
    .reduce((sum, item) => sum + item.itemCount, 0)
  // 闪卡指标一律以**实时学习数据**为准：工件摘要里的 itemCount 是生成时的静态总量，
  // 不会随评分变化，若直接展示会导致「抽认卡对速览毫无影响」（历史 Bug）。
  // 工件总量仅用于实时数据尚未就绪（如尚未落盘）时的兜底。
  const flashcardArtifactTotal = artifacts
    .filter((item) => item.kind === 'flashcard')
    .reduce((sum, item) => sum + item.itemCount, 0)
  const flashcardTotal = flashcardStats.total || flashcardArtifactTotal
  const flashcardReviewed = Math.min(flashcardStats.reviewed, flashcardTotal || flashcardStats.reviewed)

  // 学习总进度：抽认卡复习率与测验完成率各占 50%（仅有其一则取该信号，全空为 0%）
  const flashcardRatio = flashcardStats.total > 0 ? flashcardStats.reviewed / flashcardStats.total : null
  const quizRatio = latestQuiz && latestQuiz.questions.length > 0
    ? latestQuiz.questions.filter((q) => q.isCorrect !== undefined).length / latestQuiz.questions.length
    : null
  const signals = [flashcardRatio, quizRatio].filter((v): v is number => v !== null)
  const progress = signals.length > 0
    ? Math.round((signals.reduce((sum, v) => sum + v, 0) / signals.length) * 100)
    : 0

  // 熟练度文案：θ ≥ 0.5 熟练，≥ -0.5 一般，否则待加强
  const thetaLabel = latestQuiz ? (latestQuiz.estimatedTheta >= 0.5 ? '熟练' : latestQuiz.estimatedTheta >= -0.5 ? '一般' : '待加强') : null

  return (
    <div className="shrink-0 rounded-xl border border-border/50 bg-card/60 p-3 shadow-sm backdrop-blur-sm space-y-2.5">
      <div className="flex items-center justify-between text-xs font-semibold text-foreground/80">
        <span className="flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          学习情况速览
        </span>
        <span className="font-mono text-[11px] font-bold text-emerald-500">{progress}%</span>
      </div>
      {/* 总进度条 */}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60">
        <div
          className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-primary transition-all duration-500"
          style={{ width: `${Math.max(progress, progress > 0 ? 4 : 0)}%` }}
        />
      </div>
      <div className="grid grid-cols-3 gap-2 pt-1 text-center">
        <div className="rounded-lg bg-muted/40 p-1.5">
          <div className="text-[10px] text-muted-foreground">核心概念</div>
          <div className="font-mono text-xs font-bold text-foreground">{mindmapNodes}个</div>
        </div>
        <div className="rounded-lg bg-muted/40 p-1.5">
          <div className="text-[10px] text-muted-foreground">自测正确率</div>
          <div className={cnQuiz(latestQuiz?.score)}>
            {latestQuiz ? `${latestQuiz.score}%` : '—'}
          </div>
        </div>
        <div className="rounded-lg bg-muted/40 p-1.5">
          <div className="text-[10px] text-muted-foreground">闪卡复习</div>
          <div className={cnFlashcard(flashcardReviewed)}>
            {flashcardReviewed}/{flashcardTotal}
          </div>
        </div>
      </div>
      {/* FIM 潜伏认知能力：独立高对比度指标条（历史反馈：原 10px 小字看不清） */}
      {latestQuiz && thetaLabel && (
        <div className="flex items-center justify-between rounded-lg border border-primary/25 bg-primary/10 px-2.5 py-2">
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            FIM 认知能力
          </span>
          <span className="flex items-baseline gap-1.5">
            <span className="font-mono text-base font-bold leading-none text-primary">
              θ = {latestQuiz.estimatedTheta.toFixed(2)}
            </span>
            <span className="rounded-md bg-primary/15 px-1.5 py-0.5 text-[11px] font-semibold text-primary">
              {thetaLabel}
            </span>
          </span>
        </div>
      )}
    </div>
  )
}

/** 自测正确率配色：<60 红、60-69 琥珀、70-89 天蓝、≥90 翠绿（与成绩抽屉调色标准一致） */
function cnQuiz(score: number | undefined): string {
  const base = 'font-mono text-xs font-bold'
  if (score === undefined || score === null) return `${base} text-foreground`
  if (score < 60) return `${base} text-rose-500`
  if (score < 70) return `${base} text-amber-500`
  if (score < 90) return `${base} text-sky-500`
  return `${base} text-emerald-500`
}

/** 闪卡复习进度配色：已开始复习即用翠绿高亮，未开始用常规前景色 */
function cnFlashcard(reviewed: number): string {
  return `font-mono text-xs font-bold ${reviewed > 0 ? 'text-emerald-500' : 'text-foreground'}`
}
