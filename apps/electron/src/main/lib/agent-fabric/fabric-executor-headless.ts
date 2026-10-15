/**
 * Agent Fabric Headless 执行器适配
 *
 * 设计文档 §13：现有 headless runner 是执行实现，通过适配器接入统一 Task Protocol。
 * 本模块把 Gateway 的 TaskExecutor 端口接到现有
 * `agent-headless-runner-registry`（避免与 orchestrator 循环依赖的既有解耦点）。
 *
 * 任务 → 会话映射：每个 Fabric 任务创建一个真实 Agent 会话（可审计、可在 UI 查看），
 * 会话引用作为日志产物挂到任务结果上。
 *
 * 权限说明：headless 任务无人值守，沿用 automation/bridge 的既有先例
 * （permissionModeOverride='bypassPermissions'）；高风险操作的审批转发
 * （waiting_for_approval + 一次性 token）在 Phase 2/4 补齐。
 */

import type { AgentMessage } from '@profer/shared'
import {
  ArtifactKind,
  type TaskExecution,
  type TaskExecutor,
  type TaskReporter,
  type TaskResult,
} from '@profer/agent-fabric'
import { runRegisteredHeadlessAgent, stopRegisteredAgent } from '../agent-headless-runner-registry'
import { stopAgent, agentEventBus } from '../agent-service'
import { createAgentSession } from '../agent-session-manager'
import { getSettings } from '../settings-service'
import type { AgentFabricConfig } from './fabric-config'

const SUMMARY_CHAR_LIMIT = 4_000

export interface HeadlessExecutorDeps {
  config: AgentFabricConfig
}

/** 组装任务的执行提示词：目标 + 约束 + 显式上下文（设计文档 §5.1）。 */
function buildTaskPrompt(execution: TaskExecution): string {
  const { request } = execution.task
  const lines: string[] = [
    `You are a local execution node dispatched by the CDUT Studio Agent Fabric. Task ID: ${request.taskId}.`,
    ``,
    `Objective: ${request.objective}`,
  ]
  if (request.constraints.length > 0) {
    lines.push(``, `Constraints (must be followed):`)
    for (const constraint of request.constraints) lines.push(`- ${constraint}`)
  }
  if (request.context?.files && request.context.files.length > 0) {
    lines.push(``, `Related files:`)
    for (const file of request.context.files) lines.push(`- ${file}`)
  }
  if (request.context?.notes) {
    lines.push(``, `Additional notes: ${request.context.notes}`)
  }
  lines.push(
    ``,
    `When finished, summarize the result in one concise paragraph: what was done, how it was verified and with what outcome, and any remaining issues. User-facing output must be written in the user's language (e.g., Simplified Chinese when the user writes in Chinese).`,
    `Do not claim to have executed commands or tests that you did not actually run.`,
  )
  return lines.join('\n')
}

/** 从会话消息构建结构化结果：结论与证据分开（§11）。 */
function buildTaskResult(execution: TaskExecution, messages: AgentMessage[] | undefined, sessionId: string): TaskResult {
  const lastAssistant = [...(messages ?? [])].reverse().find((message) => message.role === 'assistant' && message.content.trim())
  const summary = (lastAssistant?.content ?? '').slice(0, SUMMARY_CHAR_LIMIT) || '（无文本总结）'

  const transcriptArtifactId = `session-transcript-${sessionId}`
  // 证据引用会话本身；transcript 内容由 artifact 读取端点受控返回。
  return {
    status: 'completed',
    summary,
    changedFiles: [],
    testResults: [],
    artifacts: [
      {
        artifactId: transcriptArtifactId,
        taskId: execution.task.request.taskId,
        kind: ArtifactKind.LOG,
        mimeType: 'text/markdown',
        createdAt: Date.now(),
        label: `Fabric 任务会话转录（session ${sessionId}）`,
      },
    ],
    evidence: [{ type: 'log', ref: transcriptArtifactId }],
    blockers: [],
    nextActions: [],
  }
}

export function createHeadlessTaskExecutor(deps: HeadlessExecutorDeps): TaskExecutor {
  /** taskId -> sessionId，用于取消时停止对应会话。 */
  const runningSessions = new Map<string, string>()

  return {
    start(execution: TaskExecution): void {
      const reporter: TaskReporter = execution.reporter
      const taskId = execution.task.request.taskId

      void (async () => {
        let unsubscribeBus: (() => void) | null = null
        try {
          const settings = getSettings()
          const channelId = deps.config.defaultChannelId || settings.agentChannelId || ''
          if (!channelId) {
            reporter.fail('未配置模型渠道（settings.agentChannelId 为空），无法执行 Fabric 任务')
            return
          }
          const modelId = deps.config.defaultModelId ?? settings.agentModelId
          const workspaceId = execution.task.request.workspaceId || deps.config.defaultWorkspaceId

          const session = createAgentSession(
            `[Fabric] ${execution.task.request.objective.slice(0, 40)}`,
            channelId,
            workspaceId,
            modelId,
            'pi',
            false,
            execution.task.request.preset,
          )
          runningSessions.set(taskId, session.id)

          // 进度桥接：会话事件总线 → task.progress（只转发结构化摘要，不内联全文）。
          unsubscribeBus = agentEventBus.on((sessionId, payload) => {
            if (sessionId !== session.id) return
            if (payload.kind === 'sdk_message') {
              const messageType = (payload.message as { type?: string } | undefined)?.type
              reporter.progress({ sessionId: session.id, messageType: messageType ?? 'unknown' })
            } else if (payload.kind === 'profer_event') {
              reporter.progress({ sessionId: session.id, proferEvent: payload.event.type })
            }
          })

          await runRegisteredHeadlessAgent(
            {
              sessionId: session.id,
              userMessage: buildTaskPrompt(execution),
              channelId,
              modelId,
              workspaceId,
              permissionModeOverride: 'bypassPermissions',
              triggeredBy: 'delegation',
            },
            {
              source: 'bridge',
              onError: (error) => {
                reporter.fail(error)
              },
              onComplete: (messages, opts) => {
                if (opts?.stoppedByUser) {
                  reporter.fail('执行被用户停止')
                  return
                }
                reporter.complete(buildTaskResult(execution, messages, session.id))
              },
              onTitleUpdated: () => { /* 会话标题由会话管理器维护 */ },
            },
          )
        } catch (error) {
          reporter.fail(error instanceof Error ? error.message : String(error))
        } finally {
          unsubscribeBus?.()
          runningSessions.delete(taskId)
        }
      })()
    },

    cancel(taskId: string): void {
      const sessionId = runningSessions.get(taskId)
      if (!sessionId) return
      // 优先走 orchestrator 注入的 stopper（委派取消语义）；未初始化时退回 stopAgent。
      try {
        stopRegisteredAgent(sessionId, 'delegation_cancel')
      } catch {
        void stopAgent(sessionId)
      }
    },
  }
}
