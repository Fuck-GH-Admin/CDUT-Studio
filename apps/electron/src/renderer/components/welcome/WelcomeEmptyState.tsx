/**
 * WelcomeEmptyState — Agent 空状态引导（现代立体卡片化全景）
 *
 * 自上而下四段式结构：
 *   1. 立体拟物北京时间钟表 + 分时段问候 + 实时时钟药丸（在线状态呼吸灯）；
 *   2. 4 大核心场景快速启动卡片：AI速课堂 / 代码全栈开发 / 内容合规审查 / CDUT 校园特区；
 *   3. 灵感启发气泡：一键填入聊天输入框，降低交互门槛；
 *   4. 活跃度贡献热力图：GitHub 风格学习与编码历程（沿用 UsageHeatmap）。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  Code2,
  GraduationCap,
  Lightbulb,
  Scale,
  School,
  type LucideIcon,
} from 'lucide-react'
import { userProfileAtom } from '@/atoms/user-profile'
import { appModeAtom } from '@/atoms/app-mode'
import { activeViewAtom } from '@/atoms/active-view'
import { cdutSubViewAtom } from '@/atoms/cdut-account-atoms'
import {
  agentComposerInjectionAtom,
  currentAgentSessionIdAtom,
  currentAgentWorkspaceIdAtom,
  agentWorkspacesAtom,
} from '@/atoms/agent-atoms'
import { getRandomTip, getPlatform, type Tip } from '@/lib/tips'
import { getBeijingClockAngles, getBeijingGreetingParts } from '@/lib/beijing-greeting'
import { BeijingAnalogClock } from './BeijingAnalogClock'
import { UsageHeatmap } from './UsageHeatmap'

/** 核心场景卡片定义 */
interface ScenarioCard {
  id: string
  icon: LucideIcon
  emoji: string
  title: string
  desc: string
  /** 点击后切换的目标视图（conversations = 停留在对话模式） */
  target: { view: 'conversations' | 'cdut-zone' }
}

const SCENARIO_CARDS: ScenarioCard[] = [
  // AI速课堂：只跳 CDUT 专区主页，不再进一步下沉到 ai-class 子视图。
  // 直跳 ai-class 会绕过「课堂会话选择」前置流程，落在一个表面像速课堂、
  // 实际却是常规 Agent 会话的不一致状态（历史 Bug）。
  { id: 'study', icon: GraduationCap, emoji: '🎓', title: 'AI速课堂', desc: '智能思维导图、知识树提炼、原文溯源自测', target: { view: 'cdut-zone' } },
  { id: 'code', icon: Code2, emoji: '💻', title: '代码全栈开发', desc: 'Pi 内核驱动、零配置增量快照与工程编排', target: { view: 'conversations' } },
  { id: 'review', icon: Scale, emoji: '⚖️', title: '内容合规审查', desc: '三栏联动审校、白名单网关、智能定责报告', target: { view: 'cdut-zone' } },
  // CDUT 校园特区：专区主页（bento 三大板块），严禁直跳 yanhu-express——
  // 那会挂载智联万站原生视口并连带唤起砚小龙桌宠窗口（历史 Bug：点卡片莫名弹出桌宠）
  { id: 'cdut', icon: School, emoji: '🏫', title: 'CDUT 校园特区', desc: '实时课表雷达、空教室检索、校园快达服务', target: { view: 'cdut-zone' } },
]

/** 灵感启发 Prompt Pills（点击即填入输入框） */
const PROMPT_PILLS: string[] = [
  '总结这份 PDF 的核心考点',
  '帮我用 TS 写一个防抖 Hook',
  '查询今天下午有空的自习室',
  '把这份周报润色得更精炼',
  '生成明日复习计划并提醒我',
]

export function WelcomeEmptyState(): React.ReactElement {
  const userProfile = useAtomValue(userProfileAtom)
  const mode = useAtomValue(appModeAtom)
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const setActiveView = useSetAtom(activeViewAtom)
  const setCdutSubView = useSetAtom(cdutSubViewAtom)
  const setComposerInjection = useSetAtom(agentComposerInjectionAtom)

  const currentWorkspace = React.useMemo(
    () => workspaces.find((workspace) => workspace.id === currentWorkspaceId) ?? null,
    [workspaces, currentWorkspaceId],
  )
  const showHeatmap = mode === 'agent' && currentWorkspace?.type !== 'team'
  const [tip] = React.useState<Tip>(() => getRandomTip(getPlatform()))
  const displayName = userProfile.userName || '用户'

  // 实时北京时间时钟：对齐真实秒边界的自校正递归定时器，卸载时清理
  const [now, setNow] = React.useState(() => new Date())
  React.useEffect(() => {
    let timer = 0
    const tick = (): void => {
      setNow(new Date())
      // 每次重新计算距下一整秒的延迟：不累积漂移，也不漏秒/重秒
      timer = window.setTimeout(tick, 1000 - (Date.now() % 1000) + 20)
    }
    timer = window.setTimeout(tick, 1000 - (Date.now() % 1000) + 20)
    return () => window.clearTimeout(timer)
  }, [])
  const { greeting } = getBeijingGreetingParts(now)
  const { clockText } = getBeijingClockAngles(now)

  /** 场景卡片点击：切换主视图；进入 CDUT 专区时强制落回专区主页（子视图置空） */
  const handleScenarioClick = (card: ScenarioCard): void => {
    if (card.target.view === 'cdut-zone') setCdutSubView(null)
    setActiveView(card.target.view)
  }

  /** 灵感气泡点击：复用全局 Composer 注入原子，同步清空旧 HTML 草稿并聚焦输入框 */
  const handlePromptClick = (text: string): void => {
    // 欢迎页始终渲染在具体会话的 AgentView 内；无会话时不注入，避免写入幽灵草稿。
    if (!currentSessionId) return
    setComposerInjection({ sessionId: currentSessionId, text, nonce: Date.now() })
  }

  return (
    <div className="welcome-empty-state relative flex h-full translate-y-[60px] flex-col items-center justify-center gap-5 overflow-hidden px-4 [@media(max-height:820px)]:translate-y-0 [@media(max-height:700px)]:gap-3.5">
      {/* ===== 立体拟物北京时间钟表 + 问候区 ===== */}
      <div className="z-10 flex flex-col items-center gap-2 [@media(max-height:700px)]:gap-1.5">
        <div className="mb-0.5 [@media(max-height:700px)]:mb-0">
          <BeijingAnalogClock now={now} />
        </div>
        <h1 className="text-[26px] font-semibold tracking-tight text-foreground">
          {displayName}，{greeting.split('，')[0]}
        </h1>
        <p className="text-xs text-muted-foreground">{greeting.split('，').slice(1).join('，')}</p>
        {/* 时钟徽章 + 在线状态呼吸灯 */}
        <div className="flex items-center gap-2 rounded-full border border-border/50 bg-muted/50 px-3 py-1 text-[11px] text-muted-foreground">
          <span className="relative flex size-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
          </span>
          <span className="font-mono tabular-nums">北京时间 {clockText}</span>
        </div>
      </div>

      {/* ===== 4 大核心场景快速启动卡片 ===== */}
      <div className="z-10 grid w-full max-w-[560px] grid-cols-2 gap-2.5 [@media(max-height:760px)]:hidden">
        {SCENARIO_CARDS.map((card) => {
          const Icon = card.icon
          return (
            <button
              key={card.id}
              type="button"
              onClick={() => handleScenarioClick(card)}
              className="group relative flex items-start gap-2.5 overflow-hidden rounded-xl border border-border/50 bg-card/70 p-3 text-left shadow-sm backdrop-blur-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
            >
              {/* 微弱渐变光晕 */}
              <span className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/8 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
                <Icon size={17} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-semibold text-foreground">
                  {card.emoji} {card.title}
                </span>
                <span className="mt-0.5 block text-[10px] leading-relaxed text-muted-foreground">{card.desc}</span>
              </span>
            </button>
          )
        })}
      </div>

      {/* ===== 灵感启发气泡 ===== */}
      <div className="z-10 flex max-w-[560px] flex-wrap items-center justify-center gap-1.5">
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-1 text-[10px] font-medium text-amber-600 dark:text-amber-400">
          <Lightbulb size={11} />
          试试
        </span>
        {PROMPT_PILLS.map((text) => (
          <button
            key={text}
            type="button"
            onClick={() => handlePromptClick(text)}
            title="点击填入输入框"
            className="rounded-full border border-border/50 bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary"
          >
            {text}
          </button>
        ))}
        <span className="rounded-full bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground/80">{tip.text}</span>
      </div>

      {/* ===== 活跃度贡献热力图 ===== */}
      {showHeatmap && (
        <div className="z-10 mt-1 [@media(max-height:640px)]:hidden">
          <UsageHeatmap />
        </div>
      )}
    </div>
  )
}
