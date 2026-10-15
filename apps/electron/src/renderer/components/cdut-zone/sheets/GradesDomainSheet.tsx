/**
 * GradesDomainSheet — CDUT 专区「成绩与 GPA」抽屉业务卡片
 *
 * 核心交互：
 *   - 加权 GPA 与总学分统计看板（加权绩点、总学分、课程数、优秀率）；
 *   - 成绩级别与分类筛选（全部、必修、选修、及格/不及格）；
 *   - 结构化成绩卡片列表（分数色标、学分、绩点、考核形式）；
 *   - 兼容实时教务与演示数据无缝回退（带环境徽标与重试刷新）。
 */

import * as React from 'react'
import {
  Award,
  BookOpen,
  CheckCircle2,
  Filter,
  GraduationCap,
  Loader2,
  RefreshCw,
  Sparkles,
  TrendingUp,
} from 'lucide-react'
import type { CdutDomainToolResult } from '@profer/shared'
import { cn } from '@/lib/utils'

interface GradeItem {
  name: string
  category: string
  credit: number
  score: number
  gradePoint: number
}

/** 规范化成绩数据，支持兼容实时接口结构与演示数据 */
function normalizeGrades(rawJson: unknown): {
  courses: GradeItem[]
  gpa: number
  totalCredits: number
} {
  if (!rawJson || typeof rawJson !== 'object') {
    return { courses: [], gpa: 0, totalCredits: 0 }
  }

  const obj = rawJson as Record<string, unknown>
  let rawList: unknown[] = []

  if (Array.isArray(obj)) {
    rawList = obj
  } else if (Array.isArray(obj.courses)) {
    rawList = obj.courses
  } else if (Array.isArray(obj.grades)) {
    rawList = obj.grades
  }

  const courses: GradeItem[] = []
  let totalCreditTimesGp = 0
  let totalCredits = 0

  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue
    const g = item as Record<string, unknown>
    const name = String(g.name || g.courseName || '').trim()
    if (!name) continue

    const category = String(g.category || g.courseType || '必修')
    const credit = Number(g.credit ?? 0)
    const score = Number(g.score ?? 0)
    const gradePoint = Number(g.gp ?? g.gradePoint ?? (score >= 60 ? (score - 50) / 10 : 0))

    courses.push({
      name,
      category,
      credit,
      score,
      gradePoint,
    })

    if (credit > 0) {
      totalCredits += credit
      totalCreditTimesGp += credit * gradePoint
    }
  }

  const calculatedGpa =
    typeof obj.weightedGpa === 'number'
      ? obj.weightedGpa
      : totalCredits > 0
        ? Number((totalCreditTimesGp / totalCredits).toFixed(2))
        : 0

  return {
    courses,
    gpa: calculatedGpa,
    totalCredits: Number(totalCredits.toFixed(1)),
  }
}

/** 分数颜色分级辅助函数 */
function getScoreColorClass(score: number): {
  badge: string
  text: string
  border: string
  bg: string
} {
  if (score >= 90) {
    return {
      badge: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
      text: 'text-emerald-600 dark:text-emerald-400',
      border: 'border-l-emerald-500',
      bg: 'bg-emerald-500/5',
    }
  }
  if (score >= 80) {
    return {
      badge: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
      text: 'text-blue-600 dark:text-blue-400',
      border: 'border-l-blue-500',
      bg: 'bg-blue-500/5',
    }
  }
  if (score >= 70) {
    return {
      badge: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20',
      text: 'text-violet-600 dark:text-violet-400',
      border: 'border-l-violet-500',
      bg: 'bg-violet-500/5',
    }
  }
  if (score >= 60) {
    return {
      badge: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
      text: 'text-amber-600 dark:text-amber-400',
      border: 'border-l-amber-500',
      bg: 'bg-amber-500/5',
    }
  }
  return {
    badge: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20',
    text: 'text-rose-600 dark:text-rose-400',
    border: 'border-l-rose-500',
    bg: 'bg-rose-500/5',
  }
}

type FilterCategory = 'all' | 'compulsory' | 'elective' | 'excellent'

export function GradesDomainSheet(): React.ReactElement {
  const [loading, setLoading] = React.useState(true)
  const [result, setResult] = React.useState<CdutDomainToolResult | null>(null)
  const [filter, setFilter] = React.useState<FilterCategory>('all')

  const fetchGrades = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await window.electronAPI.cdutZone.callDomainTool({
        domain: 'grades',
        params: { action: 'query_grades' },
      })
      setResult(res)
    } catch (err) {
      setResult({
        success: false,
        markdown: `加载成绩异常: ${err instanceof Error ? err.message : String(err)}`,
        json: null,
        isDemo: true,
      })
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void fetchGrades()
  }, [fetchGrades])

  const { courses, gpa, totalCredits } = React.useMemo(() => {
    return normalizeGrades(result?.json)
  }, [result?.json])

  const filteredCourses = React.useMemo(() => {
    return courses.filter((c) => {
      if (filter === 'compulsory') return c.category.includes('必修') || c.category.includes('正常')
      if (filter === 'elective') return c.category.includes('选修')
      if (filter === 'excellent') return c.score >= 90
      return true
    })
  }, [courses, filter])

  const excellentCount = React.useMemo(() => {
    return courses.filter((c) => c.score >= 90).length
  }, [courses])

  return (
    <div className="flex h-full flex-col">
      {/* 顶部状态与刷新条 */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {result?.isDemo ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
              <Sparkles className="size-3" />
              仿真演示数据
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="size-3" />
              青果教务实时同步
            </span>
          )}
        </div>

        <button
          type="button"
          disabled={loading}
          onClick={() => void fetchGrades()}
          className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs text-muted-foreground transition hover:bg-muted/50 hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          <span>刷新</span>
        </button>
      </div>

      {/* GPA 与学分总览看板 */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="relative overflow-hidden rounded-xl border border-surface-border/60 bg-gradient-to-br from-primary/10 via-card to-card p-3 shadow-xs">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs">加权 GPA</span>
            <TrendingUp className="size-4 text-primary" />
          </div>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="text-2xl font-bold tracking-tight text-primary">
              {loading ? '—' : gpa.toFixed(2)}
            </span>
            <span className="text-[11px] text-muted-foreground">/ 5.0</span>
          </div>
        </div>

        <div className="rounded-xl border border-surface-border/60 bg-card p-3 shadow-xs">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs">已获总学分</span>
            <Award className="size-4 text-amber-500" />
          </div>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="text-2xl font-bold tracking-tight text-foreground">
              {loading ? '—' : totalCredits}
            </span>
            <span className="text-[11px] text-muted-foreground">分</span>
          </div>
        </div>

        <div className="rounded-xl border border-surface-border/60 bg-card p-3 shadow-xs">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs">修读门数</span>
            <BookOpen className="size-4 text-blue-500" />
          </div>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="text-2xl font-bold tracking-tight text-foreground">
              {loading ? '—' : courses.length}
            </span>
            <span className="text-[11px] text-muted-foreground">门</span>
          </div>
        </div>

        <div className="rounded-xl border border-surface-border/60 bg-card p-3 shadow-xs">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs">优秀 (90+)</span>
            <Sparkles className="size-4 text-emerald-500" />
          </div>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="text-2xl font-bold tracking-tight text-emerald-600 dark:text-emerald-400">
              {loading ? '—' : excellentCount}
            </span>
            <span className="text-[11px] text-muted-foreground">门</span>
          </div>
        </div>
      </div>

      {/* 筛选标签条 */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
          <Filter className="size-3.5 text-muted-foreground" />
          {(
            [
              { id: 'all', label: '全部' },
              { id: 'compulsory', label: '主修/必修' },
              { id: 'elective', label: '通识/选修' },
              { id: 'excellent', label: '90分以上' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setFilter(item.id)}
              className={cn(
                'rounded-full px-2.5 py-0.5 text-xs transition-colors',
                filter === item.id
                  ? 'bg-primary text-primary-foreground font-medium shadow-xs'
                  : 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-muted-foreground">共 {filteredCourses.length} 门</span>
      </div>

      {/* 成绩单内容列表 */}
      <div className="flex-1 space-y-2.5 overflow-y-auto pr-1">
        {loading ? (
          <div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
            <Loader2 className="size-6 animate-spin text-primary" />
            <p className="text-xs">正在从青果教务拉取最新成绩单...</p>
          </div>
        ) : filteredCourses.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-dashed border-surface-border/60 bg-muted/10 p-6 text-center text-muted-foreground">
            <GraduationCap className="size-8 opacity-30" />
            <p className="mt-2 text-xs">当前筛选条件下暂无成绩记录</p>
          </div>
        ) : (
          filteredCourses.map((c, index) => {
            const colors = getScoreColorClass(c.score)
            return (
              <div
                key={`${c.name}-${index}`}
                className={cn(
                  'group flex items-center justify-between rounded-xl border border-surface-border/60 bg-card p-3 shadow-xs transition hover:border-surface-border hover:shadow-sm border-l-4',
                  colors.border,
                )}
              >
                <div className="min-w-0 flex-1 pr-3">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">{c.name}</span>
                    <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {c.category}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                    <span>{c.credit} 学分</span>
                    <span>•</span>
                    <span>绩点 {c.gradePoint.toFixed(1)}</span>
                  </div>
                </div>

                <div className="shrink-0 text-right">
                  <span className={cn('text-lg font-bold', colors.text)}>{c.score}</span>
                  <div className="text-[10px] text-muted-foreground">分</div>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
