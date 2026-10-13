/**
 * FSRS-7 记忆动力学调度引擎（Free Spaced Repetition Scheduler v7 核心状态模型）
 *
 * 记忆状态三元组 `MemoryState = (R, S, D)`：
 *   - R（Retrievability）提取概率：R(t, S) = (1 + FACTOR · t/S)^DECAY；
 *   - S（Stability）记忆稳定性：可回忆概率衰减到 90% 所需的天数；
 *   - D（Difficulty）卡片难度：1~10，随评分动态更新并向初始难度回归。
 *
 * 复习时按四挡评分（Again / Hard / Good / Easy）推进：
 *   - Again：判定记忆脱落，重置短期稳定性、累加遗忘次数，安排在 10 分钟后重测；
 *   - Hard：轻微遗忘，较小幅度递增稳定性；
 *   - Good：符合期望，按幂律检索曲线（Lomax 生存混合分布同构形式）计算最优点间隔；
 *   - Easy：极佳回忆，附加 easyBonus 大幅拉长下次复习间隔。
 *
 * 本模块为**纯函数**实现（时间通过入参注入），可在单测中直接消费。
 */

import type { FlashcardFsrs, FlashcardRating } from '@profer/shared'

/** 幂律衰减常数（FSRS 标准） */
const DECAY = -0.5
/** 幂律缩放因子 FACTOR = 19/81（使 R(S, S) = 0.9） */
const FACTOR = 19 / 81
/** 目标保留率（期望的记忆保持概率） */
export const DESIRED_RETENTION = 0.9

/** 毫秒常量 */
const MINUTE_MS = 60_000
const DAY_MS = 86_400_000

/** Again 的重测间隔（毫秒）：判定脱落 → 10 分钟后重测 */
export const AGAIN_INTERVAL_MS = 10 * MINUTE_MS

/**
 * 默认权重向量（FSRS-6 同构 21 参数，截取常用前 17 项并补 learning 步进项）。
 * 结构：w[0..3] 初始稳定性；w[4..5] 初始难度；w[6] 难度增量；w[7] 难度均值回归；
 * w[8..10] 成功稳定性增益；w[11..14] 遗忘稳定性；w[15] Hard 惩罚；w[16] Easy 奖励。
 */
export const DEFAULT_FSRS_WEIGHTS: readonly number[] = [
  0.4, 0.6, 2.4, 5.8, // 初始稳定性 S0(Again/Hard/Good/Easy)
  4.93, 0.94, // 初始难度 D0
  0.86, 0.01, // 难度增量、均值回归
  1.49, 0.14, 0.94, // 成功稳定性增益
  2.18, 0.05, 0.34, 1.26, // 遗忘稳定性
  0.5, 1.3, // Hard 惩罚、Easy 奖励
]

/** 评分 → 数字等级（Again=1 / Hard=2 / Good=3 / Easy=4） */
export function ratingGrade(rating: FlashcardRating): number {
  switch (rating) {
    case 'again':
      return 1
    case 'hard':
      return 2
    case 'good':
      return 3
    case 'easy':
      return 4
  }
}

/** 提取概率 R(t, S)：t 为距上次复习的天数 */
export function retrievability(elapsedDays: number, stability: number): number {
  if (!Number.isFinite(stability) || stability <= 0) return 0
  const t = Math.max(0, elapsedDays)
  return Math.pow(1 + FACTOR * (t / stability), DECAY)
}

/** 由稳定性 S 反解目标保留率下的间隔（毫秒，下限 1 分钟） */
export function intervalMsFromStability(stability: number, requestRetention = DESIRED_RETENTION): number {
  const r = Math.min(0.99, Math.max(0.7, requestRetention))
  const days = (stability / FACTOR) * (Math.pow(r, 1 / DECAY) - 1)
  return Math.max(MINUTE_MS, Math.round(days * DAY_MS))
}

/** 初始稳定性 S0(G) = w[G-1] */
function initialStability(grade: number, w: readonly number[]): number {
  return Math.max(0.01, w[grade - 1] ?? 0.4)
}

/** 初始难度 D0(G) = w[4] - exp(w[5]·(G-1)) + 1，收敛到 [1,10] */
function initialDifficulty(grade: number, w: readonly number[]): number {
  const d = (w[4] ?? 4.93) - Math.exp((w[5] ?? 0.94) * (grade - 1)) + 1
  return clampDifficulty(d)
}

function clampDifficulty(d: number): number {
  if (!Number.isFinite(d)) return 5
  return Math.min(10, Math.max(1, d))
}

/** 难度更新：ΔD = -w[6]·(G-3)，线性阻尼 + 向 D0(Easy) 均值回归 */
function nextDifficulty(d: number, grade: number, w: readonly number[]): number {
  const delta = -(w[6] ?? 0.86) * (grade - 3)
  const damped = d + delta * ((10 - d) / 9)
  const d0Easy = initialDifficulty(4, w)
  const reverted = (w[7] ?? 0.01) * d0Easy + (1 - (w[7] ?? 0.01)) * damped
  return clampDifficulty(reverted)
}

/** 复习成功后的稳定性增益 */
function nextStabilityOnSuccess(s: number, d: number, r: number, grade: number, w: readonly number[]): number {
  const hardPenalty = grade === 2 ? (w[15] ?? 0.5) : 1
  const easyBonus = grade === 4 ? (w[16] ?? 1.3) : 1
  const gain =
    Math.exp(w[8] ?? 1.49) *
    (11 - d) *
    Math.pow(Math.max(0.01, s), -(w[9] ?? 0.14)) *
    (Math.exp((1 - r) * (w[10] ?? 0.94)) - 1) *
    hardPenalty *
    easyBonus
  return Math.max(0.01, s * (1 + gain))
}

/** 遗忘（Again）后的稳定性：S' = w[11]·D^-w[12]·((S+1)^w[13] - 1)·exp(w[14]·(1-R))，且不超过原 S */
function nextStabilityOnLapse(s: number, d: number, r: number, w: readonly number[]): number {
  const st =
    (w[11] ?? 2.18) *
    Math.pow(Math.max(1, d), -(w[12] ?? 0.05)) *
    (Math.pow(s + 1, w[13] ?? 0.34) - 1) *
    Math.exp((1 - r) * (w[14] ?? 1.26))
  return Math.max(0.01, Math.min(st, s <= 0 ? st : s))
}

/** 新建卡片的初始 FSRS 状态 */
export function createInitialFsrs(): FlashcardFsrs {
  return {
    stability: 0,
    difficulty: 5,
    reps: 0,
    lapses: 0,
    lastReview: 0,
    nextReview: 0,
    state: 'new',
  }
}

/**
 * 依据一次评分推进 FSRS 状态（纯函数，时间由 reviewedAt 注入）。
 *
 * @returns 新的 FSRS 状态（不修改入参）。
 */
export function scheduleFsrs(
  current: FlashcardFsrs,
  rating: FlashcardRating,
  reviewedAt: number,
  weights: readonly number[] = DEFAULT_FSRS_WEIGHTS,
): FlashcardFsrs {
  const grade = ratingGrade(rating)
  const isNew = current.state === 'new' || current.reps === 0

  // 1. 计算提取概率 R（新建卡片无历史，R 视为 0）
  const elapsedDays = current.lastReview > 0 ? Math.max(0, (reviewedAt - current.lastReview) / DAY_MS) : 0
  const r = isNew ? 0 : retrievability(elapsedDays, current.stability)

  // 2. 更新难度 D
  const difficulty = isNew ? initialDifficulty(grade, weights) : nextDifficulty(current.difficulty, grade, weights)

  // 3. 更新稳定性 S
  let stability: number
  let lapses = current.lapses
  let state: FlashcardFsrs['state']
  if (isNew) {
    stability = grade === 1 ? initialStability(2, weights) : initialStability(grade, weights)
    state = grade >= 3 ? 'review' : 'learning'
  } else if (grade === 1) {
    stability = nextStabilityOnLapse(current.stability, current.difficulty, r, weights)
    lapses += 1
    state = 'relearning'
  } else {
    stability = nextStabilityOnSuccess(current.stability, current.difficulty, r, grade, weights)
    state = 'review'
  }

  // 4. 计算下次到期时间
  let nextReview: number
  if (grade === 1) {
    // Again：判定脱落，统一安排在 10 分钟后重测
    nextReview = reviewedAt + AGAIN_INTERVAL_MS
  } else if (state === 'learning') {
    // Hard 首次：仍在学习步进，安排 6 分钟后再现
    nextReview = reviewedAt + 6 * MINUTE_MS
  } else {
    nextReview = reviewedAt + intervalMsFromStability(stability, DESIRED_RETENTION)
  }

  return {
    stability,
    difficulty,
    reps: current.reps + 1,
    lapses,
    lastReview: reviewedAt,
    nextReview,
    state,
  }
}

/**
 * 估算在当前稳定度下、目标保留率下的可读间隔（天），供 UI 预览「下次复习」文案。
 */
export function previewIntervalDays(stability: number, requestRetention = DESIRED_RETENTION): number {
  return intervalMsFromStability(stability, requestRetention) / DAY_MS
}
