/**
 * 砚小龙 · 桌宠浮动窗口几何算法（纯函数）
 *
 * 该模块只做数学计算，不依赖 Electron / React，便于物理边界单元测试。
 * 架构：**160px 大立绘 + 常驻灵动伴随卡片（420px 宽）**，卡片底部与立绘底部基线对齐，
 * 气泡/历史面板向上生长，输入条恒定处于最顺手的底部位置。
 *
 *   - computePushBackCoordinates：视口边界碰撞检测与智能推回；
 *   - computePetCardLayout：伴随卡片态紧凑包裹矩形（含桌宠 / 卡片本地坐标）；
 *   - computePetOnlyLayout：仅显示桌宠态的紧凑包裹矩形。
 */

/** 桌宠立绘尺寸（DIP）——160px 大立绘强化视觉沉浸感 */
export const PET_WIDTH = 160
export const PET_HEIGHT = 160
/** 桌宠与伴随卡片间距（DIP） */
export const PET_GAP = 12
/** 伴随卡片（气泡 + 输入条）宽度（DIP）——420px 提供更从容的对话阅读宽度 */
export const CARD_WIDTH = 420
/** 灵动气泡紧凑态高度（DIP） */
export const BUBBLE_HEIGHT = 150
/** 展开完整历史时的高度（DIP） */
export const HISTORY_HEIGHT = 520
/** 输入条高度（DIP）——60px 抬高输入区，长文本更易阅读编辑 */
export const INPUT_BAR_HEIGHT = 60
/** 气泡 / 历史面板与输入条之间的内间距（DIP） */
export const CARD_INNER_GAP = 8
/** 视口内边距（DIP） */
export const PET_MARGIN = 16
/** 阴影与圆角留白缓冲（DIP），防止透明子窗口边界硬裁切立绘柔和投影与卡片 shadow */
export const SHADOW_PADDING = 16
/**
 * 伴随态联合外框总宽度（DIP）：立绘 + 间距 + 伴随卡片 = 160 + 12 + 420 = 592。
 * 正中央定位以此为水平居中基准，保证立绘与输入框整体落在用户视野黄金区域。
 */
export const PET_UNION_WIDTH = PET_WIDTH + PET_GAP + CARD_WIDTH

/** 旧版写死的极左上角坐标 (24, 24)：需在首帧自动迁移至视口正中央 */
export const LEGACY_DEFAULT_PET_POSITION = { x: 24, y: 24 } as const

/** 卡片显示模式：灵动气泡 / 完整历史 */
export type YanhuPetCardMode = 'bubble' | 'history'

/** 依据卡片模式计算卡片内容总高度（面板 + 内间距 + 输入条） */
export function computeCardHeight(mode: YanhuPetCardMode): number {
  const panel = mode === 'history' ? HISTORY_HEIGHT : BUBBLE_HEIGHT
  return panel + CARD_INNER_GAP + INPUT_BAR_HEIGHT
}

/** 推回算法入参 */
export interface PushBackInput {
  xp: number
  yp: number
  direction: 'left' | 'right'
  vw: number
  vh: number
  petW?: number
  petH?: number
  cardW?: number
  cardH?: number
  gap?: number
  margin?: number
}

/** 推回算法出参 */
export interface PushBackResult {
  nextXp: number
  nextYp: number
  autoFlippedDirection: 'left' | 'right'
}

/**
 * 边界碰撞与智能推回算法。
 *
 * 以「桌宠 + 伴随卡片」的联合外框为约束：卡片底部与桌宠底部对齐，故卡片越高，
 * 联合外框越向上生长。若越出视口则向内侧反推，必要时自动翻转卡片朝向。
 */
export function computePushBackCoordinates(input: PushBackInput): PushBackResult {
  const {
    xp,
    yp,
    direction,
    vw,
    vh,
    petW = PET_WIDTH,
    petH = PET_HEIGHT,
    cardW = CARD_WIDTH,
    cardH = computeCardHeight('bubble'),
    gap = PET_GAP,
    margin = PET_MARGIN,
  } = input

  let nextXp = xp
  let nextYp = yp
  let finalDirection = direction

  // Y 轴自适应推回：卡片底边与桌宠底边对齐，联合外框向上生长
  const unionH = Math.max(petH, cardH)
  const minYp = margin + Math.max(0, unionH - petH)
  const maxYp = Math.max(minYp, vh - margin - petH)
  nextYp = Math.min(Math.max(nextYp, minYp), maxYp)

  // X 轴智能推回
  if (finalDirection === 'right') {
    const requiredRight = nextXp + petW + gap + cardW
    if (requiredRight > vw - margin) {
      // 空间不足：向左推回桌宠
      nextXp = vw - margin - cardW - gap - petW
      // 若向左推回后导致桌宠贴出左边界，则强制翻转方向至 left
      if (nextXp < margin) {
        nextXp = margin + cardW + gap
        finalDirection = 'left'
      }
    }
  } else {
    // 朝向为左
    const requiredLeft = nextXp - gap - cardW
    if (requiredLeft < margin) {
      // 空间不足：向右推回桌宠
      nextXp = margin + cardW + gap
      // 若向右推回后导致桌宠贴出右边界，则强制翻转方向至 right
      if (nextXp + petW > vw - margin) {
        nextXp = vw - margin - petW
        finalDirection = 'right'
      }
    }
  }

  return { nextXp: Math.round(nextXp), nextYp: Math.round(nextYp), autoFlippedDirection: finalDirection }
}

/** 伴随卡片态布局（视口坐标系窗口外框 + 窗口内本地坐标） */
export interface PetCardLayout {
  winX: number
  winY: number
  winWidth: number
  winHeight: number
  /** 桌宠立绘在窗口内的本地坐标 */
  petLocalX: number
  petLocalY: number
  /** 伴随卡片在窗口内的本地坐标 */
  cardLocalX: number
  cardLocalY: number
}

export interface PetCardLayoutInput {
  xp: number
  yp: number
  direction: 'left' | 'right'
  /** 卡片实际高度（可由渲染层测量） */
  cardHeight: number
  petW?: number
  petH?: number
  cardW?: number
  gap?: number
  padding?: number
}

/**
 * 计算「桌宠 + 伴随卡片」的紧凑包裹外框，并给出两者在窗口内的本地坐标。
 * 卡片底部与桌宠底部对齐（Bottom Alignment）。
 */
export function computePetCardLayout(input: PetCardLayoutInput): PetCardLayout {
  const {
    xp,
    yp,
    direction,
    cardHeight,
    petW = PET_WIDTH,
    petH = PET_HEIGHT,
    cardW = CARD_WIDTH,
    gap = PET_GAP,
    padding = SHADOW_PADDING,
  } = input

  const unionH = Math.max(petH, cardHeight)
  const cardTopY = yp + petH - cardHeight
  const unionTopY = yp + petH - unionH
  const winY = unionTopY - padding
  const winHeight = unionH + 2 * padding

  let cardX: number
  let winX: number
  let winWidth: number
  if (direction === 'right') {
    cardX = xp + petW + gap
    winX = xp - padding
    winWidth = petW + gap + cardW + 2 * padding
  } else {
    cardX = xp - gap - cardW
    winX = cardX - padding
    winWidth = cardW + gap + petW + 2 * padding
  }

  return {
    winX: Math.round(winX),
    winY: Math.round(winY),
    winWidth: Math.round(winWidth),
    winHeight: Math.round(winHeight),
    petLocalX: Math.round(xp - winX),
    petLocalY: Math.round(yp - winY),
    cardLocalX: Math.round(cardX - winX),
    cardLocalY: Math.round(cardTopY - winY),
  }
}

/** 仅显示桌宠态的紧凑包裹矩形（含本地坐标 = padding） */
export function computePetOnlyLayout(input: {
  xp: number
  yp: number
  petW?: number
  petH?: number
  padding?: number
}): PetCardLayout {
  const { xp, yp, petW = PET_WIDTH, petH = PET_HEIGHT, padding = SHADOW_PADDING } = input
  return {
    winX: Math.round(xp - padding),
    winY: Math.round(yp - padding),
    winWidth: petW + 2 * padding,
    winHeight: petH + 2 * padding,
    petLocalX: padding,
    petLocalY: padding,
    cardLocalX: 0,
    cardLocalY: 0,
  }
}

/** 矩形（窗口本地坐标，DIP） */
export interface LocalRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 计算「桌宠 + 伴随卡片」的交互命中并集矩形（窗口本地坐标）。
 *
 * 关键：把桌宠与卡片之间的透明间隙（PET_GAP）一并纳入并集——鼠标从立绘划向卡片时若途经
 * 间隙而脱离命中区，穿透开关会被反复触发（此前的「碰撞箱不稳定」根因）。
 * 阴影留白（SHADOW_PADDING）不参与命中，保证窗口四周透明区依旧可点穿到网页。
 */
export function computeInteractionUnionRect(input: {
  petLocalX: number
  petLocalY: number
  cardLocalX: number
  cardLocalY: number
  cardVisible: boolean
  cardHeight: number
  petW?: number
  petH?: number
  cardW?: number
}): LocalRect {
  const {
    petLocalX,
    petLocalY,
    cardLocalX,
    cardLocalY,
    cardVisible,
    cardHeight,
    petW = PET_WIDTH,
    petH = PET_HEIGHT,
    cardW = CARD_WIDTH,
  } = input
  if (!cardVisible) {
    return { x: petLocalX, y: petLocalY, width: petW, height: petH }
  }
  const minX = Math.min(petLocalX, cardLocalX)
  const minY = Math.min(petLocalY, cardLocalY)
  const maxX = Math.max(petLocalX + petW, cardLocalX + cardW)
  const maxY = Math.max(petLocalY + petH, cardLocalY + cardHeight)
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** 判定点是否落在矩形内（可带滞后余量 hysteresis，用于消除边界抖动） */
export function isPointInsideRect(x: number, y: number, rect: LocalRect, hysteresis = 0): boolean {
  return (
    x >= rect.x - hysteresis &&
    x <= rect.x + rect.width + hysteresis &&
    y >= rect.y - hysteresis &&
    y <= rect.y + rect.height + hysteresis
  )
}

/** 仅显示桌宠时，将桌宠夹取到视口内边距范围内 */
export function clampPetPosition(
  xp: number,
  yp: number,
  vw: number,
  vh: number,
  margin = PET_MARGIN,
): { xp: number; yp: number } {
  const maxX = Math.max(margin, vw - margin - PET_WIDTH)
  const maxY = Math.max(margin, vh - margin - PET_HEIGHT)
  return {
    xp: Math.min(Math.max(margin, Math.round(xp)), maxX),
    yp: Math.min(Math.max(margin, Math.round(yp)), maxY),
  }
}

/**
 * 视口物理正中央定位（Center Alignment Math）。
 *
 * - 伴随卡片可见时，以「立绘 + 间距 + 卡片」联合外框（PET_UNION_WIDTH = 592px）在视口中
 *   水平居中：centerX = max(margin, round((vw - 592) / 2))；卡片底边与立绘底边对齐，故立绘纵向居中。
 * - 仅显示立绘时，以 160px 立绘单体水平居中：centerX = max(margin, round((vw - 160) / 2))。
 * - 纵向恒为 centerY = max(margin, round((vh - 160) / 2))。
 *
 * 返回坐标含义与 `petPosition` 完全一致：以视口左上角为原点的桌宠立绘左上角坐标（DIP）。
 * `direction` 决定立绘在联合外框内的位置：'right' 时卡片居右（立绘取联合左缘），
 * 'left' 时卡片居左（立绘取联合右缘），从而保证整组元素几何居中而非仅立绘居中。
 */
export function computeCenterPetPosition(
  vw: number,
  vh: number,
  cardVisible: boolean,
  direction: 'left' | 'right' = 'right',
): { x: number; y: number } {
  const centerY = Math.max(PET_MARGIN, Math.round((vh - PET_HEIGHT) / 2))
  if (!cardVisible) {
    return { x: Math.max(PET_MARGIN, Math.round((vw - PET_WIDTH) / 2)), y: centerY }
  }
  const unionLeft = Math.max(PET_MARGIN, Math.round((vw - PET_UNION_WIDTH) / 2))
  const petX = direction === 'left' ? unionLeft + PET_GAP + CARD_WIDTH : unionLeft
  return { x: petX, y: centerY }
}

/**
 * 判定坐标是否为旧版写死的极左上角死值 (24, 24) 或非法/未初始化值。
 *
 * 命中的坐标应在首帧自动迁移至视口物理正中央，消除「砚小龙贴在 Logo / 顶栏盲区」的偏倚。
 */
export function isLegacyDefaultPosition(
  pos: { x: number; y: number } | null | undefined,
): boolean {
  if (!pos) return true
  if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return true
  return pos.x === LEGACY_DEFAULT_PET_POSITION.x && pos.y === LEGACY_DEFAULT_PET_POSITION.y
}
