/**
 * AiClassChatPanel — AI 速课堂专属对话面板
 *
 * 彻底替代直接挂载的通用 AgentView：以 `variant="ai-class"` 进入精简模式，
 * 剥离 Token 消耗热力图与 MCP 通用技术提示，隐藏预设切换开关，禁用 / # & 唤起，
 * 使用柔和大字号问候与专注学习语境的占位文本，仅保留 AskUserBanner 主动摸底能力。
 */

import * as React from 'react'
import { AgentView } from '@/components/agent'
import { TabErrorBoundary } from '@/components/tabs/TabErrorBoundary'
import { CdutMark } from '@/components/shared/CdutLogo'

interface AiClassChatPanelProps {
  sessionId: string
}

export function AiClassChatPanel({ sessionId }: AiClassChatPanelProps): React.ReactElement {
  const emptyState = (
    // absolute inset-0：锚定到对话区域（最近的 relative 容器）整体居中。
    // ConversationContent 的内层 flex 容器高度为 auto，h-full 会塌陷导致内容贴顶。
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center select-none">
      <CdutMark className="size-28 shrink-0" />
      <p className="bg-gradient-to-r from-primary/85 via-foreground to-primary/85 bg-clip-text text-2xl font-semibold tracking-tight text-transparent">
        准备好专注了嘛~现在想学点什么呢？
      </p>
      <p className="whitespace-nowrap text-xs leading-relaxed text-muted-foreground">
        上传课件、教材或习题集，我会结合资料树大纲为你逐点拆解、靶向提分。
      </p>
    </div>
  )

  return (
    <div data-tour="ai-class-chat" className="flex h-full min-h-0 flex-col">
      <TabErrorBoundary key={`ai-class-${sessionId}`} sessionId={sessionId}>
        <AgentView sessionId={sessionId} variant="ai-class" emptyState={emptyState} />
      </TabErrorBoundary>
    </div>
  )
}
