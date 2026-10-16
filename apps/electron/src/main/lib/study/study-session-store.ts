/**
 * AI 速课堂会话专属存储（StudySessionStore）
 *
 * 遵循 AGENTS.md「零数据库、纯文本 JSON 原子写入」原则，全部落盘于
 * `~/.cdutai/study-sessions/{sessionId}/`：
 *   - tabs.json        当前课堂打开的 Chrome 风格多 Tab 拓扑；
 *   - mindmaps.json    生成的思维导图数据与用户自定义坐标；
 *   - flashcards.json  抽认卡卡包及 FSRS-7 学习状态；
 *   - quizzes.json     测验题库、答题记录与 FIM 认知轨迹。
 *
 * 读写均为纯函数 + 原子落盘，便于单测；损坏数据一律静默降级为空，绝不阻塞 UI。
 */

import {
  AI_CLASS_HOME_TAB_ID,
  type AiClassRightTabItem,
  type AiClassTabsState,
  type FlashcardDeck,
  type FlashcardItem,
  type FlashcardRating,
  type MindMapData,
  type QuizSession,
  type StudyArtifactSummary,
} from '@profer/shared'
import {
  getStudyFlashcardsPath,
  getStudyMindmapsPath,
  getStudyQuizzesPath,
  getStudySessionDataDir,
  getStudyTabsPath,
} from '../config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from '../safe-file'
import { scheduleFsrs } from './fsrs-scheduler'
import { estimateTheta, itemParamsForDifficulty } from './fim-estimator'
import { shuffleQuiz } from './quiz-options'

/** 存储结构版本（后续迁移用） */
export const STUDY_SESSION_STORE_VERSION = 1

/**
 * 写入前确保课堂专属存储目录存在。
 *
 * `writeJsonFileAtomic` 不会自动创建父目录，而 `getStudySessionDataDir` 默认纯路径解析
 * （无创建副作用，避免读取即建目录），故所有写入路径必须先显式确保目录存在。
 */
function ensureSessionDataDir(sessionId: string): void {
  getStudySessionDataDir(sessionId, { create: true })
}

/** 构造固定的首页标签 */
export function createHomeTab(): AiClassRightTabItem {
  return { id: AI_CLASS_HOME_TAB_ID, type: 'home', title: '学习主页', closable: false, data: {} }
}

/** 归一化多 Tab 拓扑：保证首页恒在首位且不可关闭，且 activeTabId 有效。 */
export function normalizeTabsState(
  sessionId: string,
  tabs: readonly AiClassRightTabItem[],
  activeTabId: string,
): AiClassTabsState {
  const home = createHomeTab()
  const others = tabs.filter((tab) => tab.id !== home.id && tab.type !== 'home')
  const merged = [home, ...others]
  const active = merged.some((tab) => tab.id === activeTabId) ? activeTabId : home.id
  return { sessionId, tabs: merged, activeTabId: active }
}

// ===== 多 Tab 拓扑 =====

interface TabsFile {
  version: number
  tabs: AiClassRightTabItem[]
  activeTabId: string
}

/** 读取当前课堂的多 Tab 拓扑（无记录时返回仅含首页的默认拓扑） */
export function getTabs(sessionId: string): AiClassTabsState {
  const raw = readJsonFileSafe<Partial<TabsFile>>(getStudyTabsPath(sessionId))
  const tabs = Array.isArray(raw?.tabs) ? (raw!.tabs as AiClassRightTabItem[]) : []
  return normalizeTabsState(sessionId, tabs, typeof raw?.activeTabId === 'string' ? raw!.activeTabId : AI_CLASS_HOME_TAB_ID)
}

/** 保存当前课堂的多 Tab 拓扑 */
export function saveTabs(
  sessionId: string,
  tabs: readonly AiClassRightTabItem[],
  activeTabId: string,
): AiClassTabsState {
  const state = normalizeTabsState(sessionId, tabs, activeTabId)
  ensureSessionDataDir(sessionId)
  writeJsonFileAtomic(getStudyTabsPath(sessionId), {
    version: STUDY_SESSION_STORE_VERSION,
    tabs: state.tabs,
    activeTabId: state.activeTabId,
  } satisfies TabsFile)
  return state
}

// ===== 思维导图 =====

interface MindmapsFile {
  version: number
  mindmaps: MindMapData[]
}

function readMindmaps(sessionId: string): MindMapData[] {
  const raw = readJsonFileSafe<Partial<MindmapsFile>>(getStudyMindmapsPath(sessionId))
  return Array.isArray(raw?.mindmaps) ? (raw!.mindmaps as MindMapData[]) : []
}

/** 读取思维导图（缺省返回最近一张） */
export function getMindmap(sessionId: string, mindmapId?: string): MindMapData | null {
  const list = readMindmaps(sessionId)
  if (list.length === 0) return null
  if (!mindmapId) return list[list.length - 1] ?? null
  return list.find((m) => m.id === mindmapId) ?? null
}

/** 保存（覆盖或新增）思维导图 */
export function saveMindmap(sessionId: string, mindmap: MindMapData): void {
  const list = readMindmaps(sessionId)
  const index = list.findIndex((m) => m.id === mindmap.id)
  if (index >= 0) list[index] = mindmap
  else list.push(mindmap)
  ensureSessionDataDir(sessionId)
  writeJsonFileAtomic(getStudyMindmapsPath(sessionId), {
    version: STUDY_SESSION_STORE_VERSION,
    mindmaps: list,
  } satisfies MindmapsFile)
}

/** 保存用户拖拽后的气泡坐标（按节点 id 覆盖 position） */
export function saveMindmapCoords(
  sessionId: string,
  mindmapId: string,
  coords: Record<string, { x: number; y: number }>,
): MindMapData | null {
  const list = readMindmaps(sessionId)
  const index = list.findIndex((m) => m.id === mindmapId)
  if (index < 0) return null
  const mindmap = list[index]!
  const apply = (node: MindMapData['root']): void => {
    const pos = coords[node.id]
    if (pos) node.position = { x: Math.round(pos.x), y: Math.round(pos.y) }
    for (const child of node.children ?? []) apply(child)
  }
  apply(mindmap.root)
  ensureSessionDataDir(sessionId)
  writeJsonFileAtomic(getStudyMindmapsPath(sessionId), {
    version: STUDY_SESSION_STORE_VERSION,
    mindmaps: list,
  } satisfies MindmapsFile)
  return mindmap
}

// ===== 抽认卡与 FSRS-7 =====

interface FlashcardsFile {
  version: number
  decks: FlashcardDeck[]
}

function readDecks(sessionId: string): FlashcardDeck[] {
  const raw = readJsonFileSafe<Partial<FlashcardsFile>>(getStudyFlashcardsPath(sessionId))
  return Array.isArray(raw?.decks) ? (raw!.decks as FlashcardDeck[]) : []
}

/** 读取抽认卡卡包（缺省返回最近一个） */
export function getFlashcards(sessionId: string, deckId?: string): FlashcardDeck | null {
  const list = readDecks(sessionId)
  if (list.length === 0) return null
  if (!deckId) return list[list.length - 1] ?? null
  return list.find((d) => d.id === deckId) ?? null
}

/** 保存（覆盖或新增）抽认卡卡包 */
export function saveFlashcardDeck(sessionId: string, deck: FlashcardDeck): void {
  const list = readDecks(sessionId)
  const index = list.findIndex((d) => d.id === deck.id)
  if (index >= 0) list[index] = deck
  else list.push(deck)
  ensureSessionDataDir(sessionId)
  writeJsonFileAtomic(getStudyFlashcardsPath(sessionId), {
    version: STUDY_SESSION_STORE_VERSION,
    decks: list,
  } satisfies FlashcardsFile)
}

/**
 * 提交一次卡片评分，驱动 FSRS-7 状态推进并落盘。
 * @returns 更新后的卡片（未找到卡片返回 null）。
 */
export function updateCardRating(input: {
  sessionId: string
  deckId: string
  cardId: string
  rating: FlashcardRating
  reviewedAt?: number
}): FlashcardItem | null {
  const list = readDecks(input.sessionId)
  const deck = list.find((d) => d.id === input.deckId)
  if (!deck) return null
  const card = deck.cards.find((c) => c.id === input.cardId)
  if (!card) return null
  const reviewedAt = input.reviewedAt ?? Date.now()
  card.fsrs = scheduleFsrs(card.fsrs, input.rating, reviewedAt)
  ensureSessionDataDir(input.sessionId)
  writeJsonFileAtomic(getStudyFlashcardsPath(input.sessionId), {
    version: STUDY_SESSION_STORE_VERSION,
    decks: list,
  } satisfies FlashcardsFile)
  return card
}

// ===== 测验与 FIM =====

interface QuizzesFile {
  version: number
  quizzes: QuizSession[]
}

function readQuizzes(sessionId: string): QuizSession[] {
  const raw = readJsonFileSafe<Partial<QuizzesFile>>(getStudyQuizzesPath(sessionId))
  return Array.isArray(raw?.quizzes) ? (raw!.quizzes as QuizSession[]) : []
}

function sameKeySet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.every((value, i) => value === sb[i])
}

/** 读取测验（缺省返回最近一套） */
export function getQuiz(sessionId: string, quizId?: string): QuizSession | null {
  const list = readQuizzes(sessionId)
  if (list.length === 0) return null
  if (!quizId) return list[list.length - 1] ?? null
  return list.find((q) => q.id === quizId) ?? null
}

/** 保存（覆盖或新增）测验 */
export function saveQuiz(sessionId: string, quiz: QuizSession): void {
  const list = readQuizzes(sessionId)
  const index = list.findIndex((q) => q.id === quiz.id)
  if (index >= 0) list[index] = quiz
  else list.push(quiz)
  ensureSessionDataDir(sessionId)
  writeJsonFileAtomic(getStudyQuizzesPath(sessionId), {
    version: STUDY_SESSION_STORE_VERSION,
    quizzes: list,
  } satisfies QuizzesFile)
}

/**
 * 提交单题作答：实时判分、更新 FIM 潜伏能力估计与总分，并落盘。
 * @returns 更新后的测验会话（未找到返回 null）。
 */
export function submitQuizAnswer(input: {
  sessionId: string
  quizId: string
  questionId: string
  selection: string[]
}): QuizSession | null {
  const list = readQuizzes(input.sessionId)
  const quiz = list.find((q) => q.id === input.quizId)
  if (!quiz) return null
  const question = quiz.questions.find((q) => q.id === input.questionId)
  if (!question) return null

  question.userSelection = [...input.selection]
  question.isCorrect = sameKeySet(question.answer, input.selection)

  const answered = quiz.questions.filter((q) => q.isCorrect !== undefined)
  const correctCount = answered.filter((q) => q.isCorrect === true).length
  quiz.score = answered.length > 0 ? Math.round((correctCount / quiz.questions.length) * 100) : 0
  quiz.completed = answered.length === quiz.questions.length
  quiz.estimatedTheta = estimateTheta(
    answered.map((q) => ({ item: itemParamsForDifficulty(quiz.difficulty), correct: q.isCorrect === true })),
  )

  ensureSessionDataDir(input.sessionId)
  writeJsonFileAtomic(getStudyQuizzesPath(input.sessionId), {
    version: STUDY_SESSION_STORE_VERSION,
    quizzes: list,
  } satisfies QuizzesFile)
  return quiz
}

/**
 * 重置测验：清空全部作答记录与判分状态（userSelection / isCorrect / score /
 * estimatedTheta / completed），并**重新打乱题序与选项序**，支持同一套题反复练习。
 *
 * 每次重做都重新洗牌的两点理由：
 *   1. 避免学生靠位置记忆作答（题序与选项序每轮都不同）；
 *   2. 模型可能给出「正确答案集中在 A」的原始分布，重排可保证位置均匀。
 * @returns 重置后的测验会话（未找到返回 null）。
 */
export function resetQuiz(input: { sessionId: string; quizId: string }): QuizSession | null {
  const list = readQuizzes(input.sessionId)
  const quiz = list.find((q) => q.id === input.quizId)
  if (!quiz) return null
  for (const question of quiz.questions) {
    delete question.userSelection
    delete question.isCorrect
  }
  quiz.questions = shuffleQuiz(quiz.questions)
  quiz.score = 0
  quiz.estimatedTheta = 0
  quiz.completed = false
  ensureSessionDataDir(input.sessionId)
  writeJsonFileAtomic(getStudyQuizzesPath(input.sessionId), {
    version: STUDY_SESSION_STORE_VERSION,
    quizzes: list,
  } satisfies QuizzesFile)
  return quiz
}

// ===== 已生成成果总览（右侧工作台常驻列表消费） =====

/** 递归统计导图节点数 */
function countMindMapNodes(node: MindMapData['root']): number {
  let total = 1
  for (const child of node.children ?? []) total += countMindMapNodes(child)
  return total
}

/**
 * 列出当前课堂已生成的全部学习工件摘要（导图 / 抽认卡 / 测验），
 * 按创建时间倒序返回（缺失时间戳的旧数据排后），供右侧工作台常驻列表展示。
 */
export function listStudyArtifacts(sessionId: string): StudyArtifactSummary[] {
  const summaries: StudyArtifactSummary[] = []
  for (const mindmap of readMindmaps(sessionId)) {
    summaries.push({
      id: mindmap.id,
      kind: 'mindmap',
      title: mindmap.title || '思维导图',
      createdAt: mindmap.createdAt ?? 0,
      itemCount: countMindMapNodes(mindmap.root),
    })
  }
  for (const deck of readDecks(sessionId)) {
    summaries.push({
      id: deck.id,
      kind: 'flashcard',
      title: deck.title || '抽认卡',
      createdAt: deck.createdAt ?? 0,
      itemCount: deck.cards.length,
    })
  }
  for (const quiz of readQuizzes(sessionId)) {
    summaries.push({
      id: quiz.id,
      kind: 'quiz',
      title: quiz.title || '自测练习',
      createdAt: quiz.createdAt ?? 0,
      itemCount: quiz.questions.length,
    })
  }
  return summaries.sort((a, b) => b.createdAt - a.createdAt)
}
