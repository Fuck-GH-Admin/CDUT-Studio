/**
 * cdut-ai-class-manager.ts — AI 速课堂专属工作区与会话管理（主进程）
 *
 * 职责：
 *   1. 保证速课堂专属工作区（slug: cdut-ai-class）就绪，实现与全局 Agent 会话的物理隔离；
 *   2. 提供速课堂会话 CRUD，创建时自动锁定并绑定内部导师预设，彻底内化预设逻辑，
 *      杜绝「未选择预设 / 会话不存在」报错；
 *   3. 提供「资料树图谱按需生成」：根据用户在前端弹窗选定的模式（本地极速 / 智能精炼 /
 *      全量深度），生成跨文档知识关联，产出 KnowledgeGraphEdge[] 并缓存落盘；恒定由用户
 *      主动触发，绝不在文件变更或会话加载时自动偷跑消耗 Token。
 *
 * 设计原则：所有模型调用失败均静默降级为本地启发式关联，绝不抛出阻断界面。
 */

import { join, resolve } from 'node:path'
import { existsSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { ProviderType } from '@profer/shared'
import {
  BUILTIN_PRESET_STANDARD,
  CDUT_AI_CLASS_WORKSPACE_NAME,
  CDUT_AI_CLASS_WORKSPACE_SLUG,
  type AgentPreset,
  type AgentWorkspace,
  type AiClassSessionSummary,
  type KnowledgeGraphData,
  type KnowledgeGraphEdge,
  type KnowledgeGraphGenerationMode,
  type KnowledgeRelationType,
  type StudyDocumentOutline,
  type StudyDocumentSection,
  type StudyDocumentType,
  type StudyGraphCostEstimate,
  type StudyGraphProgressEvent,
} from '@profer/shared'
import { getAdapter } from '@profer/core'
import {
  createAgentWorkspace,
  listAgentWorkspaces,
  updateAgentWorkspace,
} from '../agent-workspace-manager'
import {
  createAgentSession,
  deleteAgentSession,
  listAgentSessions,
} from '../agent-session-manager'
import { createAgentPreset, listAgentPresets } from '../agent-preset-manager'
import { listStudyDocuments } from '../study/study-document-indexer'
import {
  assertStudyId,
  getStudyMaterialsRootDir,
  getStudySessionDir,
  getStudySessionsRootDir,
} from '../config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from '../safe-file'
import { listChannels, decryptApiKey, isCommercialMode } from '../channel-manager'
import { getTeamAuthWithRefresh } from '../auth-service'
import { getFetchFn } from '../proxy-fetch'
import { getEffectiveProxyUrl } from '../proxy-settings-service'
import { isCommercialBuild } from '../build-target'
import { isOfficialManagedChannel } from '../official-channel'
import { getSettings } from '../settings-service'

// ===== 常量 =====

/** 速课堂工作区展示名（与 shared 契约保持一致） */
const AI_CLASS_WORKSPACE_NAME = CDUT_AI_CLASS_WORKSPACE_NAME
/** 速课堂工作区创建期临时名（确保 slugify 得到 cdut-ai-class） */
const AI_CLASS_WORKSPACE_SEED_NAME = 'CDUT AI Class'
/** 速课堂内部导师预设名（界面上不暴露，仅内部锁定绑定） */
const AI_CLASS_PRESET_NAME = 'AI速课堂导师'
/** 图谱关联边上限 */
const MAX_EDGES = 24
/** 模型调用最大 token */
const GRAPH_MAX_TOKENS = 3000
/** 模型并发批处理上限（限制并发数为 4，防止触发渠道限流） */
const MODEL_CONCURRENCY = 4
/** 单批注入的章节数量（防止单次上下文爆炸） */
const SECTIONS_PER_BATCH = 40
/** 单文档内部大章骨架边上限（防止单文件长文的内部边挤占跨文档映射） */
const MAX_INTRA_EDGES_PER_DOC = 10

// ===== 成本估算公式常量（对应实施方案第三节动态测算规范） =====

/** 每百万 Token 参考单价（人民币，以主流大模型约 1.5 元计） */
const PRICE_PER_MILLION_CNY = 1.5
/** 智能精炼：本地噪音过滤后保留的有效切块比例（约 60%） */
const SMART_KEEP_RATIO = 0.6
/** 智能精炼：单 Chunk 平均输入 1200 + 输出 400 Tokens */
const SMART_TOKENS_PER_CHUNK = 1_600
/** 全量精读：单 Chunk 平均输入 1500 + 输出 600 Tokens */
const FULL_TOKENS_PER_CHUNK = 2_100
/** 智能精炼预估费用下限（元） */
const SMART_COST_FLOOR = 0.01
/** 全量精读预估费用下限（元） */
const FULL_COST_FLOOR = 0.02
/** ai_smart 模式噪音段落识别（教材前言 / 致谢 / 版权 / 目录等套话） */
const NOISE_SECTION_PATTERN = /前言|序言|致谢|谢辞|版权|声明|目录|封面|扉页|参考文献|编后|出版说明/

/** 走 Anthropic 协议 proxy 的供应商（代管模式用 /v1/proxy/messages，其余 /v1/proxy/chat） */
const ANTHROPIC_PROXY_PROVIDERS = new Set<ProviderType>([
  'anthropic', 'anthropic-compatible', 'kimi-api', 'kimi-coding',
  'minimax', 'xiaomi', 'xiaomi-token-plan', 'zhipu-coding',
])

/** 一次性 JSON 补全的请求协议族 */
type CompletionProtocol = 'google' | 'openai-responses' | 'openai-chat' | 'anthropic'

/**
 * 依据渠道 Provider 解析请求协议族。
 *
 * 红线：绝不能按请求 URL 判定——商业代理模式下 URL 会被改写为 `/v1/proxy/chat`
 * 或 `/v1/proxy/messages`，`includes('/chat/completions')` 会恒为 false，
 * 导致 OpenAI 协议渠道被误注入 Anthropic 的顶层 `system` 字段而 400。
 */
function resolveCompletionProtocol(provider: ProviderType): CompletionProtocol {
  if (provider === 'google') return 'google'
  if (provider === 'openai-responses' || provider === 'xai') return 'openai-responses'
  if (ANTHROPIC_PROXY_PROVIDERS.has(provider)) return 'anthropic'
  return 'openai-chat'
}

/** 关联类型 → 微标签 */
const RELATION_LABELS: Record<KnowledgeRelationType, string> = {
  prerequisite: '前置',
  exercise: '题型',
  extension: '延伸',
  reference: '关联',
}

// ===== 工作区与会话 =====

/**
 * 确保速课堂专属工作区存在并返回。
 *
 * 通过「创建期种子名 → 重命名为中文展示名」两步法，既保证物理目录 slug 恒为
 * `cdut-ai-class`，又让工作区在界面上以「AI速课堂」可读呈现。
 */
export function ensureAiClassWorkspace(): AgentWorkspace {
  const existing = listAgentWorkspaces().find(
    (ws) => ws.slug === CDUT_AI_CLASS_WORKSPACE_SLUG || ws.name === AI_CLASS_WORKSPACE_NAME,
  )
  if (existing) return existing

  const created = createAgentWorkspace(AI_CLASS_WORKSPACE_SEED_NAME, { type: 'personal' })
  try {
    return updateAgentWorkspace(created.id, { name: AI_CLASS_WORKSPACE_NAME })
  } catch (error) {
    // 展示名重名时保留种子名，不影响隔离与使用
    console.warn('[AI速课堂] 工作区重命名失败，保留默认名:', error)
    return created
  }
}

/** 确保速课堂内部导师预设存在（幂等，按工作区范围检索） */
function ensureAiClassPreset(workspaceSlug: string): AgentPreset {
  const existing = listAgentPresets(workspaceSlug).find(
    (preset) => preset.scope === 'workspace' && preset.name === AI_CLASS_PRESET_NAME,
  )
  if (existing) return existing
  return createAgentPreset(workspaceSlug, {
    name: AI_CLASS_PRESET_NAME,
    description: 'AI 速课堂内部导师预设：专注带教与靶向提分，预设逻辑已内化，无需手动切换。',
    basePresetId: BUILTIN_PRESET_STANDARD,
  })
}

/** 列出速课堂历史课堂简报（按最近活跃降序） */
export function listAiClassSessions(): AiClassSessionSummary[] {
  const workspace = ensureAiClassWorkspace()
  return listAgentSessions()
    .filter((session) => session.workspaceId === workspace.id)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((session) => ({
      sessionId: session.id,
      courseName: session.title || '新课堂',
      createdAt: session.createdAt,
      lastActiveAt: session.updatedAt,
      documentCount: listStudyDocuments(session.id).length,
    }))
}

/**
 * 新建速课堂会话：自动归属专属工作区并锁定内部导师预设，返回课堂简报。
 */
export function createAiClassSession(courseName: string): AiClassSessionSummary {
  const workspace = ensureAiClassWorkspace()
  const preset = ensureAiClassPreset(workspace.slug)
  const title = courseName.trim() || '未命名课堂'
  const session = createAgentSession(
    title,
    undefined,
    workspace.id,
    undefined,
    'pi',
    false,
    preset.id,
  )
  return {
    sessionId: session.id,
    courseName: session.title || title,
    createdAt: session.createdAt,
    lastActiveAt: session.updatedAt,
    documentCount: 0,
  }
}

/** 删除速课堂会话（索引瞬时摘除 + 物理磁盘后台异步清理专属资料与工件） */
export function deleteAiClassSession(sessionId: string): void {
  deleteAgentSession(sessionId, { backgroundDiskCleanup: true })
  setImmediate(() => {
    try {
      const rootMaterials = resolve(getStudyMaterialsRootDir())
      const materialsDir = resolve(rootMaterials, assertStudyId(sessionId, '会话标识'))
      if (materialsDir.startsWith(`${rootMaterials}/`) || materialsDir.startsWith(`${rootMaterials}\\`)) {
        if (existsSync(materialsDir)) rmSync(materialsDir, { recursive: true, force: true })
      }
    } catch (err) {
      console.warn('[AI速课堂] 清理学习资料目录失败:', sessionId, err)
    }
    try {
      const rootSessions = resolve(getStudySessionsRootDir())
      const sessionDataDir = resolve(rootSessions, assertStudyId(sessionId, '会话标识'))
      if (sessionDataDir.startsWith(`${rootSessions}/`) || sessionDataDir.startsWith(`${rootSessions}\\`)) {
        if (existsSync(sessionDataDir)) rmSync(sessionDataDir, { recursive: true, force: true })
      }
    } catch (err) {
      console.warn('[AI速课堂] 清理会话工件目录失败:', sessionId, err)
    }
  })
}

// ===== 静默模型编排：一次性 JSON 补全 =====

/**
 * 一次性的非流式模型调用（复用 generateTitle 的渠道 / 鉴权 / 适配器链路）。
 * 任意失败返回 null，由调用方静默降级。
 */
export async function oneShotJsonCompletion(systemPrompt: string, userPrompt: string): Promise<string | null> {
  const settings = getSettings()
  const channelId = settings.agentChannelId
  const modelId = settings.agentModelId
  if (!channelId || !modelId) {
    console.warn('[AI速课堂] 未配置 agentChannelId / agentModelId，跳过静默推演')
    return null
  }
  const channel = listChannels().find((candidate) => candidate.id === channelId)
  if (!channel) {
    console.warn('[AI速课堂] 静默推演渠道不存在:', channelId)
    return null
  }

  let apiKey: string
  let proxyBaseUrl = ''
  if ((isCommercialBuild() || isCommercialMode()) && isOfficialManagedChannel(channel)) {
    const auth = await getTeamAuthWithRefresh()
    if (!auth) {
      console.warn('[AI速课堂] 团队账号登录已过期，跳过静默推演')
      return null
    }
    const proxyPath = ANTHROPIC_PROXY_PROVIDERS.has(channel.provider) ? '/v1/proxy/messages' : '/v1/proxy/chat'
    proxyBaseUrl = `${auth.baseUrl}${proxyPath}`
    apiKey = auth.proxyToken || auth.token
  } else {
    apiKey = decryptApiKey(channelId)
  }

  const adapter = getAdapter(channel.provider)
  const req = adapter.buildTitleRequest({
    baseUrl: proxyBaseUrl || channel.baseUrl,
    apiKey,
    modelId,
    prompt: userPrompt,
  })
  if (proxyBaseUrl) req.url = proxyBaseUrl

  const protocol = resolveCompletionProtocol(channel.provider)
  let bodyObj: Record<string, unknown>
  try {
    bodyObj = JSON.parse(req.body) as Record<string, unknown>
  } catch {
    bodyObj = { model: modelId }
  }

  // 严格按渠道 Provider 协议注入 system prompt 与响应约束，杜绝 400 报错或 Token 截断
  if (protocol === 'google') {
    bodyObj['contents'] = [{ role: 'user', parts: [{ text: userPrompt }] }]
    bodyObj['systemInstruction'] = { parts: [{ text: systemPrompt }] }
    bodyObj['generationConfig'] = {
      maxOutputTokens: GRAPH_MAX_TOKENS,
      temperature: 0,
      responseMimeType: 'application/json',
    }
    delete bodyObj['max_tokens']
    delete bodyObj['system']
    delete bodyObj['messages']
  } else if (protocol === 'openai-responses') {
    bodyObj['model'] = modelId
    bodyObj['instructions'] = systemPrompt
    bodyObj['input'] = [{ role: 'user', content: userPrompt }]
    bodyObj['max_output_tokens'] = GRAPH_MAX_TOKENS
    bodyObj['temperature'] = 0
    delete bodyObj['max_tokens']
    delete bodyObj['system']
    delete bodyObj['messages']
  } else if (protocol === 'openai-chat') {
    bodyObj['model'] = modelId
    bodyObj['max_tokens'] = GRAPH_MAX_TOKENS
    bodyObj['temperature'] = 0
    bodyObj['messages'] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]
    // 本地 Ollama 运行时普遍不支持 OpenAI 的 response_format，仅云端渠道启用
    if (channel.provider !== 'ollama') bodyObj['response_format'] = { type: 'json_object' }
    delete bodyObj['system']
  } else {
    // Anthropic 原生与兼容通道（/messages）
    bodyObj['model'] = modelId
    bodyObj['max_tokens'] = GRAPH_MAX_TOKENS
    bodyObj['temperature'] = 0
    bodyObj['system'] = systemPrompt
    bodyObj['messages'] = [{ role: 'user', content: userPrompt }]
    delete bodyObj['response_format']
  }
  req.body = JSON.stringify(bodyObj)

  try {
    const fetchFn = getFetchFn(await getEffectiveProxyUrl())
    const resp = await fetchFn(req.url, { method: 'POST', headers: req.headers, body: req.body })
    if (!resp.ok) {
      const errText = await resp.text().catch(() => 'unknown')
      console.warn('[AI速课堂] 静默推演请求失败:', resp.status, errText.slice(0, 300))
      return null
    }
    const data: unknown = await resp.json()
    return adapter.parseTitleResponse(data)
  } catch (error) {
    console.warn('[AI速课堂] 静默推演异常:', error)
    return null
  }
}

// ===== 跨资料关联推演 =====

/** 宽松解析模型返回的 JSON（容忍 markdown 围栏 / 前后噪声） */
function parseJsonLenient(text: string): unknown {
  let trimmed = text.trim()
  if (trimmed.startsWith('```')) {
    trimmed = trimmed.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '')
  }
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1))
      } catch {
        return null
      }
    }
    return null
  }
}

/** 从模型输出中提炼合法关联边（严格校验文档与章节存在性） */
function coerceEdges(
  raw: unknown,
  documents: StudyDocumentOutline[],
  allowIntraDocument = false,
): KnowledgeGraphEdge[] {
  if (!raw || typeof raw !== 'object') return []
  const list = (raw as { edges?: unknown }).edges
  if (!Array.isArray(list)) return []
  const sectionIndex = new Map<string, Set<string>>()
  for (const doc of documents) {
    sectionIndex.set(doc.documentId, new Set(doc.sections.map((s) => s.sectionId)))
  }
  const edges: KnowledgeGraphEdge[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const edge = item as Record<string, unknown>
    const sourceDocId = typeof edge.sourceDocId === 'string' ? edge.sourceDocId : ''
    const targetDocId = typeof edge.targetDocId === 'string' ? edge.targetDocId : ''
    const sourceSectionId = typeof edge.sourceSectionId === 'string' ? edge.sourceSectionId : ''
    const targetSectionId = typeof edge.targetSectionId === 'string' ? edge.targetSectionId : ''
    if (!sourceDocId || !targetDocId) continue
    // 跨文档场景禁止自连；单文档内部骨架推演时允许同文档跨章节连接
    if (!allowIntraDocument && sourceDocId === targetDocId) continue
    if (sourceSectionId === targetSectionId) continue
    if (!sectionIndex.get(sourceDocId)?.has(sourceSectionId)) continue
    if (!sectionIndex.get(targetDocId)?.has(targetSectionId)) continue
    const key = `${sourceSectionId}->${targetSectionId}`
    if (seen.has(key)) continue
    seen.add(key)
    const relationRaw = typeof edge.relationType === 'string' ? edge.relationType : ''
    const relationType: KnowledgeRelationType = (['prerequisite', 'exercise', 'extension', 'reference'] as const)
      .includes(relationRaw as KnowledgeRelationType)
      ? (relationRaw as KnowledgeRelationType)
      : 'reference'
    edges.push({
      edgeId: randomUUID(),
      sourceDocId,
      sourceSectionId,
      targetDocId,
      targetSectionId,
      relationType,
      label: typeof edge.label === 'string' && edge.label.trim() ? edge.label.trim() : RELATION_LABELS[relationType],
      ...(typeof edge.description === 'string' && edge.description.trim() ? { description: edge.description.trim() } : {}),
    })
    if (edges.length >= MAX_EDGES) break
  }
  return edges
}

/** 常见标题停用词与泛化前缀（避免不同章节仅因“第X章”、“概述”等虚词产生误连） */
const TITLE_STOPWORDS = new Set([
  '第', '章', '节', '篇', '部', '目', '课', '讲',
  '的', '了', '在', '是', '与', '和', '及', '或', '等', '之',
  '一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
  '简', '介', '概', '述', '总', '结', '思', '考', '复', '习',
  '第一', '第二', '第三', '第四', '第五', '第六', '第七', '第八', '第九', '第十',
  '简介', '概述', '总结', '思考', '复习', '练习', '习题', '讨论', '附录',
  'the', 'and', 'for', 'with', 'chapter', 'section', 'part', 'unit',
])

/** 中文/英文标题的分词集合（过滤虚词/章节停用词，保留高辨识度实体与词素） */
function titleTokens(title: string): Set<string> {
  const tokens = new Set<string>()
  const lower = title.toLowerCase()
  for (const word of lower.match(/[a-z0-9]{2,}/g) ?? []) {
    if (!TITLE_STOPWORDS.has(word)) tokens.add(word)
  }
  const han = lower.match(/[\u4e00-\u9fa5]/g) ?? []
  for (let i = 0; i < han.length; i++) {
    const char = han[i]!
    if (!TITLE_STOPWORDS.has(char)) {
      tokens.add(char)
    }
    if (i + 1 < han.length) {
      const bi = `${char}${han[i + 1]}`
      if (!TITLE_STOPWORDS.has(bi)) {
        tokens.add(bi)
      }
    }
  }
  return tokens
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const token of a) if (b.has(token)) inter++
  return inter / (a.size + b.size - inter)
}

/** 判断文档是否为题集 / 习题类（用于启发式关系类型推断） */
function looksLikeExercise(doc: StudyDocumentOutline): boolean {
  if (doc.fileType === 'xlsx') return true
  return /习题|练习|题库|试卷|真题|题集|作业|test|exercise|quiz/i.test(doc.fileName)
}

/**
 * 本地启发式关联：当静默模型不可用 / 无产出时兜底，保证资料树始终有可用拓扑。
 * 依据章节标题词元相似度，为「后者文档」的章节寻找「前者文档」中最相近的前置章节。
 */
function buildHeuristicEdges(documents: StudyDocumentOutline[]): KnowledgeGraphEdge[] {
  const edges: KnowledgeGraphEdge[] = []
  for (let i = 0; i < documents.length; i++) {
    for (let j = i + 1; j < documents.length; j++) {
      const earlier = documents[i]!
      const later = documents[j]!
      const relationType: KnowledgeRelationType = looksLikeExercise(later) ? 'exercise' : 'reference'
      for (const laterSection of later.sections) {
        const laterTokens = titleTokens(laterSection.title)
        let best: { sectionId: string; score: number } | null = null
        for (const earlierSection of earlier.sections) {
          const score = jaccard(laterTokens, titleTokens(earlierSection.title))
          if (score > 0.12 && (!best || score > best.score)) {
            best = { sectionId: earlierSection.sectionId, score }
          }
        }
        if (best) {
          edges.push({
            edgeId: randomUUID(),
            sourceDocId: earlier.documentId,
            sourceSectionId: best.sectionId,
            targetDocId: later.documentId,
            targetSectionId: laterSection.sectionId,
            relationType,
            label: RELATION_LABELS[relationType],
          })
          if (edges.length >= MAX_EDGES) return edges
        }
      }
    }
  }
  return edges
}

/** 章节引用（批处理与 Prompt 构造的最小单元） */
interface SectionRef {
  documentId: string
  fileName: string
  fileType: StudyDocumentType
  section: StudyDocumentSection
}

/** ai_smart 模式：判定是否为应被过滤的噪音段落（前言 / 致谢 / 目录等套话） */
function isNoiseSection(section: StudyDocumentSection): boolean {
  return NOISE_SECTION_PATTERN.test(`${section.title}${section.summary}`)
}

/** 依据模式收集需要送入模型的章节引用（ai_smart 先本地过滤噪音） */
function collectSectionRefs(
  documents: StudyDocumentOutline[],
  mode: KnowledgeGraphGenerationMode,
): SectionRef[] {
  const refs: SectionRef[] = []
  for (const doc of documents) {
    for (const section of doc.sections) {
      if (mode === 'ai_smart' && isNoiseSection(section)) continue
      refs.push({ documentId: doc.documentId, fileName: doc.fileName, fileType: doc.fileType, section })
    }
  }
  return refs
}

/** 构造紧凑 Prompt（仅发送章节标题与摘要，防止上下文爆炸） */
function buildPromptFromRefs(refs: SectionRef[]): string {
  const lines: string[] = []
  let currentDocId = ''
  for (const ref of refs) {
    if (ref.documentId !== currentDocId) {
      currentDocId = ref.documentId
      lines.push(`### 文档 documentId=${ref.documentId}｜${ref.fileName}（${ref.fileType}）`)
    }
    lines.push(`- sectionId=${ref.section.sectionId}｜${ref.section.title}｜${ref.section.summary}`)
  }
  return lines.join('\n')
}

/** 把数组按固定大小切分为批次 */
function batchArray<T>(items: T[], size: number): T[][] {
  const batches: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size))
  }
  return batches
}

/** 受限并发执行（并发数上限防止触发渠道限流） */
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const runnerCount = Math.min(limit, items.length)
  const runners = Array.from({ length: runnerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index]!)
    }
  })
  await Promise.all(runners)
  return results
}

/** 图谱推演进度上报器（sessionId 由 generateKnowledgeGraph 统一注入） */
type GraphProgressReporter = (progress: Omit<StudyGraphProgressEvent, 'sessionId'>) => void

/** 安全上报推演进度（无回调时静默） */
function emitGraphProgress(
  reporter: GraphProgressReporter | undefined,
  current: number,
  total: number,
  phase: string,
): void {
  if (!reporter) return
  const safeTotal = Math.max(1, total)
  const clamped = Math.min(current, safeTotal)
  reporter({
    current: clamped,
    total: safeTotal,
    percent: Math.round((clamped / safeTotal) * 100),
    phase,
  })
}

/** 合并多组边并按 sectionId 去重（保留最先出现者，受上限约束） */
function mergeUniqueEdges(groups: KnowledgeGraphEdge[][], cap: number): KnowledgeGraphEdge[] {
  const merged: KnowledgeGraphEdge[] = []
  const seen = new Set<string>()
  for (const group of groups) {
    for (const edge of group) {
      const key = `${edge.sourceSectionId}->${edge.targetSectionId}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(edge)
      if (merged.length >= cap) return merged
    }
  }
  return merged
}

/**
 * 云端 AI 模式：按批次并发调用配置模型抽取关联边，并逐批上报进度。
 * 任意批次失败静默跳过；全部失败返回空数组，由调用方降级为本地启发式。
 */
async function runModelEdgeBatches(
  refs: SectionRef[],
  documents: StudyDocumentOutline[],
  allowIntraDocument: boolean,
  systemPrompt: string,
  userIntro: string,
  reporter?: GraphProgressReporter,
  phase = '正在推演知识网络',
): Promise<KnowledgeGraphEdge[]> {
  if (refs.length === 0) return []
  const batches = batchArray(refs, SECTIONS_PER_BATCH)
  const total = batches.length
  let done = 0
  const groups = await runWithConcurrency(batches, MODEL_CONCURRENCY, async (batch) => {
    const output = await oneShotJsonCompletion(
      systemPrompt,
      `${userIntro}\n\n${buildPromptFromRefs(batch)}\n\n请输出关联 edges JSON。`,
    )
    done += 1
    emitGraphProgress(reporter, done, total, phase)
    if (!output) return []
    return coerceEdges(parseJsonLenient(output), documents, allowIntraDocument)
  })
  return mergeUniqueEdges(groups, MAX_EDGES)
}

const GRAPH_SYSTEM_PROMPT = [
  'You are a knowledge graph specialist. Given the chapter outlines of multiple study documents, analyze cross-document conceptual relationships.',
  'Language Convention: Generate relation labels and descriptions matching the language of the source documents. Generate final responses in the same language used by the user, defaulting to English otherwise.',
  'Output strictly valid JSON with the following schema:',
  '{"edges":[{"sourceDocId":"..","sourceSectionId":"..","targetDocId":"..","targetSectionId":"..","relationType":"prerequisite|exercise|extension|reference","label":"concise label","description":"one-sentence rationale"}]}',
  'Rules:',
  '- Connect sections between distinct documents; self-loops are omitted; sectionId must be chosen from the provided outline.',
  '- Use "prerequisite" for preparatory material; "exercise" for practice problems corresponding to concepts; "extension" for advanced topics; "reference" for related citations.',
  '- Keep relationships concise and reliable, up to 24 edges.',
].join('\n')

const INTRA_GRAPH_SYSTEM_PROMPT = [
  'You are a knowledge graph specialist. Given the sequential chapter outline of a single comprehensive study document, deduce pedagogical progression between chapters.',
  'Language Convention: Generate relation labels and descriptions matching the language of the source documents. Generate final responses in the same language used by the user, defaulting to English otherwise.',
  'Output strictly valid JSON with the following schema:',
  '{"edges":[{"sourceDocId":"..","sourceSectionId":"..","targetDocId":"..","targetSectionId":"..","relationType":"prerequisite|extension|reference","label":"concise label","description":"one-sentence rationale"}]}',
  'Rules:',
  '- Connect sequential sections within the same document to reflect pedagogical progression; self-loops are omitted; sectionId must be chosen from the provided outline.',
  '- Use "prerequisite" for sequential progressions; "extension" for conceptual expansions; "reference" for supporting sections.',
  '- Keep relationships concise and reliable, up to 10 edges.',
].join('\n')

/**
 * 单文档内部大章骨架（纯本地启发式，零额外 Token）：
 * 按顺序为每个章节在后续窗口内寻找最相近的章节作为「前置递进」桥接，
 * 找不到相近章节时退化为相邻章节连线，保证单文件长文也呈现连贯的章节脉络。
 */
function buildIntraHeuristicEdges(doc: StudyDocumentOutline): KnowledgeGraphEdge[] {
  const sections = doc.sections
  const tokens = sections.map((section) => titleTokens(section.title))
  const WINDOW = 12
  const edges: KnowledgeGraphEdge[] = []
  for (let i = 0; i < sections.length && edges.length < MAX_INTRA_EDGES_PER_DOC; i++) {
    const source = sections[i]!
    let best: { index: number; score: number } | null = null
    for (let j = i + 1; j < Math.min(sections.length, i + 1 + WINDOW); j++) {
      const score = jaccard(tokens[i]!, tokens[j]!)
      if (score > 0.12 && (!best || score > best.score)) best = { index: j, score }
    }
    const targetIndex = best ? best.index : i + 1 < sections.length ? i + 1 : -1
    if (targetIndex < 0) break
    const target = sections[targetIndex]!
    edges.push({
      edgeId: randomUUID(),
      sourceDocId: doc.documentId,
      sourceSectionId: source.sectionId,
      targetDocId: doc.documentId,
      targetSectionId: target.sectionId,
      relationType: 'prerequisite',
      label: RELATION_LABELS.prerequisite,
    })
  }
  return edges
}

/**
 * 场景 1（单文档）：推演文档内部大章之间的先后演进逻辑。
 * local_fast 纯本地启发式；AI 模式走模型推演，失败时降级为启发式。
 */
async function buildIntraDocumentGraph(
  document: StudyDocumentOutline,
  mode: KnowledgeGraphGenerationMode,
  reporter?: GraphProgressReporter,
): Promise<KnowledgeGraphEdge[]> {
  if (mode === 'local_fast') {
    emitGraphProgress(reporter, 1, 1, '正在梳理大章演进脉络')
    return buildIntraHeuristicEdges(document)
  }
  const refs = collectSectionRefs([document], mode)
  const edges = await runModelEdgeBatches(
    refs,
    [document],
    true,
    INTRA_GRAPH_SYSTEM_PROMPT,
    '以下是同一份学习资料的章节顺序目录：',
    reporter,
    '正在推演大章演进脉络',
  )
  if (edges.length > 0) return edges
  return buildIntraHeuristicEdges(document)
}

/**
 * 场景 2（多文档）：分层全息推演。
 *   Layer 1：各文档内部大章骨架（本地启发式，零额外 Token）；
 *   Layer 2：跨文档知识点映射（教材理论 ↔ 试题考点；AI 模式走模型，失败降级启发式）。
 */
async function buildHierarchicalMultiDocumentGraph(
  documents: StudyDocumentOutline[],
  mode: KnowledgeGraphGenerationMode,
  reporter?: GraphProgressReporter,
): Promise<KnowledgeGraphEdge[]> {
  const intraEdges: KnowledgeGraphEdge[] = []
  for (const doc of documents) intraEdges.push(...buildIntraHeuristicEdges(doc))

  let crossEdges: KnowledgeGraphEdge[] = []
  if (mode === 'local_fast') {
    emitGraphProgress(reporter, 1, 1, '正在推演分层知识网络')
    crossEdges = buildHeuristicEdges(documents)
  } else {
    try {
      const refs = collectSectionRefs(documents, mode)
      crossEdges = await runModelEdgeBatches(
        refs,
        documents,
        false,
        GRAPH_SYSTEM_PROMPT,
        '以下是多份学习资料的章节目录：',
        reporter,
        '正在推演分层知识网络',
      )
    } catch (error) {
      console.warn('[AI速课堂] 分层图谱云端推演失败，降级为启发式关联:', error)
    }
    if (crossEdges.length === 0) crossEdges = buildHeuristicEdges(documents)
  }

  // 跨文档映射优先保留，再补充各文档内部骨架
  return mergeUniqueEdges([crossEdges, intraEdges], MAX_EDGES)
}

/**
 * 动态测算当前会话三档生成模式的 Token 与费用预估（供弹窗看板展示）。
 *
 * 对应实施方案第三节：
 *   - 方案二（智能精炼）：有效切块数 = ⌈总切块 × 0.6⌉，单价 1600 Token/块；
 *   - 方案三（全量精读）：全量切块数，单价 2100 Token/块。
 */
export function estimateGraphGenerationCost(sessionId: string): StudyGraphCostEstimate {
  const documents = listStudyDocuments(sessionId)
  const totalDocuments = documents.length
  const totalChars = documents.reduce((sum, doc) => sum + doc.totalChars, 0)
  const totalChunks = documents.reduce((sum, doc) => sum + doc.totalSections, 0)

  const smartChunks = Math.ceil(totalChunks * SMART_KEEP_RATIO)
  const fullChunks = totalChunks

  const smartTokens = smartChunks * SMART_TOKENS_PER_CHUNK
  const fullTokens = fullChunks * FULL_TOKENS_PER_CHUNK

  const round2 = (value: number): number => Math.round(value * 100) / 100
  const clampSeconds = (value: number, min: number, max: number): number =>
    Math.round(Math.min(max, Math.max(min, value)))

  return {
    totalDocuments,
    totalChars,
    totalChunks,
    smart: {
      tokens: smartTokens,
      costCny: round2(Math.max(SMART_COST_FLOOR, (smartTokens / 1_000_000) * PRICE_PER_MILLION_CNY)),
      estimatedSeconds: clampSeconds(12 + smartChunks * 0.5, 15, 25),
    },
    full: {
      tokens: fullTokens,
      costCny: round2(Math.max(FULL_COST_FLOOR, (fullTokens / 1_000_000) * PRICE_PER_MILLION_CNY)),
      estimatedSeconds: clampSeconds(25 + fullChunks * 1.0, 40, 70),
    },
  }
}

/**
 * 按用户选定模式生成分层全息知识图谱并返回完整图谱数据。
 *
 * 恒定由前端弹窗确认后主动触发（不再静默偷跑消耗 Token）：
 *   - local_fast：纯本地 Jaccard 启发式关联，0 Token，秒级完成；
 *   - ai_smart  ：本地过滤约 40% 噪音段落后，并发调用模型抽取核心考点关联；
 *   - ai_full   ：全量分块并发调用模型穷尽抽取微观实体与关系。
 *
 * 分层推演（并发 4 批，逐批广播进度）：
 *   - 单文件（documents.length === 1）：buildIntraDocumentGraph，推演大章之间的递进因果逻辑；
 *   - 多文件（documents.length >= 2）：buildHierarchicalMultiDocumentGraph，各文档内部骨架 + 跨文档知识映射。
 * 模型失败或无产出时自动降级为本地启发式关联，永不阻断界面。
 */
export async function generateKnowledgeGraph(
  sessionId: string,
  mode: KnowledgeGraphGenerationMode = 'ai_smart',
  onProgress?: (event: StudyGraphProgressEvent) => void,
): Promise<KnowledgeGraphData> {
  const documents = listStudyDocuments(sessionId)
  let edges: KnowledgeGraphEdge[] = []

  const reporter: GraphProgressReporter | undefined = onProgress
    ? (progress) => onProgress({ sessionId, ...progress })
    : undefined

  if (documents.length >= 1) {
    if (documents.length === 1) {
      // 场景 1：单文档内部大章与知识群因果推演
      edges = await buildIntraDocumentGraph(documents[0]!, mode, reporter)
    } else {
      // 场景 2：多文档分层全息推演（各文档内部骨架 + 跨文档知识映射）
      edges = await buildHierarchicalMultiDocumentGraph(documents, mode, reporter)
    }

    // 推演完成信号（100%）
    emitGraphProgress(reporter, 1, 1, '知识网络构建完成')

    try {
      // 写入前确保目录存在（getStudySessionDir 默认纯路径解析、无创建副作用）
      const cachePath = join(getStudySessionDir(sessionId, { create: true }), 'knowledge-graph.json')
      writeJsonFileAtomic(cachePath, { documents: [], edges, updatedAt: Date.now() })
    } catch (error) {
      console.warn('[AI速课堂] 图谱缓存写入失败:', error)
    }
  }

  return { documents, edges, updatedAt: Date.now() }
}

/** 读取已缓存的图谱关联边（无缓存返回空数组，供界面首帧快速渲染） */
export function readCachedGraphEdges(sessionId: string): KnowledgeGraphEdge[] {
  try {
    const cachePath = join(getStudySessionDir(sessionId), 'knowledge-graph.json')
    const cached = readJsonFileSafe<{ edges?: KnowledgeGraphEdge[] }>(cachePath)
    return Array.isArray(cached?.edges) ? cached.edges : []
  } catch {
    return []
  }
}
