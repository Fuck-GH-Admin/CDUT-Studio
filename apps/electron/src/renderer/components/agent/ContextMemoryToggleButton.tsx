import * as React from 'react'
import { Brain } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@profer/ui/primitives/tooltip'

interface ContextMemoryToggleButtonProps {
  disabled: boolean // true 表示已关闭记忆（单轮模式），false 表示已开启记忆（多轮模式）
  onToggle: () => void
  isProcessing?: boolean
}

export const ContextMemoryToggleButton: React.FC<ContextMemoryToggleButtonProps> = ({
  disabled,
  onToggle,
  isProcessing = false,
}) => {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onToggle}
          disabled={isProcessing}
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-medium transition-all duration-150',
            disabled
              ? 'text-muted-foreground hover:bg-muted/80 hover:text-foreground'
              : 'bg-primary/10 text-primary hover:bg-primary/15 dark:bg-primary/20',
            isProcessing && 'opacity-50 cursor-not-allowed'
          )}
          aria-label={disabled ? '上下文记忆已关闭（单轮问答）' : '上下文记忆已开启（多轮问答）'}
        >
          {/* lucide-react 未提供 BrainOff，关闭态用 Brain + 斜杠覆盖表达 */}
          <span className="relative inline-flex items-center justify-center">
            <Brain className="h-3.5 w-3.5" />
            {disabled && (
              <span className="pointer-events-none absolute left-1/2 top-1/2 h-px w-4 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-current" />
            )}
          </span>
          <span className="hidden sm:inline">{disabled ? '记忆关' : '记忆开'}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs max-w-[220px]">
        {disabled ? (
          <div>
            <div className="font-semibold text-tooltip-foreground">单轮聚焦模式 (记忆已关闭)</div>
            <div className="text-tooltip-muted mt-0.5">
              发送时不携带前序问答，大幅降低 Token 消耗与费用。界面依然保留完整记录。
            </div>
          </div>
        ) : (
          <div>
            <div className="font-semibold text-tooltip-foreground">多轮对话模式 (记忆已开启)</div>
            <div className="text-tooltip-muted mt-0.5">
              保持上下文连续性，模型可以理解前文问答与讨论内容。
            </div>
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
