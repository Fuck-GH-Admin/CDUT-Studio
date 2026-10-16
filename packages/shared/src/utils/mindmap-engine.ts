/**
 * 思维导图引擎（径向整齐树布局 + 贝塞尔连线 + OPML 2.0 导出）
 *
 * 布局思想：角度按「子树叶子数占比」切分扇区（相邻子树角度互不重叠），半径采用
 * **线性等距环 + 径向/切向双约束自适应**（r(d) 逐层单调递增，保证同环弧长足以排布宽气泡）。
 * 尺寸估算唯一真源为 `estimateMindMapNodeSize`，布局、包围盒与连线锚点三处共用同一口径。
 *
 * 连线采用三次样条贝塞尔曲线：
 *   C(t) = (1-t)³P₀ + 3(1-t)²t P₁ + 3(1-t)t² P₂ + t³ P₃
 * **连接线路径数学公式锁定不可变更；气泡节点允许用户自由拖拽覆盖坐标。**
 *
 * 本模块为纯函数实现（无任何 Electron / DOM 依赖），主进程与渲染进程可共用。
 */

import type { MindMapData, MindMapNode } from '../types/study'

/** 布局后的节点位置 */
export interface MindMapPoint {
  x: number
  y: number
  /** 层级深度（根为 0） */
  depth: number
  /** 测地线角度（弧度） */
  angle: number
}

/** 布局参数 */
export interface MindMapLayoutOptions {
  centerX?: number
  centerY?: number
  /** 相邻层级的基础环距（同时作为径向与切向约束的下界） */
  baseRadius?: number
  /** 圆盘半径上限（DIP）；超出时整体等比压缩 */
  diskRadius?: number
  /** @deprecated 双曲压缩尺度已废弃（tanh 投影存在结构性重叠缺陷），仅为兼容旧调用点保留 */
  scale?: number
}

/** 统计子树叶子数（用于按占比分配角度扇区，避免跨支重叠） */
function countLeaves(node: MindMapNode): number {
  const kids = node.children ?? []
  if (kids.length === 0) return 1
  let total = 0
  for (const child of kids) total += countLeaves(child)
  return total
}

/** 判定是否为「宽字符」（CJK / 全角标点），用于气泡尺寸估算的视觉宽度换算 */
function isWideChar(ch: string): boolean {
  return /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60]/.test(ch)
}

/** 气泡尺寸估算的实测口径常量（与 mindmap-canvas 的气泡样式严格对齐） */
const BUBBLE_MAX_WIDTH = 160
const BUBBLE_PADDING_X = 22
const BUBBLE_LINE_HEIGHT = 17
const BUBBLE_PADDING_Y = 14
const CHAR_WIDTH = 11.5

/**
 * 估算气泡节点的渲染尺寸（与 `max-w-[160px] / px-2.5 / text-[11px] leading-snug` 样式对齐）。
 *
 * 该函数是布局与连线的**唯一尺寸真源**：
 *   - 布局据此计算「同环弧长是否够排布」，根治同层气泡互相重叠；
 *   - 场景包围盒据此向外扩张，根治边缘气泡被裁切；
 *   - 连线锚点在 DOM 实测前据此保底，根治首帧锚点跳变抽搐。
 */
export function estimateMindMapNodeSize(label: string): { width: number; height: number } {
  const text = (label ?? '').trim()
  let visualLen = 0
  for (const ch of text) visualLen += isWideChar(ch) ? 1 : 0.55
  const width = Math.min(BUBBLE_MAX_WIDTH, Math.max(84, Math.round(visualLen * CHAR_WIDTH) + BUBBLE_PADDING_X))
  const contentWidth = Math.max(24, width - BUBBLE_PADDING_X)
  const lines = Math.max(1, Math.ceil((visualLen * CHAR_WIDTH) / contentWidth))
  const height = Math.round(lines * BUBBLE_LINE_HEIGHT + BUBBLE_PADDING_Y)
  return { width, height }
}

/**
 * 径向整齐树布局（tidy radial tree）：
 * 角度按「子树叶子数占比」切分扇区（相邻子树角度范围互不重叠），
 * 半径采用**线性等距环 + 双约束自适应扩展**。
 *
 * 为什么放弃双曲 tanh 压缩：
 *   原实现按 r_disk = tanh(depth·base/scale)·diskRadius 投影，在 baseRadius=300 / scale=1000 下
 *   第一层半径仅 tanh(0.3)·460 ≈ 134px，而气泡宽度可达 100~160px —— 同环相邻分支的弧长
 *   （2π·134 / n）远小于气泡宽度，必然互相压叠；同时外层各环半径被 tanh 挤压到几乎相同
 *   （depth 2≈247、3≈329、4≈384、5≈416），深层节点径向几乎贴在一起。
 *   这属于数学层面的结构性缺陷，无法靠调参收敛，因此改为线性环距并同时满足两个硬约束：
 *
 *   1. 径向不重叠：r(d) ≥ r(d-1) + 父层最大半高 + 本层最大半高 + 基础环距；
 *   2. 切向不拥挤：r(d) ≥ 本层节点数 × (本层最大半宽×2 + 间隙) / 2π（保证同环弧长够排布）。
 *
 * 若推算出的最外层半径超出 `diskRadius`，整体按比例压缩（保持层级次序与相对间距），
 * 从而既杜绝重叠，又不会把画布撑到失真。
 */
export function layoutMindMap(
  root: MindMapNode,
  options: MindMapLayoutOptions = {},
): Map<string, MindMapPoint> {
  const centerX = options.centerX ?? 0
  const centerY = options.centerY ?? 0
  const ringGap = Math.max(60, options.baseRadius ?? 120)
  const diskRadius = Math.max(ringGap, options.diskRadius ?? 460)

  interface Slot {
    node: MindMapNode
    depth: number
    angle: number
  }
  const slots: Slot[] = []
  const maxHalfWidthByDepth = new Map<number, number>()
  const nodesPerDepth = new Map<number, number>()

  // ===== Pass 1：按叶子占比切分角度扇区，同时统计每层气泡尺寸与节点数 =====
  const collect = (node: MindMapNode, depth: number, angle: number, sector: number): void => {
    slots.push({ node, depth, angle })
    const halfWidth = estimateMindMapNodeSize(node.label).width / 2
    maxHalfWidthByDepth.set(depth, Math.max(maxHalfWidthByDepth.get(depth) ?? 0, halfWidth))
    nodesPerDepth.set(depth, (nodesPerDepth.get(depth) ?? 0) + 1)

    const kids = node.children ?? []
    if (kids.length === 0) return
    const totalLeaves = kids.reduce((sum, child) => sum + countLeaves(child), 0) || 1
    let cursor = angle - sector / 2
    for (const child of kids) {
      const childSector = (sector * countLeaves(child)) / totalLeaves
      collect(child, depth + 1, cursor + childSector / 2, childSector)
      cursor += childSector
    }
  }
  collect(root, 0, -Math.PI / 2, Math.PI * 2)

  // ===== Pass 2：逐层推算半径（径向 + 切向双约束，且严格单调递增） =====
  const maxDepth = slots.reduce((max, slot) => Math.max(max, slot.depth), 0)
  const radiusByDepth = new Map<number, number>([[0, 0]])
  let previousRadius = 0
  for (let depth = 1; depth <= maxDepth; depth++) {
    const count = nodesPerDepth.get(depth) ?? 0
    const halfWidth = maxHalfWidthByDepth.get(depth) ?? 48
    const parentHalfWidth = maxHalfWidthByDepth.get(depth - 1) ?? halfWidth
    // 径向约束：父子气泡外缘留出基础环距
    const radialNeed = previousRadius + parentHalfWidth + halfWidth + ringGap * 0.5
    // 切向约束：本层周长需容纳全部节点（含横向间隙）
    const tangentialNeed = count > 1 ? (count * (halfWidth * 2 + 24)) / (2 * Math.PI) : 0
    const radius = Math.max(previousRadius + ringGap, radialNeed, tangentialNeed)
    radiusByDepth.set(depth, radius)
    previousRadius = radius
  }

  // 超出圆盘上限时整体等比压缩
  const outermost = previousRadius
  const shrink = outermost > diskRadius ? diskRadius / outermost : 1

  const positions = new Map<string, MindMapPoint>()
  for (const slot of slots) {
    const radius = (radiusByDepth.get(slot.depth) ?? 0) * shrink
    positions.set(slot.node.id, {
      x: Math.round(centerX + radius * Math.cos(slot.angle)),
      y: Math.round(centerY + radius * Math.sin(slot.angle)),
      depth: slot.depth,
      angle: slot.angle,
    })
  }
  return positions
}

/**
 * 现代平滑辐射贝塞尔曲线生成算法：
 * 起点 P0(x0, y0)，终点 P1(x1, y1)，弦向量 D = (x1 - x0, y1 - y0)，距离 dist = hypot(dx, dy)。
 * 1. 起点切线 C1:
 *    - 若起点为中心根节点，直接沿连线方向发射: u0 = D / dist;
 *    - 若起点为子节点，沿其自身生长方向（极径）与连线方向的加权混合向外辐射。
 * 2. 终点切线 C2:
 *    - 终点平滑接纳切线必须沿 (P1 - P0) 方向汇入，严禁反向拉向全局原点 (0,0)！
 *      （旧实现用终点相对圆心的极径向量作为 u1，当子节点与父节点不在同一极径上时，
 *      C2 会向圆心凹陷，形成向后绕圈的怪异「蠕动/抽搐」曲线。）
 *    - 控制点距离：handle = Math.min(dist * 0.38, 140)。
 *    - C1 = P0 + u0 * handle，C2 = P1 - (D / dist) * handle。
 * 3. 经典树状模式（无中心基准）：水平 S 曲线，控制点按水平分量比例偏移。
 */
export function buildBezierPath(
  from: MindMapPoint,
  to: MindMapPoint,
  center?: { x: number; y: number },
): string {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dist = Math.hypot(dx, dy)
  if (dist < 1e-4) {
    return `M ${from.x} ${from.y} L ${to.x} ${to.y}`
  }

  const dirX = dx / dist
  const dirY = dy / dist
  const handleLen = Math.min(dist * 0.38, 140)

  let c1x: number
  let c1y: number
  let c2x: number
  let c2y: number

  if (center) {
    // 径向平滑向外放射模式
    const r0 = Math.hypot(from.x - center.x, from.y - center.y)
    if (r0 < 2.0) {
      // 根节点（位于圆心）：直接沿连线方向射出，规避 atan2(0,0) 极角退化
      c1x = from.x + dirX * handleLen
      c1y = from.y + dirY * handleLen
    } else {
      // 分支节点：沿向外极径与连线方向的加权混合向量射出，保持辐射张力又不回弯
      const radX = (from.x - center.x) / r0
      const radY = (from.y - center.y) / r0
      const blendX = radX * 0.6 + dirX * 0.4
      const blendY = radY * 0.6 + dirY * 0.4
      const blendLen = Math.hypot(blendX, blendY) || 1
      c1x = from.x + (blendX / blendLen) * handleLen
      c1y = from.y + (blendY / blendLen) * handleLen
    }
    // 终点控制点：平滑汇入气泡，绝不往原点扭曲
    c2x = to.x - dirX * handleLen
    c2y = to.y - dirY * handleLen
  } else {
    // 经典平滑水平 S 曲线
    const kx = Math.abs(dx) * 0.45
    c1x = from.x + (dx >= 0 ? kx : -kx)
    c1y = from.y
    c2x = to.x - (dx >= 0 ? kx : -kx)
    c2y = to.y
  }

  return `M ${from.x.toFixed(2)} ${from.y.toFixed(2)} C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${to.x.toFixed(2)} ${to.y.toFixed(2)}`
}

/**
 * 光标锚定缩放的视口矩阵变换（纯函数，供视口 Hook 与单元测试共用）。
 *
 * 公式：t' = P_anchor - (s'/s) * (P_anchor - t)
 * 其中 P_anchor 为锚点的屏幕坐标，s 为旧缩放、s' 为新缩放，t 为旧平移、t' 为新平移。
 * 该变换保证锚点对应的场景点在缩放前后始终投影到同一屏幕位置（可逆、无漂移）。
 */
export function computeAnchorZoomPan(
  prev: { zoom: number; pan: { x: number; y: number } },
  anchor: { x: number; y: number },
  nextZoom: number,
): { zoom: number; pan: { x: number; y: number } } {
  if (!Number.isFinite(prev.zoom) || prev.zoom <= 0 || !Number.isFinite(nextZoom) || nextZoom <= 0) {
    return { zoom: prev.zoom, pan: prev.pan }
  }
  const k = nextZoom / prev.zoom
  return {
    zoom: nextZoom,
    pan: {
      x: anchor.x - k * (anchor.x - prev.pan.x),
      y: anchor.y - k * (anchor.y - prev.pan.y),
    },
  }
}

/** 前序遍历展开导图节点（渲染层按序绘制气泡与连线） */
export function flattenMindMap(root: MindMapNode): MindMapNode[] {
  const out: MindMapNode[] = []
  const walk = (node: MindMapNode): void => {
    out.push(node)
    for (const child of node.children ?? []) walk(child)
  }
  walk(root)
  return out
}

/** 生成某主题的深度伴学 Prompt（点击气泡时写入剪贴板） */
export function buildNodeStudyPrompt(node: MindMapNode, mapTitle?: string): string {
  const topic = node.label
  const notes = node.notes ? `\nKnown key points (已知要点): ${node.notes}` : ''
  const context = mapTitle ? `\nKnowledge system (所属知识体系): ${mapTitle}` : ''
  return [
    `Please give me an in-depth companion tutoring explanation (深度伴学讲解) about "${topic}":${context}${notes}`,
    '',
    'Requirements:',
    `1. First, use 2-3 sentences to give an accurate definition of "${topic}" and its position within the overall knowledge structure;`,
    '2. Break down its core components / classifications / key rules, and give one example close to a final exam;',
    '3. Point out 2-3 concepts most easily confused with it (易错点) and analyze each one;',
    '4. Finally, give 3 self-test questions (with answers) to help me verify whether I have truly mastered them.',
    '',
    'Language: Write the entire explanation in the student\'s language — the language of the study material (e.g., Simplified Chinese). Keep your internal reasoning and planning in English.',
  ].join('\n')
}

/** XML 特殊字符转义 */
function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * 将思维导图 JSON 树导出为符合 RFC 规范的 OPML 2.0 XML 文档。
 */
export function mindMapToOpml(mindmap: MindMapData, dateCreated: Date = new Date()): string {
  const outline = (node: MindMapNode, indent: string): string => {
    const attrs = [`text="${escapeXml(node.label)}"`]
    if (node.notes) attrs.push(`_note="${escapeXml(node.notes)}"`)
    const kids = node.children ?? []
    if (kids.length === 0) return `${indent}<outline ${attrs.join(' ')} />`
    const children = kids.map((child) => outline(child, `${indent}  `)).join('\n')
    return `${indent}<outline ${attrs.join(' ')}>\n${children}\n${indent}</outline>`
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    `    <title>${escapeXml(mindmap.title)}</title>`,
    `    <dateCreated>${dateCreated.toUTCString()}</dateCreated>`,
    '  </head>',
    '  <body>',
    outline(mindmap.root, '    '),
    '  </body>',
    '</opml>',
  ].join('\n')
}

// ===== 对话流 ```mindmap 代码块解析（Mermaid mindmap 语法 + JSON 容错）=====

/** 剥离 Mermaid 节点标签的外层形状包装：`((x))` / `(x)` / `{{x}}` / `{x}` / `[x]` / `>x]` / `id[x]` */
export function stripMermaidNodeLabel(raw: string): string {
  let text = raw.trim()
  // 去掉前置可选 id（如 `a1(标签)`、`node_2[标签]`）
  text = text.replace(/^[A-Za-z0-9_.\-]+\s*(?=[(\[{>])/, '').trim()
  // 迭代剥离包裹的对称括号 / 大括号
  const pairs: Array<[string, string]> = [
    ['((', '))'],
    ['{{', '}}'],
    ['[[', ']]'],
    ['(', ')'],
    ['{', '}'],
    ['[', ']'],
  ]
  for (const [open, close] of pairs) {
    if (text.startsWith(open) && text.endsWith(close) && text.length >= open.length + close.length) {
      text = text.slice(open.length, text.length - close.length).trim()
    }
  }
  // 非对称形状 `>text]`
  if (text.startsWith('>') && text.endsWith(']')) {
    text = text.slice(1, text.length - 1).trim()
  }
  // 去掉残余的前后引号
  text = text.replace(/^["']|["']$/g, '').trim()
  return text
}

/** 递归归一化 JSON 形态的导图节点 */
function normalizeJsonNode(raw: unknown, counter: { n: number }, depth: number): MindMapNode | null {
  if (!raw || typeof raw !== 'object' || depth > 8) return null
  const node = raw as Record<string, unknown>
  const label = typeof node.label === 'string' ? node.label : typeof node.text === 'string' ? node.text : typeof node.name === 'string' ? node.name : ''
  if (!label.trim()) return null
  counter.n += 1
  const result: MindMapNode = { id: typeof node.id === 'string' && node.id ? node.id : `mm-${counter.n}`, label: label.trim().slice(0, 60) }
  if (typeof node.notes === 'string' && node.notes.trim()) result.notes = node.notes.trim().slice(0, 200)
  const childrenRaw = Array.isArray(node.children) ? node.children : Array.isArray(node.nodes) ? node.nodes : []
  const children: MindMapNode[] = []
  for (const child of childrenRaw) {
    const normalized = normalizeJsonNode(child, counter, depth + 1)
    if (normalized) children.push(normalized)
  }
  if (children.length > 0) result.children = children
  return result
}

/**
 * 解析对话流中的 ```mindmap 代码块文本为思维导图节点树。
 *
 * 支持两种输入：
 *   1. Mermaid mindmap 语法（`mindmap` 关键字 + 缩进层级 + 可选形状括号）；
 *   2. JSON 树（`{ title, root|label|text, children }` 容错形态）。
 * 解析失败返回 null，由调用方回退为普通代码块渲染。
 */
export function parseMindMapText(text: string): MindMapNode | null {
  if (!text) return null
  let source = text.replace(/\r\n?/g, '\n').trim()
  // 剥离可能残留的代码围栏
  const fence = source.match(/^```[a-zA-Z-]*\n([\s\S]*?)\n?```$/)
  if (fence && fence[1] !== undefined) source = fence[1].trim()
  if (!source) return null

  // 1) JSON 形态
  if (source.startsWith('{')) {
    try {
      const parsed = JSON.parse(source) as Record<string, unknown>
      const candidate = (parsed.root ?? parsed) as unknown
      return normalizeJsonNode(candidate, { n: 0 }, 0)
    } catch {
      return null
    }
  }

  // 2) Mermaid mindmap 缩进语法
  let lines = source.split('\n')
  const firstIndex = lines.findIndex((line) => line.trim().length > 0)
  if (firstIndex < 0) return null
  if (/^mindmap\b/i.test(lines[firstIndex]!.trim())) {
    lines = lines.slice(firstIndex + 1)
  } else {
    // 首行不是 mindmap 关键字时，仍尝试按缩进解析（容错）
    lines = lines.slice(firstIndex)
  }

  interface Frame {
    indent: number
    node: MindMapNode
  }
  const stack: Frame[] = []
  let root: MindMapNode | null = null
  let counter = 0
  for (const line of lines) {
    if (!line.trim()) continue
    const indentMatch = line.match(/^[ \t]*/)
    const indent = (indentMatch?.[0] ?? '').replace(/\t/g, '    ').length
    const label = stripMermaidNodeLabel(line.trim())
    if (!label) continue
    counter += 1
    const node: MindMapNode = { id: `mm-${counter}`, label: label.slice(0, 60) }
    if (!root) {
      root = node
      stack.push({ indent, node })
      continue
    }
    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) stack.pop()
    const parent = stack[stack.length - 1]?.node ?? root
    if (parent.children) parent.children.push(node)
    else parent.children = [node]
    stack.push({ indent, node })
  }
  return root
}
