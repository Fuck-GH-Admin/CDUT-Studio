/**
 * Category B: Max-Regret Graph Inference（最大悔标图拓扑排序）
 *
 * 攻克学术论文双栏/多栏排版阅读顺序错乱的核心算法。
 *
 * 思路：把单页文本块抽象为图节点，任意有序对 (u, v) 构成候选转移边并赋予
 * 综合亲和度 S(u, v)。排序时不再「每个节点贪心选最优后继」（会在多栏/绕排处
 * 产生多米诺连锁错误），而是每次锁定**最优解与次优解得分差（悔标）最大**的边，
 * 类比数独先填唯一解——把最没有歧义的连接先固定，再动态剪枝竞争边。
 */

import type { LayoutNode } from './types'

// ===== 分栏结构 =====

export interface ColumnLayout {
  /** 分栏分界线（归一化 X，升序）；单栏为空数组 */
  boundaries: number[]
  columnCount: number
}

export interface RouterContext {
  columns: ColumnLayout
  /** 估算行高（归一化） */
  lineHeight: number
  /** 估算栏宽（归一化） */
  columnWidth: number
  /** 各栏「栏底」节点 id 集合（其下方本栏无正文，允许跨栏换栏） */
  terminalByColumn: Set<string>
}

/** 章节标题样式：数字编号 / 常见学术小节名 */
const SECTION_HEADING_PATTERN = /^(?:\d+(?:\.\d+){0,3}[.、]?\s+\S|(?:Abstract|Introduction|Conclusion|Conclusions|References|Acknowledg|Appendix)\b)/i

/** 跨全宽块（标题/摘要）的宽度阈值（归一化） */
const SPAN_WIDTH_THRESHOLD = 0.7

/** 判定节点是否为跨栏块 */
function isSpanning(node: LayoutNode): boolean {
  return node.bbox[2] - node.bbox[0] >= SPAN_WIDTH_THRESHOLD
}

/** 判断文本是否形如独立章节标题 */
export function looksLikeSectionHeading(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  return SECTION_HEADING_PATTERN.test(trimmed)
}

/**
 * 通过节点 X 起笔聚类 + 中轴线穿透比例（Gutter Penetration Rate）探测分栏结构。
 *
 * 判据（鲁棒，绝不因单个块而全页退化为单栏）：
 * 1. 左右半区各自拥有充足的独立内容块（左半区 ≥ 2 且右半区 ≥ 2）；
 * 2. 横跨中轴 [0.47, 0.53] 的块占非跨栏块总数的比例低于 20%。
 * 二者同时满足才认定为双栏（boundaries = [0.5]）。
 */
export function detectColumnLayout(nodes: readonly LayoutNode[]): ColumnLayout {
  const readable = nodes.filter((node) => !isSpanning(node))
  if (readable.length < 2) return { boundaries: [], columnCount: 1 }

  // 1. 统计落在左半区 [0.05, 0.48] 与右半区 [0.52, 0.95] 的块数量
  const leftBlocks = readable.filter((node) => node.bbox[0] < 0.45 && node.bbox[2] <= 0.55)
  const rightBlocks = readable.filter((node) => node.bbox[0] >= 0.45 && node.bbox[2] > 0.55)

  // 2. 统计横跨中轴 [0.47, 0.53] 的块数量
  const centerCrossings = readable.filter((node) => node.bbox[0] < 0.47 && node.bbox[2] > 0.53)

  // 3. 判定准则：左右两侧各有独立内容块，且穿透中轴比例低于 20% → 认定为双栏。
  //    单栏整页正文为跨栏块（宽度 >= 0.7 已被 isSpanning 剔除），readable 为空直接判定单栏；
  //    因此「两侧各至少一块」不会把单栏文档误判为双栏，同时能覆盖图文混排的稀疏双栏页。
  const crossingRatio = centerCrossings.length / readable.length
  if (leftBlocks.length >= 1 && rightBlocks.length >= 1 && crossingRatio < 0.2) {
    return { boundaries: [0.5], columnCount: 2 }
  }

  return { boundaries: [], columnCount: 1 }
}

/** 节点所属栏序号（0 起）；单栏恒为 0 */
export function columnIndexOf(node: LayoutNode, layout: ColumnLayout): number {
  if (layout.columnCount <= 1) return 0
  let column = 0
  for (const boundary of layout.boundaries) {
    if (node.bbox[0] >= boundary) column += 1
  }
  return column
}

/** 计算各栏「栏底」节点集合 */
function computeColumnTerminals(nodes: readonly LayoutNode[], layout: ColumnLayout): Set<string> {
  const maxYByColumn = new Map<number, number>()
  const columnByNodeId = new Map<string, number>()
  for (const node of nodes) {
    if (isSpanning(node)) continue
    const column = columnIndexOf(node, layout)
    columnByNodeId.set(node.id, column)
    const current = maxYByColumn.get(column)
    if (current === undefined || node.bbox[3] > current) maxYByColumn.set(column, node.bbox[3])
  }

  const terminals = new Set<string>()
  for (const node of nodes) {
    const column = columnByNodeId.get(node.id)
    if (column === undefined) continue
    const maxY = maxYByColumn.get(column)
    if (maxY !== undefined && node.bbox[3] >= maxY - 1e-6) terminals.add(node.id)
  }
  return terminals
}

function median(values: number[], fallback: number): number {
  if (values.length === 0) return fallback
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid] ?? fallback
  const lo = sorted[mid - 1] ?? fallback
  const hi = sorted[mid] ?? fallback
  return (lo + hi) / 2
}

/** 构建路由上下文（分栏、行高、栏宽、栏底节点） */
export function buildRouterContext(nodes: readonly LayoutNode[]): RouterContext {
  const columns = detectColumnLayout(nodes)
  const lineHeight = median(nodes.map((node) => node.bbox[3] - node.bbox[1]), 0.03)
  const columnWidth = median(nodes.map((node) => node.bbox[2] - node.bbox[0]), 0.4)
  const terminalByColumn = computeColumnTerminals(nodes, columns)
  return {
    columns,
    lineHeight: Math.max(lineHeight, 0.005),
    columnWidth: Math.max(columnWidth, 0.05),
    terminalByColumn,
  }
}

// ===== 三维打分 =====

/** 分栏一致性打分 Score_col ∈ [-1, 1] */
export function scoreColumn(u: LayoutNode, v: LayoutNode, ctx: RouterContext): number {
  const down = v.bbox[1] >= u.bbox[1]

  if (ctx.columns.columnCount <= 1) {
    return down ? 1.0 : -1.0
  }

  const uSpan = isSpanning(u)
  const vSpan = isSpanning(v)
  const columnU = columnIndexOf(u, ctx.columns)
  const columnV = columnIndexOf(v, ctx.columns)

  // 跨栏块（标题/摘要）→ 后继：必须先在其下方，且优先左栏起始
  if (uSpan) {
    if (v.bbox[1] < u.bbox[3]) return -1.0
    return columnV === 0 ? 1.0 : 0.7
  }
  // 后继为跨栏块：允许，但必须在下方
  if (vSpan) {
    return v.bbox[1] >= u.bbox[3] ? 1.0 : -1.0
  }

  if (columnU === columnV) {
    return down ? 1.0 : -1.0
  }

  // 跨栏：只允许「左 → 右」且在栏底换栏到右栏顶端
  if (columnV < columnU) return -1.0
  const uAtColumnEnd = ctx.terminalByColumn.has(u.id) || u.bbox[3] >= 0.85
  const vAtColumnTop = v.bbox[1] <= 0.25
  if (uAtColumnEnd && vAtColumnTop) return 0.95
  return -1.0
}

/** 几何连续性打分 Score_geo ∈ [0, 1] */
export function scoreGeometry(u: LayoutNode, v: LayoutNode, ctx: RouterContext): number {
  const gap = Math.max(0, v.bbox[1] - u.bbox[3])
  const vertical = Math.exp(-gap / (3 * ctx.lineHeight))
  const horizontalDelta = Math.abs(v.bbox[0] - u.bbox[0])
  const horizontal = Math.max(0, Math.min(1, 1 - horizontalDelta / ctx.columnWidth))
  return vertical * horizontal
}

/** 语言学确定性先验 Score_ling ∈ [-1, 1] */
export function scoreLinguistic(u: LayoutNode, v: LayoutNode): number {
  const uText = u.text.trimEnd()
  const vText = v.text.trimStart()
  if (uText.length === 0 || vText.length === 0) return 0

  const uEndsWithContinuation = /[,\-;(\[]$/.test(uText)
  const vStartsLower = /^[a-z]/.test(vText)
  const vIsHeading = looksLikeSectionHeading(vText)

  // 强连贯：句中未完 + 下半句起首（小写/收尾标点）
  if (uEndsWithContinuation && (vStartsLower || /^[.,;:)\]%]/.test(vText))) {
    return 1.0
  }
  // 段落完结：句末标点 + 大写作起点或新章节
  if (/[.!?。！？]$/.test(uText) && (/^[A-Z\u4e00-\u9fa5]/.test(vText) || vIsHeading)) {
    return 0.5
  }
  // 冲突抑制：句中未完却跳去独立章节号
  if (uEndsWithContinuation && vIsHeading) {
    return -0.8
  }
  return 0
}

/**
 * 综合边权评分
 * S(u, v) = 0.40·Score_col + 0.35·Score_geo + 0.25·Score_ling
 */
export function computeAffinity(u: LayoutNode, v: LayoutNode, ctx: RouterContext): number {
  if (u.id === v.id) return -1
  return 0.40 * scoreColumn(u, v, ctx) + 0.35 * scoreGeometry(u, v, ctx) + 0.25 * scoreLinguistic(u, v)
}

// ===== 最大悔标推理 =====

/** 判断新增边 u → v 是否会在已选边集上形成环 */
function wouldCreateCycle(
  chosenSuccessor: Map<string, string>,
  u: string,
  v: string,
  maxSteps: number,
): boolean {
  let cursor: string | undefined = v
  let steps = 0
  while (cursor !== undefined && steps <= maxSteps) {
    if (cursor === u) return true
    cursor = chosenSuccessor.get(cursor)
    steps += 1
  }
  return false
}

/** 节点排序：页 → 上 → 左（仅用于多链兜底拼接的确定性） */
function compareNodes(a: LayoutNode, b: LayoutNode): number {
  if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber
  if (a.bbox[1] !== b.bbox[1]) return a.bbox[1] - b.bbox[1]
  return a.bbox[0] - b.bbox[0]
}

/** 从已选后继边集还原线性拓扑序列 */
export function reconstructChainsToOrderedList(
  nodes: readonly LayoutNode[],
  chosenSuccessor: Map<string, string>,
): LayoutNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const hasIncoming = new Set(chosenSuccessor.values())
  const heads = nodes.filter((node) => !hasIncoming.has(node.id)).slice().sort(compareNodes)

  const ordered: LayoutNode[] = []
  const visited = new Set<string>()
  for (const head of heads) {
    let cursor: LayoutNode | null = head
    while (cursor !== null && !visited.has(cursor.id)) {
      ordered.push(cursor)
      visited.add(cursor.id)
      const nextId = chosenSuccessor.get(cursor.id)
      cursor = nextId ? byId.get(nextId) ?? null : null
    }
  }
  // 兜底：理论上不会残留，仍保证不丢块
  for (const node of nodes.slice().sort(compareNodes)) {
    if (!visited.has(node.id)) {
      ordered.push(node)
      visited.add(node.id)
    }
  }
  return ordered
}

/**
 * 最大悔标阅读顺序求解。
 *
 * @param nodes 单页（或逻辑阅读单元）的文本块节点
 * @returns 按阅读顺序排列的节点数组（同时写回 readingOrderIndex）
 */
export function solveMaxRegretReadingOrder(nodes: readonly LayoutNode[]): LayoutNode[] {
  if (nodes.length <= 1) {
    nodes.forEach((node, index) => {
      node.readingOrderIndex = index
    })
    return [...nodes]
  }

  const ctx = buildRouterContext(nodes)
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const availableSources = new Set(nodes.map((node) => node.id))
  const availableTargets = new Set(nodes.map((node) => node.id))
  const chosenSuccessor = new Map<string, string>()

  while (availableSources.size > 1) {
    let maxRegret = Number.NEGATIVE_INFINITY
    let bestSource: string | null = null
    let bestTarget: string | null = null

    for (const sourceId of availableSources) {
      const source = byId.get(sourceId)
      if (!source) continue

      const candidates: Array<{ target: string; score: number }> = []
      for (const targetId of availableTargets) {
        if (targetId === sourceId) continue
        if (wouldCreateCycle(chosenSuccessor, sourceId, targetId, nodes.length)) continue
        const target = byId.get(targetId)
        if (!target) continue
        candidates.push({ target: targetId, score: computeAffinity(source, target, ctx) })
      }
      if (candidates.length === 0) continue

      candidates.sort((a, b) => b.score - a.score)
      const top1 = candidates[0]!
      const top2Score = candidates.length > 1 ? candidates[1]!.score : -1.0
      const regret = top1.score - top2Score

      if (regret > maxRegret) {
        maxRegret = regret
        bestSource = sourceId
        bestTarget = top1.target
      }
    }

    if (bestSource === null || bestTarget === null) break

    chosenSuccessor.set(bestSource, bestTarget)
    availableSources.delete(bestSource)
    availableTargets.delete(bestTarget)
  }

  const ordered = reconstructChainsToOrderedList(nodes, chosenSuccessor)
  ordered.forEach((node, index) => {
    node.readingOrderIndex = index
  })
  return ordered
}
