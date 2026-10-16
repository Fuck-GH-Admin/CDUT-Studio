/**
 * ExamDomainSheet — CDUT 专区「期末考场日程」抽屉业务卡片
 *
 * 核心交互：
 *   - 高保真电子准考证风格：座位号大字号粗体展示 + 距开考倒计时雷达；
 *   - 最近一场考试置顶呼吸光晕，已考科目自动置灰归档；
 *   - 详细考场卡片（考试科目、时间段、考场教室、座位号、准考证号、统考形式）；
 *   - 考前防作弊与考务注意事项贴士；
 *   - 兼容实时教务与演示数据无缝回退。
 */

import * as React from 'react'
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  Clock,
  Hash,
  Loader2,
  MapPin,
  RefreshCw,
  Sparkles,
  Ticket,
} from 'lucide-react'
import type { CdutDomainToolResult } from '@profer/shared'
import { cn } from '@/lib/utils'

interface ExamItem {
  courseName: string
  time: string
  room: string
  seat: string
  ticket: string
  form: string
}

/** 规范化考务数据，支持兼容实时接口与演示数据 */
function normalizeExams(rawJson: unknown): ExamItem[] {
  if (!rawJson || typeof rawJson !== 'object') return []
  const obj = rawJson as Record<string, unknown>

  let rawList: unknown[] = []
  if (Array.isArray(obj)) {
    rawList = obj
  } else if (Array.isArray(obj.exams)) {
    rawList = obj.exams
  }

  const list: ExamItem[] = []
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue
    const e = item as Record<string, unknown>
    const courseName = String(e.courseName || e.name || e.subject || '').trim()
    if (!courseName) continue

    list.push({
      courseName,
      time: String(e.time || e.examTime || '时间待定'),
      room: String(e.room || e.classroom || '考场待定'),
      seat: String(e.seat || e.seatNumber || '—'),
      ticket: String(e.ticket || e.ticketNumber || '—'),
      form: String(e.form || e.examType || '期末统考'),
    })
  }

  return list
}

/** 从考试时间文本解析开考时刻（如 "2027-01-18 14:30~16:30"）；失败返回 null */
function parseExamStart(time: string): Date | null {
  const m = time.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})\s*(\d{1,2})?:?(\d{2})?/)
  if (!m?.[1] || !m[2] || !m[3]) return null
  const date = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    m[4] ? Number(m[4]) : 0,
    m[5] ? Number(m[5]) : 0,
  )
  return Number.isNaN(date.getTime()) ? null : date
}

/** 倒计时描述：天 / 时 / 分 */
function describeCountdown(target: Date, now: Date): { text: string; urgent: boolean } | null {
  const diff = target.getTime() - now.getTime()
  if (diff <= 0) return null
  const minutes = Math.floor(diff / 60000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days >= 1) return { text: `${days} 天 ${hours} 小时后开考`, urgent: days <= 1 }
  if (hours >= 1) return { text: `${hours} 小时 ${mins} 分后开考`, urgent: true }
  return { text: `${mins} 分钟后开考`, urgent: true }
}

export function ExamDomainSheet(): React.ReactElement {
  const [loading, setLoading] = React.useState(true)
  const [result, setResult] = React.useState<CdutDomainToolResult | null>(null)
  const [now, setNow] = React.useState(() => new Date())

  // 倒计时每 30 秒刷新一次（不阻塞渲染，卸载即清理）
  React.useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const fetchExams = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await window.electronAPI.cdutZone.callDomainTool({
        domain: 'exams',
        params: { action: 'query_exam_schedule' },
      })
      setResult(res)
    } catch (err) {
      setResult({
        success: false,
        markdown: `查询考务失败: ${err instanceof Error ? err.message : String(err)}`,
        json: null,
        isDemo: true,
      })
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void fetchExams()
  }, [fetchExams])

  const exams = React.useMemo(() => {
    return normalizeExams(result?.json)
  }, [result?.json])

  // 已考（开始时间已过）置底置灰归档；未考按开考时间升序
  const { upcoming, archived } = React.useMemo(() => {
    const withTime = exams.map((exam) => ({ exam, start: parseExamStart(exam.time) }))
    const upcoming = withTime
      .filter((e) => e.start === null || e.start.getTime() > now.getTime())
      .sort((a, b) => (a.start?.getTime() ?? Infinity) - (b.start?.getTime() ?? Infinity))
      .map((e) => e.exam)
    const archived = withTime
      .filter((e) => e.start !== null && e.start.getTime() <= now.getTime())
      .map((e) => e.exam)
    return { upcoming, archived }
  }, [exams, now])

  const nextExam = upcoming[0]
  const nextCountdown = nextExam ? (() => {
    const start = parseExamStart(nextExam.time)
    return start ? describeCountdown(start, now) : null
  })() : null

  const renderExamCard = (exam: ExamItem, idx: number, isArchived: boolean, isNext: boolean): React.ReactElement => (
    <div
      key={`${exam.courseName}-${idx}`}
      className={cn(
        'rounded-xl border bg-card p-4 shadow-xs transition',
        isArchived
          ? 'border-surface-border/40 opacity-55'
          : isNext
            ? 'border-primary/50 ring-1 ring-primary/20 shadow-md'
            : 'border-surface-border/60 hover:border-surface-border hover:shadow-sm',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-foreground">{exam.courseName}</span>
            <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">{exam.form}</span>
            {isNext && (
              <span className="inline-flex items-center gap-1 rounded-md bg-primary px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground">
                <Clock size={10} />
                最近一场
              </span>
            )}
            {isArchived && <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">已结束</span>}
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="size-3.5 text-primary" />
            <span className="font-medium text-foreground">{exam.time}</span>
          </div>
          {isNext && nextCountdown && (
            <div
              className={cn(
                'mt-1.5 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-bold',
                nextCountdown.urgent ? 'animate-pulse bg-rose-500/10 text-rose-600 dark:text-rose-400' : 'bg-muted text-foreground',
              )}
            >
              ⏱ {nextCountdown.text}
            </div>
          )}
        </div>

        {/* 座位号：高保真电子准考证大字风格 */}
        <div className="flex flex-col items-center rounded-xl border-2 border-dashed border-primary/30 bg-primary/5 px-3 py-1.5">
          <div className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
            <Hash className="size-3" />
            座位号
          </div>
          <span className="text-2xl font-black leading-tight tracking-wider text-primary">{exam.seat}</span>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-surface-border/40 pt-3 text-xs">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <MapPin className="size-3.5 text-rose-500" />
          <span className="font-medium text-foreground">{exam.room}</span>
        </div>

        {exam.ticket && exam.ticket !== '—' && (
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Ticket className="size-3" />
            <span>准考证：</span>
            <span className="font-mono">{exam.ticket}</span>
          </div>
        )}
      </div>
    </div>
  )

  return (
    <div className="flex h-full flex-col">
      {/* 顶部状态与刷新 */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {result?.isDemo ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
              <Sparkles className="size-3" />
              仿真演示考务
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="size-3" />
              教务考场实时同步
            </span>
          )}
        </div>

        <button
          type="button"
          disabled={loading}
          onClick={() => void fetchExams()}
          className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs text-muted-foreground transition hover:bg-muted/50 hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          <span>刷新考场</span>
        </button>
      </div>

      {/* 考务总览摘要看板 */}
      <div className="mb-4 rounded-xl border border-surface-border/60 bg-gradient-to-r from-primary/10 via-card to-card p-4 shadow-xs">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-xs font-medium text-muted-foreground">本学期排考安排</span>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="text-2xl font-bold tracking-tight text-foreground">
                {loading ? '—' : exams.length}
              </span>
              <span className="text-xs text-muted-foreground">门考试已排期</span>
            </div>
            {nextCountdown && (
              <div className="mt-1 text-[11px] font-semibold text-primary">距下一门：{nextCountdown.text}</div>
            )}
          </div>
          <div className="rounded-xl bg-primary/10 p-2.5 text-primary">
            <Calendar className="size-6" />
          </div>
        </div>
      </div>

      {/* 考务特别提醒 */}
      <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300">
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <p className="leading-relaxed">
          温馨提示：请考生携带好<strong>身份证与学生证（或校园卡）</strong>
          提前 15 分钟抵达考场，严禁携带手机及一切未经允许的智能终端设备入场。
        </p>
      </div>

      {/* 考场日程清单 */}
      <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>考试日程明细</span>
        <span>
          未考 {upcoming.length} 门{archived.length > 0 ? ` · 已结束 ${archived.length} 门` : ''}
        </span>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto pr-1">
        {loading ? (
          <div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
            <Loader2 className="size-6 animate-spin text-primary" />
            <p className="text-xs">正在查询青果考务数据库...</p>
          </div>
        ) : exams.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-dashed border-surface-border/60 bg-muted/10 p-6 text-center text-muted-foreground">
            <Calendar className="size-8 opacity-30" />
            <p className="mt-2 text-xs">暂无正在进行的考试日程安排</p>
            <p className="mt-1 text-[11px] text-muted-foreground/75">教务处尚未发布排考或考试已经圆满结束</p>
          </div>
        ) : (
          <>
            {upcoming.map((exam, idx) => renderExamCard(exam, idx, false, idx === 0))}
            {archived.map((exam, idx) => renderExamCard(exam, idx, true, false))}
          </>
        )}
      </div>
    </div>
  )
}
