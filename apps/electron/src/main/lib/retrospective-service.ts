/**
 * retrospective-service.ts — 回溯放弃抽取服务（主进程）
 *
 * 通读会话 JSONL 的增量轮次，用一次性 LLM 调用抽取「显式放弃的探索方向」，
 * 高置信且能挂到现有任务节点的，写成 task_abandon_annotated 事件进图（枯死支线）；
 * 挂不上真实节点的，降级为文字注记返回，不硬造节点。
 *
 * 设计（对齐 workspace-files/.context/plan/task-panel-exploration-provenance.md）：
 * - 只抓显式放弃信号（Plan B，Precision 0.85-0.90），前置离线 eval 已验证。
 * - 增量水位 lastAnalyzedTurn，只烧新增轮次；带 OVERLAP 回看窗口缓解跨批次割裂。
 * - 一次性 LLM 调用复用 generateTitle 的渠道/鉴权/适配器链（buildTitleRequest 拿 url+鉴权头，
 *   改写 body 提高 max_tokens + JSON 模式），deepseek 走 /chat/completions。
 */

import type { SDKMessage, SDKAssistantMessage, SDKUserMessage, ProviderType } from '@profer/shared'
import { groupIntoTurns, extractUserText, summarizeToolInput } from '@profer/session-core'
import { getAdapter } from '@profer/core'
import type { TaskGraph, TaskNode, GraphEvent, RetrospectiveResult, UnmappedAbandonment } from '@profer/project-core'
import { listChannels, decryptApiKey, isCommercialMode } from './channel-manager'
import { getTeamAuthWithRefresh } from './auth-service'
import { getFetchFn } from './proxy-fetch'
import { getEffectiveProxyUrl } from './proxy-settings-service'
import { isCommercialBuild } from './build-target'
import { isOfficialManagedChannel } from './official-channel'
import { getSettings } from './settings-service'
import { getAgentSessionSDKMessages, getAgentSessionMeta, updateAgentSessionMeta } from './agent-session-manager'
import { loadGraph, appendGraphEvent } from './project-graph-service'

// ===== 常量 =====

/** 只落地置信度 ≥ 此阈值的放弃（宁可漏，不可错） */
const CONFIDENCE_THRESHOLD = 0.7
/** 增量回看窗口：从 lastAnalyzedTurn - OVERLAP 开始重新看，缓解跨批次方向割裂 */
const OVERLAP = 10
/** 单次分析 transcript 字符上限（超出截取最近轮次，避免撑爆上下文） */
const MAX_TRANSCRIPT_CHARS = 50_000
const ASSISTANT_CAP = 2600
const USER_CAP = 2000
/** 一次性调用给足 token（deepseek-v4-pro 等推理模型 reasoning 单独计） */
const MAX_TOKENS = 8000

/** 走 Anthropic 协议 proxy 的供应商（代管模式用 /v1/proxy/messages，其余 /v1/proxy/chat） */
const ANTHROPIC_PROXY_PROVIDERS = new Set<ProviderType>([
  'anthropic', 'anthropic-compatible', 'kimi-api', 'kimi-coding',
  'minimax', 'xiaomi', 'xiaomi-token-plan', 'zhipu-coding',
])

// ===== 类型 =====

interface RenderedTurn {
  idx: number
  role: 'user' | 'assistant'
  text: string
}

/** LLM 抽取出的单条放弃（原始，未校验） */
interface RawAbandonment {
  direction?: string
  reason?: string
  reasonCategory?: string
  reasonVerbatim?: string
  evidenceTurns?: unknown
  switchedTo?: string | null
  mappedTaskId?: string | null
  confidence?: number
}

// UnmappedAbandonment / RetrospectiveResult 定义在 @profer/project-core（供 preload/渲染层共用）

// ===== Turn 渲染（对齐 session-core/groupIntoTurns，只留自然语言文本） =====

function stripThink(s: string): string {
  return s.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim()
}

/** 每个助手轮最多展示的工具摘要条数（超出折叠计数），防止单轮撑爆 */
const MAX_TOOLS_PER_TURN = 14

/**
 * 渲染一个助手轮为「自然语言 + 执行痕迹」。
 *
 * 关键升级（B）：不再只留文本、把工具调用当空气——探索逻辑恰恰活在工具活动里。
 * 这里把 tool_use 用 summarizeToolInput 压成一行行「做了什么」，并扫 tool_result(is_error)
 * 标出「哪步报错」，让模型能判断「试了 X→失败→换 Y」的真放弃 vs 同方向迭代。
 */
function assistantText(turn: { assistantMessages: SDKAssistantMessage[]; turnMessages?: SDKMessage[] }): string {
  const textParts: string[] = []
  const toolLines: string[] = []
  for (const a of turn.assistantMessages) {
    const content = a.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const b = block as { type?: string; text?: string; name?: string; input?: unknown }
      if (b.type === 'text' && typeof b.text === 'string') {
        textParts.push(b.text)
      } else if (b.type === 'tool_use' && typeof b.name === 'string') {
        toolLines.push('· ' + summarizeToolInput(b.name, b.input))
      }
    }
  }
  // 扫本轮的 tool_result(is_error)，把「哪步报错」作为强信号带上
  let errorCount = 0
  for (const m of turn.turnMessages ?? []) {
    if (m.type !== 'user') continue
    const content = (m as SDKUserMessage).message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const b = block as { type?: string; is_error?: boolean }
      if (b.type === 'tool_result' && b.is_error) errorCount++
    }
  }
  const shownTools =
    toolLines.length > MAX_TOOLS_PER_TURN
      ? [...toolLines.slice(0, MAX_TOOLS_PER_TURN), `· …and ${toolLines.length - MAX_TOOLS_PER_TURN} more tool calls`]
      : toolLines
  const segments: string[] = []
  const text = stripThink(textParts.join('\n')).trim()
  if (text) segments.push(text)
  if (shownTools.length) segments.push('[Execution]\n' + shownTools.join('\n'))
  if (errorCount > 0) segments.push(`[${errorCount} tool error(s) this turn]`)
  return segments.join('\n')
}

/** 把 SDKMessage 列表切成带 1-based 编号的 user/assistant 轮次（system 组不计入，与 Phase 1 eval 一致） */
function renderTurns(messages: SDKMessage[]): RenderedTurn[] {
  const groups = groupIntoTurns(messages)
  const turns: RenderedTurn[] = []
  for (const g of groups) {
    if (g.type === 'user') {
      turns.push({ idx: 0, role: 'user', text: extractUserText(g.message as SDKUserMessage) ?? '' })
    } else if (g.type === 'assistant-turn') {
      turns.push({ idx: 0, role: 'assistant', text: assistantText(g) })
    }
    // system 组跳过
  }
  return turns.map((t, i) => ({ ...t, idx: i + 1 }))
}

/** 渲染分析窗口为紧凑编号转录；超上限时保留最近轮次并记录丢弃 */
function renderTranscript(turns: RenderedTurn[]): string {
  const render = (t: RenderedTurn): string => {
    const cap = t.role === 'user' ? USER_CAP : ASSISTANT_CAP
    let body = t.text
    if (!body && t.role === 'assistant') body = '(tool calls only, no text)'
    if (body.length > cap) body = body.slice(0, cap) + ' …[truncated]'
    return `[Turn ${t.idx}] ${t.role === 'user' ? 'user' : 'assistant'}: ${body}`
  }
  let picked = turns
  let text = picked.map(render).join('\n\n')
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    // 从尾部保留最近轮次直到不超上限
    const kept: RenderedTurn[] = []
    let size = 0
    for (let i = turns.length - 1; i >= 0; i--) {
      const line = render(turns[i]!)
      if (size + line.length > MAX_TRANSCRIPT_CHARS) break
      kept.unshift(turns[i]!)
      size += line.length + 2
    }
    const dropped = turns.length - kept.length
    console.warn(`[回溯] transcript 超 ${MAX_TRANSCRIPT_CHARS} 字符，丢弃最早 ${dropped} 轮，仅分析最近 ${kept.length} 轮`)
    picked = kept
    text = picked.map(render).join('\n\n')
  }
  return text
}

// ===== Prompt =====

const SYSTEM_PROMPT = `You are a rigorous conversation analyzer that extracts **explicitly abandoned exploration directions** from human ↔ AI agent work session transcripts and maps them onto existing task nodes. You serve a research/engineering exploration provenance tool that only annotates **verifiably trustworthy** abandoned branches on the graph; therefore the top priority is **high precision (prefer missing one over a false positive)**.

[Capture only "explicit abandonment" — hard constraint]
Only count cases where the conversation contains **explicitly spoken abandonment language**, e.g., "this approach won't work", "let's try a different idea / do X instead", "abandon X", "X is not suitable", "stop using X", "forget X", "start over", "reject A/B/C", "revert it". Anything without explicit wording must not be extracted.

[Never misjudge "iteration" as "abandonment" — the most common and severe error]
After saying "still wrong / not quite working", if the assistant **continues tuning parameters, changing config, fixing bugs, or re-running with the same approach**, that is **iteration within the same direction, not abandonment**—extraction is forbidden. Abandonment counts only when "negating a direction" AND "clearly switching to a different direction OR clearly shelving it" hold simultaneously.

[Use "execution traces" to judge abandonment vs iteration]
Assistant turns in the transcript carry an **[Execution]** section (listing actual tool calls such as TaskCreate/Edit/Bash) and **[N tool error(s) this turn]** markers. Use them to judge: a direction that "created tasks / wrote code → errored or got stuck → moved on to a different thing and never came back" is more likely a genuine abandonment; "errored → kept fixing the same place" is iteration, not abandonment. When execution traces do not corroborate the wording, prefer not extracting at all.

[No hallucination (grounding hard constraint)]
direction must have been **genuinely discussed** in evidenceTurns; reasonVerbatim must be an **actual verbatim excerpt** from the conversation (truncation allowed, fabrication forbidden).

[Node mapping]
A list of "existing task nodes" is provided below. For each abandonment, decide which node's id it corresponds to and fill in mappedTaskId; when there is no clear match, fill null (wrong mappings are worse than no mapping). If the list is empty, fill null for all.

[Short sessions / no exploration] Simple Q&A, a single task advancing smoothly, no explicit abandonment → output an empty array. Do not pad.

[Confidence] confidence∈[0,1] reflects only "how certain this is an explicit abandonment"; do not output entries below 0.7.

Output strictly JSON with no extra text or markdown fences. Write \`direction\`, \`reason\`, and \`switchedTo\` in the conversation's language (the user's language); quote \`reasonVerbatim\` verbatim from the transcript.`

function buildNodeList(nodes: TaskNode[]): string {
  if (nodes.length === 0) return '(No task nodes in this session; fill mappedTaskId with null for all abandonments)'
  return nodes
    .map((n) => `- [${n.id}] ${n.subject} (${n.status})`)
    .join('\n')
}

function buildUserPrompt(transcript: string, nodes: TaskNode[], sessionId: string): string {
  return `Below is the incremental record of a human ↔ AI agent work session (turns are numbered). Following the system instructions, extract only **explicitly abandoned** directions and map them onto the existing task nodes.

Session ID: ${sessionId}

Existing task nodes (map each abandonment to one of these ids; fill null when there is no clear match):
${buildNodeList(nodes)}

=== Session transcript start ===
${transcript}
=== Session transcript end ===

Output only JSON with the following structure (abandonments may be an empty array):
{
  "abandonments": [
    {
      "direction": "short name of the abandoned direction (in the conversation's language)",
      "reason": "reason for abandonment (one sentence, distilled from the conversation)",
      "reasonCategory": "technical_infeasibility|better_alternative_found|user_preference_change|cost_or_complexity|performance_unsatisfactory|scope_reduction|other",
      "reasonVerbatim": "verbatim conversation excerpt best reflecting the abandonment (must have actually occurred)",
      "evidenceTurns": [evidence turn numbers],
      "switchedTo": "what was switched to after abandonment (null if none)",
      "mappedTaskId": "the matching task node id, or null",
      "confidence": 0.0
    }
  ]
}`
}

// ===== 一次性 LLM 调用（复用 generateTitle 的渠道/鉴权链，改写 body） =====

/** 一次性 JSON 调用；CSLab 审稿等服务复用同一套渠道/代理/商用计费链路。 */
export async function oneShotJsonCall(systemPrompt: string, userPrompt: string): Promise<string | null> {
  const settings = getSettings()
  const channelId = settings.agentChannelId
  const modelId = settings.agentModelId
  if (!channelId || !modelId) {
    console.warn('[回溯] 未配置 agentChannelId/agentModelId，跳过')
    return null
  }
  const channel = listChannels().find((c) => c.id === channelId)
  if (!channel) {
    console.warn('[回溯] 渠道不存在:', channelId)
    return null
  }

  let apiKey: string
  let proxyBaseUrl = ''
  if ((isCommercialBuild() || isCommercialMode()) && isOfficialManagedChannel(channel)) {
    const auth = await getTeamAuthWithRefresh()
    if (!auth) {
      console.warn('[回溯] 团队账号登录已过期，跳过')
      return null
    }
    const proxyPath = ANTHROPIC_PROXY_PROVIDERS.has(channel.provider) ? '/v1/proxy/messages' : '/v1/proxy/chat'
    proxyBaseUrl = `${auth.baseUrl}${proxyPath}`
    apiKey = auth.proxyToken || auth.token
  } else {
    apiKey = decryptApiKey(channelId)
  }

  const adapter = getAdapter(channel.provider)
  // 借 buildTitleRequest 拿到正确的 url + 鉴权头 + provider 请求体骨架，再改写 body
  const req = adapter.buildTitleRequest({
    baseUrl: proxyBaseUrl || channel.baseUrl,
    apiKey,
    modelId,
    prompt: userPrompt,
  })
  if (proxyBaseUrl) req.url = proxyBaseUrl

  const isOpenAiChat = req.url.includes('/chat/completions')
  let bodyObj: Record<string, unknown>
  try {
    bodyObj = JSON.parse(req.body) as Record<string, unknown>
  } catch {
    bodyObj = { model: modelId }
  }
  bodyObj['max_tokens'] = MAX_TOKENS
  bodyObj['temperature'] = 0
  if (isOpenAiChat) {
    bodyObj['messages'] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]
    bodyObj['response_format'] = { type: 'json_object' }
  } else {
    // Anthropic messages 协议：system 顶层字段 + messages
    bodyObj['system'] = systemPrompt
    bodyObj['messages'] = [{ role: 'user', content: userPrompt }]
  }
  req.body = JSON.stringify(bodyObj)

  try {
    const fetchFn = getFetchFn(await getEffectiveProxyUrl())
    const resp = await fetchFn(req.url, { method: 'POST', headers: req.headers, body: req.body })
    if (!resp.ok) {
      const errText = await resp.text().catch(() => 'unknown')
      console.warn('[回溯] LLM 请求失败:', resp.status, errText.slice(0, 300))
      return null
    }
    const data: unknown = await resp.json()
    return adapter.parseTitleResponse(data)
  } catch (e) {
    console.warn('[回溯] LLM 调用异常:', e)
    return null
  }
}

/** 宽松解析 LLM 返回的 JSON（容忍 markdown 围栏 / 前后噪声） */
function parseJsonLenient(s: string): { abandonments?: RawAbandonment[] } | null {
  let t = s.trim()
  if (t.startsWith('```')) {
    t = t.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '')
  }
  try {
    return JSON.parse(t) as { abandonments?: RawAbandonment[] }
  } catch {
    const i = t.indexOf('{')
    const j = t.lastIndexOf('}')
    if (i >= 0 && j > i) {
      try {
        return JSON.parse(t.slice(i, j + 1)) as { abandonments?: RawAbandonment[] }
      } catch {
        return null
      }
    }
    return null
  }
}

function toIntArray(v: unknown): number[] {
  if (!Array.isArray(v)) return []
  return v.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
}

// ===== 主入口 =====

/**
 * 对一个会话跑一次回溯放弃抽取。增量、幂等（同一水位重复跑不会重复落地新范围）。
 */
export async function runRetrospective(sessionId: string): Promise<RetrospectiveResult> {
  const meta = getAgentSessionMeta(sessionId)
  const lastAnalyzed = meta?.lastAnalyzedTurn ?? 0
  const messages = getAgentSessionSDKMessages(sessionId)
  const turns = renderTurns(messages)
  const graph0 = loadGraph(sessionId)
  console.log(`[回溯][诊断] 开始 session=${sessionId} 消息数=${messages.length} 主进程轮次=${turns.length} 已分析水位=${lastAnalyzed} 现有节点=${Object.keys(graph0.nodes).length}`)

  const baseResult: RetrospectiveResult = {
    graph: graph0,
    newAbandonments: 0,
    unmappedNotes: [],
    analyzedRange: { start: lastAnalyzed, end: turns.length },
    lastAnalyzedTurn: lastAnalyzed,
  }

  if (turns.length <= lastAnalyzed) {
    console.log(`[回溯][诊断] 跳过：无新增轮次（${turns.length} <= ${lastAnalyzed}）`)
    return { ...baseResult, skipped: 'no-new-turns' }
  }

  const analyzeFrom = Math.max(0, lastAnalyzed - OVERLAP)
  const windowTurns = turns.filter((t) => t.idx > analyzeFrom)
  const transcript = renderTranscript(windowTurns)
  const nodes = Object.values(graph0.nodes)
  console.log(`[回溯][诊断] 分析窗口 从轮次>${analyzeFrom} 共${windowTurns.length}轮 transcript字符=${transcript.length}`)

  const raw = await oneShotJsonCall(SYSTEM_PROMPT, buildUserPrompt(transcript, nodes, sessionId))
  if (raw === null) {
    console.warn(`[回溯][诊断] LLM 返回 null（调用失败），不推进水位`)
    // 失败：不推进水位，下次可重试
    return { ...baseResult, skipped: 'llm-failed' }
  }
  console.log(`[回溯][诊断] LLM 原始返回长度=${raw.length} 预览=${raw.slice(0, 200).replace(/\n/g, ' ')}`)
  const parsed = parseJsonLenient(raw)
  if (!parsed) {
    console.warn(`[回溯][诊断] JSON 解析失败，不推进水位`)
    return { ...baseResult, skipped: 'parse-failed' }
  }

  const abandonments = Array.isArray(parsed.abandonments) ? parsed.abandonments : []
  console.log(`[回溯][诊断] 抽出放弃条目=${abandonments.length}`)
  let newCount = 0
  const unmapped: UnmappedAbandonment[] = []
  const now = Date.now()

  for (const a of abandonments) {
    if (typeof a.confidence !== 'number' || a.confidence < CONFIDENCE_THRESHOLD) {
      console.log(`[回溯][诊断] 丢弃(置信不足): dir=${a.direction} conf=${a.confidence}`)
      continue
    }
    const mapped = a.mappedTaskId && graph0.nodes[a.mappedTaskId] ? a.mappedTaskId : null
    // 去重：OVERLAP 回看会重复抽到旧放弃，若目标节点已带 abandonReason 则跳过，
    // 避免同一枯枝每次运行都被重刨、newCount 虚高。
    if (mapped && graph0.nodes[mapped]!.abandonReason) {
      console.log(`[回溯][诊断] 跳过(节点已标注枯枝): dir=${a.direction} taskId=${mapped}`)
      continue
    }
    console.log(`[回溯][诊断] 放弃: dir=${a.direction} conf=${a.confidence} mappedTaskId=${a.mappedTaskId} → 落图=${mapped ? mapped : '否(游离)'}`)
    if (mapped) {
      const event: GraphEvent = {
        type: 'task_abandon_annotated',
        timestamp: now,
        taskId: mapped,
        payload: {
          reason: (a.reason || a.direction || '').toString(),
          confidence: a.confidence,
          evidenceTurns: toIntArray(a.evidenceTurns),
          source: 'retrospective',
        },
      }
      appendGraphEvent(sessionId, event)
      newCount++
    } else {
      unmapped.push({
        direction: (a.direction || '').toString(),
        reason: (a.reason || '').toString(),
        reasonVerbatim: (a.reasonVerbatim || '').toString(),
        evidenceTurns: toIntArray(a.evidenceTurns),
        switchedTo: a.switchedTo ?? null,
        confidence: a.confidence,
      })
    }
  }

  // 推进水位到当前总轮次
  updateAgentSessionMeta(sessionId, { lastAnalyzedTurn: turns.length })
  const readback = getAgentSessionMeta(sessionId)?.lastAnalyzedTurn
  console.log(`[回溯][诊断] 落地完成 新增枯枝=${newCount} 游离=${unmapped.length} 写水位=${turns.length} 回读水位=${readback}`)

  return {
    graph: loadGraph(sessionId),
    newAbandonments: newCount,
    unmappedNotes: unmapped,
    analyzedRange: { start: analyzeFrom, end: turns.length },
    lastAnalyzedTurn: turns.length,
  }
}
