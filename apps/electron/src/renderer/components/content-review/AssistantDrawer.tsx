/**
 * AssistantDrawer — 审核助手对话抽屉（D9）
 *
 * 固定右侧抽屉（reviewAssistantOpenAtom 控制显隐，translate-x 过渡）。
 * - 头部：标题 + 关闭按钮 + 当前上下文（案卷名 + 选中的问题卡）
 * - 消息列表：按案卷隔离（reviewAssistantThreadsAtom[caseId]）；
 *   degraded 消息顶部显示"离线解答（未连接模型）"灰条，references 显示为小 badge
 * - 输入区：Textarea + 发送按钮（pending 时 spinner）
 * - 快捷提问 3 个（为什么这样判？/ 我要补哪张证明？/ 申报分值怎么改？）
 * - 快捷键 Ctrl+Shift+A（Mac: Cmd+Shift+A）由主视图监听，这里只管开关状态
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Send, X } from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'
import { Spinner } from '@profer/ui/primitives/spinner'
import { Textarea } from '@profer/ui/primitives/textarea'
import type { ReviewAssistantMessage } from '@profer/shared'
import {
  reviewAssistantOpenAtom,
  reviewAssistantPendingAtom,
  reviewAssistantThreadsAtom,
  reviewCaseAtom,
  selectedFindingAtom,
} from '@/atoms/review-atoms'
import { cn } from '@/lib/utils'
import type { ReviewActions } from './use-review-actions'

/** 快捷提问（设计文档 §审核助手 的三个示例问题） */
const QUICK_PROMPTS = ['为什么这样判？', '我要补哪张证明？', '申报分值怎么改？'] as const

interface AssistantDrawerProps {
  actions: ReviewActions
}

export function AssistantDrawer({ actions }: AssistantDrawerProps): React.ReactElement {
  const open = useAtomValue(reviewAssistantOpenAtom)
  const pending = useAtomValue(reviewAssistantPendingAtom)
  const reviewCase = useAtomValue(reviewCaseAtom)
  const selectedFinding = useAtomValue(selectedFindingAtom)
  const threads = useAtomValue(reviewAssistantThreadsAtom)
  const setOpen = useSetAtom(reviewAssistantOpenAtom)
  const setThreads = useSetAtom(reviewAssistantThreadsAtom)

  const [draft, setDraft] = React.useState('')
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)

  const caseId = reviewCase?.id ?? ''
  const messages = threads[caseId] ?? []

  // 新消息到达 → 滚到底部
  React.useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, pending])

  // 抽屉打开 → 聚焦输入框
  React.useEffect(() => {
    if (open) textareaRef.current?.focus()
  }, [open])

  /** 发送一条用户消息并请求助手回答 */
  const send = async (text: string): Promise<void> => {
    const content = text.trim()
    if (!content || pending || !caseId) return
    const userMessage: ReviewAssistantMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    }
    const nextHistory = [...messages, userMessage]
    // 先乐观写入用户消息（线程按案卷隔离），再请求回答
    setThreads((previous) => ({ ...previous, [caseId]: nextHistory }))
    setDraft('')
    await actions.assistantChat(nextHistory)
  }

  if (!open) return <div aria-hidden="true" className="hidden" />

  return (
    <aside
      role="dialog"
      aria-label="审核助手"
      className="absolute right-0 top-0 z-40 flex h-full w-[380px] flex-col border-l border-border/60 bg-card shadow-2xl transition-transform duration-200 translate-x-0"
    >
      {/* 头部 */}
      <header className="flex shrink-0 items-start justify-between gap-2 border-b border-border/60 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">审核助手</h2>
          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={reviewCase?.title}>
            案卷：{reviewCase?.title ?? '未载入'}
          </p>
          {selectedFinding && (
            <p className="mt-0.5 truncate text-xs text-blue-600 dark:text-blue-400" title={selectedFinding.title}>
              当前问题卡：{selectedFinding.title}
            </p>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label="关闭审核助手"
          onClick={() => setOpen(false)}
        >
          <X size={15} />
        </Button>
      </header>

      {/* 消息列表 */}
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto scrollbar-thin px-4 py-3">
        {messages.length === 0 && (
          <p className="rounded-lg bg-muted/40 px-3 py-2 text-xs leading-5 text-muted-foreground">
            我会基于本案卷的规则、申报与证明回答你的问题，并标注引用出处；没有依据时会明说无法确定。
          </p>
        )}
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
        {pending && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner size="sm" />
            助手思考中…
          </div>
        )}
      </div>

      {/* 快捷提问 */}
      <div className="flex shrink-0 flex-wrap gap-1.5 border-t border-border/60 px-4 py-2">
        {QUICK_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            disabled={pending}
            onClick={() => void send(prompt)}
            className="rounded-md bg-muted px-2 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted/70 disabled:opacity-50"
          >
            {prompt}
          </button>
        ))}
      </div>

      {/* 输入区 */}
      <div className="flex shrink-0 items-end gap-2 border-t border-border/60 px-4 py-3">
        <Textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void send(draft)
            }
          }}
          placeholder="向助手提问（Enter 发送，Shift+Enter 换行）"
          rows={2}
          className="min-h-[56px] resize-none text-sm"
        />
        <Button
          type="button"
          size="icon"
          className="size-9 shrink-0"
          aria-label="发送"
          disabled={pending || !draft.trim()}
          onClick={() => void send(draft)}
        >
          {pending ? <Spinner size="sm" /> : <Send size={15} />}
        </Button>
      </div>
    </aside>
  )
}

/** 单条消息气泡（含 degraded 灰条与 references 徽标） */
function MessageBubble({ message }: { message: ReviewAssistantMessage }): React.ReactElement {
  const isUser = message.role === 'user'
  return (
    <div className={cn('flex flex-col gap-1', isUser && 'items-end')}>
      {/* degraded：无模型渠道时的静态解答，顶部灰条明示 */}
      {message.degraded && !isUser && (
        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
          离线解答（未连接模型）
        </span>
      )}
      <div
        className={cn(
          'max-w-[92%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm leading-5',
          isUser ? 'bg-primary text-primary-foreground' : 'bg-muted/60 text-foreground',
        )}
      >
        {message.content}
      </div>
      {/* 引用出处徽标 */}
      {message.references && message.references.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1">
          {message.references.map((reference) => (
            <span
              key={reference}
              className="rounded-md bg-blue-500/10 px-1.5 py-0.5 text-xs font-medium text-blue-600 dark:text-blue-400"
            >
              {reference}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
