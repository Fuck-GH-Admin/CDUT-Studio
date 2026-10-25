/**
 * Category B: Max-Regret Graph Inference（最大悔标图拓扑排序）+ 分栏拓扑分析
 *
 * 攻克学术论文单栏/双栏/三栏/非对称分栏、栏间浮动图表穿插导致阅读顺序错乱的核心算法。
 *
 * 两层结构：
 * 1. **版面拓扑**（Column Topology）：投影直方图深谷搜索 → 多峰确定性 K-Means 自适应定栏数
 *    → 非对称 ColumnSpan → 水平分带（Band Decomposition），把页面切成自顶向下的阅读带；
 * 2. **带内排序**（Max-Regret）：把带内文本块抽象为图节点，任意有序对 (u, v) 赋综合亲和度
 *    S(u, v)，每次锁定「最优解与次优解得分差（悔标）最大」的边，类比数独先填唯一解。
 *
 * 关键护栏（历史缺陷的根因修复）：
 * - 页眉/页脚在进入分带与投影聚类前被剔除，否则整页顶部与底部会被误判为跨栏通栏块，
 *   切出碎片带并污染栏位投影直方图；
 * - 分带拓扑逐带隔离求解，跨栏大图下方的正文不再被提前吸附到右栏顶部。
 */

import type { LayoutNode } from './types'

// ===== 分栏结构 =====

/** 单栏的独立物理范围（支撑左宽右窄等非对称分栏） */
export interface ColumnSpan {
  index: number
  x0: number
  x1: number
}

export interface ColumnLayout {
  /** 每栏独立物理范围 */
  columns: ColumnSpan[]
  /** 栏界（归一化 X，升序）；单栏为空数组 */
  boundaries: number[]
  columnCount: number
}

/** 水平阅读带：由跨栏浮动块切出的、内部栏结构一致的垂直区间 */
export interface HorizontalBand {
  index: number
  y0: number
  y1: number
  columnCount: number
  columns: ColumnSpan[]
  nodeIds: string[]
}

export interface RouterContext {
  columns: ColumnLayout
  /** 估算行高（归一化） */
  lineHeight: number
  /** 估算栏宽（归一化，兜底用） */
  columnWidth: number
  /** 各栏实际栏宽（归一化），用于非对称分栏下的水平偏差归一化 */
  columnWidthByIndex: number[]
  /** 各栏「栏底」节点 id 集合（其下方本栏无正文，允许跨栏换栏） */
  terminalByColumn: Set<string>
  /** 当前带的垂直范围（归一化页面坐标） */
  bandY0: number
  bandY1: number
}

/** 章节标题样式：数字编号 / 常见学术小节名 */
const SECTION_HEADING_PATTERN = /^(?:\d+(?:\.\d+){0,3}[.、]?\s+\S|(?:Abstract|Introduction|Conclusion|Conclusions|References|Acknowledg|Appendix)\b)/i

/** 跨全宽块（标题/摘要/通栏图表）的宽度阈值（归一化） */
const SPAN_WIDTH_THRESHOLD = 0.7

/** 判定节点是否为跨栏块 */
export function isSpanning(node: LayoutNode): boolean {
  return node.bbox[2] - node.bbox[0] >= SPAN_WIDTH_THRESHOLD
}

/** 判断文本是否形如独立章节标题 */
export function looksLikeSectionHeading(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  return SECTION_HEADING_PATTERN.test(trimmed)
}

// ===== 页眉/页脚快速过滤（必须先于水平分带执行） =====

/**
 * 只保留真正属于正文区域的候选节点。
 *
 * 页眉（readingStreamId < 0 / kind 'header'、'footer'）若混入分带，会被误判为跨栏通栏块，
 * 在每页顶部与底部强行切出碎片带，并把投影直方图拉平到全页宽。
 */
function filterBodyNodes(nodes: readonly LayoutNode[]): LayoutNode[] {
  return nodes.filter(
    (node) => node.readingStreamId >= 0 && node.kind !== 'header' && node.kind !== 'footer',
  )
}

// ===== 版面拓扑：投影直方图 + 深谷搜索 =====

export interface ProjectionProfile {
  bins: number[]
  binCount: number
  binWidth: number
}

export interface DeepValley {
  x0: number
  x1: number
  /** 谷深：1 - 谷内均值 / 全局峰值 */
  depth: number
}

const DEFAULT_PROFILE_BINS = 128
/** 高斯平滑标准差（单位：bin），用于滤除行内小字距空隙噪声 */
const GAUSSIAN_SIGMA = 1.5
/** 判定深谷的密度上限（相对全局峰值） */
const VALLEY_DENSITY_RATIO = 0.08
/** 最小栏间距（归一化），低于此宽度的空隙不视为真实栏隙 */
const MIN_GUTTER_WIDTH = 0.015
/** 版面有效区左右裁剪，页面外白边不算栏隙 */
const LAYOUT_X_MIN = 0.04
const LAYOUT_X_MAX = 0.96

/** 计算节点集合的 X 轴投影直方图（墨迹密度） */
export function computeXProjectionProfile(
  nodes: readonly LayoutNode[],
  binCount: number = DEFAULT_PROFILE_BINS,
): ProjectionProfile {
  const size = Math.max(8, Math.floor(binCount))
  const bins = new Array<number>(size).fill(0)
  for (const node of nodes) {
    const x0 = Math.min(1, Math.max(0, node.bbox[0]))
    const x1 = Math.min(1, Math.max(0, node.bbox[2]))
    if (x1 <= x0) continue
    const start = Math.min(size - 1, Math.max(0, Math.floor(x0 * size)))
    const end = Math.min(size - 1, Math.max(0, Math.floor(x1 * size)))
    const span = end - start + 1
    if (span <= 0) continue
    const weight = 1 / span
    for (let i = start; i <= end; i += 1) {
      bins[i] = (bins[i] ?? 0) + weight
    }
  }
  return { bins, binCount: size, binWidth: 1 / size }
}

/** 一维高斯平滑（核半径 3σ，边界截断） */
export function gaussianSmooth(bins: readonly number[], sigma = GAUSSIAN_SIGMA): number[] {
  const radius = Math.max(1, Math.ceil(3 * sigma))
  const kernel: number[] = []
  let kernelSum = 0
  for (let offset = -radius; offset <= radius; offset += 1) {
    const weight = Math.exp(-(offset * offset) / (2 * sigma * sigma))
    kernel.push(weight)
    kernelSum += weight
  }
  const normalized = kernel.map((weight) => weight / kernelSum)

  return bins.map((_, index) => {
    let acc = 0
    for (let offset = -radius; offset <= radius; offset += 1) {
      const source = index + offset
      if (source < 0 || source >= bins.length) continue
      acc += (bins[source] ?? 0) * (normalized[offset + radius] ?? 0)
    }
    return acc
  })
}

/**
 * 搜索深谷（Deep Valleys）：平滑后密度为邻域极小且接近 0 的连续区间，
 * 宽度需大于最小栏间距阈值，用于精确捕获真实栏隙的位置与宽度。
 */
export function findDeepValleys(
  profile: ProjectionProfile,
  opts: { minGutter?: number; densityRatio?: number } = {},
): DeepValley[] {
  const minGutter = opts.minGutter ?? MIN_GUTTER_WIDTH
  const densityRatio = opts.densityRatio ?? VALLEY_DENSITY_RATIO
  const smoothed = gaussianSmooth(profile.bins)

  let peak = 0
  for (const value of smoothed) {
    if (value > peak) peak = value
  }
  if (peak <= 0) return []
  const threshold = peak * densityRatio

  const valleys: DeepValley[] = []
  let runStart = -1

  const flushRun = (runEnd: number): void => {
    const start = runStart
    runStart = -1
    if (start < 0 || runEnd < start) return
    const x0 = start * profile.binWidth
    const x1 = (runEnd + 1) * profile.binWidth
    // 页面左右外白边不是栏隙
    if (x1 <= LAYOUT_X_MIN || x0 >= LAYOUT_X_MAX) return
    if (x1 - x0 < minGutter) return
    let sum = 0
    for (let k = start; k <= runEnd; k += 1) sum += smoothed[k] ?? 0
    valleys.push({ x0, x1, depth: 1 - sum / (runEnd - start + 1) / peak })
  }

  for (let i = 0; i < smoothed.length; i += 1) {
    if ((smoothed[i] ?? 0) <= threshold) {
      if (runStart < 0) runStart = i
    } else {
      flushRun(i - 1)
    }
  }
  flushRun(smoothed.length - 1)
  return valleys
}

// ===== 动态多峰 K-Means 栏线聚类 =====

/** 单栏最少块数；多栏时每栏至少 2 块，杜绝零散块被误判为独立栏 */
const MIN_BLOCKS_PER_COLUMN = 2
/** 谷点支撑度的权重 */
const VALLEY_SUPPORT_WEIGHT = 0.25
/** 栏数复杂度惩罚（偏向更简单的版面） */
const COLUMN_COMPLEXITY_PENALTY = 0.1
/** K-Means 最大迭代轮数（确定性，无随机数） */
const KMEANS_MAX_ITER = 20

interface KMeans1dResult {
  centers: number[]
  assignment: number[]
}

function kmeans1d(values: readonly number[], k: number): KMeans1dResult {
  if (values.length === 0 || k <= 0) return { centers: [], assignment: [] }
  const sorted = [...values].sort((a, b) => a - b)
  const centers = Array.from(
    { length: k },
    (_, i) => sorted[Math.floor(((i + 0.5) / k) * sorted.length)] ?? 0,
  )
  const assignment = new Array<number>(values.length).fill(0)

  for (let iter = 0; iter < KMEANS_MAX_ITER; iter += 1) {
    let changed = false
    for (let i = 0; i < values.length; i += 1) {
      const value = values[i] ?? 0
      let best = 0
      let bestDist = Number.POSITIVE_INFINITY
      for (let c = 0; c < k; c += 1) {
        const dist = Math.abs(value - (centers[c] ?? 0))
        if (dist < bestDist) {
          bestDist = dist
          best = c
        }
      }
      if (assignment[i] !== best) {
        assignment[i] = best
        changed = true
      }
    }

    const sums = new Array<number>(k).fill(0)
    const counts = new Array<number>(k).fill(0)
    for (let i = 0; i < values.length; i += 1) {
      const c = assignment[i] ?? 0
      sums[c] = (sums[c] ?? 0) + (values[i] ?? 0)
      counts[c] = (counts[c] ?? 0) + 1
    }
    for (let c = 0; c < k; c += 1) {
      if ((counts[c] ?? 0) > 0) centers[c] = (sums[c] ?? 0) / (counts[c] ?? 1)
    }
    if (!changed) break
  }
  return { centers, assignment }
}

/** 一维轮廓系数；无法评估（簇退化/样本过少）时返回 -1 */
function silhouette1d(
  values: readonly number[],
  assignment: readonly number[],
  k: number,
): number {
  if (k <= 1 || values.length < k + 1) return -1
  const groups: number[][] = Array.from({ length: k }, () => [])
  for (let i = 0; i < values.length; i += 1) {
    groups[assignment[i] ?? 0]?.push(values[i] ?? 0)
  }
  if (groups.some((group) => group.length === 0)) return -1

  let total = 0
  let count = 0
  for (let i = 0; i < values.length; i += 1) {
    const ownIndex = assignment[i] ?? 0
    const own = groups[ownIndex] ?? []
    if (own.length <= 1) continue
    const value = values[i] ?? 0

    let a = 0
    for (const other of own) a += Math.abs(value - other)
    a /= own.length - 1

    let b = Number.POSITIVE_INFINITY
    for (let c = 0; c < k; c += 1) {
      if (c === ownIndex) continue
      const group = groups[c] ?? []
      if (group.length === 0) continue
      let dist = 0
      for (const other of group) dist += Math.abs(value - other)
      const mean = dist / group.length
      if (mean < b) b = mean
    }
    if (!Number.isFinite(b)) continue

    const denominator = Math.max(a, b)
    total += denominator > 0 ? (b - a) / denominator : 0
    count += 1
  }
  return count > 0 ? total / count : -1
}

/** 相邻两栏之间的空隙是否被真实深谷支撑 */
function gapIsValleySupported(
  leftMax: number,
  rightMin: number,
  valleys: readonly DeepValley[],
): 'valley' | 'wide-gap' | 'none' {
  const gapWidth = rightMin - leftMax
  if (gapWidth <= 0) return 'none'
  const overlapNeeded = Math.min(gapWidth, MIN_GUTTER_WIDTH) * 0.5
  for (const valley of valleys) {
    const overlap = Math.min(valley.x1, rightMin) - Math.max(valley.x0, leftMax)
    if (overlap >= overlapNeeded) return 'valley'
  }
  return gapWidth >= MIN_GUTTER_WIDTH * 2 ? 'wide-gap' : 'none'
}

function singleColumnLayout(nodes: readonly LayoutNode[]): ColumnLayout {
  let x0 = 0
  let x1 = 1
  if (nodes.length > 0) {
    x0 = Math.min(...nodes.map((node) => node.bbox[0]))
    x1 = Math.max(...nodes.map((node) => node.bbox[2]))
  }
  return { columns: [{ index: 0, x0, x1 }], boundaries: [], columnCount: 1 }
}

/**
 * 由聚类结果 + 谷点约束构造分栏布局。
 *
 * 栏界位置取「左栏末墨迹与右栏首墨迹的中点」——这是空栏隙的物理中心，
 * 比谷点区间端点更稳定；深谷只负责**确认**栏隙真实存在并约束其宽度。
 */
function buildLayoutFromClusters(
  nodes: readonly LayoutNode[],
  assignment: readonly number[],
  k: number,
  valleys: readonly DeepValley[],
): { layout: ColumnLayout; supported: number } {
  const groups: LayoutNode[][] = Array.from({ length: k }, () => [])
  for (let i = 0; i < nodes.length; i += 1) {
    groups[assignment[i] ?? 0]?.push(nodes[i]!)
  }

  const spans: ColumnSpan[] = groups
    .map((group, index) => {
      let x0 = Number.POSITIVE_INFINITY
      let x1 = Number.NEGATIVE_INFINITY
      for (const node of group) {
        x0 = Math.min(x0, node.bbox[0])
        x1 = Math.max(x1, node.bbox[2])
      }
      return {
        index,
        x0: Number.isFinite(x0) ? x0 : index / k,
        x1: Number.isFinite(x1) ? x1 : (index + 1) / k,
      }
    })
    .sort((a, b) => a.x0 - b.x0)
  spans.forEach((span, index) => {
    span.index = index
  })

  const boundaries: number[] = []
  let supportedCount = 0
  for (let i = 0; i + 1 < spans.length; i += 1) {
    const leftMax = spans[i]!.x1
    const rightMin = spans[i + 1]!.x0
    boundaries.push((leftMax + rightMin) / 2)
    if (gapIsValleySupported(leftMax, rightMin, valleys) === 'valley') supportedCount += 1
  }

  const gapCount = Math.max(1, spans.length - 1)
  return {
    layout: { columns: spans, boundaries, columnCount: spans.length },
    supported: supportedCount / gapCount,
  }
}

/**
 * 动态多峰 K-Means 自适应确定栏数与栏界。
 *
 * 候选 K ∈ {1, 2, 3}，以轮廓系数 + 谷点支撑度 - 复杂度惩罚综合评分择优；
 * 任一栏块数不足则该 K 无效，彻底废除硬编码 `boundaries: [0.5]`。
 */
export function clusterColumnBoundaries(
  nodes: readonly LayoutNode[],
  valleys: readonly DeepValley[] = [],
): ColumnLayout {
  const readable = nodes.filter((node) => !isSpanning(node))
  if (readable.length < 2) return singleColumnLayout(nodes)

  const x0Values = readable.map((node) => node.bbox[0])
  const maxK = Math.min(3, Math.floor(readable.length / MIN_BLOCKS_PER_COLUMN))

  let bestLayout: ColumnLayout | null = null
  let bestScore = Number.NEGATIVE_INFINITY

  for (let k = 1; k <= Math.max(1, maxK); k += 1) {
    const { assignment } = kmeans1d(x0Values, k)

    const counts = new Array<number>(k).fill(0)
    for (const c of assignment) counts[c] = (counts[c] ?? 0) + 1
    if (k > 1 && counts.some((count) => count < MIN_BLOCKS_PER_COLUMN)) continue

    const { layout, supported } = buildLayoutFromClusters(readable, assignment, k, valleys)
    const silhouette = k > 1 ? silhouette1d(x0Values, assignment, k) : 0
    const score =
      (k > 1 ? Math.max(0, silhouette) : 0) +
      VALLEY_SUPPORT_WEIGHT * supported -
      COLUMN_COMPLEXITY_PENALTY * (k - 1)

    if (score > bestScore) {
      bestScore = score
      bestLayout = layout
    }
  }

  return bestLayout ?? singleColumnLayout(nodes)
}

/**
 * 探测分栏结构（单栏 / 对称双栏 / 三栏 / 非对称分栏）。
 *
 * 绝不因单个块而全页退化为单栏：K-Means 每栏块数护栏 + 谷点支撑度共同约束。
 */
export function detectColumnLayout(nodes: readonly LayoutNode[]): ColumnLayout {
  const body = filterBodyNodes(nodes)
  if (body.length === 0) return singleColumnLayout([])
  const valleys = findDeepValleys(computeXProjectionProfile(body))
  return clusterColumnBoundaries(body, valleys)
}

/** 节点所属栏序号（0 起）；单栏恒为 0。按节点水平中心落栏，天然支持非对称分栏 */
export function columnIndexOf(node: LayoutNode, layout: ColumnLayout): number {
  if (layout.columnCount <= 1) return 0
  const center = (node.bbox[0] + node.bbox[2]) / 2
  let best = 0
  let bestDist = Number.POSITIVE_INFINITY
  for (const span of layout.columns) {
    if (center >= span.x0 && center <= span.x1) return span.index
    const dist = center < span.x0 ? span.x0 - center : center - span.x1
    if (dist < bestDist) {
      bestDist = dist
      best = span.index
    }
  }
  return best
}

/** 由栏跨度反推栏界数组（供外部消费方兼容） */
function boundariesFromColumns(columns: readonly ColumnSpan[]): number[] {
  const sorted = [...columns].sort((a, b) => a.x0 - b.x0)
  const boundaries: number[] = []
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    boundaries.push((sorted[i]!.x1 + sorted[i + 1]!.x0) / 2)
  }
  return boundaries
}

/** 计算各栏「栏底」节点集合 */
function computeColumnTerminals(
  nodes: readonly LayoutNode[],
  layout: ColumnLayout,
): Set<string> {
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
export function buildRouterContext(
  nodes: readonly LayoutNode[],
  layout?: ColumnLayout,
  band?: { y0: number; y1: number },
): RouterContext {
  const columns = layout ?? detectColumnLayout(nodes)
  const lineHeight = median(nodes.map((node) => node.bbox[3] - node.bbox[1]), 0.03)
  const columnWidth = median(nodes.map((node) => node.bbox[2] - node.bbox[0]), 0.4)
  const columnWidthByIndex = columns.columns.map((span) => Math.max(span.x1 - span.x0, 0.05))
  const terminalByColumn = computeColumnTerminals(nodes, columns)
  return {
    columns,
    lineHeight: Math.max(lineHeight, 0.005),
    columnWidth: Math.max(columnWidth, 0.05),
    columnWidthByIndex,
    terminalByColumn,
    bandY0: band?.y0 ?? 0,
    bandY1: band?.y1 ?? 1,
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

  // 跨栏块（标题/摘要/通栏图表）→ 后继：必须先在其下方，且优先左栏起始
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
  // 带内相对坐标：栏底/栏顶判据必须相对当前带，而非整页
  const bandHeight = Math.max(1e-6, ctx.bandY1 - ctx.bandY0)
  const uBottomRatio = (u.bbox[3] - ctx.bandY0) / bandHeight
  const vTopRatio = (v.bbox[1] - ctx.bandY0) / bandHeight
  const uAtColumnEnd = ctx.terminalByColumn.has(u.id) || uBottomRatio >= 0.85
  const vAtColumnTop = vTopRatio <= 0.25
  if (uAtColumnEnd && vAtColumnTop) return 0.95
  return -1.0
}

/** 几何连续性打分 Score_geo ∈ [0, 1]；水平偏差按所在栏的实际栏宽归一化 */
export function scoreGeometry(u: LayoutNode, v: LayoutNode, ctx: RouterContext): number {
  const gap = Math.max(0, v.bbox[1] - u.bbox[3])
  const vertical = Math.exp(-gap / (3 * ctx.lineHeight))
  const horizontalDelta = Math.abs(v.bbox[0] - u.bbox[0])
  const columnWidth =
    ctx.columnWidthByIndex[columnIndexOf(u, ctx.columns)] ?? ctx.columnWidth
  const horizontal = Math.max(0, Math.min(1, 1 - horizontalDelta / Math.max(columnWidth, 0.05)))
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
  if (/[.!?。！？]$/.test(uText) && (/^[A-Z一-龥]/.test(vText) || vIsHeading)) {
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

/** 单带内的最大悔标阅读顺序求解 */
function solveBandReadingOrder(
  nodes: readonly LayoutNode[],
  layout: ColumnLayout,
  band: { y0: number; y1: number },
): LayoutNode[] {
  if (nodes.length <= 1) return [...nodes]

  const ctx = buildRouterContext(nodes, layout, band)
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

  return reconstructChainsToOrderedList(nodes, chosenSuccessor)
}

// ===== 水平分带拓扑 =====

/** 碎片带高度下限（归一化），低于此高度不独立成带 */
const MIN_BAND_HEIGHT = 0.02

/** 跨栏块是否真正「截断」了上下文：上下都存在分栏正文时才切带 */
function isBandSplitter(node: LayoutNode, nodes: readonly LayoutNode[], layout: ColumnLayout): boolean {
  const crossesColumns = (() => {
    if (layout.columnCount <= 1) return false
    let touched = 0
    for (const span of layout.columns) {
      const overlap = Math.min(span.x1, node.bbox[2]) - Math.max(span.x0, node.bbox[0])
      if (overlap > (span.x1 - span.x0) * 0.35) touched += 1
    }
    return touched >= 2
  })()
  if (!isSpanning(node) && !crossesColumns) return false

  let hasAbove = false
  let hasBelow = false
  for (const other of nodes) {
    if (other.id === node.id || isSpanning(other)) continue
    if (other.bbox[3] <= node.bbox[1] + 1e-6) hasAbove = true
    if (other.bbox[1] >= node.bbox[3] - 1e-6) hasBelow = true
    if (hasAbove && hasBelow) break
  }
  return hasAbove && hasBelow
}

/**
 * 水平分带切分：以跨栏浮动块的垂直覆盖区间为切割线，把页面划分为垂直有序的多个 Band。
 *
 * 每个 Band 内部栏结构一致，独立求解阅读流后按 Band 顺序自顶向下串联，
 * 彻底根除「浮动块下方正文提前被吸附到右栏顶部」的拓扑错乱。
 */
export function decomposeHorizontalBands(nodes: readonly LayoutNode[]): HorizontalBand[] {
  const body = filterBodyNodes(nodes)
  if (body.length === 0) return []

  const valleys = findDeepValleys(computeXProjectionProfile(body))
  const pageLayout = clusterColumnBoundaries(body, valleys)

  const splitters = body.filter((node) => isBandSplitter(node, body, pageLayout))
  const intervals = splitters
    .map((node) => ({ y0: node.bbox[1], y1: node.bbox[3] }))
    .sort((a, b) => a.y0 - b.y0)

  const merged: Array<{ y0: number; y1: number }> = []
  for (const interval of intervals) {
    const last = merged[merged.length - 1]
    if (last && interval.y0 <= last.y1) {
      last.y1 = Math.max(last.y1, interval.y1)
    } else {
      merged.push({ ...interval })
    }
  }

  const cuts: Array<{ y0: number; y1: number }> = []
  let cursor = 0
  for (const interval of merged) {
    if (interval.y0 - cursor > MIN_BAND_HEIGHT) cuts.push({ y0: cursor, y1: interval.y0 })
    cuts.push({ y0: interval.y0, y1: interval.y1 })
    cursor = interval.y1
  }
  if (1 - cursor > MIN_BAND_HEIGHT) cuts.push({ y0: cursor, y1: 1 })
  if (cuts.length === 0) cuts.push({ y0: 0, y1: 1 })

  // 节点按垂直中心归属（脚注落在页底带，天然正确）
  const buckets: LayoutNode[][] = cuts.map(() => [])
  for (const node of body) {
    const center = (node.bbox[1] + node.bbox[3]) / 2
    let target = cuts.findIndex((cut) => center >= cut.y0 && center < cut.y1)
    if (target < 0) target = center >= 1 ? cuts.length - 1 : 0
    buckets[target]?.push(node)
  }

  const bands: HorizontalBand[] = []
  for (let index = 0; index < cuts.length; index += 1) {
    const bandNodes = buckets[index] ?? []
    if (bandNodes.length === 0) continue
    // 栏聚类只吃正文块：页底脚注是窄条，会污染栏位投影直方图
    const clusteringInput = bandNodes.filter((node) => node.kind !== 'footnote')
    const pool = clusteringInput.length >= 2 ? clusteringInput : bandNodes
    const layout = clusterColumnBoundaries(
      pool,
      findDeepValleys(computeXProjectionProfile(pool)),
    )
    bands.push({
      index: bands.length,
      y0: cuts[index]!.y0,
      y1: cuts[index]!.y1,
      columnCount: layout.columnCount,
      columns: layout.columns,
      nodeIds: bandNodes.map((node) => node.id),
    })
  }
  return bands
}

/** 页面拓扑分析结果 */
export interface PageTopology {
  bands: HorizontalBand[]
  ordered: LayoutNode[]
}

/**
 * 单页版面拓扑分析 + 阅读流求解。
 *
 * 一次拿全水平分带、各带栏结构与全局阅读顺序，同时写回
 * `readingOrderIndex`（全局连续）与 `readingStreamId` / `columnCount`（栏归属）。
 */
export function analyzePageTopology(nodes: readonly LayoutNode[]): PageTopology {
  const body = filterBodyNodes(nodes)
  if (body.length === 0) return { bands: [], ordered: [] }

  const bands = decomposeHorizontalBands(body)
  const nodeById = new Map(body.map((node) => [node.id, node]))
  const ordered: LayoutNode[] = []

  for (const band of bands) {
    const bandNodes = band.nodeIds
      .map((id) => nodeById.get(id))
      .filter((node): node is LayoutNode => node !== undefined)
    const layout: ColumnLayout = {
      columns: band.columns,
      boundaries: boundariesFromColumns(band.columns),
      columnCount: band.columnCount,
    }
    const routed = solveBandReadingOrder(bandNodes, layout, { y0: band.y0, y1: band.y1 })
    for (const node of routed) {
      // 跨栏块与单栏带统一按「通栏」表达，供聚光灯锚点渲染人类可读位置
      const spanning = band.columnCount <= 1 || isSpanning(node)
      node.readingStreamId = spanning ? 0 : columnIndexOf(node, layout)
      node.columnCount = spanning ? 1 : band.columnCount
      ordered.push(node)
    }
  }

  ordered.forEach((node, index) => {
    node.readingOrderIndex = index
  })
  return { bands, ordered }
}

/**
 * 最大悔标阅读顺序求解（对外兼容入口）。
 *
 * 内部先做水平分带，逐带隔离求解后按 Band 顺序自顶向下串联。
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
  return analyzePageTopology(nodes).ordered
}
