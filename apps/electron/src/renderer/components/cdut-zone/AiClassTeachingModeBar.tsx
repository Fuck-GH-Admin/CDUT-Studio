/**
 * AI 速课堂带教模式悬浮条（三档切换胶囊）
 *
 * 挂载于 AgentView 输入区 composer-stack 顶部（仅 variant="ai-class"）。
 * 状态策略：atom 只存「本次运行内用户显式覆盖」，有效模式按
 * 「atom 覆盖 ?? sessionMeta?.studyTeachingMode ?? 'balanced'」派生，
 * 不做 meta→atom 回填 effect，杜绝快速切换会话时的竞态重置。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { studyTeachingModeAtomFamily } from '@/atoms/agent-atoms'
import type { AgentSessionMeta, StudyTeachingMode } from '@profer/shared'

/** 三档模式展示配置（emoji 徽标 + 短标签 + 原生 title 提示，沿用项目 Tooltip 惯例） */
const TEACHING_MODE_OPTIONS: ReadonlyArray<{
  value: StudyTeachingMode
  badge: string
  label: string
  title: string
}> = [
  { value: 'fast', badge: '⚡', label: '轻快', title: '极速直答 · 无测验打扰' },
  { value: 'balanced', badge: '🎯', label: '精讲', title: '核心考点 · 思维导图 · 默认' },
  { value: 'strict', badge: '🏆', label: '硬核', title: '闭环带教 · 考题抽测' },
]

const TEACHING_MODE_LABELS: Record<StudyTeachingMode, string> = {
  fast: '⚡ 轻快查证',
  balanced: '🎯 专项精讲',
  strict: '🏆 考霸硬核',
}

interface AiClassTeachingModeBarProps {
  sessionId: string
  sessionMeta?: AgentSessionMeta | null
}

export function AiClassTeachingModeBar({ sessionId, sessionMeta }: AiClassTeachingModeBarProps): React.ReactElement {
  // atom 只存显式覆盖；未切换时跟随会话元数据（缺省 balanced）
  const override = useAtomValue(studyTeachingModeAtomFamily(sessionId))
  const setOverride = useSetAtom(studyTeachingModeAtomFamily(sessionId))
  const effectiveMode: StudyTeachingMode = override ?? sessionMeta?.studyTeachingMode ?? 'balanced'

  const handleSelect = React.useCallback((mode: StudyTeachingMode) => {
    if (mode === effectiveMode) return
    // 先写本地覆盖（UI 即时高亮），再异步持久化到会话元数据（下一轮 buildSystemPrompt 生效）
    setOverride(mode)
    window.electronAPI.updateSessionStudyTeachingMode(sessionId, mode).catch((error) => {
      console.error('[AiClassTeachingModeBar] 切换带教模式失败:', error)
      toast.error(error instanceof Error ? error.message : '切换带教模式失败')
    })
    toast.info(`已切换至「${TEACHING_MODE_LABELS[mode]}」，下一轮生效`)
  }, [sessionId, effectiveMode, setOverride])

  return (
    <div className="mb-1.5 flex select-none items-center justify-start px-1">
      <div
        role="radiogroup"
        aria-label="AI 速课堂带教模式"
        className="inline-flex h-7 shrink-0 items-center gap-0.5 rounded-full border-[0.5px] border-border bg-background/70 p-0.5 shadow-sm backdrop-blur-sm"
      >
        {TEACHING_MODE_OPTIONS.map((option) => {
          const active = option.value === effectiveMode
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              title={option.title}
              onClick={() => handleSelect(option.value)}
              className={cn(
                'whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs transition-colors duration-150',
                active
                  ? 'bg-primary/10 font-medium text-primary shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <span className="mr-0.5">{option.badge}</span>
              {option.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
