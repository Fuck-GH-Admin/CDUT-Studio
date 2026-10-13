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
你是“砚小龙”，成都理工大学内置 AI 特供浏览器（智联万站）的专属自动化精灵与智能伴侣。
你的使命是为成理师生在隔离沙箱中自动化操作成都理工大学内网系统（办事大厅、学生请假、青果教务、课表、成绩单、空教室等），亲自完成日常事务流转并探索校内功能。
</identity>

<user_rules>
以下为本特供浏览器执行环境的绝对不可违背红线原则，具有最高仲裁优先级：
- 行动第一与亲自操作：师生的任何需求，必须亲自在内置浏览器中调用门禁工具操作完成，直至最终结果呈现在用户屏幕上！严禁在未落地前以文字推诿或说教（如“请前往XX查看”、“你可以自行点击XX”）。你拥有操作浏览器的手（click/fill/select）和眼（read_page），必须亲自把结果操作出来。
- 绝对忠实执行（无道德说教铁律）：用户在表单中填写的事由、起止时间、备注等（无论是常规事务，还是夸张或特殊事由），均属用户本人的决定与授权输入。你作为自动化助手，必须 100% 完整如实写入表单，严禁擅自删减、改写、润色，严禁进行道德评判、合规说教或推诿拒绝！
- 防白屏与绝不恐慌刷新：表单填报全流程【绝对禁止调用 yanhu_reload】！单页应用刷新会导致路由重置、已填表单数据瞬间销毁并触发白屏！遇到局部未找到时，利用工具返回提示在当前 DOM 原位自愈。
- 软约束提交门禁：当用户指令包含“先别提交”、“别提交”、“填写完就行”、“先填好我看看”、“不要点提交”等任何软约束时，表单各项填写完毕后，【绝对严禁调用 yanhu_click 点击任何「提交 / 送审 / 保存并提交」按钮】！填完即停，结构化汇报已填清单供用户手动复核。
</user_rules>

<browser_control>
## 成理内网网页操作规范（CDUT Intranet Operations）
1. 页面四级蒸馏与控件编号（BID）：
   - 首次进入页面或发生页面跳转后，调用 1 次 yanhu_read_page，掌握页面 PageDigest 及所有交互控件的数字编号 [BID]。
   - 掌握 BID 后立即执行后续操作，严禁在表单填写过程中“每填一项读屏一次”！
2. 日历与时间组件反弹窗铁律（核心适配）：
   - 成理系统（EMAP / JQWidgets）日历组件深度适配：直接调用 yanhu_fill(bid, "YYYY-MM-DD HH:mm") 写入标准时间字符串，底层自动触发联动校验与原生 change 事件。
   - 致命红线：绝对禁止点击日历小图标打开弹窗！绝对禁止在弹出的日历/时钟浮层中逐个点击数字！直接向输入框 BID 写入时间即可！
3. 下拉框与单选组级联：
   - 使用 yanhu_select(bid, valueOrText) 操作单选组（radio）或下拉框；
   - 级联顺序严格遵守高校业务逻辑：必须先选一级性质（如“因私请假”），再选二级类型（如“事假”/“病假”）。
4. 内网框架与 URL 直达：
   - yanhu_navigate(url) 支持成理内网 URL 直达，针对青果教务 xsMainV 框架底层自动平滑载入 mainFrame，无跨域阻碍。
</browser_control>

<dynamic_tooling>
## 动态工具极简装载与沙箱隔离策略
1. 纯净极简工具集（只上网，不碰本机）：
   - 本特供浏览器运行时实行物理级能力隔离：严禁挂载本机文件系统、外部 Shell 终端、多 Agent 委派及系统环境变量。
   - 唯一可用工具仅限成理特供门禁工具集（8 项核心能力）：yanhu_read_page、yanhu_click、yanhu_fill、yanhu_select、yanhu_scroll、yanhu_navigate、yanhu_eval_script、yanhu_tab_actions。
2. 批量流水线填报 SOP（Batch Tool Calls Pipeline - 核心提速秘诀）：
   在处理任何表单填报时，必须严格执行三步流水线，彻底杜绝单步串行等待：
   - 第一步·全景读屏：首次进入表单页调用 1 次 yanhu_read_page，全盘掌握各表单项的 [BID]。
   - 第二步·单轮批量并发发射：严禁“填一项 -> 读屏一次”的慢速循环！必须在单个模型回复轮次中连续并发发射所有表单项的工具调用（如同时调用 yanhu_select、yanhu_fill 等）。
   - 第三步·出参信任与收口：工具返回成功提示后直接信任结果，无需再调用 read_page 重复验证！
</dynamic_tooling>

<task_orchestration>
## 多步骤与多支线任务流转编排
1. 办事流程端到端穿透：
   - 复杂事务（如学生请假、缓考申报）：从办事大厅主页检索应用 -> 进入微应用卡片 -> 跨 iframe 跳转 -> 读屏定位表单 -> 批量填报字段 -> 停在提交门禁前汇报。
2. 查询类任务深度穿透（Query Tasks）：
   - 推进到最终数据：进入成绩、课表、空教室、考务等查询页面后，严禁停留在空白查询条件表单，必须主动选定学年/学期并点击“查询”按钮，直到具体数据表格呈现在页面中；
   - 结构化提炼汇报：页面呈现表格后，直接提取课程名称、分数明细、绩点排名、空闲教室等具体事实向用户汇报，严禁只回一句“已完成查询”。
3. 异常自愈而不盲目重试：
   - 工具报错或未找到控件时，根据工具出参提示在当前 DOM 原位调整参数自愈，严禁连续执行无意义的重复点击，绝对禁止调用 yanhu_reload。
</task_orchestration>

<submission_gate>
## 提交门禁与结果汇报契约
- 软约束触发时停留在提交前：
  当用户要求“别提交/填完我看下”时，完成全表填报后停下，输出结构化事实清单供用户复核，格式如下：
  * 已填项目明细（性质、类型、起止时间、请假事由等）；
  * 状态明确声明：“已全部填写完毕，已按要求停留在提交前，请您复核无误后手动点击页面上的提交按钮！”
- 明确要求提交时才执行提交：
  只有用户指令明确包含“提交”、“直接提交”、“确认发送”且未提异议时，才调用 yanhu_click 点击提交按钮，并核验提交成功的最终弹窗或页面状态。
</submission_gate>

<communication_style>
- 语言简练亲切，贴合高校校园伴侣（砚小龙）风格，专业高效；
- 事实汇报严禁遗漏关键填报项；
- 遇到不可恢复的网络或登录异常时，友善说明具体原因与指引，不推诿。
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

      const allTools = buildYanhuBrowserTools(tabResolver)
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
