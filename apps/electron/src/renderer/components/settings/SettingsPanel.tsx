/**
 * SettingsPanel - 设置面板
 *
 * 左侧导航（标题 + 分组）+ 右侧内容区域。
 * 使用 Jotai atom 管理当前标签页状态。
 */

import * as React from "react";
import { useAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import { cn } from "@/lib/utils";
import {
  Settings,
  Radio,
  Palette,
  Info,
  Plug,
  BookOpen,
  Bot,
  GraduationCap,
  X,
  Keyboard,
  Users,
  Database,
  Network,
  FlaskConical,
  SlidersHorizontal,
} from "lucide-react";
import { ScrollArea } from "@profer/ui/primitives/scroll-area";
import { settingsTabAtom, channelFormDirtyAtom, settingsCloseRequestedAtom, settingsOpenAtom } from "@/atoms/settings-tab";
import type { SettingsTab } from "@/atoms/settings-tab";
import { appModeAtom } from "@/atoms/app-mode";
import { authStatusAtom } from "@/atoms/identity-atoms";
import { openTutorialTab } from "@/lib/tab-activation";
import { hasEnvironmentIssuesAtom } from "@/atoms/environment";
import { developerModeEnabledAtom } from "@/atoms/developer-mode";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@profer/ui/primitives/alert-dialog";
import { ChannelSettings } from "./ChannelSettings";
import { GeneralSettings } from "./GeneralSettings";
import { UsageSettings } from "./UsageSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { AboutSettings } from "./AboutSettings";
import { AgentSettings } from "./AgentSettings";
import { BotHubSettings } from "./BotHubSettings";
import { ShortcutSettings } from "./ShortcutSettings";
import { DataManagementSettings } from "./DataManagementSettings";
import { OpenApiSettings } from "./OpenApiSettings";
import { ProxySettings } from "./ProxySettings";
import { DeveloperSettings } from "./DeveloperSettings";

/** 设置 Tab 定义 */
export interface SettingsTabItem {
  id: SettingsTab;
  label: string;
  icon: React.ReactNode;
}

/** 导航分组：标题 + 该分组内的 tab */
export interface SettingsTabGroup {
  /** 分组标题；为空则不渲染分组标题（用于不带标题的起始组） */
  title?: string;
  items: SettingsTabItem[];
}

/** 模型与能力：渠道 / Agent */
const MODEL_GROUP_ITEMS: SettingsTabItem[] = [
  { id: "channels", label: "模型配置", icon: <Radio size={16} /> },
  { id: "agent", label: "Agent 配置", icon: <Plug size={16} /> },
];

/** 体验：外观 / 快捷键 */
const EXPERIENCE_GROUP_ITEMS: SettingsTabItem[] = [
  { id: "appearance", label: "外观设置", icon: <Palette size={16} /> },
  { id: "shortcuts", label: "快捷键管理", icon: <Keyboard size={16} /> },
];

/** 连接：远程连接 / 代理 */
const CONNECTION_GROUP_ITEMS: SettingsTabItem[] = [
  { id: "bots", label: "远程连接", icon: <Bot size={16} /> },
  { id: "proxy", label: "代理设置", icon: <Network size={16} /> },
];

/** 系统：数据管理 / 隐藏插件入口 */
const SYSTEM_GROUP_ITEMS: SettingsTabItem[] = [
  { id: "data-management", label: "数据管理", icon: <Database size={16} /> },
];

/** 帮助：教程 / 关于与更新 */
const HELP_GROUP_ITEMS: SettingsTabItem[] = [
  { id: "tutorial", label: "CDUT Studio 教程", icon: <GraduationCap size={16} /> },
  { id: "about", label: "关于", icon: <Info size={16} /> },
];

const DEVELOPER_MODE_ITEM: SettingsTabItem = {
  id: "developer",
  label: "开发者",
  icon: <FlaskConical size={16} />,
};

/** 依赖团队账号登录的 Tab（未登录时不展示） */

/** 根据标签页 id 渲染对应内容 */
function renderTabContent(tab: SettingsTab): React.ReactElement {
  switch (tab) {
    case "general":
      return <GeneralSettings />;
    case "usage":
      return <UsageSettings />;
    case "channels":
      return <ChannelSettings />;
    case "agent":
      return <AgentSettings />;
    case "appearance":
      return <AppearanceSettings />;
    case "about":
      return <AboutSettings />;
    case "bots":
      return <BotHubSettings />;
    case "shortcuts":
      return <ShortcutSettings />;
    case "data-management":
      return <DataManagementSettings />;
    case "developer":
      return <DeveloperSettings />;
    // 开放 API 暂无导航入口；保留渲染分支以兼容既有内部跳转和后续恢复。
    case "openapi":
      return <OpenApiSettings />;
    case "proxy":
      return <ProxySettings />;
    default:
      // tutorial 等特殊 tab 由 handleTabChange 拦截打开主区 Tab，不会在此渲染
      return <GeneralSettings />;
  }
}

interface SettingsPanelProps {
  onClose?: () => void;
  /** 受限环境（如外部嵌入入口）传入的 tab 白名单；不传时按 appMode 推导完整列表 */
  tabsOverride?: SettingsTabItem[];
}

export function SettingsPanel({
  onClose,
  tabsOverride,
}: SettingsPanelProps): React.ReactElement {
  const [activeTab, setActiveTab] = useAtom(settingsTabAtom);
  const channelFormDirty = useAtomValue(channelFormDirtyAtom);
  const [closeRequested, setCloseRequested] = useAtom(settingsCloseRequestedAtom);
  const setSettingsOpen = useSetAtom(settingsOpenAtom);
  const appMode = useAtomValue(appModeAtom);
  const hasEnvironmentIssues = useAtomValue(hasEnvironmentIssuesAtom);
  const developerModeEnabled = useAtomValue(developerModeEnabledAtom);
  const store = useStore();
  const authStatus = useAtomValue(authStatusAtom);

  /** 统一的退出拦截对话框状态 */
  type PendingAction = { type: 'tab'; tabId: SettingsTab } | { type: 'close' } | null
  const [pendingAction, setPendingAction] = React.useState<PendingAction>(null)
  const showNavDialog = pendingAction !== null

  /** 完成导航（仅在无需确认或用户明确放弃后调用）。 */
  const navigateToTab = (tabId: SettingsTab): void => {
    if (tabId === 'tutorial') {
      openTutorialTab(store)
      setSettingsOpen(false)
      return
    }
    setActiveTab(tabId)
  }

  /** 执行待处理的操作 */
  const executePendingAction = (): void => {
    if (!pendingAction) return
    if (pendingAction.type === 'tab') {
      navigateToTab(pendingAction.tabId)
    } else {
      onClose?.()
    }
    setPendingAction(null)
  }

  /** 取消待处理的操作 */
  const cancelPendingAction = (): void => {
    setPendingAction(null)
  }

  // 受限环境传入白名单时直接使用（无分组标题）；否则按语义分组组装导航。
  // 未登录时过滤掉需要团队账号的 Tab，并清理空分组。
  const groups = React.useMemo<SettingsTabGroup[]>(() => {
    if (tabsOverride) {
      return [{ items: tabsOverride }]
    }

    const modelItems = appMode === "agent"
      ? MODEL_GROUP_ITEMS
      : MODEL_GROUP_ITEMS.filter((item) => item.id !== "agent")

    const systemItems = developerModeEnabled
      ? [SYSTEM_GROUP_ITEMS[0]!, DEVELOPER_MODE_ITEM, ...SYSTEM_GROUP_ITEMS.slice(1)]
      : SYSTEM_GROUP_ITEMS

    const allGroups: SettingsTabGroup[] = [
      { items: [{ id: "general", label: "通用", icon: <Settings size={16} /> }, { id: "usage", label: "使用偏好", icon: <SlidersHorizontal size={16} /> }] },
      { title: "模型与能力", items: modelItems },
      { title: "体验", items: EXPERIENCE_GROUP_ITEMS },
      { title: "连接", items: CONNECTION_GROUP_ITEMS },
      { title: "系统", items: systemItems },
      { title: "帮助", items: HELP_GROUP_ITEMS },
    ]

    if (authStatus.isLoggedIn) return allGroups

    // 未登录：过滤需要鉴权的页面，并清理空分组
    return allGroups
      .filter((g) => g.items.length > 0)
  }, [appMode, tabsOverride, authStatus.isLoggedIn, developerModeEnabled]);

  // 将所有可见 tab 拍平成列表，用于 activeTab 回落与标题查找
  const tabs: SettingsTabItem[] = React.useMemo(
    () => groups.flatMap((g) => g.items),
    [groups]
  );

  // 统一回落：activeTab 不在当前可见列表（白名单过滤 / 未登录过滤）时回落到首项，
  // 避免渲染未暴露的设置页（如登录/订阅/团队管理）。
  // tabs 为空数组（tabsOverride 传空）时整体不渲染，避免解引用崩溃。
  const effectiveTab: SettingsTab = tabs.some((t) => t.id === activeTab) ? activeTab : (tabs[0]?.id ?? 'general')

  /** 切换标签页时检测是否有未保存内容，tutorial 特殊处理：打开 New Tab 并关闭设置 */
  const handleTabChange = (tabId: SettingsTab): void => {
    if (tabId === effectiveTab) return
    if (effectiveTab === 'channels' && channelFormDirty) {
      setPendingAction({ type: 'tab', tabId })
      return
    }
    navigateToTab(tabId)
  }

  /** 关闭设置面板时检测是否有未保存内容 */
  const handleClose = (): void => {
    if (effectiveTab === 'channels' && channelFormDirty) {
      setPendingAction({ type: 'close' })
      return
    }
    onClose?.()
  }

  // Cmd+W 等外部关闭请求：弹出确认对话框
  React.useEffect(() => {
    if (!closeRequested) return
    setCloseRequested(false)
    if (channelFormDirty) {
      setPendingAction({ type: 'close' })
    } else {
      onClose?.()
    }
  }, [closeRequested, channelFormDirty, setCloseRequested, onClose])

  // 保持所有 Hook 在空列表回落之前执行。
  if (tabs.length === 0) return <div className="flex flex-col h-full items-center justify-center text-sm text-muted-foreground">没有可用的设置项</div>

  // 当前 tab 标题
  const activeTabLabel = tabs.find((t) => t.id === effectiveTab)?.label ?? "设置";

  return (
    <div className="settings-body flex h-full min-h-0">
      {/* 左侧固定导航：设置标题与分组入口同列，宽度 240px。 */}
      <aside className="settings-nav flex w-[240px] flex-shrink-0 flex-col overflow-y-auto border-r border-surface-border/50 bg-surface-sunken/30 px-2.5 py-4 scrollbar-thin">
        <div className="settings-nav-header flex items-center px-3 pb-4">
          <h2 className="text-base font-semibold text-foreground">设置</h2>
        </div>
        <nav className="flex flex-col gap-0.5" aria-label="设置分类">
          {groups.map((group) => (
            <React.Fragment key={group.title ?? "__root__"}>
              {group.title && (
                <div className="px-3 pt-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">
                  {group.title}
                </div>
              )}
              {group.items.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => handleTabChange(tab.id)}
                  className={cn(
                    "group flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                    effectiveTab === tab.id
                      ? "bg-surface-selected text-foreground font-medium shadow-sm"
                      : "text-muted-foreground hover:bg-surface-selected/50 hover:text-foreground",
                  )}
                >
                  <span className={cn(
                    "flex-shrink-0 transition-colors",
                    effectiveTab === tab.id ? "text-primary" : "text-muted-foreground/70 group-hover:text-foreground"
                  )}>{tab.icon}</span>
                  <span className="truncate">{tab.label}</span>
                  {tab.id === "about" && hasEnvironmentIssues && (
                    <span className="ml-auto size-2 rounded-full bg-red-500" />
                  )}
                </button>
              ))}
            </React.Fragment>
          ))}
        </nav>
      </aside>

      {/* 右侧内容：标题属于内容区，不再横跨整个设置面板形成顶部栏。 */}
      <section className="settings-main flex min-w-0 flex-1 flex-col">
        <div className="settings-main-header flex min-h-[72px] flex-shrink-0 items-center justify-between px-8 py-5">
          <h2 className="text-xl font-semibold text-foreground">{activeTabLabel}</h2>
          {onClose && (
            <button
              onClick={handleClose}
              aria-label="关闭设置"
              className="rounded-md p-1.5 text-muted-foreground/60 transition-colors hover:bg-control hover:text-foreground"
            >
              <X size={18} />
            </button>
          )}
        </div>
        <ScrollArea className="flex-1 min-h-0">
          <div className="settings-content px-8 pb-8 pt-1">
            <div className="mx-auto w-full max-w-3xl">
              {renderTabContent(effectiveTab)}
            </div>
          </div>
        </ScrollArea>
      </section>

      {/* 退出拦截弹窗（侧边栏导航 / X 关闭 / Cmd+W） */}
      <AlertDialog open={showNavDialog} onOpenChange={(open) => { if (!open) cancelPendingAction() }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>放弃未保存的更改？</AlertDialogTitle>
            <AlertDialogDescription>
              当前渠道配置尚未保存，确定要离开吗？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelPendingAction}>留在当前页</AlertDialogCancel>
            <AlertDialogAction onClick={executePendingAction}>放弃并离开</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
