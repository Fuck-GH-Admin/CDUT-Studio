/**
 * AI Elements - 对话容器原语
 *
 * 基于 use-stick-to-bottom 实现自动滚动到底部的对话容器。
 * 移植自 profer-frontend 的 ai-elements/conversation.tsx。
 *
 * 包含：
 * - Conversation — 根容器（StickToBottom）
 * - ConversationContent — 内容区域
 * - ConversationEmptyState — 空状态
 * - ConversationScrollButton — 滚动到底部按钮
 */

import { Button } from '@profer/ui/primitives/button'
import { cn } from '@/lib/utils'
import { ArrowDownIcon } from 'lucide-react'
import type { ComponentProps } from 'react'
import { useCallback } from 'react'
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom'

// ===== Conversation 根容器 =====

export type ConversationProps = ComponentProps<typeof StickToBottom>

export function Conversation({ className, ...props }: ConversationProps): React.ReactElement {
  return (
    <StickToBottom
      className={cn('relative flex-1 overflow-y-hidden scrollbar-none', className)}
      initial="instant"
      resize="smooth"
      role="log"
      {...props}
    />
  )
}

// ===== ConversationContent 内容区域 =====

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>

/** 块级标签集合：用于纯文本降级时在块边界补换行，避免复制结果挤成一行 */
const BLOCK_TAGS = new Set([
  'DIV', 'P', 'LI', 'TR', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE', 'TABLE', 'UL', 'OL', 'HR', 'FIGURE',
])

/** 将 DOM 子树序列化为带换行的纯文本（不依赖布局，detached 节点同样正确） */
function extractPlainText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const el = node as HTMLElement
  if (el.tagName === 'BR') return '\n'
  let out = ''
  el.childNodes.forEach((child) => {
    out += extractPlainText(child)
  })
  if (BLOCK_TAGS.has(el.tagName) && !out.endsWith('\n')) out += '\n'
  return out
}

/**
 * 会话区复制净化器（Dual MIME Clipboard Sanitizer）：
 * 用户 Ctrl+C 复制会话正文时，克隆选区片段并剔除悬浮工具条 / 气泡菜单 / 置顶横幅 /
 * 代码块头部等非内容 Chrome 元素，再以「纯文本 + HTML」双模写回剪贴板，
 * 保证复制结果与视觉所见一致（不再混入 "Markdown/纯文本/复制此块" 等噪音文字）。
 *
 * 关键修复：选区中未命中任何噪音元素时**必须放行原生复制**——此前无条件
 * preventDefault 并以「detached 节点 innerText」重写剪贴板，会让块级内容丢失换行、
 * 甚至与用户实际选中的文本对不上（历史 Bug：Ctrl+C 粘贴结果与选区不一致）。
 */
function handleConversationCopy(event: React.ClipboardEvent<HTMLDivElement>): void {
  // 焦点处于输入框（ProseMirror / textarea / input / contenteditable）时放行原生行为
  const activeEl = document.activeElement
  if (activeEl?.closest('.ProseMirror, input, textarea, [contenteditable="true"]')) return

  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return

  const range = selection.getRangeAt(0)
  const container = event.currentTarget
  if (!container.contains(range.commonAncestorContainer)) return

  // 克隆选区片段并净化非文本 Chrome 元素
  const fragment = range.cloneContents()
  const noisySelectors = [
    '[data-agent-toolbar-corridor]',
    '[data-selection-action-popover]',
    '.sticky-user-banner',
    '.code-block-header',
    '.line-numbers',
    'button',
  ]
  let removedCount = 0
  for (const selector of noisySelectors) {
    fragment.querySelectorAll(selector).forEach((el) => {
      el.remove()
      removedCount += 1
    })
  }
  // 未命中噪音元素：交给浏览器原生复制，保证剪贴板内容与选区 100% 一致
  if (removedCount === 0) return

  const tempDiv = document.createElement('div')
  tempDiv.appendChild(fragment)
  const cleanHtml = tempDiv.innerHTML
  const cleanText = extractPlainText(tempDiv).replace(/\n{3,}/g, '\n\n').trim()

  if (cleanText) {
    event.preventDefault()
    // 双模写入：text/plain 为净化后的纯文本，text/html 保留结构排版
    event.clipboardData.setData('text/plain', cleanText)
    event.clipboardData.setData('text/html', cleanHtml)
  }
}

export function ConversationContent({ className, onCopy, ...props }: ConversationContentProps): React.ReactElement {
  return (
    <StickToBottom.Content
      scrollClassName="profer-scroll-region"
      className={cn('flex flex-col gap-1 py-4 px-8', className)}
      onCopy={onCopy ?? handleConversationCopy}
      {...props}
    />
  )
}

// ===== ConversationEmptyState 空状态 =====

export interface ConversationEmptyStateProps extends ComponentProps<'div'> {
  title?: string
  description?: string
  icon?: React.ReactNode
}

export function ConversationEmptyState({
  className,
  title = '暂无消息',
  description = '在下方输入框开始对话',
  icon,
  children,
  ...props
}: ConversationEmptyStateProps): React.ReactElement {
  return (
    <div
      className={cn(
        'flex size-full flex-col items-center justify-center gap-3 p-8 text-center',
        className
      )}
      {...props}
    >
      {children ?? (
        <>
          {icon && <div className="text-muted-foreground">{icon}</div>}
          <div className="space-y-1">
            <h3 className="font-medium text-sm">{title}</h3>
            {description && (
              <p className="text-muted-foreground text-sm">{description}</p>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ===== ConversationScrollButton 滚动到底部 =====

export type ConversationScrollButtonProps = ComponentProps<typeof Button>

export function ConversationScrollButton({
  className,
  ...props
}: ConversationScrollButtonProps): React.ReactElement | null {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext()

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom()
  }, [scrollToBottom])

  if (isAtBottom) return null

  return (
    <Button
      data-scroll-to-bottom
      className={cn(
        'absolute bottom-[26px] left-1/2 z-50 -translate-x-1/2 rounded-[17px] size-9',
        'border-[0.5px] border-border bg-background/95 shadow-md backdrop-blur-sm',
        className
      )}
      onClick={handleScrollToBottom}
      type="button"
      variant="outline"
      {...props}
    >
      <ArrowDownIcon className="size-4" />
    </Button>
  )
}
