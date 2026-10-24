/**
 * cslab-edge-router — 推演画布连线动态锚点路由（纯函数，无 React 依赖）
 *
 * 协议保真：JSON Canvas 规范允许边显式携带 fromSide/toSide —— 用户在
 * Obsidian 中手工指定的连接端点必须原样呈现，几何评分只对缺失端兜底。
 *
 * 几何规则：
 * - 锚点 = 4 边中点之一，外推方向严格沿该边单位法向量 n ∈ {(-1,0),(1,0),(0,-1),(0,1)}；
 * - 控制点 C1 = P_start + n_from * offset，C2 = P_end + n_to * offset，
 *   offset = max(50, dist * 0.4) —— 禁止横向 dx 一刀切，垂直连接沿 Y 轴自然伸出；
 * - 评分 = 锚点间欧氏距离 + 方向惩罚（法线背离对方节点 +200），杜绝同侧穿透绕线。
 */

import type { CsLabCanvasEdge, CsLabCanvasNode, CsLabCanvasSide } from '@profer/shared'

export interface EdgeAnchor {
  side: CsLabCanvasSide
  point: { x: number; y: number }
  /** 单位外法向量。 */
  normal: { x: number; y: number }
}

const SIDES: readonly CsLabCanvasSide[] = ['top', 'right', 'bottom', 'left']

const SIDE_NORMALS: Record<CsLabCanvasSide, { x: number; y: number }> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
}

function anchorFor(node: CsLabCanvasNode, side: CsLabCanvasSide): EdgeAnchor {
  switch (side) {
    case 'top':
      return { side, point: { x: node.x + node.width / 2, y: node.y }, normal: SIDE_NORMALS.top }
    case 'bottom':
      return {
        side,
        point: { x: node.x + node.width / 2, y: node.y + node.height },
        normal: SIDE_NORMALS.bottom,
      }
    case 'left':
      return { side, point: { x: node.x, y: node.y + node.height / 2 }, normal: SIDE_NORMALS.left }
    case 'right':
    default:
      return {
        side,
        point: { x: node.x + node.width, y: node.y + node.height / 2 },
        normal: SIDE_NORMALS.right,
      }
  }
}

function nodeCenter(node: CsLabCanvasNode): { x: number; y: number } {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 }
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

/**
 * 评分：欧氏距离 + 方向惩罚。
 * from 锚点法线应朝向 to 节点中心；to 锚点法线应朝向 from 节点中心；
 * 背离即 +200 —— 避免「从右缘出又绕回右缘」的同侧穿透。
 */
function scoreAnchors(
  fromAnchor: EdgeAnchor,
  toAnchor: EdgeAnchor,
  fromNode: CsLabCanvasNode,
  toNode: CsLabCanvasNode,
): number {
  const dist = distance(fromAnchor.point, toAnchor.point)
  const fromCenter = nodeCenter(fromNode)
  const toCenter = nodeCenter(toNode)

  const fromDirX = toCenter.x - fromAnchor.point.x
  const fromDirY = toCenter.y - fromAnchor.point.y
  const toDirX = fromCenter.x - toAnchor.point.x
  const toDirY = fromCenter.y - toAnchor.point.y

  let penalty = 0
  if (fromAnchor.normal.x * fromDirX + fromAnchor.normal.y * fromDirY < 0) penalty += 200
  if (toAnchor.normal.x * toDirX + toAnchor.normal.y * toDirY < 0) penalty += 200
  return dist + penalty
}

function parseSide(value: unknown): CsLabCanvasSide | undefined {
  return typeof value === 'string' && (SIDES as readonly string[]).includes(value)
    ? (value as CsLabCanvasSide)
    : undefined
}

/** 为单个未指定端挑选最优边（另一端已固定）。 */
function bestSideFor(
  node: CsLabCanvasNode,
  otherNode: CsLabCanvasNode,
  otherAnchor: EdgeAnchor,
  forFrom: boolean,
): EdgeAnchor {
  let best: { anchor: EdgeAnchor; score: number } | null = null
  for (const side of SIDES) {
    const candidate = anchorFor(node, side)
    const score = forFrom
      ? scoreAnchors(candidate, otherAnchor, node, otherNode)
      : scoreAnchors(otherAnchor, candidate, otherNode, node)
    if (!best || score < best.score) best = { anchor: candidate, score }
  }
  return best!.anchor
}

/**
 * 计算连线的 SVG 路径。
 * 优先尊重 edge.fromSide / edge.toSide；缺失端按几何评分兜底。
 */
export function edgePath(
  from: CsLabCanvasNode,
  to: CsLabCanvasNode,
  edge?: Pick<CsLabCanvasEdge, 'fromSide' | 'toSide'>,
): string {
  const explicitFrom = parseSide(edge?.fromSide)
  const explicitTo = parseSide(edge?.toSide)

  let fromAnchor: EdgeAnchor
  let toAnchor: EdgeAnchor
  if (explicitFrom && explicitTo) {
    fromAnchor = anchorFor(from, explicitFrom)
    toAnchor = anchorFor(to, explicitTo)
  } else if (explicitFrom) {
    fromAnchor = anchorFor(from, explicitFrom)
    toAnchor = bestSideFor(to, from, fromAnchor, false)
  } else if (explicitTo) {
    toAnchor = anchorFor(to, explicitTo)
    fromAnchor = bestSideFor(from, to, toAnchor, true)
  } else {
    // 双端均未指定：遍历 16 组合取最优。
    let best: { fromAnchor: EdgeAnchor; toAnchor: EdgeAnchor; score: number } | null = null
    for (const fromSide of SIDES) {
      for (const toSide of SIDES) {
        const candidateFrom = anchorFor(from, fromSide)
        const candidateTo = anchorFor(to, toSide)
        const score = scoreAnchors(candidateFrom, candidateTo, from, to)
        if (!best || score < best.score) {
          best = { fromAnchor: candidateFrom, toAnchor: candidateTo, score }
        }
      }
    }
    fromAnchor = best!.fromAnchor
    toAnchor = best!.toAnchor
  }

  const dist = distance(fromAnchor.point, toAnchor.point)
  const offset = Math.max(50, dist * 0.4)
  const c1 = {
    x: fromAnchor.point.x + fromAnchor.normal.x * offset,
    y: fromAnchor.point.y + fromAnchor.normal.y * offset,
  }
  const c2 = {
    x: toAnchor.point.x + toAnchor.normal.x * offset,
    y: toAnchor.point.y + toAnchor.normal.y * offset,
  }
  return [
    `M ${fromAnchor.point.x} ${fromAnchor.point.y}`,
    `C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${toAnchor.point.x} ${toAnchor.point.y}`,
  ].join(' ')
}
