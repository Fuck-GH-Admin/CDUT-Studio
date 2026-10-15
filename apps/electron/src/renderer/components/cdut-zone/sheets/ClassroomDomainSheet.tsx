/**
 * ClassroomDomainSheet — CDUT 专区「自习空教室」抽屉业务卡片
 *
 * 核心交互：
 *   - 校区选择器（成都校区 / 宜宾校区）；
 *   - 常用教学楼快速标签（东区1教、9教、6教、甲教、乙教等）；
 *   - 节次时间段筛选（上午 1-2节、3-4节；下午 5-8节；晚自习 9-10节；全天）；
 *   - 空闲教室卡片网格（教室编号、座位容量、空调支持、空闲节次明细）；
 *   - 兼容实时教务与演示数据无缝回退。
 */

import * as React from 'react'
import {
  Building2,
  CheckCircle2,
  Clock,
  Flame,
  Loader2,
  MapPin,
  RefreshCw,
  Search,
  Sparkles,
  Users,
  Wind,
} from 'lucide-react'
import type { CdutDomainToolResult } from '@profer/shared'
import { cn } from '@/lib/utils'

interface ClassroomItem {
  roomName: string
  capacity: number
  availableSections: number[]
  hasAirConditioner: boolean
}

const CHENGDU_BUILDINGS = ['东区1教', '东区9教', '6教', '艺术大楼', '地灾国重'] as const
const YIBIN_BUILDINGS = ['甲教A座', '甲教B座', '乙教', '综合楼'] as const

const TIME_SLOTS: { id: string; label: string; sections?: number[] }[] = [
  { id: 'morning', label: '上午 (1-4节)', sections: [1, 2, 3, 4] },
  { id: 'afternoon', label: '下午 (5-8节)', sections: [5, 6, 7, 8] },
  { id: 'evening', label: '晚自习 (9-10节)', sections: [9, 10] },
  { id: 'all', label: '全天时段', sections: undefined },
]

/** 规范化空闲教室列表 */
function normalizeClassrooms(rawJson: unknown): ClassroomItem[] {
  if (!rawJson || typeof rawJson !== 'object') return []
  const obj = rawJson as Record<string, unknown>

  // 1. 标准结构: obj.emptyRooms
  if (Array.isArray(obj.emptyRooms)) {
    return obj.emptyRooms.map((r) => {
      const item = r as Record<string, unknown>
      return {
        roomName: String(item.roomName || '未知教室'),
        capacity: Number(item.capacity || 0),
        availableSections: Array.isArray(item.availableSections)
          ? (item.availableSections as number[])
          : [],
        hasAirConditioner: Boolean(item.hasAirConditioner),
      }
    })
  }

  // 2. 简易数组: ['东区1教-E1A106']
  if (Array.isArray(obj)) {
    return obj.map((r) => {
      if (typeof r === 'string') {
        return {
          roomName: r,
          capacity: 120,
          availableSections: [1, 2, 3, 4, 5, 6, 7, 8],
          hasAirConditioner: true,
        }
      }
      const item = r as Record<string, unknown>
      return {
        roomName: String(item.roomName || item.name || '未知教室'),
        capacity: Number(item.capacity || 0),
        availableSections: Array.isArray(item.availableSections)
          ? (item.availableSections as number[])
          : [],
        hasAirConditioner: Boolean(item.hasAirConditioner),
      }
    })
  }

  return []
}

export function ClassroomDomainSheet(): React.ReactElement {
  const [campus, setCampus] = React.useState<'chengdu' | 'yibin'>('chengdu')
  const [building, setBuilding] = React.useState<string>('东区1教')
  const [timeSlotId, setTimeSlotId] = React.useState<string>('afternoon')
  const [acOnly, setAcOnly] = React.useState(false)

  const [loading, setLoading] = React.useState(true)
  const [result, setResult] = React.useState<CdutDomainToolResult | null>(null)

  const queryClassrooms = React.useCallback(async () => {
    setLoading(true)
    try {
      const selectedSlot = TIME_SLOTS.find((s) => s.id === timeSlotId)
      const res = await window.electronAPI.cdutZone.callDomainTool({
        domain: 'classrooms',
        params: {
          action: 'query_empty_classrooms',
          campus,
          building,
          timeSlots: selectedSlot?.sections,
        },
      })
      setResult(res)
    } catch (err) {
      setResult({
        success: false,
        markdown: `查询失败: ${err instanceof Error ? err.message : String(err)}`,
        json: null,
        isDemo: true,
      })
    } finally {
      setLoading(false)
    }
  }, [campus, building, timeSlotId])

  // 校区切换时自动更新默认建筑
  const handleCampusChange = (c: 'chengdu' | 'yibin') => {
    setCampus(c)
    setBuilding(c === 'chengdu' ? CHENGDU_BUILDINGS[0] : YIBIN_BUILDINGS[0])
  }

  React.useEffect(() => {
    void queryClassrooms()
  }, [queryClassrooms])

  const classrooms = React.useMemo(() => {
    const list = normalizeClassrooms(result?.json)
    if (acOnly) return list.filter((r) => r.hasAirConditioner)
    return list
  }, [result?.json, acOnly])

  const currentBuildings = campus === 'chengdu' ? CHENGDU_BUILDINGS : YIBIN_BUILDINGS

  return (
    <div className="flex h-full flex-col">
      {/* 顶部状态与刷新 */}
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
              实时自习雷达
            </span>
          )}
        </div>

        <button
          type="button"
          disabled={loading}
          onClick={() => void queryClassrooms()}
          className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs text-muted-foreground transition hover:bg-muted/50 hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          <span>查询空位</span>
        </button>
      </div>

      {/* 筛选控制器卡片 */}
      <div className="mb-4 space-y-3 rounded-xl border border-surface-border/60 bg-card p-3.5 shadow-xs">
        {/* 校区选择 */}
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">校区选择</span>
          <div className="flex rounded-lg bg-muted/60 p-0.5">
            <button
              type="button"
              onClick={() => handleCampusChange('chengdu')}
              className={cn(
                'rounded-md px-3 py-1 text-xs transition-colors',
                campus === 'chengdu'
                  ? 'bg-card font-medium text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              成都校区
            </button>
            <button
              type="button"
              onClick={() => handleCampusChange('yibin')}
              className={cn(
                'rounded-md px-3 py-1 text-xs transition-colors',
                campus === 'yibin'
                  ? 'bg-card font-medium text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              宜宾校区
            </button>
          </div>
        </div>

        {/* 教学楼胶囊 */}
        <div>
          <span className="mb-1.5 block text-xs font-medium text-muted-foreground">教学楼</span>
          <div className="flex flex-wrap gap-1.5">
            {currentBuildings.map((b) => (
              <button
                key={b}
                type="button"
                onClick={() => setBuilding(b)}
                className={cn(
                  'rounded-lg px-2.5 py-1 text-xs transition-colors',
                  building === b
                    ? 'bg-primary text-primary-foreground font-medium shadow-xs'
                    : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {b}
              </button>
            ))}
          </div>
        </div>

        {/* 时段与空调 */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-surface-border/40 pt-2.5">
          <div className="flex flex-wrap items-center gap-1">
            {TIME_SLOTS.map((slot) => (
              <button
                key={slot.id}
                type="button"
                onClick={() => setTimeSlotId(slot.id)}
                className={cn(
                  'rounded-md px-2 py-0.5 text-[11px] transition-colors',
                  timeSlotId === slot.id
                    ? 'bg-secondary font-medium text-secondary-foreground'
                    : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                )}
              >
                {slot.label}
              </button>
            ))}
          </div>

          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground select-none">
            <input
              type="checkbox"
              checked={acOnly}
              onChange={(e) => setAcOnly(e.target.checked)}
              className="size-3.5 rounded border-muted-foreground/30 accent-primary"
            />
            <Wind className="size-3 text-blue-500" />
            <span>仅看空调房</span>
          </label>
        </div>
      </div>

      {/* 匹配结果列表 */}
      <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>当前楼栋空闲教室</span>
        <span>匹配到 {classrooms.length} 间</span>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto pr-1">
        {loading ? (
          <div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
            <Loader2 className="size-6 animate-spin text-primary" />
            <p className="text-xs">正在探测指定教学楼空闲状态...</p>
          </div>
        ) : classrooms.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-dashed border-surface-border/60 bg-muted/10 p-6 text-center text-muted-foreground">
            <Building2 className="size-8 opacity-30" />
            <p className="mt-2 text-xs">当前时段未探测到符合条件的空闲教室</p>
            <p className="mt-1 text-[11px] text-muted-foreground/75">
              建议切换其他节次或尝试周边邻近教学楼
            </p>
          </div>
        ) : (
          classrooms.map((room, idx) => (
            <div
              key={`${room.roomName}-${idx}`}
              className="flex items-center justify-between rounded-xl border border-surface-border/60 bg-card p-3 shadow-xs transition hover:border-surface-border hover:shadow-sm"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <MapPin className="size-4 shrink-0 text-primary" />
                  <span className="truncate text-sm font-semibold text-foreground">
                    {room.roomName}
                  </span>
                  {room.hasAirConditioner && (
                    <span className="inline-flex items-center gap-0.5 rounded-md bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-600 dark:text-blue-400">
                      <Wind className="size-2.5" />
                      空调
                    </span>
                  )}
                </div>

                {room.availableSections.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                    <Clock className="size-3" />
                    <span>空闲节次：</span>
                    {room.availableSections.map((sec) => (
                      <span
                        key={sec}
                        className="rounded bg-muted/60 px-1 py-0.2 text-[10px] text-foreground"
                      >
                        第{sec}节
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="shrink-0 pl-3 text-right">
                <div className="flex items-center gap-1 text-muted-foreground">
                  <Users className="size-3.5" />
                  <span className="text-sm font-bold text-foreground">
                    {room.capacity ? room.capacity : '—'}
                  </span>
                  <span className="text-[10px]">座</span>
                </div>
                <span className="text-[10px] text-emerald-600 dark:text-emerald-400">可自习</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
