/**
 * ScheduleDomainSheet — CDUT 专区「今日课表 / 学期日程」抽屉业务卡片
 *
 * 核心交互：
 *   - 周次筛选（第 1 ~ 20 周下拉或数字胶囊）；
 *   - 星期标签切换（周一至周日 + 全周总览）；
 *   - 今日课程时间轴卡片（起止节次、上课教室、授课教师、单双周）；
 *   - 支持真实青果教务实时同步与高仿真演示数据透明回退（带环境徽标）。
 */

import * as React from 'react'
import {
  CalendarDays,
  Clock,
  GraduationCap,
  Loader2,
  MapPin,
  RefreshCw,
  Sparkles,
  User,
} from 'lucide-react'
import type { CdutDomainToolResult } from '@profer/shared'
import { cn } from '@/lib/utils'

interface ScheduleCourseItem {
  name: string
  dayOfWeek: number
  periodText: string
  startSection: number
  endSection: number
  location: string
  teacher: string
  weeks: string
}

const WEEKDAYS = [
  { id: 1, label: '周一' },
  { id: 2, label: '周二' },
  { id: 3, label: '周三' },
  { id: 4, label: '周四' },
  { id: 5, label: '周五' },
  { id: 6, label: '周六' },
  { id: 7, label: '周日' },
] as const

/** 规范化课程数据（兼容 Kingosoft 真实解析与 Demo 假数据两种 JSON 结构） */
function normalizeCourses(rawJson: unknown): ScheduleCourseItem[] {
  if (!rawJson || typeof rawJson !== 'object') return []
  const obj = rawJson as Record<string, unknown>
  const list = Array.isArray(obj.courses) ? obj.courses : []
  const result: ScheduleCourseItem[] = []

  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const c = item as Record<string, unknown>
    const name = String(c.name || c.courseName || '').trim()
    if (!name) continue

    const dayOfWeek = Number(c.dayOfWeek || c.weekday || 1)
    const startSection = Number(c.startSection || c.period || 1)
    const endSection = Number(c.endSection || (c.period ? Number(c.period) + 1 : 2))
    const location = String(c.location || c.classroom || '待定').trim()
    const teacher = String(c.teacher || '任课教师').trim()
    const weeks = String(c.weeks || '').trim()

    result.push({
      name,
      dayOfWeek,
      periodText: `第 ${startSection}-${endSection} 节`,
      startSection,
      endSection,
      location,
      teacher,
      weeks,
    })
  }

  return result
}

export function ScheduleDomainSheet(): React.ReactElement {
  const [week, setWeek] = React.useState<number>(1)
  const [selectedDay, setSelectedDay] = React.useState<number>(() => {
    const day = new Date().getDay()
    return day === 0 ? 7 : day
  })
  const [loading, setLoading] = React.useState(true)
  const [data, setData] = React.useState<CdutDomainToolResult | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const fetchSchedule = React.useCallback(async (targetWeek: number): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const res = await window.electronAPI.cdutZone.callDomainTool({
        domain: 'schedule',
        params: {
          action: 'get_my_schedule',
          week: targetWeek,
        },
      })
      setData(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取课表日程失败')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void fetchSchedule(week)
  }, [week, fetchSchedule])

  const courses = React.useMemo(() => normalizeCourses(data?.json), [data])
  const filteredCourses = React.useMemo(() => {
    return courses.filter((c) => c.dayOfWeek === selectedDay)
  }, [courses, selectedDay])

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* 顶栏控件：周次选择器 + 状态徽标 + 刷新 */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-3">
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-muted-foreground">当前周次：</label>
          <select
            value={week}
            onChange={(e) => setWeek(Number(e.target.value))}
            className="h-8 rounded-lg border border-border/80 bg-background px-2.5 text-xs font-semibold text-foreground shadow-xs outline-none focus:border-primary"
          >
            {Array.from({ length: 20 }, (_, i) => i + 1).map((w) => (
              <option key={w} value={w}>
                第 {w} 周 {w === 1 ? '(当前学期启动)' : ''}
              </option>
            ))}
          </select>
          {data?.isDemo && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
              <Sparkles size={11} />
              高仿真演示数据
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={() => void fetchSchedule(week)}
          disabled={loading}
          className="flex h-8 items-center gap-1.5 rounded-lg border border-border/70 bg-background px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw size={13} className={cn(loading && 'animate-spin')} />
          <span>刷新</span>
        </button>
      </div>

      {/* 星期横向标签栏 */}
      <div className="grid grid-cols-7 gap-1.5 rounded-xl bg-muted/40 p-1">
        {WEEKDAYS.map((item) => {
          const isSelected = selectedDay === item.id
          const dayCount = courses.filter((c) => c.dayOfWeek === item.id).length
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setSelectedDay(item.id)}
              className={cn(
                'flex flex-col items-center justify-center rounded-lg py-1.5 transition-all text-xs',
                isSelected
                  ? 'bg-background font-semibold text-primary shadow-xs'
                  : 'text-muted-foreground hover:bg-background/50 hover:text-foreground',
              )}
            >
              <span>{item.label}</span>
              <span className="mt-0.5 text-[10px] opacity-75">{dayCount} 节</span>
            </button>
          )
        })}
      </div>

      {/* 课程列表卡片流 */}
      <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-3">
        {loading ? (
          <div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
            <Loader2 size={20} className="animate-spin text-primary" />
            <p className="text-xs">正在同步成理青果课表日程…</p>
          </div>
        ) : error ? (
          <div className="rounded-xl border border-destructive/20 bg-destructive/10 p-4 text-xs text-destructive">
            {error}
          </div>
        ) : filteredCourses.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border/60 bg-muted/20 text-muted-foreground text-center p-6">
            <CalendarDays size={24} className="text-muted-foreground/60" />
            <p className="text-xs font-medium">当天暂无排课安排</p>
            <p className="text-[11px] text-muted-foreground/80">
              好好享受静谧自习或科研时光，可前往「自习空教室」寻找安适学习位点。
            </p>
          </div>
        ) : (
          filteredCourses.map((c, idx) => (
            <div
              key={`${c.name}-${c.startSection}-${idx}`}
              className="relative overflow-hidden rounded-xl border border-border/70 bg-card p-4 shadow-xs transition-all hover:border-primary/40 hover:shadow-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
                      <Clock size={11} />
                      {c.periodText}
                    </span>
                    {c.weeks && (
                      <span className="rounded-md bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                        {c.weeks}
                      </span>
                    )}
                  </div>
                  <h4 className="text-sm font-semibold text-foreground pt-1">{c.name}</h4>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground border-t border-border/40 pt-2.5">
                <div className="flex items-center gap-1.5">
                  <MapPin size={13} className="text-emerald-500" />
                  <span>{c.location}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <User size={13} className="text-indigo-500" />
                  <span>{c.teacher}</span>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
