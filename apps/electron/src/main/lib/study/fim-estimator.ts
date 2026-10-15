/**
 * 连续 Fisher 信息矩阵（FIM）认知水平追踪引擎
 *
 * 以 2 参数逻辑斯蒂 IRT 模型（2PL）刻画潜伏认知能力 θ ∈ [-3, +3]：
 *
 *   P(correct | θ, a, b) = 1 / (1 + exp(-a · (θ - b)))
 *
 * 每道题的区分度 a 与难度 b 决定了该题携带的 Fisher 信息量；作答后以在线梯度
 * 更新 θ（等价于对单题对数似然做一步 Newton / 梯度上升），并整体钳制在 [-3, +3]：
 *
 *   θ' = clamp(θ + η · a · (u - P), -3, +3)   （u ∈ {0,1} 为是否答对）
 *
 * 本模块为纯函数实现，可在单测中直接消费。
 */

/** 单道题的 2PL 参数 */
export interface FimItemParams {
  /** 区分度 a（越大越能区分能力高低，通常 0.5 ~ 2.5） */
  discrimination: number
  /** 难度 b（与 θ 同尺度） */
  difficulty: number
}

/** θ 的取值边界 */
export const THETA_MIN = -3
export const THETA_MAX = 3

/** 依据难度标签推导默认 2PL 参数 */
export function itemParamsForDifficulty(level: 'easy' | 'medium' | 'hard' | string | undefined): FimItemParams {
  switch (level) {
    case 'easy':
      return { discrimination: 1.0, difficulty: -1.0 }
    case 'hard':
      return { discrimination: 1.4, difficulty: 1.2 }
    case 'medium':
    default:
      return { discrimination: 1.2, difficulty: 0.2 }
  }
}

function clampTheta(theta: number): number {
  if (!Number.isFinite(theta)) return 0
  return Math.min(THETA_MAX, Math.max(THETA_MIN, theta))
}

/** 2PL 作答正确概率 */
export function fimProbability(theta: number, item: FimItemParams): number {
  const z = item.discrimination * (theta - item.difficulty)
  return 1 / (1 + Math.exp(-z))
}

/** 单题 Fisher 信息量 I(θ) = a² · P · (1 - P) */
export function fimInformation(theta: number, item: FimItemParams): number {
  const p = fimProbability(theta, item)
  return item.discrimination * item.discrimination * p * (1 - p)
}

/**
 * 在线更新潜伏能力 θ（单题作答后）。
 *
 * @param theta 当前能力估计
 * @param item  题目参数
 * @param correct 是否答对
 * @param learningRate 学习率 η（默认 0.6，兼顾收敛速度与稳定性）
 */
export function updateTheta(
  theta: number,
  item: FimItemParams,
  correct: boolean,
  learningRate = 0.6,
): number {
  const p = fimProbability(theta, item)
  const u = correct ? 1 : 0
  return clampTheta(theta + learningRate * item.discrimination * (u - p))
}

/**
 * 由一组作答记录整体估计 θ（按序在线更新，最终钳制在 [-3, 3]）。
 */
export function estimateTheta(
  answers: ReadonlyArray<{ item: FimItemParams; correct: boolean }>,
  initialTheta = 0,
): number {
  let theta = clampTheta(initialTheta)
  for (const answer of answers) {
    theta = updateTheta(theta, answer.item, answer.correct)
  }
  return theta
}

/** 把连续 θ 映射为可读的能力等级标签（统一从 @profer/shared 导出） */
export { describeTheta } from '@profer/shared'
