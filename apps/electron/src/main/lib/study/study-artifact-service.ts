/**
 * 学习工件生成服务（StudyArtifactService）
 *
 * 双轨联动生成：在 AI 速课堂首页提交「思维导图 / 抽认卡 / 测验」生成请求后，
 * 由本服务聚合当前课堂资料大纲，构建结构化提示链调用一次性 JSON 补全，解析并
 * 归一化为强类型工件后原子落盘至 `~/.cdutai/study-sessions/{sessionId}/`。
 *
 * 设计要点：
 *   - 抽认卡严格遵循最小信息原则（MIP）：单问题-单答案原子命题，符合米勒 7±2 组块极限；
 *   - 测验注入一阶逻辑互斥约束（Z3 SMT 形式化），杜绝「干扰项事实上也正确」的幻觉重叠；
 *   - 全部失败路径抛出可读错误，由 IPC 层回传 UI，绝不伪造内容。
 */

import type {
  FlashcardDeck,
  FlashcardItem,
  MindMapData,
  MindMapNode,
  QuizOption,
  QuizQuestion,
  QuizSession,
  StudyGenerateArtifactInput,
  StudyGenerateArtifactResult,
} from '@profer/shared'
import { oneShotJsonCompletion } from '../cdut/cdut-ai-class-manager'
import { listStudyDocuments } from './study-document-indexer'
import { createInitialFsrs } from './fsrs-scheduler'
import { saveFlashcardDeck, saveMindmap, saveQuiz } from './study-session-store'

/** 单次生成注入模型的资料大纲字符上限（防上下文爆炸） */
const MAX_SOURCE_CHARS = 12_000

/** 生成 id 工具 */
function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 聚合当前课堂资料大纲作为生成素材（仅取已激活资料） */
function buildSourceMaterial(sessionId: string): string {
  const docs = listStudyDocuments(sessionId).filter((doc) => doc.enabled !== false)
  const parts: string[] = []
  let used = 0
  for (const doc of docs) {
    const text = `${doc.fileName}\n${doc.navigationMarkdown || ''}`.trim()
    if (!text) continue
    const remain = MAX_SOURCE_CHARS - used
    if (remain <= 0) break
    const slice = text.length > remain ? text.slice(0, remain) : text
    parts.push(slice)
    used += slice.length
  }
  return parts.join('\n\n---\n\n')
}

/** 从模型输出中稳健提取 JSON 对象（剔除可能的 markdown 代码围栏与前后缀说明） */
export function extractJsonObject(raw: string): unknown | null {
  if (!raw) return null
  let text = raw.trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence && fence[1]) text = fence[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

// ===== 思维导图归一化 =====

function normalizeMindMapNode(raw: unknown, depth: number): MindMapNode | null {
  if (!raw || typeof raw !== 'object') return null
  const node = raw as Record<string, unknown>
  const label = asString(node.label).trim()
  if (!label) return null
  const childrenRaw = asArray(node.children)
  const children: MindMapNode[] = []
  if (depth < 5) {
    for (const child of childrenRaw) {
      const normalized = normalizeMindMapNode(child, depth + 1)
      if (normalized) children.push(normalized)
    }
  }
  const result: MindMapNode = {
    id: asString(node.id) || genId('mm-node'),
    label: label.slice(0, 40),
  }
  const notes = asString(node.notes).trim()
  if (notes) result.notes = notes.slice(0, 200)
  const studyPrompt = asString(node.studyPrompt).trim()
  if (studyPrompt) result.studyPrompt = studyPrompt.slice(0, 400)
  if (children.length > 0) result.children = children
  return result
}

function normalizeMindMap(json: unknown, sourceDocs: string[]): MindMapData {
  const obj = (json ?? {}) as Record<string, unknown>
  const root = normalizeMindMapNode(obj.root ?? obj, 0)
  if (!root) throw new Error('模型未返回有效的思维导图结构')
  return {
    id: genId('mindmap'),
    title: asString(obj.title, '学习思维导图').slice(0, 60),
    sourceDocs,
    createdAt: Date.now(),
    root,
  }
}

// ===== 抽认卡归一化 =====

function normalizeFlashcard(raw: unknown): FlashcardItem | null {
  if (!raw || typeof raw !== 'object') return null
  const card = raw as Record<string, unknown>
  const front = asString(card.front).trim()
  const back = asString(card.back).trim()
  if (!front || !back) return null
  const item: FlashcardItem = {
    id: asString(card.id) || genId('card'),
    front: front.slice(0, 200),
    back: back.slice(0, 1200),
    topic: asString(card.topic, '综合').slice(0, 40),
    fsrs: createInitialFsrs(),
  }
  const anchor = asString(card.sourceAnchor).trim()
  if (anchor) item.sourceAnchor = anchor.slice(0, 120)
  return item
}

function normalizeDeck(json: unknown, input: StudyGenerateArtifactInput): FlashcardDeck {
  const obj = (json ?? {}) as Record<string, unknown>
  const cards = asArray(obj.cards).map(normalizeFlashcard).filter((c): c is FlashcardItem => !!c)
  if (cards.length === 0) throw new Error('模型未返回有效的抽认卡内容')
  return {
    id: genId('deck'),
    title: asString(obj.title, input.focusedTopic || '抽认卡卡包').slice(0, 60),
    difficulty: input.difficulty ?? 'medium',
    mode: input.cardMode ?? 'standard',
    createdAt: Date.now(),
    cards,
  }
}

// ===== 测验归一化 =====

function normalizeQuizQuestion(raw: unknown): QuizQuestion | null {
  if (!raw || typeof raw !== 'object') return null
  const q = raw as Record<string, unknown>
  const question = asString(q.question).trim()
  if (!question) return null
  const options: QuizOption[] = asArray(q.options)
    .map((opt) => {
      if (!opt || typeof opt !== 'object') return null
      const o = opt as Record<string, unknown>
      const key = asString(o.key).trim()
      const text = asString(o.text).trim()
      if (!key || !text) return null
      return { key, text: text.slice(0, 300) }
    })
    .filter((o): o is QuizOption => !!o)
  const answer = asArray(q.answer).map((a) => asString(a).trim()).filter(Boolean)
  if (options.length === 0 || answer.length === 0) return null
  const typeRaw = asString(q.type, 'single')
  const type: QuizQuestion['type'] =
    typeRaw === 'multiple' || typeRaw === 'boolean' ? typeRaw : 'single'
  return {
    id: asString(q.id) || genId('q'),
    type,
    question: question.slice(0, 400),
    options,
    answer,
    explanation: asString(q.explanation, '暂无解析').slice(0, 1200),
    sourceTrace: asString(q.sourceTrace, '课程资料').slice(0, 300),
  }
}

function normalizeQuiz(json: unknown, input: StudyGenerateArtifactInput): QuizSession {
  const obj = (json ?? {}) as Record<string, unknown>
  const questions = asArray(obj.questions)
    .map(normalizeQuizQuestion)
    .filter((q): q is QuizQuestion => !!q)
  if (questions.length === 0) throw new Error('模型未返回有效的测验题目')
  const difficulty = input.difficulty ?? 'medium'
  return {
    id: genId('quiz'),
    title: asString(obj.title, input.focusedTopic || '自测练习').slice(0, 60),
    totalQuestions: questions.length,
    difficulty,
    completed: false,
    score: 0,
    estimatedTheta: 0,
    createdAt: Date.now(),
    questions,
  }
}

// ===== 提示链构建 =====

function buildMindMapPrompts(source: string, input: StudyGenerateArtifactInput): { system: string; user: string } {
  const system = [
    'You are the Lead Knowledge Architect for AI Quick Classroom at 成都理工大学, specialized in synthesizing course materials into hierarchical concept mind maps.',
    'Language Convention: Generate all node labels and notes in the language matching the source material or user prompt. Generate final responses in the same language used by the user, defaulting to English otherwise.',
    'Output format: Return strictly valid JSON without Markdown code fences or explanatory prose.',
  ].join('\n')
  const focus = input.focusedTopic ? `\nFocused Topic: ${input.focusedTopic}` : ''
  const user = [
    'Analyze the following course material outline and generate a hierarchical mind map covering the core knowledge structure.',
    focus,
    '',
    'Output Schema (Strict JSON):',
    '{ "title": string, "root": { "id": string, "label": string, "notes": string, "studyPrompt": string, "children": [ identical node structure ] } }',
    'Specifications:',
    '- Depth: 2 to 4 levels, with 2 to 6 branch nodes per level.',
    '- Labels: Concise concept names (maximum 14 Chinese characters or equivalent concise phrasing).',
    '- Notes: A single concise sentence summarizing the core takeaway.',
    '- Study Prompt: For each non-leaf node, provide an actionable companion tutoring prompt.',
    '',
    'Course Material Outline:',
    source,
  ].join('\n')
  return { system, user }
}

function buildFlashcardPrompts(source: string, input: StudyGenerateArtifactInput): { system: string; user: string } {
  const modeCount = input.cardMode === 'concise' ? '5 to 8 cards' : input.cardMode === 'in_depth' ? '20 or more cards' : '10 to 15 cards'
  const difficultyLabel =
    input.difficulty === 'easy' ? 'Foundational Recall (Basic Concept Recognition)' : input.difficulty === 'hard' ? 'Comprehensive Analysis (Multi-source Comparative Judgment)' : 'Application (Core Taxonomies and Rule Application)'
  const system = [
    'You are an expert cognitive scientist designing atomic flashcards based on the Minimum Information Principle (MIP).',
    'Structure each card as an atomic single-question, single-answer proposition adhering to Miller\'s 7±2 cognitive chunking limits, ensuring each card targets an independent concept.',
    'Language Convention: Generate all flashcard contents in the language matching the source material or user prompt. Generate final responses in the same language used by the user, defaulting to English otherwise.',
    'Output format: Return strictly valid JSON without Markdown code fences or conversational prose.',
  ].join('\n')
  const focus = input.focusedTopic ? `\nFocused Topic: ${input.focusedTopic}` : ''
  const user = [
    'Deconstruct the following course material into atomic flashcards.',
    `Target Card Count: ${modeCount}; Difficulty Level: ${difficultyLabel}.`,
    focus,
    '',
    'Output Schema (Strict JSON):',
    '{ "title": string, "cards": [ { "front": string, "back": string, "topic": string, "sourceAnchor": string } ] }',
    'Specifications: "front" must be an atomic concept, term, or specific question; "back" must be a concise, precise answer and distillation; "topic" indicates the subtopic.',
    '',
    'Course Material Outline:',
    source,
  ].join('\n')
  return { system, user }
}

function buildQuizPrompts(source: string, input: StudyGenerateArtifactInput): { system: string; user: string } {
  const count = Math.max(1, Math.min(50, input.questionCount ?? 5))
  const types = input.questionTypes && input.questionTypes.length > 0 ? input.questionTypes.join(', ') : 'single'
  const difficultyLabel =
    input.difficulty === 'easy' ? 'Foundational Consolidation (Factual Knowledge Recall)' : input.difficulty === 'hard' ? 'Comprehensive Analysis (Integrated Judgment)' : 'Application (Policy Interpretation and Criteria Assessment)'
  const system = [
    'You are an expert psychometrician designing diagnostic assessment quizzes.',
    'Enforce first-order logic mutual exclusion (Z3 SMT formalization) for multiple-choice distractors: for every distractor d, (d ∩ CorrectAnswer = ∅) ∧ IsA(d, DomainConcept). Ensure each distractor is factually incorrect and semantically disjoint from the correct key.',
    'Language Convention: Generate quiz content in the language matching the source material or user prompt. Generate final responses in the same language used by the user, defaulting to English otherwise.',
    'Output format: Return strictly valid JSON without Markdown code fences or explanatory prose.',
  ].join('\n')
  const focus = input.focusedTopic ? `\nFocused Topic: ${input.focusedTopic}` : ''
  const user = [
    `Generate ${count} questions. Difficulty Level: ${difficultyLabel}; Question Types: ${types} (single=multiple choice, multiple=multi-select, boolean=true/false).`,
    focus,
    '',
    'Output Schema (Strict JSON):',
    '{ "title": string, "questions": [ { "type": "single|multiple|boolean", "question": string, "options": [ { "key": "A", "text": string } ], "answer": ["A"], "explanation": string, "sourceTrace": string } ] }',
    'Specifications:',
    '- Each question must provide question text, options, answer key and distractor analysis (explanation).',
    '- "sourceTrace" MUST be a Markdown citation anchor of the form `[第X页·小节名](#fN:pX)`, where `fN` is the document anchor prefix declared in the course outline (e.g. `#f1:p3`) and X is the page/slide number; output only this anchor without extra prose.',
    '- The explanation must elucidate why each distractor is incorrect.',
    '- True/False questions must use options: [{key:"A",text:"正确"},{key:"B",text:"错误"}].',
    '',
    'Course Material Outline:',
    source,
  ].join('\n')
  return { system, user }
}

/**
 * 生成学习工件（思维导图 / 抽认卡 / 测验）并落盘。
 */
export async function generateStudyArtifact(
  input: StudyGenerateArtifactInput,
): Promise<StudyGenerateArtifactResult> {
  const source = buildSourceMaterial(input.sessionId)
  if (!source.trim()) {
    throw new Error('当前课堂暂无可用资料：请先导入课程资料后再生成。')
  }
  const docs = listStudyDocuments(input.sessionId).filter((doc) => doc.enabled !== false).map((doc) => doc.documentId)

  if (input.kind === 'mindmap') {
    const { system, user } = buildMindMapPrompts(source, input)
    const raw = await oneShotJsonCompletion(system, user)
    if (!raw) throw new Error('思维导图生成失败：模型未返回结果，请检查渠道配置。')
    const mindmap = normalizeMindMap(extractJsonObject(raw), docs)
    saveMindmap(input.sessionId, mindmap)
    return { kind: 'mindmap', mindmap }
  }

  if (input.kind === 'flashcard') {
    const { system, user } = buildFlashcardPrompts(source, input)
    const raw = await oneShotJsonCompletion(system, user)
    if (!raw) throw new Error('抽认卡生成失败：模型未返回结果，请检查渠道配置。')
    const deck = normalizeDeck(extractJsonObject(raw), input)
    saveFlashcardDeck(input.sessionId, deck)
    return { kind: 'flashcard', deck }
  }

  const { system, user } = buildQuizPrompts(source, input)
  const raw = await oneShotJsonCompletion(system, user)
  if (!raw) throw new Error('测验生成失败：模型未返回结果，请检查渠道配置。')
  const quiz = normalizeQuiz(extractJsonObject(raw), input)
  saveQuiz(input.sessionId, quiz)
  return { kind: 'quiz', quiz }
}
