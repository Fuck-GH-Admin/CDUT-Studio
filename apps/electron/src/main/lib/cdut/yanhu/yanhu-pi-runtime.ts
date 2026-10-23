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
  buildYanhuPetSystemPrompt,
  YANHU_PET_SYSTEM_PROMPT,
} from './yanhu-pet-prompt'
import {
  nextYanhuMessageId,
  resolveInjectedHistory,
  toChatMessages,
  YanhuPetMemoryStore,
  getYanhuPetHistoryPath,
} from './yanhu-pet-memory'
import { pruneYanhuContinuationMessages, slimYanhuToolResultForHistory } from './yanhu-context-pruning'
import { appendYanhuThinkingRecord, buildYanhuThinkingRecord } from './yanhu-thinking-log'

/** 单次对话工具循环最大轮次（防止失控） */
const MAX_TOOL_ITERATIONS = 500

/**
 * 可安全并行派发的工具白名单。
 *
 * 仅收录「页面内局部读写、不改变页面拓扑、不共享因果基线」的工具：表单写入与只读诊断之间
 * 没有先后依赖，并行派发可把 N 次「本地写入 + 稳态收口」压成一次收口耗时。
 * `yanhu_click` / `yanhu_navigate` / `yanhu_tab_actions` / `yanhu_read_page` 一律串行——
 * 它们要么共享混合分派器的因果基线，要么会改变页面拓扑与后续工具的定位前提。
 */
const YANHU_PARALLEL_SAFE_TOOLS = new Set([
  'yanhu_fill',
  'yanhu_select',
  'yanhu_scroll',
  'yanhu_inspect_element',
  'yanhu_get_network_logs',
  'yanhu_get_console_logs',
])

/** 判定同轮工具调用是否可以并行派发（单个调用无需并行，退化为串行路径） */
function canRunInParallel(calls: readonly ToolCall[]): boolean {
  return calls.length > 1 && calls.every((call) => YANHU_PARALLEL_SAFE_TOOLS.has(call.name))
}

/** 把工具执行结果归一为续接消息所需的 ToolResult（串行 / 并行两条路径共用，避免口径分裂） */
function toToolResult(call: ToolCall, invocation: YanhuPetToolInvocation): ToolResult {
  return {
    toolCallId: call.id,
    content: typeof invocation.result === 'string' ? invocation.result : JSON.stringify(invocation.result ?? ''),
    isError: invocation.status === 'error',
  }
}

/**
 * 用户中止时为未执行的 toolCall 补齐占位回执。
 *
 * 保证 assistant.toolCalls 与 tool.results 一一配对；缺少配对会让下一轮请求
 * 被模型网关判为协议错误（tool_use_id without matching tool_result）。
 */
export function padAbortedToolResults(
  calls: readonly ToolCall[],
  results: ToolResult[],
): ToolResult[] {
  if (results.length >= calls.length) return results
  const padded = [...results]
  for (let index = padded.length; index < calls.length; index += 1) {
    padded.push({
      toolCallId: calls[index]!.id,
      content: '（操作已由用户手动中止，未执行）',
      isError: true,
    })
  }
  return padded
}

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

// 系统提示词（基础人设 + 条件化能力指引 + 实际挂载工具清单）已收敛至 ./yanhu-pet-prompt，
// 由纯函数统一装配，保证「提示词中出现的工具名 ⊆ 实际挂载工具」这一不变式可被单测守卫。

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
    /**
     * 本轮思考链（跨步累积）。
     *
     * 供应商只在流式过程中回传思考增量，一旦本轮结束就再无来源；因此这里逐步累积，
     * 在落盘助手消息的同时把完整思考链追加写入 `~/.cdutai/yanhu-thinking.jsonl`，
     * 使「模型为什么这么做」成为可离线复查的一等记录。
     */
    const reasoningParts: string[] = []
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

      // 系统提示词在整轮多步循环中恒定不变：移到循环外装配一次，避免每步重复拼装与重复估算
      const systemMessage = buildYanhuPetSystemPrompt(YANHU_PET_SYSTEM_PROMPT, tools)
      console.log(
        `[yanhu:context] system=${estimateYanhuTokens(systemMessage)} tools=${estimateYanhuTokens(
          JSON.stringify(toolDefinitions),
        )} history=${estimateYanhuTokens(JSON.stringify(history))}`,
      )

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
          // 系统提示词的工具清单由「实际挂载的 tools」动态生成，杜绝提示词与工具清单脱节
          systemMessage,
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
        if (result.reasoning) reasoningParts.push(result.reasoning)

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
          `[yanhu:token] step=${iteration + 1} in=${stepInput} out=${stepOutput} ctx=${estimateYanhuTokens(
            JSON.stringify(prunedContinuation),
          )} real=${real ? 'yes' : 'estimate'} total=${runningTotal}`,
        )
        if (runningTotal > YANHU_TOKEN_WARN_THRESHOLD) {
          console.warn(`[yanhu:token] 单轮累计 Token 已超 ${YANHU_TOKEN_WARN_THRESHOLD} 阈值：${runningTotal}`)
        }

        if (!result.toolCalls || result.toolCalls.length === 0) break

        // 中止必须「立刻生效」，而不是等到整批工具跑完。
        //
        // 历史缺陷：`signal.aborted` 只在循环顶层检查一次，工具阶段完全不看信号。而每个工具
        // 都带「稳态收口观察窗」（300~1500ms，多工具时更长），于是用户点了中止之后，整批工具
        // 仍会逐个跑完才停 —— 体感就是「点了没反应 / 死活停不下来」。
        // 这里在工具批次开始前与每个工具之间各查一次，命中即把已产生的部分结果照常收口。
        if (signal.aborted) break

        // 执行工具并组装续接消息
        const calls = result.toolCalls
        let results: ToolResult[]
        if (canRunInParallel(calls)) {
          // 同轮批量并行：模型按提示词一次性下发多个表单写入时，把 N 次「本地写入 + 稳态收口」
          // 压缩到一次收口耗时内（此前串行 await，3 个字段就要 3 倍观察窗，是后段明显变慢的来源之一）。
          const settled = await Promise.all(
            calls.map(async (call) => {
              const invocation = await this.executeTool(call, toolIndex, labelOf, emit, requestId)
              return { invocation, toolResult: toToolResult(call, invocation) }
            }),
          )
          invocations.push(...settled.map((item) => item.invocation))
          results = settled.map((item) => item.toolResult)
        } else {
          results = []
          for (const call of calls) {
            // 逐个工具之间同样查一次中止：串行批次不该把整批跑完才停
            if (signal.aborted) break
            const invocation = await this.executeTool(call, toolIndex, labelOf, emit, requestId)
            invocations.push(invocation)
            results.push(toToolResult(call, invocation))
          }
        }

        // 中止命中：未执行的工具必须补齐占位回执，保持 toolCalls / results 严格配对
        if (signal.aborted) results = padAbortedToolResults(calls, results)

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
        result: slimYanhuToolResultForHistory(invocation.toolName, invocation.result, invocation.status === 'error'),
      }))
      // 用户手动中止时走的是「循环顶层 break」而非异常路径，这里必须同样如实标注，
      // 否则中止会被渲染成一次正常完成，用户根本看不出自己已经停下来了。
      const abortedLate = signal.aborted
      const assistantMessage: YanhuPetMessage = {
        id: nextYanhuMessageId(),
        role: 'assistant',
        content: content
          ? `${content}${abortedLate ? '\n\n（操作已由用户手动中止）' : ''}`
          : abortedLate
            ? '（操作已由用户手动中止）'
            : '（砚小龙已完成操作）',
        timestamp: Date.now(),
        toolInvocations: slimmedInvocations.length > 0 ? slimmedInvocations : undefined,
        usage,
      }
      this.store.appendMessages([assistantMessage])
      // 思考链异步追加落盘：不阻塞主线程，也绝不因写盘失败影响对话结果
      void appendYanhuThinkingRecord(
        buildYanhuThinkingRecord({
          messageId: assistantMessage.id,
          userText: text,
          reasoning: abortedLate
            ? `${reasoningParts.join('\n\n')}\n\n[本轮由用户手动中止]`
            : reasoningParts.join('\n\n'),
          tools: slimmedInvocations,
        }),
      )
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
        result: slimYanhuToolResultForHistory(invocation.toolName, invocation.result, invocation.status === 'error'),
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
      // 异常 / 手动中止同样是排查重点：把已产生的思考链与工具时间线一并落盘（含中止原因）
      void appendYanhuThinkingRecord(
        buildYanhuThinkingRecord({
          messageId: errorAssistantMessage.id,
          userText: text,
          reasoning: aborted
            ? `${reasoningParts.join('\n\n')}\n\n[本轮由用户手动中止]`
            : `${reasoningParts.join('\n\n')}\n\n[本轮异常中断：${message}]`,
          tools: slimmedInvocations,
        }),
      )

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
      // 可自愈的报错：直接回传当前可用工具清单，模型下一轮即可改用正确工具，
      // 不再只抛一句无从下手的「未知工具」（历史问题：提示词宣传了未挂载的开发者级工具）
      const available = [...toolIndex.keys()].join(', ')
      invocation.status = 'error'
      invocation.result =
        `未知工具：${call.name}。该工具当前未挂载（开发者级 / 视觉类工具默认关闭）。` +
        `当前可用工具：${available}。请改用上述可用工具重试。`
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
