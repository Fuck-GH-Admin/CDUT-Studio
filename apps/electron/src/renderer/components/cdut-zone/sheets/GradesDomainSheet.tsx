/**
 * GradesDomainSheet — CDUT 专区「学业绩点 / 培养方案」抽屉业务卡片
 *
 * 核心交互：
 *   - Tab 双模式：「历年成绩」/「培养方案与学业进度」；
 *   - 补考重修双轨加权 GPA 仪表盘（最新成绩轨 vs 最高成绩轨一键切换）；
 *   - 学期筛选 + 成绩级别分类（全部、必修、选修、90+）；
 *   - 培养方案树状图谱：模块应修/已修进度条 + 课程完成状态（已修(成绩) / 未修）；
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
  semester: string
  category: string
  credit: number
  score: number
  hasScore: boolean
  gradePoint: number
  makeupSemester: string
}

interface CurriculumModuleItem {
  name: string
  requiredCredits?: number
  completedCredits?: number
  courses: Array<{ courseName: string; credit: number; status: 'completed' | 'pending'; score?: string; semester: string }>
}

interface GpaSummary {
  courseCount: number
  totalCredits: number
  requiredCredits: number
  weightedAverage: number
  weightedGpa: number
}

/** 规范化成绩数据（双轨 + 明细记录） */
function normalizeGrades(rawJson: unknown): {
  latest: GpaSummary
  highest: GpaSummary
  records: GradeItem[]
} {
  const empty: GpaSummary = { courseCount: 0, totalCredits: 0, requiredCredits: 0, weightedAverage: 0, weightedGpa: 0 }
  if (!rawJson || typeof rawJson !== 'object') return { latest: empty, highest: empty, records: [] }

  const obj = rawJson as Record<string, unknown>
  const pickSummary = (v: unknown): GpaSummary => {
    if (!v || typeof v !== 'object') return empty
    const s = v as Record<string, unknown>
    return {
      courseCount: Number(s.courseCount ?? 0),
      totalCredits: Number(s.totalCredits ?? 0),
      requiredCredits: Number(s.requiredCredits ?? 0),
      weightedAverage: Number(s.weightedAverage ?? 0),
      weightedGpa: Number(s.weightedGpa ?? 0),
    }
  }

  const records: GradeItem[] = []
  const rawList = Array.isArray(obj.records) ? obj.records : Array.isArray(obj.courses) ? obj.courses : []
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue
    const g = item as Record<string, unknown>
    const name = String(g.courseName || g.name || '').trim()
    if (!name) continue
    const hasScore = g.scoreNumber !== undefined && g.scoreNumber !== null
    records.push({
      name,
      semester: String(g.semester || ''),
      category: String(g.courseAttr || g.category || g.courseNature || '必修'),
      credit: Number(g.credit ?? 0),
      score: hasScore ? Number(g.scoreNumber) : Number.NaN,
      hasScore,
      gradePoint: Number(g.gp ?? (hasScore && Number(g.scoreNumber) >= 60 ? (Number(g.scoreNumber) - 50) / 10 : 0)),
      makeupSemester: String(g.makeupSemester || ''),
    })
  }

  return { latest: pickSummary(obj.latest), highest: pickSummary(obj.highest), records }
}

/** 规范化培养方案数据 */
function normalizeCurriculum(rawJson: unknown): CurriculumModuleItem[] {
  if (!rawJson || typeof rawJson !== 'object') return []
  const obj = rawJson as Record<string, unknown>
  const modules = Array.isArray(obj.modules) ? obj.modules : []
  const result: CurriculumModuleItem[] = []
  for (const item of modules) {
    if (!item || typeof item !== 'object') continue
    const m = item as Record<string, unknown>
    const coursesRaw = Array.isArray(m.courses) ? m.courses : []
    result.push({
      name: String(m.name || '未命名模块'),
      requiredCredits: m.requiredCredits !== undefined ? Number(m.requiredCredits) : undefined,
      completedCredits: m.completedCredits !== undefined ? Number(m.completedCredits) : undefined,
      courses: coursesRaw
        .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
        .map((c) => ({
          courseName: String(c.courseName || ''),
          credit: Number(c.credit ?? 0),
          status: c.status === 'completed' ? ('completed' as const) : ('pending' as const),
          score: c.score ? String(c.score) : undefined,
          semester: String(c.semester || ''),
        }))
        .filter((c) => c.courseName),
    })
  }
  return result
}

/** 分数颜色分级辅助函数 */
function getScoreColorClass(score: number): {
  badge: string
  text: string
  border: string
} {
  if (score >= 90) {
    return {
      badge: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
      text: 'text-emerald-600 dark:text-emerald-400',
      border: 'border-l-emerald-500',
    }
  }
  if (score >= 80) {
    return {
      badge: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
      text: 'text-blue-600 dark:text-blue-400',
      border: 'border-l-blue-500',
    }
  }
  if (score >= 70) {
    return {
      badge: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20',
      text: 'text-violet-600 dark:text-violet-400',
      border: 'border-l-violet-500',
    }
  }
  if (score >= 60) {
    return {
      badge: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
      text: 'text-amber-600 dark:text-amber-400',
      border: 'border-l-amber-500',
    }
  }
  return {
    badge: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20',
    text: 'text-rose-600 dark:text-rose-400',
    border: 'border-l-rose-500',
  }
}

type FilterCategory = 'all' | 'compulsory' | 'elective' | 'excellent'

/** 学期快选列表（从记录中归纳，倒序） */
function collectSemesters(records: GradeItem[]): string[] {
  const set = new Set<string>()
  for (const r of records) if (r.semester) set.add(r.semester)
  return [...set].sort((a, b) => (a > b ? -1 : 1))
}

export function GradesDomainSheet(): React.ReactElement {
  const [tab, setTab] = React.useState<'grades' | 'plan'>('grades')
  const [loading, setLoading] = React.useState(true)
  const [planLoading, setPlanLoading] = React.useState(false)
  const [result, setResult] = React.useState<CdutDomainToolResult | null>(null)
  // SWR 陈旧数据：抽屉打开先读离线缓存秒开渲染，网络成功后热更新并原子落盘
  const [cachedResult, setCachedResult] = React.useState<CdutDomainToolResult | null>(null)
  const [planResult, setPlanResult] = React.useState<CdutDomainToolResult | null>(null)
  const [filter, setFilter] = React.useState<FilterCategory>('all')
  const [track, setTrack] = React.useState<'latest' | 'highest'>('latest')
  const [semesterFilter, setSemesterFilter] = React.useState<string>('all')

  // SWR 第一步：抽屉打开立即读取成绩离线缓存，完成前台初次秒开渲染。
  // 防御式调用：主进程未随渲染层一起更新时 readDomainCache 可能不存在，
  // 直接调用会同步抛 TypeError 打断整个组件渲染（历史 Bug：入口一片空白且无加载动画）。
  React.useEffect(() => {
    let alive = true
    const api = window.electronAPI?.cdutZone
    if (typeof api?.readDomainCache !== 'function') return
    api
      .readDomainCache('grades')
      .then((cached) => {
        if (!alive || !cached || typeof cached !== 'object') return
        const payload = (cached as { data?: unknown }).data
        if (payload && typeof payload === 'object' && typeof (payload as CdutDomainToolResult).json !== 'undefined') {
          setCachedResult(payload as CdutDomainToolResult)
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const fetchGrades = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await window.electronAPI.cdutZone.callDomainTool({
        domain: 'grades',
        params: { action: 'query_grades' },
      })
      setResult(res)
      // SWR 第二步：仅当真实在线且确有成绩记录时才原子写入离线缓存。
      // 严禁空表（0 条）或演示回退数据覆盖磁盘上的有效缓存。
      const api = window.electronAPI?.cdutZone
      const hasRecords = normalizeGrades(res.json).records.length > 0
      if (res.success && res.isDemo !== true && hasRecords && typeof api?.writeDomainCache === 'function') {
        void api.writeDomainCache({ name: 'grades', payload: res }).catch(() => {})
      }
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

  const fetchPlan = React.useCallback(async () => {
    setPlanLoading(true)
    try {
      const res = await window.electronAPI.cdutZone.callDomainTool({
        domain: 'curriculum',
        params: { action: 'get_training_plan' },
      })
      setPlanResult(res)
    } catch (err) {
      setPlanResult({
        success: false,
        markdown: `加载培养方案异常: ${err instanceof Error ? err.message : String(err)}`,
        json: null,
        isDemo: true,
      })
    } finally {
      setPlanLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (tab === 'grades') void fetchGrades()
    else if (!planResult) void fetchPlan()
  }, [tab, fetchGrades, fetchPlan, planResult])

  // SWR 防御性合并：真实在线数据优先；网络失败/空表/演示回退时，若磁盘缓存含有效记录则优雅降级，绝不白屏
  const liveGrades = React.useMemo(() => normalizeGrades(result?.json), [result?.json])
  const cachedGrades = React.useMemo(() => normalizeGrades(cachedResult?.json), [cachedResult?.json])
  const hasLiveRecords = liveGrades.records.length > 0 && result?.isDemo !== true && result?.success !== false
  const hasCachedRecords = cachedGrades.records.length > 0
  const useCachedSnapshot = !hasLiveRecords && hasCachedRecords
  const { latest, highest, records } = useCachedSnapshot ? cachedGrades : liveGrades
  const displayedResult = useCachedSnapshot ? cachedResult : result
  const modules = React.useMemo(() => normalizeCurriculum(planResult?.json), [planResult?.json])
  const summary = track === 'latest' ? latest : highest

  const semesterOptions = React.useMemo(() => collectSemesters(records), [records])
  const filteredCourses = React.useMemo(() => {
    return records.filter((c) => {
      if (semesterFilter !== 'all' && c.semester !== semesterFilter) return false
      if (filter === 'compulsory') return c.category.includes('必修')
      if (filter === 'elective') return c.category.includes('选修')
      if (filter === 'excellent') return c.hasScore && c.score >= 90
      return true
    })
  }, [records, filter, semesterFilter])

  const excellentCount = React.useMemo(() => records.filter((c) => c.hasScore && c.score >= 90).length, [records])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶部状态与刷新条 */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex rounded-lg bg-muted/60 p-0.5">
          {(
            [
              { id: 'grades', label: '历年成绩' },
              { id: 'plan', label: '培养方案与学业进度' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={cn(
                'rounded-md px-3 py-1 text-xs transition-colors',
                tab === item.id
                  ? 'bg-card font-semibold text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          {displayedResult?.isDemo && (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
              <Sparkles className="size-3" />
              演示数据
            </span>
          )}
          <button
            type="button"
            disabled={tab === 'grades' ? loading : planLoading}
            onClick={() => void (tab === 'grades' ? fetchGrades() : fetchPlan())}
            className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs text-muted-foreground transition hover:bg-muted/50 hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw className={cn('size-3.5', (tab === 'grades' ? loading : planLoading) && 'animate-spin')} />
            <span>刷新</span>
          </button>
        </div>
      </div>

      {/* SWR 同步状态：缓存秒开时给出轻量提示，同步失败时提供重试入口，绝不整屏空白 */}
      {tab === 'grades' && loading && hasCachedRecords && (
        <div className="mb-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin text-primary" />
          <span>已加载离线数据，正在同步最新成绩…</span>
        </div>
      )}
      {tab === 'grades' && !loading && useCachedSnapshot && (
        <div className="mb-2 flex items-center gap-2 text-[11px] text-amber-600 dark:text-amber-400">
          <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-medium">
            离线快照 · 同步未完成
          </span>
          <button
            type="button"
            onClick={() => void fetchGrades()}
            className="underline underline-offset-2 transition-colors hover:text-amber-500"
          >
            点击重试
          </button>
        </div>
      )}

      {tab === 'grades' ? (
        <>
          {/* 双轨 GPA 仪表盘：最新成绩轨 vs 最高成绩轨 */}
          <div className="mb-4 rounded-xl border border-surface-border/60 bg-gradient-to-br from-primary/10 via-card to-card p-3.5 shadow-xs">
            <div className="mb-2.5 flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <TrendingUp className="size-3.5 text-primary" />
                补考/重修双轨加权 GPA
              </span>
              <div className="flex rounded-lg bg-muted/70 p-0.5">
                {(
                  [
                    { id: 'latest', label: '最新成绩' },
                    { id: 'highest', label: '最高成绩' },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setTrack(item.id)}
                    className={cn(
                      'rounded-md px-2.5 py-0.5 text-[11px] transition-colors',
                      track === item.id
                        ? 'bg-card font-semibold text-foreground shadow-xs'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <div className="text-[11px] text-muted-foreground">加权 GPA</div>
                <div className="mt-0.5 flex items-baseline gap-1">
                  <span className="text-2xl font-bold tracking-tight text-primary">
                    {records.length === 0 && loading ? '—' : summary.weightedGpa.toFixed(2)}
                  </span>
                  <span className="text-[11px] text-muted-foreground">/ 5.0</span>
                </div>
              </div>
              <div>
                <div className="text-[11px] text-muted-foreground">加权平均分</div>
                <div className="mt-0.5 flex items-baseline gap-1">
                  <span className="text-2xl font-bold tracking-tight text-foreground">
                    {records.length === 0 && loading ? '—' : summary.weightedAverage}
                  </span>
                </div>
              </div>
              <div>
                <div className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Award className="size-3 text-amber-500" />
                  总学分（必修）
                </div>
                <div className="mt-0.5 flex items-baseline gap-1">
                  <span className="text-2xl font-bold tracking-tight text-foreground">
                    {records.length === 0 && loading ? '—' : summary.totalCredits}
                  </span>
                  <span className="text-[11px] text-muted-foreground">/ {summary.requiredCredits} 必修</span>
                </div>
              </div>
              <div>
                <div className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Sparkles className="size-3 text-emerald-500" />
                  优秀 (90+)
                </div>
                <div className="mt-0.5 flex items-baseline gap-1">
                  <span className="text-2xl font-bold tracking-tight text-emerald-600 dark:text-emerald-400">
                    {records.length === 0 && loading ? '—' : excellentCount}
                  </span>
                  <span className="text-[11px] text-muted-foreground">门</span>
                </div>
              </div>
            </div>
          </div>

          {/* 筛选标签条（分类 + 学期） */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
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
            <div className="flex items-center gap-1.5">
              <select
                value={semesterFilter}
                onChange={(e) => setSemesterFilter(e.target.value)}
                className="h-7 rounded-lg border border-border/70 bg-background px-2 text-[11px] text-foreground shadow-xs outline-none focus:border-primary"
              >
                <option value="all">全部学期</option>
                {semesterOptions.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <span className="text-[11px] text-muted-foreground">共 {filteredCourses.length} 门</span>
            </div>
          </div>

          {/* 成绩单内容列表 */}
          <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto pr-1">
            {records.length === 0 && loading ? (
              <div className="space-y-2.5">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin text-primary" />
                  <span>正在从青果教务拉取最新成绩单…</span>
                </div>
                {/* 骨架屏：保证加载期始终有明确的可视反馈，杜绝「一片空白」 */}
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="flex animate-pulse items-center justify-between rounded-xl border border-surface-border/60 bg-card p-3">
                    <div className="min-w-0 flex-1 space-y-2 pr-3">
                      <div className="h-4 w-44 rounded bg-muted" />
                      <div className="h-3 w-28 rounded bg-muted" />
                    </div>
                    <div className="h-6 w-10 rounded bg-muted" />
                  </div>
                ))}
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
                    key={`${c.name}-${c.semester}-${index}`}
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
                        {c.makeupSemester && (
                          <span className="shrink-0 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                            补重 {c.makeupSemester}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                        <span>{c.semester || '—'}</span>
                        <span>{c.credit} 学分</span>
                        <span>绩点 {c.gradePoint.toFixed(1)}</span>
                      </div>
                    </div>

                    <div className="shrink-0 text-right">
                      <span className={cn('text-lg font-bold', colors.text)}>{c.hasScore ? c.score : '—'}</span>
                      <div className="text-[10px] text-muted-foreground">分</div>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </>
      ) : (
        /* 培养方案树状图谱与进度条 */
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {planLoading ? (
            <div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="size-6 animate-spin text-primary" />
              <p className="text-xs">正在解析培养方案与学业进度...</p>
            </div>
          ) : modules.length === 0 ? (
            <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-dashed border-surface-border/60 bg-muted/10 p-6 text-center text-muted-foreground">
              <BookOpen className="size-8 opacity-30" />
              <p className="mt-2 text-xs">暂未获取到培养方案数据，请确认已绑定在校学籍</p>
            </div>
          ) : (
            modules.map((m) => {
              const completed = m.courses.filter((c) => c.status === 'completed')
              const totalCreditsInModule = m.courses.reduce((sum, c) => sum + (c.credit > 0 ? c.credit : 0), 0)
              const doneCredits = completed.reduce((sum, c) => sum + (c.credit > 0 ? c.credit : 0), 0)
              const required = m.requiredCredits ?? totalCreditsInModule
              const done = m.completedCredits ?? doneCredits
              const rate = required > 0 ? Math.min(100, Math.round((done / required) * 100)) : 0
              return (
                <div key={m.name} className="rounded-xl border border-surface-border/60 bg-card p-3.5 shadow-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-foreground">{m.name}</span>
                    <span className="text-[11px] text-muted-foreground">
                      已修 <span className="font-bold text-primary">{done}</span> / 应修 {required} 学分 · {completed.length}/{m.courses.length} 门
                    </span>
                  </div>
                  {/* 模块进度条 */}
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted/70">
                    <div
                      className={cn('h-full rounded-full transition-all', rate >= 100 ? 'bg-emerald-500' : 'bg-primary')}
                      style={{ width: `${rate}%` }}
                    />
                  </div>
                  <div className="mt-1 text-right text-[10px] text-muted-foreground">{rate}%</div>

                  {/* 课程完成状态清单 */}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {m.courses.map((c, idx) => (
                      <span
                        key={`${c.courseName}-${idx}`}
                        title={c.status === 'completed' ? `已修${c.score ? `（${c.score} 分）` : ''}` : '未修'}
                        className={cn(
                          'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px]',
                          c.status === 'completed'
                            ? // 深色模式下采用高对比度亮白文字与发光边框，杜绝 OLED 暗背景难以分辨
                              'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/20 dark:font-semibold dark:text-zinc-50'
                            : 'border-transparent bg-muted/60 text-muted-foreground',
                        )}
                      >
                        <CheckCircle2 className={cn('size-2.5', c.status !== 'completed' && 'opacity-30')} />
                        {c.courseName}
                        <span className="opacity-70">{c.credit ? `${c.credit}分` : ''}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
