/**
 * 长期记忆图谱存储（Long-Term Memory Store）
 *
 * 职责：
 *   - 管理 `~/.cdutai/user-habit-graph.json` 的崩溃安全原子读写（复用 safe-file）；
 *   - 内存缓存 + 轻量 stat 指纹校验，外部编辑可被感知；
 *   - 所有写操作走模块内 Promise 串行队列，杜绝「手动编辑 / 后台反思 / 睡眠整合」
 *     三路并发时基于旧快照覆盖新写入。
 *
 * 严格红线：
 *   - 单文件 JSON，零数据库、零额外索引文件；
 *   - 读盘必须发生在写队列任务内部（不能先读快照再入队）。
 */

import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import type {
  LongTermMemoryCategory,
  LongTermMemoryGraph,
  LongTermMemoryNode,
  LongTermMemoryNodeInput,
} from '@profer/shared'
import { getLongTermMemoryGraphPath } from '../config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from '../safe-file'

// ===== 容量与校验常量 =====

/** 节点总数上限，超出时按 权重 × 置信度 淘汰自动节点 */
export const MAX_LONGTERM_MEMORY_NODES = 500
const MAX_TITLE_CHARS = 48
const MAX_CONTENT_CHARS = 800
const MAX_TAGS = 8
const MAX_TAG_CHARS = 24
/** 单节点权重上限，避免无限膨胀 */
const MAX_WEIGHT = 50
const DEFAULT_CONFIDENCE = 0.6

const VALID_CATEGORIES = new Set<LongTermMemoryCategory>([
  'coding_preference',
  'workflow_habit',
  'cdut_special_domain',
  'tool_affinity',
  'interaction_style',
])

// ===== 缓存与写队列 =====

interface CacheEntry {
  path: string
  /** `mtimeMs:size`，文件不存在时为 'missing' */
  stamp: string
  graph: LongTermMemoryGraph
}

let cache: CacheEntry | null = null
let writeChain: Promise<unknown> = Promise.resolve()

/** 串行执行写任务；前序失败不阻断后续任务 */
function enqueueWrite<T>(task: () => T | Promise<T>): Promise<T> {
  const run = writeChain.then(task, task)
  writeChain = run.catch(() => undefined)
  return run
}

function stampOf(graphPath: string): string {
  try {
    const stat = statSync(graphPath)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return 'missing'
  }
}

// ===== 归一化 =====

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const tags: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const tag = item.trim().slice(0, MAX_TAG_CHARS)
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    tags.push(tag)
    if (tags.length >= MAX_TAGS) break
  }
  return tags
}

function normalizeNode(raw: unknown, fallbackNow: number): LongTermMemoryNode | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const content = typeof obj.content === 'string' ? obj.content.trim() : ''
  if (!content) return null

  const category = VALID_CATEGORIES.has(obj.category as LongTermMemoryCategory)
    ? (obj.category as LongTermMemoryCategory)
    : 'interaction_style'

  const rawTitle = typeof obj.title === 'string' ? obj.title.trim() : ''
  const title = (rawTitle || content.slice(0, 24)).slice(0, MAX_TITLE_CHARS)

  const createdAt = typeof obj.createdAt === 'number' && Number.isFinite(obj.createdAt) ? obj.createdAt : fallbackNow
  const updatedAt = typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt) ? obj.updatedAt : createdAt

  return {
    id: typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : randomUUID(),
    category,
    title,
    content: content.length > MAX_CONTENT_CHARS ? `${content.slice(0, MAX_CONTENT_CHARS)}…` : content,
    tags: normalizeTags(obj.tags),
    weight: clamp(typeof obj.weight === 'number' ? obj.weight : 0, 0, MAX_WEIGHT),
    confidence: clamp(typeof obj.confidence === 'number' ? obj.confidence : DEFAULT_CONFIDENCE, 0, 1),
    createdAt,
    updatedAt,
    source: obj.source === 'user_manual' ? 'user_manual' : 'auto_inferred',
  }
}

/** 超限时优先淘汰「权重 × 置信度」最低的自动节点，用户手动节点永不淘汰 */
function capNodes(nodes: LongTermMemoryNode[]): LongTermMemoryNode[] {
  if (nodes.length <= MAX_LONGTERM_MEMORY_NODES) return nodes
  const auto = nodes
    .filter((node) => node.source === 'auto_inferred')
    .sort((a, b) => a.weight * a.confidence - b.weight * b.confidence)
  const overflow = nodes.length - MAX_LONGTERM_MEMORY_NODES
  const evicted = new Set(auto.slice(0, overflow).map((node) => node.id))
  return nodes.filter((node) => !evicted.has(node.id))
}

function normalizeGraph(raw: unknown): LongTermMemoryGraph {
  const now = Date.now()
  if (!raw || typeof raw !== 'object') {
    return { version: 1, updatedAt: now, nodes: [] }
  }
  const obj = raw as Record<string, unknown>
  const list = Array.isArray(obj.nodes) ? obj.nodes : []
  const nodes: LongTermMemoryNode[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const node = normalizeNode(item, now)
    if (!node || seen.has(node.id)) continue
    seen.add(node.id)
    nodes.push(node)
  }
  return {
    version: 1,
    updatedAt: typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt) ? obj.updatedAt : now,
    nodes: capNodes(nodes),
  }
}

function cloneGraph(graph: LongTermMemoryGraph): LongTermMemoryGraph {
  return {
    version: 1,
    updatedAt: graph.updatedAt,
    nodes: graph.nodes.map((node) => ({ ...node, tags: [...node.tags] })),
  }
}

function persistGraph(graphPath: string, graph: LongTermMemoryGraph): void {
  writeJsonFileAtomic(graphPath, graph)
  cache = { path: graphPath, stamp: stampOf(graphPath), graph }
}

/** 标题归一化，用于同类别下的写入期去重（弥补读-写间隙） */
function normalizeTitleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。；、：！？,.;:!?'"“”‘’（）()\[\]【】]/g, '')
}

// ===== 只读 API =====

/** 读取全量图谱（缺失或损坏时返回空图谱，不写盘） */
export function readLongTermMemoryGraph(graphPath: string = getLongTermMemoryGraphPath()): LongTermMemoryGraph {
  const stamp = stampOf(graphPath)
  if (cache && cache.path === graphPath && cache.stamp === stamp) {
    return cache.graph
  }
  const raw = readJsonFileSafe<unknown>(graphPath)
  const graph = normalizeGraph(raw)
  cache = { path: graphPath, stamp, graph }
  return graph
}

/** 按权重降序返回节点副本 */
export function listLongTermMemoryNodes(graphPath: string = getLongTermMemoryGraphPath()): LongTermMemoryNode[] {
  return [...readLongTermMemoryGraph(graphPath).nodes]
    .sort((a, b) => b.weight * b.confidence - a.weight * a.confidence)
    .map((node) => ({ ...node, tags: [...node.tags] }))
}

// ===== 写 API（全部串行） =====

/** 手动新增节点（来源固定为 user_manual） */
export function addLongTermMemoryNode(
  input: LongTermMemoryNodeInput,
  graphPath: string = getLongTermMemoryGraphPath(),
): Promise<LongTermMemoryNode> {
  return enqueueWrite(() => {
    const graph = cloneGraph(readLongTermMemoryGraph(graphPath))
    const now = Date.now()
    const node = normalizeNode(
      {
        id: randomUUID(),
        category: input.category,
        title: input.title,
        content: input.content,
        tags: input.tags ?? [],
        weight: 1,
        confidence: input.confidence ?? DEFAULT_CONFIDENCE,
        createdAt: now,
        updatedAt: now,
        source: 'user_manual',
      },
      now,
    )
    if (!node) throw new Error('记忆内容不能为空')
    graph.nodes.push(node)
    graph.updatedAt = now
    persistGraph(graphPath, capGraphNodes(graph))
    return node
  })
}

export type LongTermMemoryNodePatch = Partial<
  Pick<LongTermMemoryNode, 'category' | 'title' | 'content' | 'tags' | 'confidence'>
>

/** 局部更新节点；不存在返回 null */
export function updateLongTermMemoryNode(
  nodeId: string,
  patch: LongTermMemoryNodePatch,
  graphPath: string = getLongTermMemoryGraphPath(),
): Promise<LongTermMemoryNode | null> {
  return enqueueWrite(() => {
    const graph = cloneGraph(readLongTermMemoryGraph(graphPath))
    const index = graph.nodes.findIndex((node) => node.id === nodeId)
    if (index < 0) return null

    const now = Date.now()
    const merged = normalizeNode(
      {
        ...graph.nodes[index],
        ...patch,
        id: nodeId,
        source: graph.nodes[index]!.source,
        createdAt: graph.nodes[index]!.createdAt,
        updatedAt: now,
      },
      now,
    )
    if (!merged) return null

    graph.nodes[index] = merged
    graph.updatedAt = now
    persistGraph(graphPath, capGraphNodes(graph))
    return merged
  })
}

/** 删除节点；返回是否真的删除了 */
export function deleteLongTermMemoryNode(
  nodeId: string,
  graphPath: string = getLongTermMemoryGraphPath(),
): Promise<boolean> {
  return enqueueWrite(() => {
    const graph = cloneGraph(readLongTermMemoryGraph(graphPath))
    const nextNodes = graph.nodes.filter((node) => node.id !== nodeId)
    if (nextNodes.length === graph.nodes.length) return false
    graph.nodes = nextNodes
    graph.updatedAt = Date.now()
    persistGraph(graphPath, graph)
    return true
  })
}

/** 单条增量变更（反思器批量提交用） */
export interface LongTermMemoryMutation {
  id: string
  weightDelta?: number
  confidenceDelta?: number
  title?: string
  content?: string
  tags?: string[]
  /**
   * 是否刷新 updatedAt（默认 true）。
   * 仅时间衰减等「非活跃」变更需显式传 false，否则空闲天数会被重置，弱记忆永远无法淘汰。
   */
  touchUpdatedAt?: boolean
}

/** 批量创建入参：允许内部指定初始权重（如本轮工具被调用 3 次） */
export interface LongTermMemoryCreateInput extends LongTermMemoryNodeInput {
  weight?: number
}

/**
 * 批量增量写入：只读一次盘、只写一次盘。
 * `creates` 中若存在同类别同标题的节点，则自动转为权重提升，避免读-写间隙重复创建。
 */
export function applyLongTermMemoryMutations(
  mutations: LongTermMemoryMutation[],
  creates: LongTermMemoryCreateInput[] = [],
  graphPath: string = getLongTermMemoryGraphPath(),
): Promise<void> {
  return enqueueWrite(() => {
    const graph = cloneGraph(readLongTermMemoryGraph(graphPath))
    const now = Date.now()
    let changed = false

    for (const mutation of mutations) {
      const node = graph.nodes.find((item) => item.id === mutation.id)
      if (!node) continue
      let dirty = false
      if (mutation.weightDelta) {
        node.weight = clamp(node.weight + mutation.weightDelta, 0, MAX_WEIGHT)
        dirty = true
      }
      if (mutation.confidenceDelta) {
        node.confidence = clamp(node.confidence + mutation.confidenceDelta, 0, 1)
        dirty = true
      }
      if (mutation.title) {
        node.title = mutation.title.slice(0, MAX_TITLE_CHARS)
        dirty = true
      }
      if (mutation.content) {
        node.content = mutation.content.slice(0, MAX_CONTENT_CHARS)
        dirty = true
      }
      if (mutation.tags) {
        node.tags = normalizeTags(mutation.tags)
        dirty = true
      }
      if (dirty) {
        if (mutation.touchUpdatedAt !== false) node.updatedAt = now
        changed = true
      }
    }

    for (const input of creates) {
      const candidate = normalizeNode(
        {
          id: randomUUID(),
          category: input.category,
          title: input.title,
          content: input.content,
          tags: input.tags ?? [],
          weight: typeof input.weight === 'number' ? input.weight : 1,
          confidence: input.confidence ?? DEFAULT_CONFIDENCE,
          createdAt: now,
          updatedAt: now,
          source: 'auto_inferred',
        },
        now,
      )
      if (!candidate) continue

      const titleKey = normalizeTitleKey(candidate.title)
      const existing = graph.nodes.find(
        (node) => node.category === candidate.category && normalizeTitleKey(node.title) === titleKey,
      )
      if (existing) {
        existing.weight = clamp(existing.weight + 1, 0, MAX_WEIGHT)
        existing.confidence = clamp(existing.confidence + 0.05, 0, 1)
        existing.updatedAt = now
      } else {
        graph.nodes.push(candidate)
      }
      changed = true
    }

    if (!changed) return
    graph.updatedAt = now
    persistGraph(graphPath, capGraphNodes(graph))
  })
}

function capGraphNodes(graph: LongTermMemoryGraph): LongTermMemoryGraph {
  const capped = capNodes(graph.nodes)
  return capped.length === graph.nodes.length ? graph : { ...graph, nodes: capped }
}

/** 仅供测试：等待写队列排空后清空缓存 */
export function resetLongTermMemoryCache(): Promise<void> {
  return enqueueWrite(() => {
    cache = null
  })
}
