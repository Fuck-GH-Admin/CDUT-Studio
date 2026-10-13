/**
 * 思维导图引擎（双曲 Poincaré 投影布局 + 贝塞尔连线 + OPML 2.0 导出）
 *
 * 布局思想：传统欧氏平面在层级较深时边缘节点互相挤压；本引擎把径向欧氏坐标经
 * 双曲正切投影 r_disk = tanh(r_euclid / scale) · diskRadius 映射到 Poincaré 圆盘，
 * 根节点居中，子分支按测地线角向外辐射扩散，天然避免深层节点重叠。
 *
 * 连线采用三次样条贝塞尔曲线（控制点按起终点相对几何向量自适应水平偏移）：
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
  /** 相邻层级间的欧氏基准半径（映射到圆盘前） */
  baseRadius?: number
  /** 圆盘半径上限（DIP） */
  diskRadius?: number
  /** 双曲压缩尺度（越大越接近欧氏） */
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

/**
 * 双曲 Poincaré 圆盘布局：返回以节点 id 为键的位置表。
 *
 * 角度分配采用「按子树叶子数占比切分扇区」的经典整齐树（tidy radial tree）算法：
 * 根节点占据整圆，其子分支按各自叶子数占比平分角度扇区，深层节点递归切分父扇区。
 * 这样相邻子树的角度范围互不重叠，天然避免边缘节点挤压与连线交错。
 */
export function layoutMindMap(
  root: MindMapNode,
  options: MindMapLayoutOptions = {},
): Map<string, MindMapPoint> {
  const centerX = options.centerX ?? 0
  const centerY = options.centerY ?? 0
  const baseRadius = options.baseRadius ?? 120
  const diskRadius = options.diskRadius ?? 460
  const scale = options.scale ?? 900
  const positions = new Map<string, MindMapPoint>()

  const project = (depth: number, angle: number): { x: number; y: number } => {
    const radiusEuclid = depth * baseRadius
    const rDisk = Math.tanh(radiusEuclid / scale) * diskRadius
    return {
      x: Math.round(centerX + rDisk * Math.cos(angle)),
      y: Math.round(centerY + rDisk * Math.sin(angle)),
    }
  }

  const assign = (node: MindMapNode, depth: number, angle: number, sector: number): void => {
    const projected = project(depth, angle)
    positions.set(node.id, { x: projected.x, y: projected.y, depth, angle })
    const kids = node.children ?? []
    if (kids.length === 0) return
    const totalLeaves = kids.reduce((sum, child) => sum + countLeaves(child), 0) || 1
    // 自扇区起始角顺次切分：每个子分支按其叶子数占比获得一段连续角度
    let cursor = angle - sector / 2
    for (const child of kids) {
      const childSector = (sector * countLeaves(child)) / totalLeaves
      const childAngle = cursor + childSector / 2
      assign(child, depth + 1, childAngle, childSector)
      cursor += childSector
    }
  }

  // 根节点：整圆扇区（其自身角度仅作占位，半径恒为 0）
  assign(root, 0, -Math.PI / 2, Math.PI * 2)
  return positions
}

/**
 * 生成三次样条贝塞尔连线路径。
 *
 * - 提供 `center`（圆盘中心）时采用**径向弧线**控制点：起始控制点取父节点极角、半径为父子
 *   半径中值，末端控制点取子节点极角、同半径——连线沿测地线平滑辐射，树形结构下互不相交；
 * - 未提供 `center` 时退化为沿起终点相对几何向量自适应偏移（避免固定水平切线导致的 S 形回绕）。
 */
export function buildBezierPath(
  from: MindMapPoint,
  to: MindMapPoint,
  center?: { x: number; y: number },
): string {
  let c1x: number
  let c1y: number
  let c2x: number
  let c2y: number
  if (center) {
    const a0 = Math.atan2(from.y - center.y, from.x - center.x)
    const a1 = Math.atan2(to.y - center.y, to.x - center.x)
    const r0 = Math.hypot(from.x - center.x, from.y - center.y)
    const r1 = Math.hypot(to.x - center.x, to.y - center.y)
    const rm = (r0 + r1) / 2
    c1x = center.x + rm * Math.cos(a0)
    c1y = center.y + rm * Math.sin(a0)
    c2x = center.x + rm * Math.cos(a1)
    c2y = center.y + rm * Math.sin(a1)
  } else {
    const dx = to.x - from.x
    const dy = to.y - from.y
    c1x = from.x + dx * 0.33
    c1y = from.y + dy * 0.33
    c2x = from.x + dx * 0.67
    c2y = from.y + dy * 0.67
  }
  return `M ${from.x} ${from.y} C ${c1x} ${c1y} ${c2x} ${c2y} ${to.x} ${to.y}`
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
  const notes = node.notes ? `\n已知要点：${node.notes}` : ''
  const context = mapTitle ? `\n所属知识体系：${mapTitle}` : ''
  return [
    `请围绕「${topic}」为我做一次深度伴学讲解：${context}${notes}`,
    '',
    '要求：',
    `1. 先用 2~3 句话给出「${topic}」的准确定义与它在整体知识结构中的定位；`,
    '2. 拆解其核心构成 / 分类 / 关键规则，并给出一个贴近期末考试的实例；',
    '3. 指出 2~3 个最容易与其它概念混淆的易错点，并逐一辨析；',
    '4. 最后给出 3 个自测问题（附答案），帮助我检验是否真正掌握。',
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
