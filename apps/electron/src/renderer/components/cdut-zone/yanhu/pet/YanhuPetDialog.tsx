/**
 * 砚小龙 · 常驻灵动伴随卡片（YanhuPetDialog）
 *
 * 结构：上栏（灵动说话气泡 或 完整历史流）+ 下栏（紧凑输入条）。
 * 卡片底边与 160px 立绘底部基线对齐，气泡/历史向上生长，输入条恒定处于最顺手位置。
 *
 * - 默认进入灵动气泡态，无需任何操作即可看到输入框（根治“输入框看不见”缺陷）；
 * - 工具调用以微胶囊（Micro-Capsule）标签流呈现，可点击展开入参 / 出参；
 * - 回车上优先拦截隐藏特权指令 `/development-DevTool-MCC`，零 Token 消耗。
 */

import * as React from 'react'
import { Send, Settings, Square } from 'lucide-react'
import type { YanhuPetMessage, YanhuPetToolInvocation } from '@profer/shared'
import { cn } from '@/lib/utils'
import { MessageResponse } from '@/components/ai-elements/message'
import { BUBBLE_HEIGHT, HISTORY_HEIGHT } from './pet-geometry'
import { YanhuPetSpeechBubble, YanhuToolCapsule, YanhuUsageBadge } from './YanhuPetSpeechBubble'

/** 隐藏特权指令（自动联想完全黑名单过滤，普通用户不可见） */
export const YANHU_DEV_COMMAND = '/development-DevTool-MCC'

export interface YanhuPetDialogProps {
  messages: YanhuPetMessage[]
  streamText: string
  reasoning: string
  activeTools: YanhuPetToolInvocation[]
  streaming: boolean
  /** 是否展开完整历史 */
  historyExpanded: boolean
  /** 桌宠相对卡片的排布侧（决定气泡尖角方向） */
  direction: 'left' | 'right'
  /** 气泡尖角距顶部偏移（px） */
  tailTop: number
  /** 桌宠是否处于闲置打哈欠态 */
  sleepy: boolean
  onToggleHistory: () => void
  onHideCard: () => void
  onSend: (text: string) => void
  onAbort: () => void
  /** 打开桌宠设置菜单 */
  onOpenSettings: () => void
  /** 唤起实时底层诊断控制台（特权指令） */
  onDevCommand: () => void
  /** 输入活动回调（驱动 Blinking 态） */
  onInputActivity: () => void
  /** 新手引导：外部一次性填入输入框（nonce 保证重复文本也能触发） */
  fillRequest?: { text: string; nonce: number } | null
}

export function YanhuPetDialog({
  messages,
  streamText,
  reasoning,
  activeTools,
  streaming,
  historyExpanded,
  direction,
  tailTop,
  sleepy,
  onToggleHistory,
  onHideCard,
  onSend,
  onAbort,
  onOpenSettings,
  onDevCommand,
  onInputActivity,
  fillRequest,
}: YanhuPetDialogProps): React.ReactElement {
  const [input, setInput] = React.useState('')
  const isComposingRef = React.useRef(false)
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)

  // 新手引导：把演示指令填入输入框（只填入、不代发送）。
  // 仅由 fillRequest（含 nonce）驱动，避免宿主重渲染时反复覆盖用户输入。
  React.useEffect(() => {
    if (!fillRequest) return
    setInput(fillRequest.text)
    onInputActivity()
    window.requestAnimationFrame(() => textareaRef.current?.focus())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fillRequest])

  React.useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, streamText, activeTools.length, historyExpanded])

  // 自动适应内容高度（最小 46px，最大 160px）
  React.useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const nextHeight = Math.min(Math.max(el.scrollHeight, 46), 160)
    el.style.height = `${nextHeight}px`
  }, [input])

  const submit = (): void => {
    const value = input.trim()
    if (!value) return
    // 特权指令：纯前端拦截，绝不向大模型发送请求（Token 消耗恒等于 0）
    if (value === YANHU_DEV_COMMAND) {
      setInput('')
      if (textareaRef.current) textareaRef.current.style.height = '46px'
      onDevCommand()
      return
    }
    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = '46px'
    onSend(value)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey) return
    // 中文输入法上屏过程中拦截 Enter，防止误提交原始拼音英文字符
    if (event.nativeEvent.isComposing || isComposingRef.current || event.keyCode === 229) return
    event.preventDefault()
    submit()
  }

  // 气泡内容模式判定
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
  const lastTool = activeTools.length > 0 ? activeTools[activeTools.length - 1] : undefined
  const bubbleMode: 'idle' | 'executing' | 'response' = streaming
    ? 'executing'
    : lastAssistant
      ? 'response'
      : 'idle'
  const bubbleText = streaming
    ? lastTool
      ? lastTool.label
      : '正在读屏，分析页面结构…'
    : lastAssistant?.content ?? ''

  return (
    <div className="flex w-full flex-col gap-2">
      {/* 上栏：灵动气泡 / 完整历史 */}
      <div className="shrink-0" style={{ height: historyExpanded ? HISTORY_HEIGHT : BUBBLE_HEIGHT }}>
        {historyExpanded ? (
          <div className="flex h-full w-full flex-col overflow-hidden rounded-2xl border border-border/80 bg-card text-card-foreground shadow-2xl">
            <div className="flex shrink-0 items-center justify-between px-3 py-2 select-none">
              <span className="text-[11px] font-semibold text-foreground">砚小龙 · 完整历史</span>
              <button
                type="button"
                onClick={onToggleHistory}
                className="rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground cursor-pointer"
              >
                收起历史
              </button>
            </div>
            <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-2.5 select-text">
              {messages.length === 0 ? (
                <div className="px-1 py-6 text-center text-[11px] leading-relaxed text-muted-foreground select-none">
                  还没有对话记录，下达第一条指令吧～
                </div>
              ) : null}

              {messages.map((message) => {
                if (message.role === 'user') {
                  return (
                    <div key={message.id} className="flex justify-end">
                      <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-2.5 py-1.5 text-xs leading-relaxed text-primary-foreground select-text">
                        {message.content}
                      </div>
                    </div>
                  )
                }
                if (message.role === 'system') return null
                return (
                  <div key={message.id} className="space-y-1">
                    {message.toolInvocations && message.toolInvocations.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {message.toolInvocations.map((tool) => (
                          <YanhuToolCapsule key={tool.id} tool={tool} />
                        ))}
                      </div>
                    ) : null}
                    <div className="rounded-xl border border-border/40 bg-muted/40 px-2.5 py-1.5 text-xs text-foreground select-text">
                      <MessageResponse className="prose-p:my-0.5 prose-headings:my-1.5">
                        {message.content}
                      </MessageResponse>
                      {message.usage ? (
                        <div className="mt-1 flex justify-start">
                          <YanhuUsageBadge usage={message.usage} />
                        </div>
                      ) : null}
                    </div>
                  </div>
                )
              })}

              {streaming ? (
                <div className="space-y-1">
                  {activeTools.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {activeTools.map((tool) => (
                        <YanhuToolCapsule key={tool.id} tool={tool} />
                      ))}
                    </div>
                  ) : null}
                  {reasoning ? (
                    <div className="whitespace-pre-wrap rounded-xl border border-border/30 bg-muted/30 px-2.5 py-1.5 text-[10px] leading-relaxed text-muted-foreground select-text">
                      {reasoning}
                    </div>
                  ) : null}
                  {streamText ? (
                    <div className="rounded-xl border border-border/40 bg-muted/40 px-2.5 py-1.5 text-xs text-foreground select-text">
                      <MessageResponse className="prose-p:my-0.5 prose-headings:my-1.5">{streamText}</MessageResponse>
                    </div>
                  ) : (
                    <div className="px-2.5 py-1 text-[11px] text-muted-foreground select-none">砚小龙正在思考…</div>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <YanhuPetSpeechBubble
            mode={bubbleMode}
            text={bubbleText}
            streaming={streaming}
            activeTools={activeTools}
            historyExpanded={historyExpanded}
            usage={lastAssistant?.usage}
            sleepy={sleepy}
            tailSide={direction === 'right' ? 'left' : 'right'}
            tailTop={tailTop}
            onToggleHistory={onToggleHistory}
            onHideCard={onHideCard}
          />
        )}
      </div>

      {/* 下栏：输入条（加高加宽，长文本更从容） */}
      <div className="flex w-full shrink-0 items-end gap-2 rounded-2xl border border-border/80 bg-card p-2.5 shadow-2xl">
        <button
          type="button"
          onClick={onOpenSettings}
          title="砚小龙设置（记忆/位置）"
          className="mb-0.5 flex h-10 w-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground cursor-pointer"
        >
          <Settings className="h-4 w-4" />
        </button>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            onInputActivity()
          }}
          onKeyDown={handleKeyDown}
          onFocus={onInputActivity}
          onCompositionStart={() => {
            isComposingRef.current = true
          }}
          onCompositionEnd={() => {
            isComposingRef.current = false
          }}
          rows={1}
          placeholder="吩咐砚小龙去做点什么…"
          className="max-h-40 min-h-[46px] flex-1 resize-none rounded-xl border border-border/70 bg-background px-3.5 py-2.5 text-sm leading-relaxed text-foreground shadow-xs outline-none transition-colors select-text placeholder:text-muted-foreground/60 focus:border-primary/60"
        />
        {streaming ? (
          <button
            type="button"
            onClick={onAbort}
            title="中止"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-destructive/10 text-destructive transition-colors hover:bg-destructive/20 cursor-pointer"
          >
            <Square className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!input.trim()}
            title="发送"
            className={cn(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-xs transition-all hover:bg-primary/90 cursor-pointer',
              !input.trim() && 'pointer-events-none opacity-30',
            )}
          >
            <Send className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  )
}
