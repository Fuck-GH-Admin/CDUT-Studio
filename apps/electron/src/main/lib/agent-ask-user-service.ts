/**
 * Agent AskUserQuestion 交互式问答服务
 *
 * 核心职责：
 * - 拦截 AskUserQuestion 工具调用
 * - 解析问题列表，发送到渲染进程展示交互 UI
 * - 等待用户回答，通过 updatedInput 注入 answers 字段
 * - 管理 pending 请求生命周期
 *
 * 复用权限系统的 Promise + Map 异步等待模式。
 */

import { randomUUID } from 'node:crypto'
import type {
  AskUserRequest,
  AskUserQuestion,
  AskUserQuestionOption,
  AskUserQuestionType,
} from '@profer/shared'

/**
 * 归一化模型下发的题型：显式合法 type 优先；缺省时按选项数量与 multiSelect 优雅降级，
 * 兼容历史会话与非速课堂场景的存量调用。
 */
export function normalizeAskUserQuestionType(
  rawType: unknown,
  optionCount: number,
  multiSelect: boolean,
): AskUserQuestionType {
  if (rawType === 'fill-blank') return 'fill-blank'
  // 选择题没有 options 时无法作答，统一降级为填空，避免下发畸形题。
  if (optionCount === 0) return 'fill-blank'
  if (rawType === 'single' || rawType === 'multiple') return rawType
  return multiSelect ? 'multiple' : 'single'
}

/** canUseTool 返回的权限结果 */
type PermissionResult = {
  behavior: 'allow'
  updatedInput: Record<string, unknown>
} | {
  behavior: 'deny'
  message: string
}

/** 待处理的 AskUser 请求 */
interface PendingAskUser {
  resolve: (result: PermissionResult) => void
  request: AskUserRequest
  /** 原始输入仅留在主进程，用于恢复 SDK 工具调用，不随 renderer request 泄露。 */
  toolInput: Record<string, unknown>
}

/**
 * Agent AskUserQuestion 交互式问答服务
 *
 * 单例模式，管理所有会话的 AskUser 请求。
 */
export class AgentAskUserService {
  /** 待处理的 AskUser 请求 Map（requestId → PendingAskUser） */
  private pendingRequests = new Map<string, PendingAskUser>()
  /**
   * 处理 AskUserQuestion 工具调用
   *
   * 解析问题列表，发送到渲染进程，阻塞等待用户回答，
   * 回答后通过 updatedInput 注入 answers 字段。
   */
  handleAskUserQuestion(
    sessionId: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    sendToRenderer: (request: AskUserRequest) => void,
  ): Promise<PermissionResult> {
    const questions = this.parseQuestions(input)

    // 空题熔断：解析不出任何有效问题时立即结构化拒绝，严禁创建 pending 死等造成会话假死。
    if (questions.length === 0) {
      return Promise.resolve({
        behavior: 'deny' as const,
        message:
          'AskUserQuestion 输入未包含任何有效问题。请修正参数后重试，标准格式为 '
          + '{ questions: [{ question, header, options: [{ label, description }], multiSelect }] }。',
      })
    }

    const requestId = randomUUID()
    const rendererToolInput = { ...input }
    const request: AskUserRequest = {
      requestId,
      sessionId,
      questions,
      toolInput: rendererToolInput,
    }

    return new Promise<PermissionResult>((resolve) => {
      this.pendingRequests.set(request.requestId, { resolve, request, toolInput: input })

      signal.addEventListener('abort', () => {
        if (this.pendingRequests.has(request.requestId)) {
          this.pendingRequests.delete(request.requestId)
          resolve({ behavior: 'deny', message: '操作已中止' })
        }
      }, { once: true })

      // 先登记再通知，避免事件监听方同步提交答案时找不到 pending request。
      sendToRenderer(request)
    })
  }

  /**
   * 响应 AskUser 请求（由 IPC handler 调用）
   *
   * @returns 对应的 sessionId，用于向渲染进程发送 resolved 事件；未找到返回 null
   */
  async respondToAskUser(requestId: string, answers: Record<string, string>): Promise<string | null> {
    const pending = this.pendingRequests.get(requestId)
    if (!pending) return null

    const sessionId = pending.request.sessionId
    this.pendingRequests.delete(requestId)

    // 构建 updatedInput：保留原始输入 + 注入 answers；内部 metadata 不展示给 renderer。
    const updatedInput: Record<string, unknown> = {
      ...pending.toolInput,
      answers,
    }

    pending.resolve({
      behavior: 'allow' as const,
      updatedInput,
    })
    return sessionId
  }

  /**
   * 获取当前所有待处理的 AskUser 请求（用于渲染进程重载后恢复状态）
   */
  getPendingRequests(): AskUserRequest[] {
    return [...this.pendingRequests.values()].map((p) => p.request)
  }

  /**
   * 清除指定会话的所有待处理 AskUser 请求
   */
  clearSessionPending(sessionId: string): void {
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.request.sessionId === sessionId) {
        pending.resolve({ behavior: 'deny', message: '会话已结束' })
        this.pendingRequests.delete(requestId)
      }
    }
  }

  /**
   * 从工具输入中解析问题列表
   *
   * 标准格式：{ questions: [{ question, header, options: [{ label, description, preview }], multiSelect }] }
   * 兼容容错：部分模型会平铺下发单题 { question, header, options, multiSelect }，同样接受。
   */
  private parseQuestions(input: Record<string, unknown>): AskUserQuestion[] {
    let rawQuestions: unknown[]
    if (Array.isArray(input.questions)) {
      rawQuestions = input.questions
    } else if (typeof input.question === 'string') {
      // 平铺单题：将 input 自身视为题目对象，仅提取已知字段。
      rawQuestions = [input]
    } else {
      return []
    }

    return rawQuestions.map((q: unknown) => this.parseSingleQuestion(q))
  }

  /** 解析单个题目对象，字段全部做类型防御，非法值降级为空串/缺省。 */
  private parseSingleQuestion(q: unknown): AskUserQuestion {
    const raw = q as Record<string, unknown>
    const options = Array.isArray(raw.options)
      ? (raw.options as Array<Record<string, unknown>>)
          .map((o): AskUserQuestionOption => ({
            label: typeof o.label === 'string' ? o.label : '',
            description: typeof o.description === 'string' ? o.description : undefined,
            preview: typeof o.preview === 'string' ? o.preview.slice(0, 10_000) : undefined,
          }))
          .filter((o) => o.label.length > 0)
      : []
    const multiSelect = raw.multiSelect === true
    const type = normalizeAskUserQuestionType(raw.type, options.length, multiSelect)

    return {
      question: typeof raw.question === 'string' ? raw.question : '',
      header: typeof raw.header === 'string' ? raw.header : undefined,
      type,
      placeholder: typeof raw.placeholder === 'string' ? raw.placeholder.slice(0, 500) : undefined,
      options: type === 'fill-blank' ? [] : options,
      multiSelect: type === 'multiple',
    }
  }
}

/** 全局 AskUser 服务实例 */
export const askUserService = new AgentAskUserService()
