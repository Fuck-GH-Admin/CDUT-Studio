import * as React from 'react'
import { Database, BookOpen } from 'lucide-react'
import type { AgentContextMode } from '@profer/shared'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@profer/ui/primitives/tooltip'

interface ContextModeToggleButtonProps {
  mode: AgentContextMode
  onChange: (mode: AgentContextMode) => void
  /** 记忆关闭时禁用；全局索引通过点击「经典」退出，不再禁用按钮 */
  disabled?: boolean
  /** 禁用原因（用于 tooltip） */
  disabledReason?: string
  isProcessing?: boolean
}

const MODES: Array<{ value: AgentContextMode; label: string; icon: React.ReactNode }> = [
  { value: 'classic', label: '经典', icon: <BookOpen className="h-3.5 w-3.5" /> },
  { value: 'index', label: '索引', icon: <Database className="h-3.5 w-3.5" /> },
]

/**
 * 输入栏常驻的上下文模式开关。
 * 经典 = 续接完整前序对话；索引 = 只检索相关历史，不上传全量 transcript。
 */
export const ContextModeToggleButton: React.FC<ContextModeToggleButtonProps> = ({
  mode,
  onChange,
  disabled = false,
  disabledReason,
  isProcessing = false,
}) => {
  const locked = disabled || isProcessing
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            'inline-flex h-7 items-center gap-0.5 rounded-lg bg-muted/50 p-0.5 text-xs',
            locked && 'opacity-50',
          )}
          aria-label={`上下文模式：${mode === 'index' ? '索引' : '经典'}`}
        >
          {MODES.map((item) => {
            const active = mode === item.value
            return (
              <button
                key={item.value}
                type="button"
                disabled={locked}
                aria-pressed={active}
                onClick={() => onChange(item.value)}
                className={cn(
                  'inline-flex h-6 items-center gap-1 rounded-md px-2 font-medium transition-colors',
                  active
                    ? 'bg-primary/10 text-primary dark:bg-primary/20'
                    : 'text-muted-foreground hover:bg-muted/80 hover:text-foreground',
                  locked && 'cursor-not-allowed',
                )}
              >
                {item.icon}
                <span className="hidden sm:inline">{item.label}</span>
              </button>
            )
          })}
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs max-w-[260px]">
        <div>
          <div className="font-semibold text-tooltip-foreground">
            上下文模式：{mode === 'index' ? '索引' : '经典'}
          </div>
          <div className="text-tooltip-muted mt-0.5">
            {disabledReason
              ? disabledReason
              : mode === 'index'
                ? '索引模式：只检索与当前提问相关的历史片段，不再上传完整前序对话，显著降低 Token 消耗。'
                : '经典模式：续接完整前序对话，上下文最完整，但 Token 消耗更高。'}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
