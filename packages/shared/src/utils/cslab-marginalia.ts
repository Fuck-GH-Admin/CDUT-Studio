/**
 * CSLab 旁注（Marginalia）一维区间排程纯函数
 *
 * 主进程 / 渲染进程共用，零 DOM 依赖：
 * - 按锚点目标 Y 自上而下做「重力松弛」，消除同段落多条批注的重叠；
 * - 输出 actualTop 与 connectorOffset，供 React 用 `transform: translateY()`
 *   做 GPU 合成层位移动画（严禁修改 top / margin 触发整页布局抖动）。
 */

export interface CsLabCommentAnchor {
  id: string
  /** 正文锚点的理想像素 Y 坐标（已转换为容器相对坐标）。 */
  targetTop: number
  /** 卡片实际渲染高度。 */
  cardHeight: number
}

export interface CsLabPositionedComment extends CsLabCommentAnchor {
  /** 松弛之后的最终 Y 坐标（卡片 top）。 */
  actualTop: number
  /** targetTop - actualTop，供 SVG 引线补偿。 */
  connectorOffset: number
}

/**
 * 计算互不重叠的卡片 Y 坐标。
 * gapMargin 为卡片之间的最小垂直间距（px）。
 */
export function calculateMarginaliaLayout(
  comments: CsLabCommentAnchor[],
  gapMargin = 16,
): CsLabPositionedComment[] {
  const gap = Number.isFinite(gapMargin) ? Math.max(0, gapMargin) : 16
  const sorted = [...comments]
    .filter(
      (comment) =>
        Number.isFinite(comment.targetTop) && Number.isFinite(comment.cardHeight),
    )
    .sort((left, right) => left.targetTop - right.targetTop)

  const positioned: CsLabPositionedComment[] = []
  let minimumAllowedTop = 0

  for (const comment of sorted) {
    const height = Math.max(0, comment.cardHeight)
    const resolvedTop = Math.max(comment.targetTop, minimumAllowedTop)
    positioned.push({
      ...comment,
      actualTop: resolvedTop,
      connectorOffset: comment.targetTop - resolvedTop,
    })
    minimumAllowedTop = resolvedTop + height + gap
  }

  return positioned
}

/**
 * 三次贝塞尔引线：从正文锚点（fromX, fromY）连到卡片左缘（toX, toY）。
 * 控制点取水平中点，保证平滑且不会穿过正文。
 */
export function buildConnectorPath(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): string {
  const midX = (fromX + toX) / 2
  return `M ${round(fromX)} ${round(fromY)} C ${round(midX)} ${round(fromY)}, ${round(midX)} ${round(toY)}, ${round(toX)} ${round(toY)}`
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
