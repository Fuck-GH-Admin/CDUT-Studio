/**
 * AppShell - 应用主布局容器
 *
 * 布局结构：[LeftSidebar 可折叠] | [MainArea: TabBar + TabContent] | [RightSidePanel 可折叠]
 *
 * MainArea 支持多标签页，Settings 视图为独立覆盖。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { LeftSidebar } from './LeftSidebar'
import { RightSidePanel } from './RightSidePanel'
import { MainArea } from '@/components/tabs/MainArea'
import { TabBar } from '@/components/tabs/TabBar'
import { WindowControlsTemplateProvider } from '@/components/WindowControlsTemplate'
import { AppShellProvider, type AppShellContextType } from '@/contexts/AppShellContext'
import { appModeAtom } from '@/atoms/app-mode'
import { agentSidePanelOpenAtom, agentSidePanelWidthAtom, agentPreviewPanelWidthAtom, currentAgentSessionIdAtom, agentWorkspacesAtom, currentAgentWorkspaceIdAtom, agentDiffPanelTabAtom } from '@/atoms/agent-atoms'
import { panelVisibilityAtom } from '@/atoms/panel-layout-atoms'
import { automationFormAtom } from '@/atoms/automation-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { leftSidebarWidthAtom } from '@/atoms/sidebar-atoms'
import { sidebarCollapsedAtom } from '@/atoms/tab-atoms'
import { cslabAuthAtom } from '@/atoms/cslab-atoms'
import { detectIsMac, detectIsWindows } from '@profer/ui'
import { MacTrafficLights } from './MacTrafficLights'
import { interfaceVariantAtom } from '@/atoms/theme'
import { usePanelAutoLayout } from '@/hooks/usePanelAutoLayout'
import { cn } from '@/lib/utils'
import { Z_LAYER } from '@profer/ui'

const MIN_RIGHT_PANEL_WIDTH = 300
const MAX_RIGHT_PANEL_WIDTH = 560
const MIN_PREVIEW_PANEL_WIDTH = 340

const MIN_LEFT_SIDEBAR_WIDTH = 300
const MAX_LEFT_SIDEBAR_WIDTH = 420

function clampLeftSidebarWidth(width: number): number {
  return Math.max(MIN_LEFT_SIDEBAR_WIDTH, Math.min(MAX_LEFT_SIDEBAR_WIDTH, width))
}

export interface AppShellProps {
  /** Context 值，用于传递给子组件 */
  contextValue: AppShellContextType
}

export function AppShell({ contextValue }: AppShellProps): React.ReactElement {
  const appMode = useAtomValue(appModeAtom)
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const interfaceVariant = useAtomValue(interfaceVariantAtom)
  const isClassic = interfaceVariant === 'classic'
  const filePanelVisible = useAtomValue(panelVisibilityAtom).filePanel
  const activeRightPanelTab = useAtomValue(agentDiffPanelTabAtom).get(currentSessionId ?? '') ?? 'session'
  const setSidePanelOpen = useSetAtom(agentSidePanelOpenAtom)

  // 聚焦右侧面板（profer:focus-right-panel 事件，来自快捷键/全局提示）
  React.useEffect(() => {
    const focusRightPanel = (): void => {
      setSidePanelOpen(true)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const panel = document.querySelector<HTMLElement>('[data-profer-navigation-region="right-panel"]')
          const target = panel && Array.from(panel.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
          )).find((element) => element.offsetParent !== null)
          target?.focus()
        })
      })
    }
    window.addEventListener('profer:focus-right-panel', focusRightPanel)
    return () => window.removeEventListener('profer:focus-right-panel', focusRightPanel)
  }, [setSidePanelOpen])

  const automationForm = useAtomValue(automationFormAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const currentWorkspace = workspaces.find((w) => w.id === currentWorkspaceId)
  const isTeamWorkspace = false // 团队工作区已下线（原 TEAM_WORKSPACE_UI_ENABLED 分支移除）
  // 定时任务表单打开时隐藏右侧文件面板，让中间区域扩展到全宽（表单内含自己的右栏配置）
  const activeView = useAtomValue(activeViewAtom)
  const cslabVerified = useAtomValue(cslabAuthAtom).isVerified
  // CDUT Science 验密通过后进入实验室选择页，完全隐藏左侧主侧边栏
  const isCsLabImmersive = activeView === 'cdut-science' && cslabVerified
  const showRightPanel = appMode === 'agent' && !!currentSessionId && !automationForm.open && activeView === 'conversations'
  // 文件面板/浏览器仅在 agent 个人视图参与布局判定（团队/规划/自动化表单时右侧面板不渲染）
  const filePanelActive = !isTeamWorkspace && showRightPanel
  // 统一自适应可见性：窗口 resize 监听 + 浏览器/文件面板可见性计算（挂载于此布局容器）
  usePanelAutoLayout({ filePanelActive })
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  const isMac = React.useMemo(() => detectIsMac(), [])

  // 窗口标题设为用户名
  React.useEffect(() => {
    try {
      const raw = localStorage.getItem('profer-user-profile')
      if (raw) {
        const profile = JSON.parse(raw)
        if (profile?.userName) {
          document.title = profile.userName
        }
      }
    } catch { /* ignore */ }
  }, [])

  // 右侧面板可拖拽宽度：文件列表态与预览态分档记忆。
  // 预览态使用舒适阅读宽度（340px ~ 62vw），列表态保持 300 ~ 560px。
  const [listPanelWidth, setListPanelWidth] = useAtom(agentSidePanelWidthAtom)
  const [previewPanelWidth, setPreviewPanelWidth] = useAtom(agentPreviewPanelWidthAtom)
  const isPreviewTab = activeRightPanelTab === 'preview'
  const rightPanelWidth = isPreviewTab ? previewPanelWidth : listPanelWidth
  const setRightPanelWidth = isPreviewTab ? setPreviewPanelWidth : setListPanelWidth
  const dragging = React.useRef(false)
  const rightPanelMinimumWidth = isPreviewTab ? MIN_PREVIEW_PANEL_WIDTH : MIN_RIGHT_PANEL_WIDTH
  const clampCurrentRightPanelWidth = React.useCallback(
    (width: number) => {
      const max = isPreviewTab
        ? Math.max(MIN_PREVIEW_PANEL_WIDTH, Math.floor(window.innerWidth * 0.62))
        : MAX_RIGHT_PANEL_WIDTH
      return Math.max(rightPanelMinimumWidth, Math.min(max, width))
    },
    [isPreviewTab, rightPanelMinimumWidth],
  )
  const clampedRightPanelWidth = clampCurrentRightPanelWidth(rightPanelWidth)

  React.useEffect(() => {
    if (clampedRightPanelWidth !== rightPanelWidth) {
      setRightPanelWidth(clampedRightPanelWidth)
    }
  }, [clampedRightPanelWidth, rightPanelWidth, setRightPanelWidth])

  const handleMouseDown = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    const startX = e.clientX
    const startWidth = clampedRightPanelWidth
    let rafId = 0

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        const delta = startX - ev.clientX
        const newWidth = clampCurrentRightPanelWidth(startWidth + delta)
        setRightPanelWidth(newWidth)
      })
    }

    const onMouseUp = () => {
      dragging.current = false
      if (rafId) cancelAnimationFrame(rafId)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [clampCurrentRightPanelWidth, clampedRightPanelWidth, setRightPanelWidth])

  // 左侧边栏可拖拽宽度
  const [leftSidebarWidth, setLeftSidebarWidth] = useAtom(leftSidebarWidthAtom)
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom)
  const leftDragging = React.useRef(false)
  const [isDraggingLeftSidebar, setIsDraggingLeftSidebar] = React.useState(false)
  const clampedLeftSidebarWidth = clampLeftSidebarWidth(leftSidebarWidth)

  React.useEffect(() => {
    if (clampedLeftSidebarWidth !== leftSidebarWidth) {
      setLeftSidebarWidth(clampedLeftSidebarWidth)
    }
  }, [clampedLeftSidebarWidth, leftSidebarWidth, setLeftSidebarWidth])

  const handleLeftSidebarMouseDown = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    leftDragging.current = true
    setIsDraggingLeftSidebar(true)
    const startX = e.clientX
    const startWidth = clampedLeftSidebarWidth
    let latestClientX = startX
    let rafId = 0

    const applyWidth = () => {
      const delta = latestClientX - startX
      setLeftSidebarWidth(clampLeftSidebarWidth(startWidth + delta))
    }

    const onMouseMove = (ev: MouseEvent) => {
      if (!leftDragging.current) return
      latestClientX = ev.clientX
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        applyWidth()
      })
    }

    const onMouseUp = () => {
      leftDragging.current = false
      setIsDraggingLeftSidebar(false)
      if (rafId) {
        cancelAnimationFrame(rafId)
        rafId = 0
      }
      applyWidth()
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [clampedLeftSidebarWidth, setLeftSidebarWidth])

  return (
    <WindowControlsTemplateProvider>
    <AppShellProvider value={contextValue}>
      {/* 只保留顶端 8px 的全局拖拽缝隙。
          过去这里覆盖 50px 高的固定 drag-region；它会和 TabBar 内的 no-drag
          控件重叠。Electron 的原生 app-region 命中并不总是遵循 CSS z-index，
          尤其当皮肤为 TabBar 创建 backdrop-filter 合成层时，Tab、工具按钮会被
          误判为窗口拖动区而不可点击。TabBar、侧栏和各独立视图已经各自提供
          局部 drag region，因此全局层不能覆盖任何实际交互区域。 */}
      <div
        className={cn(
          `titlebar-drag-region fixed top-0 left-0 h-2 ${Z_LAYER.shellTopDrag}`,
          isWindows ? 'right-[126px]' : 'right-0'
        )}
      />

      <div className="shell-bg h-screen w-screen flex overflow-clip bg-surface-shell">
        {/* 左侧边栏：可折叠，可拖拽调整宽度；CSLab 授权后完全隐藏 */}
        {!isCsLabImmersive && (
        <div
          className={cn(
            isClassic ? 'p-2 pr-0' : '',
            // 收起 rail 必须压过其右侧的分隔线；冷启动直接恢复收起状态时，
            // 分隔线处于更高层会裁掉 rail 最右侧，造成整列图标视觉上向左偏移。
            sidebarCollapsed ? `relative ${Z_LAYER.shellRail} flex-none crt-sidebar` : `relative ${Z_LAYER.shell} flex-none crt-sidebar`,
          )}
        >
          <LeftSidebar width={clampedLeftSidebarWidth} noTransition={isDraggingLeftSidebar} />
          {/* 左栏复用主区既有的 8px 外边距作为拖动命中区：不额外占宽度，也不覆盖侧栏滚动条。 */}
          {!sidebarCollapsed && (
            <div
              className={`titlebar-no-drag absolute left-full top-0 bottom-0 ${Z_LAYER.shellResizer} w-1.5 translate-x-px cursor-col-resize pointer-events-auto`}
              onMouseDown={handleLeftSidebarMouseDown}
              role="separator"
              aria-orientation="vertical"
              aria-label="调整左侧边栏宽度"
            />
          )}
        </div>
        )}

        {/* macOS 红绿灯原本挂在侧栏内：CSLab 沉浸态隐藏侧栏后由这里接管 */}
        {isCsLabImmersive && isMac && (
          <div className="fixed left-0 top-0 z-[999] h-0 w-0">
            <MacTrafficLights />
          </div>
        )}

        {/* 中间容器 */}
        <div className={cn('main-area-glass-host flex-1 min-w-0 relative', isCsLabImmersive ? 'p-0' : 'p-2', Z_LAYER.shellContent)}>
          <MainArea />
        </div>

        {/* 右侧边栏：实际可见由 filePanelVisible（意图 A + 窗口足够）驱动；
            SidePanel 内部按此做宽度过渡动画。 */}
        {showRightPanel && (
          <div
            data-profer-navigation-region="right-panel"
            className={cn(
              // 上下边距始终保留，避免收起瞬间面板从上下各扩展 8px；仅切换右侧
              // 横向 padding，并让 SidePanel 自身负责宽度过渡，保持收起方向纯水平。
              filePanelVisible
                ? `relative ${Z_LAYER.shell} flex items-stretch crt-sidebar py-2 pr-2 pl-0`
                : `relative ${Z_LAYER.shellContent} flex items-stretch crt-sidebar py-2 pr-0 pl-0`
            )}
          >
            <RightSidePanel width={clampedRightPanelWidth} />
            {/* 透明命中区收窄为 6px，仅落在现有中缝中心，不参与布局也不产生额外留白。 */}
            {filePanelVisible && (
              <div
                className={`titlebar-no-drag absolute -left-[7px] top-0 bottom-0 ${Z_LAYER.shellResizer} w-1.5 cursor-col-resize pointer-events-auto`}
                onMouseDown={handleMouseDown}
                role="separator"
                aria-orientation="vertical"
                aria-label="调整右侧文件面板宽度"
              />
            )}
          </div>
        )}
      </div>
    </AppShellProvider>
    </WindowControlsTemplateProvider>
  )
}
