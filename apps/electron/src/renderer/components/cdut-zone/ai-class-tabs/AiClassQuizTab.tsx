/**
 * AiClassQuizTab — AI 速课堂自测练习视图（FIM 认知能力追踪）
 *
 * 单选 / 多选 / 是非交互，提交后即时判错溯源并展示考点解析与原文依据；
 * 每道题作答后由主进程以连续 Fisher 信息矩阵更新潜伏认知能力 θ ∈ [-3, +3]，
 * 完整作答后在结算页展示综合得分、能力评级与薄弱环节诊断清单。
 */

import * as React from 'react'
import { CheckCircle2, Loader2, RotateCcw, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { describeTheta, type QuizQuestion, type QuizSession } from '@profer/shared'
import { cn } from '@/lib/utils'
import { useBumpStudyRevision } from '@/atoms/study-atoms'
import { StudySourceTrace } from './StudySourceTrace'

interface AiClassQuizTabProps {
  sessionId: string
  quizId: string
}

export function AiClassQuizTab({ sessionId, quizId }: AiClassQuizTabProps): React.ReactElement {
  const [quiz, setQuiz] = React.useState<QuizSession | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [selections, setSelections] = React.useState<Record<string, string[]>>({})
  const [submittingId, setSubmittingId] = React.useState<string | null>(null)
  // 作答 / 重置后自增学习数据版本号，驱动「学习情况速览」实时刷新
  const bumpStudyRevision = useBumpStudyRevision(sessionId)

  React.useEffect(() => {
    let alive = true
    if (!quizId) {
      setQuiz(null)
      setLoading(false)
      return
    }
    setLoading(true)
    window.electronAPI.study
      .getQuiz({ sessionId, quizId })
      .then((data) => {
        if (!alive) return
        setQuiz(data)
        const restored: Record<string, string[]> = {}
        for (const question of data?.questions ?? []) {
          if (question.userSelection) restored[question.id] = question.userSelection
        }
        setSelections(restored)
      })
      .catch(() => setQuiz(null))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [sessionId, quizId])

  const toggleOption = (question: QuizQuestion, key: string): void => {
    if (question.isCorrect !== undefined) return
    setSelections((prev) => {
      const current = prev[question.id] ?? []
      if (question.type === 'multiple') {
        return { ...prev, [question.id]: current.includes(key) ? current.filter((k) => k !== key) : [...current, key] }
      }
      return { ...prev, [question.id]: [key] }
    })
  }

  const submit = async (question: QuizQuestion): Promise<void> => {
    if (!quiz || question.isCorrect !== undefined) return
    const selection = selections[question.id] ?? []
    if (selection.length === 0) {
      toast.error('请先选择答案')
      return
    }
    setSubmittingId(question.id)
    try {
      const updated = await window.electronAPI.study.submitQuizAnswer({
        sessionId,
        quizId: quiz.id,
        questionId: question.id,
        selection,
      })
      if (updated) {
        setQuiz(updated)
        // 作答改变了得分与 FIM θ → 通知速览卡重拉
        bumpStudyRevision()
      }
    } catch {
      toast.error('提交失败，请重试')
    } finally {
      setSubmittingId(null)
    }
  }

  /** 再练一次：清空全部作答与判分状态（同步落盘重置），回到首题重新开始 */
  const handleResetQuiz = async (): Promise<void> => {
    if (!quiz) return
    setSelections({})
    setSubmittingId(null)
    try {
      const reset = await window.electronAPI.study.resetQuiz({ sessionId, quizId: quiz.id })
      setQuiz(reset)
      bumpStudyRevision()
    } catch {
      toast.error('重置失败，请重试')
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 size={18} className="animate-spin" />
      </div>
    )
  }
  if (!quiz || quiz.questions.length === 0) {
    return <div className="flex h-full items-center justify-center p-6 text-center text-[11px] text-muted-foreground">尚未生成自测练习，请回到学习主页创建。</div>
  }

  const answeredCount = quiz.questions.filter((q) => q.isCorrect !== undefined).length
  const wrongQuestions = quiz.questions.filter((q) => q.isCorrect === false)

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4">
      <div className="flex shrink-0 items-center justify-between text-[10px] text-muted-foreground">
        <span className="truncate font-medium text-foreground">{quiz.title}</span>
        <span>
          已完成 {answeredCount} / {quiz.questions.length}
        </span>
      </div>

      {quiz.completed && (
        <div className="shrink-0 rounded-xl border border-primary/30 bg-primary/5 p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-foreground">本次得分</span>
            <span className="text-lg font-bold text-primary">{quiz.score} 分</span>
          </div>
          {/* FIM 指标高对比度条（历史反馈：原小字看不清） */}
          <div className="mt-2 flex items-center justify-between rounded-lg border border-primary/25 bg-primary/10 px-2.5 py-2">
            <span className="text-[11px] font-medium text-muted-foreground">FIM 潜伏认知能力</span>
            <span className="flex items-baseline gap-1.5">
              <span className="font-mono text-base font-bold leading-none text-primary">
                θ = {quiz.estimatedTheta.toFixed(2)}
              </span>
              <span className="rounded-md bg-primary/15 px-1.5 py-0.5 text-[11px] font-semibold text-primary">
                {describeTheta(quiz.estimatedTheta)}
              </span>
            </span>
          </div>
          {wrongQuestions.length > 0 && (
            <div className="mt-2 rounded-lg bg-background/60 p-2">
              <p className="text-[10px] font-medium text-foreground">薄弱环节诊断清单</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[10px] text-muted-foreground">
                {wrongQuestions.map((q) => (
                  <li key={q.id}>{q.question.slice(0, 40)}…</li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-2.5 flex items-center justify-end">
            <button
              type="button"
              onClick={() => void handleResetQuiz()}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-primary-foreground font-medium shadow-sm hover:opacity-90 transition-all text-xs"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              再练一次
            </button>
          </div>
        </div>
      )}

      {quiz.questions.map((question, index) => {
        const selected = selections[question.id] ?? []
        const answered = question.isCorrect !== undefined
        return (
          <div key={question.id} className="shrink-0 rounded-xl border border-border/60 bg-card/60 p-3">
            <div className="mb-2 flex items-start gap-2">
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
                {index + 1}
              </span>
              <p className="text-[12px] font-medium leading-relaxed text-foreground">{question.question}</p>
            </div>

            <div className="space-y-1.5">
              {question.options.map((option) => {
                const picked = selected.includes(option.key)
                const isAnswer = question.answer.includes(option.key)
                return (
                  <button
                    key={option.key}
                    type="button"
                    disabled={answered}
                    onClick={() => toggleOption(question, option.key)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[11px] transition-colors',
                      answered
                        ? isAnswer
                          ? 'border-emerald-400/60 bg-emerald-500/10 text-emerald-700'
                          : picked
                            ? 'border-rose-400/60 bg-rose-500/10 text-rose-600'
                            : 'border-border/50 text-muted-foreground'
                        : picked
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border/60 text-foreground hover:border-primary/40',
                    )}
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-current text-[9px] font-semibold">
                      {option.key}
                    </span>
                    <span className="min-w-0 flex-1">{option.text}</span>
                  </button>
                )
              })}
            </div>

            {!answered && (
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  disabled={submittingId === question.id}
                  onClick={() => void submit(question)}
                  className="rounded-lg bg-primary px-3 py-1 text-[11px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {submittingId === question.id ? '判分中…' : '提交作答'}
                </button>
              </div>
            )}

            {answered && (
              <div className={cn('mt-2 rounded-lg p-2 text-[10px] leading-relaxed', question.isCorrect ? 'bg-emerald-500/10 text-emerald-700' : 'bg-rose-500/10 text-rose-600')}>
                <p className="flex items-center gap-1 font-medium">
                  {question.isCorrect ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                  {question.isCorrect ? '回答正确' : `回答错误（正确答案：${question.answer.join('、')}）`}
                </p>
                <p className="mt-1 text-foreground/80">【判错溯源】{question.explanation}</p>
                {question.sourceTrace && (
                  <div className="mt-0.5 flex flex-wrap items-center gap-1 text-muted-foreground">
                    <span>【原文依据】</span>
                    <StudySourceTrace sessionId={sessionId} trace={question.sourceTrace} />
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
