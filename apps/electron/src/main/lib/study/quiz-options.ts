/**
 * 测验题目与选项的洗牌（纯函数，无主进程依赖，便于单元测试覆盖）
 *
 * 两条产品红线：
 *   1. **选项位置不得偏置**：模型在缺少位置约束时会系统性地把正确答案放在首位（A），
 *      导致整套题「答案全是 A」；重排后按新顺序重新编号 A/B/C/D 并同步重映射答案。
 *   2. **每次重做都要重新打乱**：题目出现顺序与选项顺序在每轮练习中都应重新随机，
 *      避免学生靠位置记忆作答（同一道题重练时顺序也会变化）。
 */

/** 选项最小结构（与 @profer/shared 的 QuizOption 结构兼容） */
export interface ShufflableOption {
  key: string
  text: string
}

/** 题型（与 @profer/shared 的 QuizQuestionType 兼容） */
export type ShufflableQuestionType = 'single' | 'multiple' | 'boolean'

/** 可参与洗牌的题目最小结构 */
export interface ShufflableQuestion {
  question: string
  type: ShufflableQuestionType
  options: ShufflableOption[]
  answer: string[]
}

/** 随机源（0 ≤ r < 1）；注入形式便于测试复现 */
export type RandomSource = () => number

/** 选项编号序列 */
export const OPTION_KEYS: readonly string[] = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

/** 就地 Fisher-Yates 洗牌（返回新数组，不修改入参） */
export function shuffleWith<T>(items: readonly T[], random: RandomSource = Math.random): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const a = out[i]!
    out[i] = out[j]!
    out[j] = a
  }
  return out
}

/** 确定性伪随机源（FNV-1a 文本哈希播种 + xorshift32），供测试与需要可复现性的场景使用 */
export function createSeededRandom(seedText: string): RandomSource {
  let seed = 2166136261
  for (let i = 0; i < seedText.length; i++) {
    seed ^= seedText.charCodeAt(i)
    seed = Math.imul(seed, 16777619)
  }
  seed = seed >>> 0 || 1
  return () => {
    seed ^= seed << 13
    seed >>>= 0
    seed ^= seed >>> 17
    seed ^= seed << 5
    seed >>>= 0
    return seed / 0xffffffff
  }
}

/**
 * 重排选项顺序并按新顺序重新编号 A/B/C/D…，同时同步重映射正确答案。
 *
 * - True/False 题保持约定顺序（正确在前）不参与重排；
 * - 选项不足 2 个时不重排；
 * - 若 answer 与任何选项 key 都对不上（脏数据），原样返回，绝不把题目改坏。
 */
export function shuffleQuestionOptions<T extends ShufflableOption>(
  question: string,
  type: ShufflableQuestionType,
  options: readonly T[],
  answer: readonly string[],
  random: RandomSource = Math.random,
): { options: T[]; answer: string[] } {
  if (type === 'boolean' || options.length < 2) return { options: [...options], answer: [...answer] }
  const correctKeys = new Set(answer)
  const remappedOptions: T[] = []
  const remappedAnswer: string[] = []
  for (const [index, option] of shuffleWith(options, random).entries()) {
    const key = OPTION_KEYS[index] ?? option.key
    remappedOptions.push({ ...option, key })
    if (correctKeys.has(option.key)) remappedAnswer.push(key)
  }
  // 重映射失败（模型给的 key 与选项不匹配）时保留原样，避免把题目改坏
  if (remappedAnswer.length === 0) return { options: [...options], answer: [...answer] }
  return { options: remappedOptions, answer: [...new Set(remappedAnswer)] }
}

/**
 * 洗牌整份测验：题目出现顺序随机 + 每题选项顺序随机（答案同步重映射）。
 * 生成时与每次「再练一次」时都应调用，保证每轮练习的题序与选项序都不同。
 */
export function shuffleQuiz<T extends ShufflableQuestion>(
  questions: readonly T[],
  random: RandomSource = Math.random,
): T[] {
  return shuffleWith(questions, random).map((question) => {
    const { options, answer } = shuffleQuestionOptions(
      question.question,
      question.type,
      question.options,
      question.answer,
      random,
    )
    return { ...question, options, answer }
  })
}

/** 统计一组题目正确答案所在位置（选项序号，0-based）的分布 */
export function answerPositionHistogram(
  questions: ReadonlyArray<{ options: ReadonlyArray<ShufflableOption>; answer: string[] }>,
): number[] {
  const histogram = [0, 0, 0, 0]
  for (const question of questions) {
    const key = question.answer[0]
    if (!key) continue
    const index = question.options.findIndex((option) => option.key === key)
    if (index >= 0 && index < histogram.length) histogram[index] = (histogram[index] ?? 0) + 1
  }
  return histogram
}
