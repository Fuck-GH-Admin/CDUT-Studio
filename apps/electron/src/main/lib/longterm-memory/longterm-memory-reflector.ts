/**
 * 长期记忆反思器（Long-Term Memory Reflector）
 *
 * 双轨静默捕获：
 *   1. 单轮结束后扫描用户输入中的「强偏好表达」，提炼为候选习惯；
 *   2. 统计本轮工具调用频次与 Slash 指令使用频次。
 *
 * 末尾附带空闲期睡眠整合：权重时间衰减 / 同义合并 / 弱记忆淘汰。
 *
 * 红线：
 *   - 默认纯确定性规则；仅在调用方注入 `auditCandidate` 时对语义候选做一次隔离审核，
 *     审核异常只会降级为「降置信度写入」，绝不影响对话主流程；
 *   - 绝不阻塞主线程（由编排层 setImmediate 调用）；
 *   - 任何异常都只在本地 warn，绝不影响对话主流程。
 */

import type { LongTermMemoryCategory, LongTermMemoryNode, LongTermMemoryNodeInput } from '@profer/shared'
import { getLongTermMemoryGraphPath } from '../config-paths'
import type { MemoryAuditVerdict } from './longterm-memory-auditor'
import {
  applyLongTermMemoryMutations,
  deleteLongTermMemoryNode,
  listLongTermMemoryNodes,
  type LongTermMemoryCreateInput,
  type LongTermMemoryMutation,
} from './longterm-memory-store'

// ===== 偏好句式 =====

const PREFERENCE_PATTERNS: RegExp[] = [
  /以后(都|统一|一律|只)?(用|使用|走|按)/,
  // 允许「以后 + 中间语境 + 都/统一 + 用」的句式（如「以后查空教室都用 CDUT 专区」）
  /以后[^。！？!?\n]{0,24}(都|统一|一律)(用|使用|走)/,
  /(我)?(更)?(喜欢|偏好|习惯)/,
  /统一(用|使用|走)/,
  /(必须|务必|一定要)(用|使用)/,
  /(不要|别|禁止|严禁)(用|再|直接)/,
  /(改用|换成)/,
  /记住/,
  /下次/,
  /\balways use\b/i,
  /\bnever use\b/i,
  /\bprefer\b/i,
  /\bfrom now on\b/i,
  /\binstead of\b/i,
  /\bdon'?t use\b/i,
  /\bmust use\b/i,
  /\bi (like|hate)\b/i,
]

/** 纯指代 / 虚指片段，命中即丢弃 */
const PRONOUN_ONLY_PATTERN = /^(把它|把那个|就这样|用那个|改成这样|那样就行|do it|that one)$/i

/**
 * 疑问句守卫：只认真正的问句。
 * 故意不含句尾「吧」，避免误杀「以后都用 Jotai 吧」这类祈使/建议表达。
 */
const QUESTION_PATTERN =
  /[?？]\s*$|^(?:怎么|如何|为什么|为何|难道|是否|能否|要不要)|(?:吗|呢|行不行|好不好|对不对|可不可以|是不是)\s*[?？。!！]?\s*$/

/** 类别关键词（按优先级从上到下匹配） */
const CATEGORY_KEYWORDS: Array<{ category: LongTermMemoryCategory; pattern: RegExp }> = [
  { category: 'cdut_special_domain', pattern: /教务|课表|成绩|空教室|考试|青果|一卡通|图书馆|学分|选课|cdut/i },
  { category: 'tool_affinity', pattern: /mcp|skill|技能|工具|命令|\/goal|\/plan|终端|browser|浏览器/i },
  { category: 'coding_preference', pattern: /typescript|react|jotai|tailwind|usestate|useeffect|组件|代码|函数|注释|接口|依赖/i },
  { category: 'workflow_habit', pattern: /先.{0,6}再|方案|规划|计划|流程|步骤|review|测试|检查点/i },
  { category: 'interaction_style', pattern: /简洁|直接|少废话|中文|英文|语气|格式|markdown|回复/i },
]

/** 可提炼为标签的专有名词 */
const TAG_PATTERN = /jotai|react|typescript|tailwind|usestate|useeffect|mcp|skill|origin|matplotlib|cslab/gi

const MAX_CANDIDATES_PER_TURN = 3
const MIN_VALID_CHARS = 6
/** 审核不可用时写入的降级置信度，便于睡眠整合优先淘汰 */
const AUDIT_DEGRADED_CONFIDENCE = 0.45
/** 超过该长度的句子才做逗号二次切分 */
const LONG_SENTENCE_THRESHOLD = 60

// ===== 文本处理 =====

/** 归一化指纹：仅用于去重比较，不落盘 */
function fingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。；、：！？,.;:!?'"“”‘’（）()\[\]【】]/g, '')
}

function titleKey(title: string): string {
  return fingerprint(title)
}

/** 有效信息量校验：去停用词与标点后是否仍有足够实义字符 */
function isMeaningful(fragment: string): boolean {
  const stripped = fragment
    .replace(/[\s\u3000\p{P}\p{S}]/gu, '')
    .replace(/(的|了|和|与|及|或|是|在|我|你|他|她|它|这|那|请|就|都|也|会|能)/g, '')
  return stripped.length >= MIN_VALID_CHARS
}

/**
 * 分句：整句优先，超过 60 字才按逗号二次切分，且切分后与前一子句拼接以保留语境。
 * 例：「以后做科研绘图的时候不要用 matplotlib，统一走 CSLab 原生 Origin」不会只剩后半句。
 */
export function splitPreferenceCandidates(text: string): string[] {
  const sentences = text
    .split(/(?<=[。！？!?\n])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)

  const units: string[] = []
  for (const sentence of sentences) {
    if (sentence.length <= LONG_SENTENCE_THRESHOLD) {
      units.push(sentence)
      continue
    }
    const fragments = sentence
      .split(/[，,；;]/)
      .map((fragment) => fragment.trim())
      .filter(Boolean)
    for (let i = 0; i < fragments.length; i++) {
      const previous = i > 0 ? fragments[i - 1]! : ''
      const unit = previous ? `${previous}，${fragments[i]}` : fragments[i]!
      units.push(unit.slice(0, 200))
    }
  }
  return units
}

function inferCategory(text: string): LongTermMemoryCategory {
  for (const item of CATEGORY_KEYWORDS) {
    if (item.pattern.test(text)) return item.category
  }
  return 'interaction_style'
}

function inferTags(text: string): string[] {
  const tags = new Set<string>()
  for (const match of text.matchAll(TAG_PATTERN)) {
    tags.add(match[0].toLowerCase())
  }
  return [...tags].slice(0, 4)
}

function buildTitle(text: string): string {
  const cleaned = text
    .replace(/^(以后|下次|记住|从现在开始|from now on)[，,\s]*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  return (cleaned || text).slice(0, 36)
}

/** 从用户输入中提取强偏好候选 */
export function extractPreferenceCandidates(userMessage: string): LongTermMemoryNodeInput[] {
  const candidates: LongTermMemoryNodeInput[] = []
  const seen = new Set<string>()

  for (const unit of splitPreferenceCandidates(userMessage)) {
    if (candidates.length >= MAX_CANDIDATES_PER_TURN) break
    if (!isMeaningful(unit) || PRONOUN_ONLY_PATTERN.test(unit)) continue
    // 疑问句不构成长期习惯：拦截「请记住这个吗？」「以后统一走 X 对不对」
    if (QUESTION_PATTERN.test(unit.trim())) continue
    if (!PREFERENCE_PATTERNS.some((pattern) => pattern.test(unit))) continue

    const content = unit.slice(0, 200)
    const key = fingerprint(content)
    if (seen.has(key)) continue
    seen.add(key)

    candidates.push({
      category: inferCategory(unit),
      title: buildTitle(unit),
      content,
      tags: inferTags(unit),
      confidence: 0.65,
    })
  }

  return candidates
}

/**
 * 从本轮消息中提取工具调用名。
 *
 * 刻意不去重：同轮重复调用同一工具是「高频」信号，频次统计交给下游 `toolCounts`。
 */
export function extractToolNamesFromMessages(messages: unknown[]): string[] {
  const names: string[] = []
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const record = message as { type?: unknown; message?: { content?: unknown } }
    if (record.type !== 'assistant') continue
    const content = record.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const item = block as { type?: unknown; name?: unknown }
      if (item.type === 'tool_use' && typeof item.name === 'string' && item.name.trim()) {
        names.push(item.name.trim())
      }
    }
  }
  return names
}

// ===== 单轮反思 =====

export interface ReflectTurnInput {
  /** 用户原始输入（不含内部注入 prompt） */
  userMessage: string
  /** 本轮调用的工具名（可重复，重复即计频） */
  toolNames?: string[]
  graphPath?: string
  /**
   * 可选写入前审核：只作用于「新增的语义偏好候选」。
   * 缺省表示不审核（保持纯规则行为，供测试与无渠道场景）。
   */
  auditCandidate?: (
    candidate: LongTermMemoryNodeInput,
    userMessage: string,
  ) => Promise<MemoryAuditVerdict>
}

/**
 * 单轮静默反思：提取候选 → 与现有图谱比对 → 一次批量原子落盘。
 * 调用方负责把它放到后台（setImmediate），本函数本身不做调度。
 */
export async function reflectOnTurn(input: ReflectTurnInput): Promise<void> {
  try {
    const message = input.userMessage.trim()
    if (message.length < 4) return
    if (message.startsWith('/compact')) return

    const graphPath = input.graphPath ?? getLongTermMemoryGraphPath()
    const nodes = listLongTermMemoryNodes(graphPath)

    const byFingerprint = new Map<string, LongTermMemoryNode>()
    const byTitle = new Map<string, LongTermMemoryNode>()
    for (const node of nodes) {
      byFingerprint.set(`${node.category}:${fingerprint(node.content)}`, node)
      byTitle.set(`${node.category}:${titleKey(node.title)}`, node)
    }

    const mutations: LongTermMemoryMutation[] = []
    const creates: LongTermMemoryCreateInput[] = []
    const touched = new Set<string>()

    const pushMutation = (node: LongTermMemoryNode, delta: number, confidenceDelta = 0): void => {
      if (touched.has(node.id)) {
        const existing = mutations.find((mutation) => mutation.id === node.id)
        if (existing) {
          existing.weightDelta = (existing.weightDelta ?? 0) + delta
          if (confidenceDelta) existing.confidenceDelta = (existing.confidenceDelta ?? 0) + confidenceDelta
        }
        return
      }
      touched.add(node.id)
      mutations.push({
        id: node.id,
        weightDelta: delta,
        ...(confidenceDelta ? { confidenceDelta } : {}),
      })
    }

    // 1. 强偏好表达：先收集待新建候选，再并发过一次隔离审核
    const pending: LongTermMemoryNodeInput[] = []
    for (const candidate of extractPreferenceCandidates(message)) {
      const existing = byFingerprint.get(`${candidate.category}:${fingerprint(candidate.content)}`)
      if (existing) {
        pushMutation(existing, 1, 0.05)
        continue
      }
      const duplicate = pending.some(
        (item) => item.category === candidate.category && fingerprint(item.content) === fingerprint(candidate.content),
      )
      if (!duplicate) pending.push(candidate)
    }

    if (pending.length > 0 && input.auditCandidate) {
      const auditor = input.auditCandidate
      // 并发审核：单条候选异常独立降级，不拖累同轮其它候选
      const verdicts = await Promise.all(
        pending.map((candidate) => auditor(candidate, message).catch(
          (): MemoryAuditVerdict => ({ status: 'unavailable', reason: '审核调用异常' }),
        )),
      )
      pending.forEach((candidate, index) => {
        const verdict = verdicts[index]!
        if (verdict.status === 'rejected') {
          console.log(`[长期记忆] 审核未通过，丢弃候选: ${verdict.reason}`)
          return
        }
        if (verdict.status === 'unavailable') {
          console.warn(`[长期记忆] 审核不可用，降置信度写入: ${verdict.reason}`)
          candidate.confidence = AUDIT_DEGRADED_CONFIDENCE
        }
        creates.push(candidate)
      })
    } else {
      creates.push(...pending)
    }

    // 2. 工具调用频次（同轮重复调用累计权重）
    const toolCounts = new Map<string, number>()
    for (const rawName of input.toolNames ?? []) {
      const name = rawName.trim()
      if (!name) continue
      toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1)
    }
    for (const [name, count] of toolCounts) {
      const title = `常用工具 ${name}`
      const existing = byTitle.get(`tool_affinity:${titleKey(title)}`)
      if (existing) {
        pushMutation(existing, count)
      } else {
        creates.push({
          category: 'tool_affinity',
          title,
          content: `用户在本机高频调用 ${name} 工具。`,
          tags: [name, 'tool'],
          confidence: 0.6,
          weight: count,
        })
      }
    }

    // 3. Slash 指令偏好
    const slashMatch = message.match(/^\/([a-z][\w-]{1,20})\b/)
    if (slashMatch) {
      const command = slashMatch[1]!
      const title = `常用指令 /${command}`
      const existing = byTitle.get(`workflow_habit:${titleKey(title)}`)
      if (existing) {
        pushMutation(existing, 1)
      } else {
        creates.push({
          category: 'workflow_habit',
          title,
          content: `用户经常使用 /${command} 指令推进任务。`,
          tags: [command, 'slash'],
          confidence: 0.6,
        })
      }
    }

    if (mutations.length === 0 && creates.length === 0) return
    await applyLongTermMemoryMutations(mutations, creates, graphPath)
  } catch (error) {
    console.warn('[长期记忆] 后台反思失败（已隔离）:', error)
  }
}

// ===== 空闲期睡眠整合 =====

/** 时间衰减半衰期：30 天权重减半 */
const DECAY_HALF_LIFE_DAYS = 30
/** 淘汰阈值 */
const REMOVE_WEIGHT_THRESHOLD = 0.2
const REMOVE_CONFIDENCE_THRESHOLD = 0.6
const REMOVE_AGE_DAYS = 60
/** 默认整合间隔：6 小时 */
const DEFAULT_CONSOLIDATION_INTERVAL_MS = 6 * 60 * 60 * 1000
/** 系统空闲判定阈值：5 分钟 */
const IDLE_THRESHOLD_SEC = 300

export interface ConsolidationResult {
  merged: number
  decayed: number
  removed: number
}

/**
 * 睡眠整合：时间衰减 → 同义自动节点合并 → 弱记忆淘汰。
 * 用户手动节点永不淘汰、也不衰减。
 */
export async function consolidateLongTermMemory(
  options: { graphPath?: string; now?: number } = {},
): Promise<ConsolidationResult> {
  const graphPath = options.graphPath ?? getLongTermMemoryGraphPath()
  const now = options.now ?? Date.now()
  const nodes = listLongTermMemoryNodes(graphPath)
  if (nodes.length === 0) return { merged: 0, decayed: 0, removed: 0 }

  const mutations: LongTermMemoryMutation[] = []
  const removalIds = new Set<string>()
  let merged = 0
  let decayed = 0

  // 1. 同义自动节点合并（同类别 + 同内容指纹）
  const groups = new Map<string, LongTermMemoryNode[]>()
  for (const node of nodes) {
    if (node.source !== 'auto_inferred') continue
    const key = `${node.category}:${fingerprint(node.content)}`
    const group = groups.get(key) ?? []
    group.push(node)
    groups.set(key, group)
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const [keep, ...duplicates] = group
    if (!keep) continue
    let weightDelta = 0
    let maxConfidence = keep.confidence
    const tags = new Set(keep.tags)
    for (const duplicate of duplicates) {
      weightDelta += duplicate.weight
      maxConfidence = Math.max(maxConfidence, duplicate.confidence)
      for (const tag of duplicate.tags) tags.add(tag)
      removalIds.add(duplicate.id)
    }
    mutations.push({
      id: keep.id,
      weightDelta,
      confidenceDelta: maxConfidence - keep.confidence,
      tags: [...tags].slice(0, 8),
    })
    merged += 1
  }

  // 2. 时间衰减与弱记忆淘汰（仅自动节点）
  for (const node of nodes) {
    if (node.source !== 'auto_inferred' || removalIds.has(node.id)) continue
    const idleDays = Math.max(0, (now - node.updatedAt) / 86_400_000)
    if (idleDays < 1) continue

    const nextWeight = round3(node.weight * 0.5 ** (idleDays / DECAY_HALF_LIFE_DAYS))
    if (nextWeight < node.weight) {
      // 衰减不是活跃行为：禁止刷新 updatedAt，否则 idleDays 永远归零、淘汰条件永不达成
      mutations.push({ id: node.id, weightDelta: nextWeight - node.weight, touchUpdatedAt: false })
      decayed += 1
    }

    if (
      nextWeight < REMOVE_WEIGHT_THRESHOLD &&
      node.confidence < REMOVE_CONFIDENCE_THRESHOLD &&
      idleDays > REMOVE_AGE_DAYS
    ) {
      removalIds.add(node.id)
    }
  }

  if (mutations.length > 0) {
    await applyLongTermMemoryMutations(mutations, [], graphPath)
  }

  let removed = 0
  for (const id of removalIds) {
    try {
      if (await deleteLongTermMemoryNode(id, graphPath)) removed += 1
    } catch (error) {
      console.warn('[长期记忆] 淘汰弱记忆失败（已跳过）:', error)
    }
  }

  return { merged, decayed, removed }
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** 空闲判定：不可用 electron 的测试环境视为空闲；省电模式或用户活跃时跳过 */
function isIdleForConsolidation(): boolean {
  try {
    const { powerMonitor } = require('electron') as typeof import('electron')
    if (!powerMonitor) return true
    if (powerMonitor.isOnBatteryPower()) return false
    return powerMonitor.getSystemIdleTime() >= IDLE_THRESHOLD_SEC
  } catch {
    return true
  }
}

let consolidationTimer: NodeJS.Timeout | null = null
let consolidationRunning = false

/**
 * 启动空闲期定时整合；返回停止函数。
 * 定时器 `.unref()`，不阻塞进程退出。
 */
export function startLongTermMemoryConsolidator(
  intervalMs: number = DEFAULT_CONSOLIDATION_INTERVAL_MS,
): () => void {
  if (consolidationTimer) {
    const existing = consolidationTimer
    return () => {
      clearInterval(existing)
      if (consolidationTimer === existing) consolidationTimer = null
    }
  }

  const timer = setInterval(() => {
    if (consolidationRunning || !isIdleForConsolidation()) return
    consolidationRunning = true
    void consolidateLongTermMemory()
      .catch((error) => console.warn('[长期记忆] 睡眠整合失败（已隔离）:', error))
      .finally(() => {
        consolidationRunning = false
      })
  }, Math.max(60_000, intervalMs))
  timer.unref?.()
  consolidationTimer = timer

  return () => {
    clearInterval(timer)
    if (consolidationTimer === timer) consolidationTimer = null
  }
}
