/**
 * bulletin-startup — 公告栏启动弹出纯判定逻辑
 *
 * 独立成纯函数模块以便单元测试（仓库范式：同目录 *.test.ts），
 * useBulletinStartupTrigger Hook 消费这里的判定结果。
 */
import type { BulletinItem } from '@profer/shared'

/**
 * 取「最新」公告：按 date（YYYY-MM-DD）倒序第一条。
 * pinned 仅影响列表展示排序，不参与「最新」判定。
 */
export function pickLatestBulletin(items: BulletinItem[]): BulletinItem | null {
  if (items.length === 0) return null
  return [...items].sort((a, b) => b.date.localeCompare(a.date))[0] ?? null
}

/** 列表展示排序：置顶优先，同组内按日期倒序 */
export function sortBulletinsForDisplay(items: BulletinItem[]): BulletinItem[] {
  return [...items].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) {
      return a.pinned ? -1 : 1
    }
    return b.date.localeCompare(a.date)
  })
}

export interface BulletinStartupGuard {
  /** 内置公告非空 */
  hasBulletins: boolean
  /** 最新公告 ID ≠ lastReadBulletinId（存在未读新公告） */
  hasUnreadLatest: boolean
  /** 本次运行会话内用户已关闭过公告栏 */
  sessionDismissed: boolean
  /** CoachTour 蒙层导览正在进行 */
  coachTourActive: boolean
  /** CoachTour 已排定即将播放（settings.coachTourVersion < CURRENT_COACH_TOUR_VERSION） */
  coachTourPending: boolean
  /** 首次欢迎导览重播进行中 */
  welcomeReplayActive: boolean
}

/** 启动自动弹出判定：任一引导态激活即推迟 */
export function shouldAutoOpenBulletin(guard: BulletinStartupGuard): boolean {
  return (
    guard.hasBulletins &&
    guard.hasUnreadLatest &&
    !guard.sessionDismissed &&
    !guard.coachTourActive &&
    !guard.coachTourPending &&
    !guard.welcomeReplayActive
  )
}
