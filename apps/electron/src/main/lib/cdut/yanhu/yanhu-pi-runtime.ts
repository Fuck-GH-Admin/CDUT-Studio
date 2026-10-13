/**
 * 智联万站 · 「砚小龙」专属阉割版 Pi 运行时（YanhuPiRuntime）
 *
 * 这是一个与通用 Agent 工作区**严格隔离**的纯净执行循环，只具备三件事：
 *   1. Chat：向已配置的模型渠道发起流式对话；
 *   2. Memory：0 ~ 1000 条滑动窗口，原子落盘 `~/.cdutai/yanhu-pet-history.json`；
 *   3. ToolCalling：循环驱动 14 项浏览器专属门禁工具。
 *
 * 边界红线（见规格书 4.1）：严禁挂载文件系统、外部终端、子会话委派与系统级环境变量。
 * 因此本运行时直接复用 `@profer/core` 的供应商适配器 + SSE 读取器这一底层引擎，
 * 而绕开 Pi SDK 的全部文件 / Shell / 多 Agent 特权能力。
 */

import {
  getAdapter,
  streamSSE,
  type ContinuationMessage,
  type ProviderAdapter,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
} from '@profer/core'
import type {
  YanhuPetChatInput,
  YanhuPetConfig,
  YanhuPetMessage,
  YanhuPetMessageUsage,
  YanhuPetStreamEvent,
  YanhuPetToolInvocation,
} from '@profer/shared'
import { getSettings } from '../../settings-service'
import { getChannelById, resolveChannelRuntimeApiKey } from '../../channel-manager'
import { DEFAULT_MODEL_ID } from '../../agent-prompt-utils'
import { getFetchFn } from '../../proxy-fetch'
import { getEffectiveProxyUrl } from '../../proxy-settings-service'
import { buildYanhuBrowserTools, createYanhuToolLabeler, type YanhuBrowserTool } from './yanhu-browser-tools'
import {
  nextYanhuMessageId,
  resolveInjectedHistory,
  toChatMessages,
  YanhuPetMemoryStore,
  getYanhuPetHistoryPath,
} from './yanhu-pet-memory'
import { pruneYanhuContinuationMessages, slimYanhuToolResultForHistory } from './yanhu-context-pruning'

/** 单次对话工具循环最大轮次（防止失控） */
const MAX_TOOL_ITERATIONS = 500

/** CJK 字符与全角符号匹配（用于 Token 估算） */
const CJK_CHAR_PATTERN = /[\u3000-\u9fff\uff00-\uffef]/g

/**
 * 粗略估算文本 Token 数。
 *
 * 供应商适配器当前未回传真实 usage，故按主流分词经验估算：
 * CJK 字符约 1 字符 ≈ 1 Token，非 CJK 字符约 4 字符 ≈ 1 Token。
 */
export function estimateYanhuTokens(text: string): number {
  if (!text) return 0
  const cjk = text.match(CJK_CHAR_PATTERN)?.length ?? 0
  const other = Math.max(0, text.length - cjk)
  return cjk + Math.ceil(other / 4)
}

/** 流式事件发射器 */
export type YanhuRuntimeEmit = (event: YanhuPetStreamEvent) => void

/** 单轮 Token 软阈值（超过时打印告警，便于观测 ≤10k 硬目标） */
export const YANHU_TOKEN_WARN_THRESHOLD = 10_000

/**
 * 砚小龙高可用专属系统提示词（完全重构版）
 *
 * 核心架构：
 * 1. 角色使命与 Action-First 绝对执行铁律（100% 忠实用户意图，绝对禁止道德说教与推诿）；
 * 2. 门禁工具箱速查字典（与底层实现强绑定，明确每个工具的专长与误用红线）；
 * 3. 表单极速流水线填报 SOP（Batch Tool Calls 提速秘诀，整表填报 1~2 轮压缩）；

 * 5. 提交门禁与软约束遵守（“别提交 / 填写完就行”填完即停，汇报已填清单，严禁点击提交）；
 * 6. 自愈与防恐慌刷新铁律（表单填报全流程绝对禁止调用 yanhu_reload）。
 */
const YANHU_PET_SYSTEM_PROMPT = `<identity>
You are "砚小龙", the automated browser navigator and companion embedded in CDUT Studio for the intranet environment (智联万站) at 成都理工大学.
Your mission is to execute web operations on internal university systems (办事大厅, 学生请假, 青果教务, 课表, 成绩单, 空教室, etc.) directly within the isolated sandbox to fulfill academic and administrative workflows.
</identity>

<language_convention>
Generate final responses in the same language used by the user in the ongoing conversation. Default to English when the user language is ambiguous or unspecified.
</language_convention>

<execution_principles>
- Action-First Execution: Complete tasks by directly invoking browser gate tools in the embedded browser until tangible results appear on screen. Deliver verified results in place.
- Faithful Input Recording: Record all user-specified details (purposes, date ranges, notes, and remarks) directly into form fields as authentic, authorized inputs without unilateral alteration.
- Single-Page Application Continuity: Preserve active router and form state during complex workflows by diagnosing and resolving field values within the active DOM.
- Pre-Submission Review: Maintain the form state at the completed pre-submission stage and present a structured summary of entered data for student verification. Execute final submission upon explicit user confirmation.
</execution_principles>

<browser_control>
## CDUT Intranet Operations
1. Four-Tier DOM Distillation & BIDs:
   - Call \`yanhu_read_page\` upon initial page navigation or route change to obtain the compact PageDigest and numeric element identifiers [BID].
   - Proceed directly with operations using identified BIDs.
2. Visual Screenshot Recognition & Dual-Plane Anchors:
   - When visual geometry, custom Canvas graphics, CAPTCHAs, or heavily occluded layouts require optical inspection, call \`yanhu_capture_visual\`.
   - The vision engine provides visual landmarks and a homography matrix H mapping visual normalized coordinates [u, v] in [0, 1000]^2 to physical DIP coordinates. Invoke \`yanhu_click_visual(u, v)\` to dispatch clicks with automatic DOM magnetic snapping.
3. Form Calendar & Datetime Integration:
   - Assign standardized datetime strings ("YYYY-MM-DD HH:mm") directly to target input fields using \`yanhu_fill(bid, value)\` to trigger native change events in EMAP and JQWidgets.
4. Cascading Select & Radio Controls:
   - Use \`yanhu_select(bid, valueOrText)\` in hierarchical order: select primary categories (e.g. "因私请假") prior to secondary subcategories (e.g. "事假").
5. Intranet Routing & Frame Navigation:
   - Navigate directly to target URLs via \`yanhu_navigate(url)\`. In 青果教务 frameworks (xsMainV), the system smoothly loads mainFrame content while preserving navigation chrome.
</browser_control>

<dynamic_tooling>
## Core Gate Toolset (10 Core Capabilities)
1. Active Tools:
   - \`yanhu_read_page\`: Inspects distilled DOM and returns BID assignments.
   - \`yanhu_capture_visual\`: Captures viewport screenshot and computes dual-plane parallel coordinate anchors for visual recognition.
   - \`yanhu_click_visual\`: Dispatches physical click to visual coordinates [u, v] in [0, 1000]^2 with DOM magnetic snapping.
   - \`yanhu_click\`: Dispatches hardware-grade CDP mouse click or native click to [BID].
   - \`yanhu_fill\`: Fills text inputs, textareas, or contenteditable fields with event cascades.
   - \`yanhu_select\`: Selects options in native selects, custom dropdowns, or radio groups.
   - \`yanhu_scroll\`: Scrolls viewport in specified directions.
   - \`yanhu_navigate\`: Navigates to target intranet URLs with frame handling.
   - \`yanhu_eval_script\`: Evaluates isolated JavaScript in page context when programmatic inspection is required.
   - \`yanhu_tab_actions\`: Manages tab creation, switching, and inspection.
2. Batch Pipeline Processing:
   - Pipeline form inputs concurrently within a single assistant turn using batch tool calls after acquiring BIDs.
</dynamic_tooling>

<task_orchestration>
## Workflow Execution & Reporting
1. Administrative Workflows:
   - Traverse end-to-end steps: search in 办事大厅 -> open micro-app -> handle iframes -> batch fill fields -> summarize at pre-submission gate.
2. Query Workflows:
   - Drive queries to their final data tables (grades, class schedules, empty classrooms), extract structured facts, and present clear tabular findings to the user.
3. Self-Healing:
   - Adjust locator parameters in place within the current DOM based on tool diagnostic feedback.
</task_orchestration>

<submission_gate>
## Submission Gate & Verification Reporting
- Pre-Submission Gate:
  When the user requests verification prior to submission ("先别提交", "填完我看下", etc.), pause after completing all form entries and present a structured summary of entered parameters for review:
  * Entered item summary (category, subcategory, start/end time, leave reason, remarks);
  * Clear status confirmation: "All form fields have been populated. The workflow is paused before final submission as requested. Please review the details and submit manually."
- Final Submission Confirmation:
  Invoke \`yanhu_click\` on the submission button upon explicit confirmation ("提交", "直接提交", "确认发送"), and verify the final confirmation modal or state.
</submission_gate>

<communication_style>
- Maintain a concise, supportive campus companion tone (砚小龙).
- Present structured facts clearly with complete verification details.
- Provide clear explanations and next steps during network or authentication exceptions.
</communication_style>`

/** 解析后的目标渠道 */
interface ResolvedChannel {
  channelId: string
  modelId: string
  baseUrl: string
  apiKey: string
  adapter: ProviderAdapter
}

/**
 * 「砚小龙」专属运行时单例。
 */
export class YanhuPiRuntime {
  private readonly store: YanhuPetMemoryStore
  private activeController: AbortController | null = null
  private activeRequestId: string | null = null

  constructor(filePath: string = getYanhuPetHistoryPath()) {
    this.store = new YanhuPetMemoryStore(filePath)
  }

  /** 读取配置 */
  public getConfig(): YanhuPetConfig {
    return this.store.getConfig()
  }

  /** 保存配置（浅合并） */
  public saveConfig(patch: Partial<YanhuPetConfig>): YanhuPetConfig {
    return this.store.saveConfig(patch)
  }

  /** 读取全部历史消息 */
  public getHistory(): YanhuPetMessage[] {
    return this.store.getMessages()
  }

  /** 清空当前对话记忆 */
  public clearHistory(): void {
    this.store.clear()
  }

  /** 是否正在生成 */
  public isBusy(): boolean {
    return this.activeRequestId !== null
  }

  /** 中止当前对话 */
  public abort(): void {
    if (this.activeController) this.activeController.abort()
  }

  /** 解析目标渠道（未配置专属渠道时无缝继承全局默认激活渠道） */
  private resolveChannel(): ResolvedChannel {
    const settings = getSettings()
    const channelId = this.store.getConfig().selectedChannelId || settings.agentChannelId
    if (!channelId) {
      throw new Error('尚未配置模型渠道：请在设置页「模型配置」中配置智联万站专属模型或全局默认渠道。')
    }
    const channel = getChannelById(channelId)
    if (!channel) {
      throw new Error(`渠道 ${channelId} 不存在或已被删除，请重新配置智联万站专属模型。`)
    }
    const config = this.store.getConfig()
    const modelId =
      config.selectedModelId ||
      settings.agentModelId ||
      channel.models.find((model) => model.enabled)?.id ||
      DEFAULT_MODEL_ID
    return { channelId, modelId, baseUrl: channel.baseUrl, apiKey: '', adapter: getAdapter(channel.provider) }
  }

  /**
   * 发起一次对话（含工具循环）。
   *
   * @param input 用户提问
   * @param tabResolver 目标标签解析器
   * @param emit 流式事件发射器（主进程 -> 桌宠子窗口）
   */
  public async send(
    input: YanhuPetChatInput,
    tabResolver: () => string,
    emit: YanhuRuntimeEmit,
  ): Promise<void> {
    const text = (input.text ?? '').trim()
    if (!text) return
    if (this.activeRequestId) {
      throw new Error('砚小龙正在处理上一条指令，请稍候或先中止。')
    }

    const requestId = `yanhu-req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    this.activeRequestId = requestId
    this.activeController = new AbortController()
    const signal = this.activeController.signal
    /** 本轮对话起始时间（用于耗时统计） */
    const startTime = Date.now()

    // 用户消息入历史
    const userMessage: YanhuPetMessage = {
      id: nextYanhuMessageId(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    }
    this.store.appendMessages([userMessage])

    let content = ''
    const invocations: YanhuPetToolInvocation[] = []
    let continuationMessages: ContinuationMessage[] = []
    /** 本轮累计输入 Token（含系统提示词、历史与工具结果） */
    let inputTokens = 0
    /** 本轮累计输出 Token（正文与思考） */
    let outputTokens = 0
    /** 本轮累计缓存读取 / 写入 Token（真实 usage 提供时） */
    let cacheReadTokens = 0
    let cacheCreationTokens = 0

    try {
      const resolved = this.resolveChannel()
      resolved.apiKey = await resolveChannelRuntimeApiKey(resolved.channelId)

      const allTools = buildYanhuBrowserTools(tabResolver, {
        // 视觉截图辅助感知：仅当用户显式开启 enableVision 时向模型挂载视觉工具并启用隐式兜底
        enableVision: this.store.getConfig().enableVision === true,
      })
      // 开发者级工具默认不向大模型暴露（节省工具定义 Token 并规避大输出），
      // 仅当用户经隐藏指令持久化开启 devToolsEnabled 后才挂载。
      const tools = this.store.getConfig().devToolsEnabled
        ? allTools
        : allTools.filter((tool) => !tool.developer)
      const labelOf = createYanhuToolLabeler(tools)
      const toolDefinitions: ToolDefinition[] = tools.map((tool) => tool.definition)
      const toolIndex = new Map<string, YanhuBrowserTool>(tools.map((tool) => [tool.definition.name, tool]))

      const injected = resolveInjectedHistory(
        this.store.getMessages().filter((m) => m.id !== userMessage.id),
        this.store.getConfig().memoryLimit,
      )
      const history = toChatMessages(injected)

      const proxyUrl = await getEffectiveProxyUrl()
      const fetchFn = getFetchFn(proxyUrl)

      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
        if (signal.aborted) break
        // 上下文剪枝：压缩「最后 keepSteps 步之前」的旧工具结果，阻断多步循环 O(N²) 膨胀
        const prunedContinuation = pruneYanhuContinuationMessages(continuationMessages)
        const request = resolved.adapter.buildStreamRequest({
          baseUrl: resolved.baseUrl,
          apiKey: resolved.apiKey,
          modelId: resolved.modelId,
          history,
          userMessage: text,
          systemMessage: YANHU_PET_SYSTEM_PROMPT,
          readImageAttachments: () => [],
          thinkingEnabled: false,
          tools: toolDefinitions,
          continuationMessages: prunedContinuation,
        })

        const result = await streamSSE({
          request,
          adapter: resolved.adapter,
          fetchFn,
          signal,
          onEvent: (event) => {
            if (event.type === 'chunk') {
              emit({ requestId, type: 'delta', delta: event.delta })
            } else if (event.type === 'reasoning') {
              emit({ requestId, type: 'reasoning', reasoning: event.delta })
            }
          },
        })

        content = result.content || content

        // Token 计量：优先供应商回传的真实 usage，缺失时回退启发式估算
        const real = result.usage
        const stepInput = real?.inputTokens != null ? real.inputTokens : estimateYanhuTokens(request.body)
        const stepOutput =
          real?.outputTokens != null
            ? real.outputTokens
            : estimateYanhuTokens(result.content) + estimateYanhuTokens(result.reasoning)
        inputTokens += stepInput
        outputTokens += stepOutput
        if (real?.cacheReadTokens != null) cacheReadTokens += real.cacheReadTokens
        if (real?.cacheWriteTokens != null) cacheCreationTokens += real.cacheWriteTokens

        const runningTotal = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens
        console.log(
          `[yanhu:token] step=${iteration + 1} in=${stepInput} out=${stepOutput} real=${real ? 'yes' : 'estimate'} total=${runningTotal}`,
        )
        if (runningTotal > YANHU_TOKEN_WARN_THRESHOLD) {
          console.warn(`[yanhu:token] 单轮累计 Token 已超 ${YANHU_TOKEN_WARN_THRESHOLD} 阈值：${runningTotal}`)
        }

        if (!result.toolCalls || result.toolCalls.length === 0) break

        // 执行工具并组装续接消息
        const results: ToolResult[] = []
        for (const call of result.toolCalls) {
          const invocation = await this.executeTool(call, toolIndex, labelOf, emit, requestId)
          invocations.push(invocation)
          results.push({
            toolCallId: call.id,
            content:
              typeof invocation.result === 'string' ? invocation.result : JSON.stringify(invocation.result ?? ''),
            isError: invocation.status === 'error',
          })
        }

        continuationMessages = [
          ...continuationMessages,
          {
            role: 'assistant',
            content: result.content,
            reasoning: result.reasoning,
            thinkingBlocks: result.thinkingBlocks,
            toolCalls: result.toolCalls,
          },
          { role: 'tool', results },
        ]
      }

      // 汇总本轮用量（耗时 + Token），随助手消息持久化并广播
      const usage: YanhuPetMessageUsage = {
        inputTokens,
        outputTokens,
        cacheReadTokens: cacheReadTokens > 0 ? cacheReadTokens : undefined,
        cacheCreationTokens: cacheCreationTokens > 0 ? cacheCreationTokens : undefined,
        totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
        durationMs: Date.now() - startTime,
      }

      // 助手消息入历史：中间步骤的巨型 PageDigest / 日志先脱敏瘦身为单行摘要再落盘，
      // 避免下一轮加载历史时前几轮上下文继续以数万 Token 规模重复注入。
      const slimmedInvocations = invocations.map((invocation) => ({
        ...invocation,
        result: slimYanhuToolResultForHistory(invocation.toolName, invocation.result),
      }))
      const assistantMessage: YanhuPetMessage = {
        id: nextYanhuMessageId(),
        role: 'assistant',
        content: content || '（砚小龙已完成操作）',
        timestamp: Date.now(),
        toolInvocations: slimmedInvocations.length > 0 ? slimmedInvocations : undefined,
        usage,
      }
      this.store.appendMessages([assistantMessage])
      emit({ requestId, type: 'done', usage })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const aborted = signal.aborted
      console.error(`[yanhu:runtime:error] requestId=${requestId} aborted=${aborted} error=`, err)

      // 无论何种异常或中断，必须为当前用户消息生成对应的助手消息持久化落盘，绝对不留孤儿消息
      const errUsage: YanhuPetMessageUsage = {
        inputTokens,
        outputTokens,
        cacheReadTokens: cacheReadTokens > 0 ? cacheReadTokens : undefined,
        cacheCreationTokens: cacheCreationTokens > 0 ? cacheCreationTokens : undefined,
        totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
        durationMs: Date.now() - startTime,
      }
      const slimmedInvocations = invocations.map((invocation) => ({
        ...invocation,
        result: slimYanhuToolResultForHistory(invocation.toolName, invocation.result),
      }))

      let fallbackText = ''
      if (aborted) {
        fallbackText = content ? `${content}\n\n（操作已由用户手动中止）` : '（操作已由用户手动中止）'
      } else {
        fallbackText = content
          ? `${content}\n\n（操作遇到异常中断：${message}）`
          : `（砚小龙执行操作遇到异常：${message}）`
      }

      const errorAssistantMessage: YanhuPetMessage = {
        id: nextYanhuMessageId(),
        role: 'assistant',
        content: fallbackText,
        timestamp: Date.now(),
        toolInvocations: slimmedInvocations.length > 0 ? slimmedInvocations : undefined,
        usage: errUsage,
      }
      this.store.appendMessages([errorAssistantMessage])

      emit({ requestId, type: aborted ? 'done' : 'error', error: aborted ? undefined : message, usage: errUsage })
    } finally {
      this.activeController = null
      this.activeRequestId = null
    }
  }

  /** 执行单个工具调用并广播微胶囊事件 */
  private async executeTool(
    call: ToolCall,
    toolIndex: Map<string, YanhuBrowserTool>,
    labelOf: (toolName: string, args: Record<string, unknown>) => string,
    emit: YanhuRuntimeEmit,
    requestId: string,
  ): Promise<YanhuPetToolInvocation> {
    const label = labelOf(call.name, call.arguments)
    const invocation: YanhuPetToolInvocation = {
      id: call.id,
      toolName: call.name,
      label,
      args: call.arguments,
      status: 'running',
    }
    emit({ requestId, type: 'tool-start', tool: { ...invocation } })

    const tool = toolIndex.get(call.name)
    if (!tool) {
      invocation.status = 'error'
      invocation.result = `未知工具：${call.name}`
      emit({ requestId, type: 'tool-end', tool: { ...invocation } })
      return invocation
    }

    try {
      const outcome = await tool.execute(call.arguments ?? {})
      invocation.status = outcome.isError ? 'error' : 'success'
      invocation.result = outcome.content
    } catch (err) {
      invocation.status = 'error'
      invocation.result = err instanceof Error ? err.message : String(err)
    }
    emit({ requestId, type: 'tool-end', tool: { ...invocation } })
    return invocation
  }
}

/** 全局单例 */
export const yanhuPiRuntime = new YanhuPiRuntime()
