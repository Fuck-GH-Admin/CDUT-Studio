import * as React from 'react'
import { useAtom, useStore } from 'jotai'
import { AppShell } from './components/app-shell/AppShell'
import { PlanningReminderRail } from './components/planning/PlanningReminderRail'
import { TutorialBanner } from './components/tutorial/TutorialBanner'
import { TooltipProvider } from '@profer/ui/primitives/tooltip'
import { useCreateSession } from './hooks/useCreateSession'
import { environmentCheckDialogOpenAtom } from './atoms/environment'
import { openTutorialTab } from './lib/tab-activation'
import { replayIntroEnvironmentTestAtom, replayIntroOpenAtom } from './atoms/intro-atoms'
import { IntroWaterRipple } from './components/onboarding/IntroWaterRipple'
import { CoachTourOverlay } from './components/onboarding/coach-tour/CoachTourOverlay'
import { coachTourOpenAtom } from './atoms/coach-tour-atoms'
import { CURRENT_COACH_TOUR_VERSION } from './components/onboarding/coach-tour/coach-tour-steps'
import type { AppShellContextType } from './contexts/AppShellContext'

/** 懒加载非首屏组件——减少首次渲染的 JS 解析量 */
const OnboardingView = React.lazy(() => import('./components/onboarding/OnboardingView').then(m => ({ default: m.OnboardingView })))
const EnvironmentCheckDialog = React.lazy(() => import('./components/environment/EnvironmentCheckDialog').then(m => ({ default: m.EnvironmentCheckDialog })))
const MigrationImportDialog = React.lazy(() => import('./components/migration/MigrationImportDialog').then(m => ({ default: m.MigrationImportDialog })))
const SettingsDialog = React.lazy(() => import('./components/settings/SettingsDialog').then(m => ({ default: m.SettingsDialog })))

export default function App(): React.ReactElement {
  const store = useStore()
  const [isLoading, setIsLoading] = React.useState(true)
  const [showOnboarding, setShowOnboarding] = React.useState(false)
  const [showOnboardingEnvironmentTest, setShowOnboardingEnvironmentTest] = useAtom(replayIntroEnvironmentTestAtom)

  // 初始化：检查是否需要显示 Onboarding
  // macOS/Linux 上 SDK 自带 claude native binary 不依赖宿主 Node/Git；
  // Windows 上仍需 Git Bash/WSL，由 Onboarding Step 2 与聊天错误卡片引导用户安装。
  React.useEffect(() => {
    const initialize = async () => {
      try {
        const settings = await window.electronAPI.getSettings()
        if (!settings.onboardingCompleted) {
          setShowOnboarding(true)
        } else if ((settings.coachTourVersion ?? 0) < CURRENT_COACH_TOUR_VERSION) {
          // 界面引导版本化接力：Onboarding 已完成的用户（含升级后版本偏低的老用户）
          // 等主界面首帧稳定后自动播放一次；退出时写入版本，不会重复出现。
          window.setTimeout(() => store.set(coachTourOpenAtom, true), 800)
        }
      } catch (error) {
        console.error('[App] 初始化失败:', error)
      } finally {
        setIsLoading(false)
      }
    }

    initialize()
  }, [])

  // 等 React 真正提交掉“正在初始化...”后，再允许主进程撤掉原生启动页。
  React.useEffect(() => {
    if (!isLoading) window.electronAPI.notifyRendererReady()
  }, [isLoading])

  // 打开教程 Tab：统一入口负责切回对话视图并同步副作用
  const handleOpenTutorial = React.useCallback((): void => {
    openTutorialTab(store)
  }, [store])

  // 加载中状态
  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">正在初始化...</p>
        </div>
      </div>
    )
  }

  // 主界面开屏测试结束后，复用首次 onboarding 的完整环境配置页；不写持久化状态。
  if (showOnboardingEnvironmentTest) {
    return (
      <TooltipProvider delayDuration={200}>
        <React.Suspense fallback={null}>
          <OnboardingView
            initialStep="welcome"
            persistCompletion={false}
            onComplete={() => setShowOnboardingEnvironmentTest(false)}
          />
        </React.Suspense>
      </TooltipProvider>
    )
  }

  // 显示首次 onboarding 界面
  if (showOnboarding) {
    return (
      <TooltipProvider delayDuration={200}>
        <React.Suspense fallback={null}>
          <OnboardingRoute
            onExit={() => setShowOnboarding(false)}
            onOpenTutorial={handleOpenTutorial}
          />
        </React.Suspense>
        <React.Suspense fallback={null}>
          <MigrationImportDialog />
        </React.Suspense>
      </TooltipProvider>
    )
  }

  // Placeholder context value
  const contextValue: AppShellContextType = {}

  // 显示主界面
  return (
    <TooltipProvider delayDuration={200}>
      <PlanningReminderRail />
      <AppShell contextValue={contextValue} />
      <React.Suspense fallback={null}>
        <SettingsDialog />
      </React.Suspense>
      <TutorialBanner />
      <GlobalEnvironmentCheckDialog />
      <React.Suspense fallback={null}>
        <MigrationImportDialog />
      </React.Suspense>
      <IntroReplayOverlay />
      <CoachTourOverlay />
    </TooltipProvider>
  )
}

/**
 * OnboardingRoute —— 仅在校首次引导期挂载的引导入口。
 *
 * `useCreateSession`（内部经 `useOpenSession` 订阅 tabs / agentSessions / 模型等多个 atom）
 * 被收敛到本子树：引导结束后本组件即卸载，App 根组件不再订阅这些无关 atom，
 * 从根本上消除「App re-render #41」式的根组件高频重渲染。
 */
function OnboardingRoute({
  onExit,
  onOpenTutorial,
}: {
  onExit: () => void
  onOpenTutorial: () => void
}): React.ReactElement {
  const store = useStore()
  const { createAgent } = useCreateSession()

  const handleComplete = React.useCallback(
    async (openTutorial?: boolean): Promise<void> => {
      onExit()
      if (openTutorial) {
        onOpenTutorial()
        return
      }
      try {
        await createAgent()
        // Onboarding 接力：进入主界面后自动播放一次界面蒙层引导；
        // 等首帧渲染稳定再启动，保证锚点（输入区/模型选择器）已挂载。
        window.setTimeout(() => store.set(coachTourOpenAtom, true), 600)
      } catch (error) {
        console.error('[App] 创建 Agent 会话失败:', error)
      }
    },
    [createAgent, store, onExit, onOpenTutorial],
  )

  return <OnboardingView onComplete={handleComplete} />
}

/**
 * 全屏开屏动画重播遮罩：
 * 主界面顶栏点按钮 → replayIntroOpenAtom=true → 渲染 IntroWaterRipple
 * 动画结束（或点按跳过）后重置 atom，回到主界面。
 * 不改动 onboardingCompleted，纯重播/测试用途。
 */
function IntroReplayOverlay(): React.ReactElement | null {
  const [open, setOpen] = useAtom(replayIntroOpenAtom)
  const [, setShowOnboardingEnvironmentTest] = useAtom(replayIntroEnvironmentTestAtom)
  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-[9999]"
      role="dialog"
      aria-modal="true"
      aria-label="CDUT Studio 开屏动画"
      data-profer-intro-overlay
    >
      <IntroWaterRipple
        onDone={() => {
          setOpen(false)
          // 复用首次安装时的完整环境配置页，不触碰 onboardingCompleted。
          setShowOnboardingEnvironmentTest(true)
        }}
      />
    </div>
  )
}

/**
 * 全局环境检测 Dialog，由错误卡片的 recovery action 按钮打开。
 */
function GlobalEnvironmentCheckDialog(): React.ReactElement {
  const [open, setOpen] = useAtom(environmentCheckDialogOpenAtom)
  return <EnvironmentCheckDialog open={open} onOpenChange={setOpen} />
}
