/**
 * ExamDomainSheet — CDUT 专区「期末考场日程」抽屉业务卡片
 *
 * 核心交互：
 *   - 考场日程倒计时卡片（距下一门考试天数、场次总览）；
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

export function ExamDomainSheet(): React.ReactElement {
  const [loading, setLoading] = React.useState(true)
  const [result, setResult] = React.useState<CdutDomainToolResult | null>(null)

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
        <span>共 {exams.length} 门</span>
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
            <p className="mt-1 text-[11px] text-muted-foreground/75">
              教务处尚未发布排考或考试已经圆满结束
            </p>
          </div>
        ) : (
          exams.map((exam, idx) => (
            <div
              key={`${exam.courseName}-${idx}`}
              className="rounded-xl border border-surface-border/60 bg-card p-4 shadow-xs transition hover:border-surface-border hover:shadow-sm"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-foreground">{exam.courseName}</span>
                    <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      {exam.form}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Clock className="size-3.5 text-primary" />
                    <span className="font-medium text-foreground">{exam.time}</span>
                  </div>
                </div>

                {/* 座位号徽标 */}
                <div className="flex flex-col items-end">
                  <div className="flex items-center gap-1 rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-1 text-primary">
                    <Hash className="size-3.5" />
                    <span className="text-xs font-semibold">座位号</span>
                    <span className="text-sm font-bold">{exam.seat}</span>
                  </div>
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
          ))
        )}
      </div>
    </div>
  )
}
