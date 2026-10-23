/**
 * 长期记忆图谱（用户习惯与偏好）
 *
 * 纯本地端侧记忆：全部数据落盘于 `~/.cdutai/user-habit-graph.json`，
 * 主进程内存中维护纯内存 BM25 倒排索引，不引入任何数据库。
 *
 * 契约要点：
 *   - 节点是唯一事实源；节点之间的关联由共享 `tags` 动态推导，不落盘死边；
 *   - 权重 `weight` 表示命中/验证次数，置信度 `confidence` 表示可信程度；
 *   - 用户手动编辑的节点（`user_manual`）永不被自动淘汰。
 */

/** 记忆节点类别 */
export type LongTermMemoryCategory =
  | 'coding_preference'
  | 'workflow_habit'
  | 'cdut_special_domain'
  | 'tool_affinity'
  | 'interaction_style'

/** 记忆来源：规则/模型自主提炼 | 用户手动添加 */
export type LongTermMemorySource = 'auto_inferred' | 'user_manual'

/** 单个长期记忆/习惯实体节点 */
export interface LongTermMemoryNode {
  id: string
  category: LongTermMemoryCategory
  title: string
  content: string
  /** 关联实体标签，用于图关联与扩展召回 */
  tags: string[]
  /** 触发与命中权重（每次被验证或提及自动累加，>= 0） */
  weight: number
  /** 置信度 0~1 */
  confidence: number
  createdAt: number
  updatedAt: number
  source: LongTermMemorySource
}

/** 长期记忆图谱根数据结构 */
export interface LongTermMemoryGraph {
  version: 1
  updatedAt: number
  nodes: LongTermMemoryNode[]
}

/** 检索命中项 */
export interface LongTermMemoryHit {
  node: LongTermMemoryNode
  score: number
  excerpt: string
}

/** 新建/编辑入参（id、时间戳、权重由主进程托管） */
export interface LongTermMemoryNodeInput {
  category: LongTermMemoryCategory
  title: string
  content: string
  tags?: string[]
  confidence?: number
}

/** 类别元信息：UI 中文标签、提示词英文标签与视觉主色 */
export const LONGTERM_MEMORY_CATEGORY_META: Record<
  LongTermMemoryCategory,
  { label: string; promptLabel: string; accent: string }
> = {
  coding_preference: { label: '编码偏好', promptLabel: 'Coding Style', accent: 'emerald' },
  workflow_habit: { label: '解法范式', promptLabel: 'Workflow Habit', accent: 'violet' },
  cdut_special_domain: { label: '校园高频', promptLabel: 'CDUT Domain', accent: 'sky' },
  tool_affinity: { label: '工具习惯', promptLabel: 'Tool Habit', accent: 'amber' },
  interaction_style: { label: '交互风格', promptLabel: 'Interaction Style', accent: 'rose' },
}

/** 全部类别（UI 遍历顺序固定） */
export const LONGTERM_MEMORY_CATEGORIES: LongTermMemoryCategory[] = [
  'coding_preference',
  'workflow_habit',
  'cdut_special_domain',
  'tool_affinity',
  'interaction_style',
]

export const LONGTERM_MEMORY_IPC_CHANNELS = {
  /** 读取全量长期记忆图谱 */
  READ_GRAPH: 'longterm-memory:read-graph',
  /** 手动新增记忆节点 */
  ADD_NODE: 'longterm-memory:add-node',
  /** 更新单个记忆节点 */
  UPDATE_NODE: 'longterm-memory:update-node',
  /** 删除记忆节点 */
  DELETE_NODE: 'longterm-memory:delete-node',
  /** 检索测试（供星图面板即时模拟 RAG 命中） */
  QUERY_TEST: 'longterm-memory:query-test',
  /** 图谱变更广播（多窗口同步） */
  CHANGED: 'longterm-memory:changed',
} as const
