/**
 * useBulletinStartupTrigger — 公告栏启动自动弹出触发器
 *
 * 生命周期规则：
 *  - 仅在主界面分支挂载（天然排除 Onboarding 与欢迎导览重播两个全屏接管分支）；
 *  - 主界面就绪后延迟 600ms 检测：存在公告且最新条目 ≠ lastReadBulletinId 时弹一次；
 *  - CoachTour 竞态保护：App 初始化后 800ms 才置 coachTourOpenAtom=true（见 App.tsx），
 *    本 Hook 在 600ms 时还需检查 settings.coachTourVersion 是否低于当前版本，
 *    识别「CoachTour 已排定即将播放」并推迟，等引导结束后由 effect 重跑接力弹出；
 *  - 用户关闭后 bulletinSessionDismissedAtom=true，本次运行会话内绝不重弹。
 */
import * as React from 'react'
import { useAtomValue, useStore } from 'jotai'
import { CURRENT_COACH_TOUR_VERSION } from '@/components/onboarding/coach-tour/coach-tour-steps'
import { coachTourOpenAtom } from '@/atoms/coach-tour-atoms'
import { replayWelcomeTourAtom } from '@/atoms/intro-atoms'
import {
  bulletinDialogOpenAtom,
  bulletinLastReadIdAtom,
  bulletinListAtom,
  bulletinSessionDismissedAtom,
  selectedBulletinIdAtom,
} from '@/atoms/bulletin-atoms'
import { pickLatestBulletin, shouldAutoOpenBulletin } from '@/components/bulletin/bulletin-startup'

/** 启动自动弹出检测延迟（ms） */
const BULLETIN_STARTUP_DELAY_MS = 600

export function useBulletinStartupTrigger(): void {
  const store = useStore()
  const coachTourOpen = useAtomValue(coachTourOpenAtom)
  const welcomeReplay = useAtomValue(replayWelcomeTourAtom)
  const sessionDismissed = useAtomValue(bulletinSessionDismissedAtom)

  React.useEffect(() => {
    // 任一引导态激活（或本次会话已关闭过）时绝不调度弹出
    if (coachTourOpen || welcomeReplay || sessionDismissed) return

    let cancelled = false
    const timer = window.setTimeout(async () => {
      if (cancelled) return

      // 双重检查原子当前值，防回调执行期间状态翻转的竞态
      const coachTourActive = store.get(coachTourOpenAtom)
      const welcomeReplayActive = store.get(replayWelcomeTourAtom)
      const dismissed = store.get(bulletinSessionDismissedAtom)
      if (coachTourActive || welcomeReplayActive || dismissed) return

      try {
        const [items, settings] = await Promise.all([
          window.electronAPI.getBulletins(),
          window.electronAPI.getSettings(),
        ])
        if (cancelled) return

        const latest = pickLatestBulletin(items)
        // 写入缓存供弹窗复用，避免二次 IPC
        store.set(bulletinListAtom, items)
        store.set(bulletinLastReadIdAtom, settings.lastReadBulletinId ?? null)
        if (!latest) return

        // 竞态关键：600ms 时 CoachTour 蒙层尚未挂载（App 在 800ms 才置原子），
        // 需凭持久化版本字段识别「CoachTour 已排定即将播放」并推迟
        const coachTourPending = (settings.coachTourVersion ?? 0) < CURRENT_COACH_TOUR_VERSION

        const shouldOpen = shouldAutoOpenBulletin({
          hasBulletins: items.length > 0,
          hasUnreadLatest: latest.id !== settings.lastReadBulletinId,
          sessionDismissed: dismissed,
          coachTourActive,
          coachTourPending,
          welcomeReplayActive,
        })
        if (!shouldOpen) return

        store.set(selectedBulletinIdAtom, latest.id)
        store.set(bulletinDialogOpenAtom, true)
      } catch (error) {
        console.error('[Bulletin] 启动公告检测失败:', error)
      }
    }, BULLETIN_STARTUP_DELAY_MS)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [store, coachTourOpen, welcomeReplay, sessionDismissed])
}
