/**
 * AI 速课堂（Autonomous Study Module）共享契约
 *
 * 本模块定义 CDUT 专区「AI速课堂」板块的资料大纲、章节分块与学生认知档案结构。
 * 设计要点：
 *   - 全类型文档解析后只把「轻量级大纲向导」注入模型上下文，完整原文分块缓存到本地；
 *   - 模型按需调用 `study_inspect_section` 工具查阅指定 sectionId 的原文，防止上下文爆炸；
 *   - 学生认知档案以 Markdown 形式持久化，分立「已掌握 / 待学未知 / 薄弱混淆」三维清单。
 */

/** 支持解析的学习资料类型 */
export type StudyDocumentType =
  | 'pdf'
  | 'pptx'
  | 'docx'
  | 'xlsx'
  | 'image'
  | 'text'
  | 'markdown'

/** 文档中抽取出的单个章节分块（对应大纲树的一个节点） */
export interface StudyDocumentSection {
  /** 稳定分块标识，模型查阅原文时使用 */
  sectionId: string
  /** 所属文档标识 */
  documentId: string
  title: string
  /** 层级：1 为顶层章节，数值越大越靠内 */
  level: number
  /** PDF 页码范围（含端点）；非 PDF 可省略 */
  pageRange?: [number, number]
  /** PPT 幻灯片序号（从 1 开始）；非 PPT 可省略 */
  slideIndex?: number
  /** Excel 工作表名称；非 Excel 可省略 */
  sheetName?: string
  /** 核心知识点摘要（注入大纲，通常 1-2 句） */
  summary: string
  /** 原文片段预览（用于大纲导航展示，非完整原文） */
  contentSnippet: string
  /** 该分块完整原文字符数 */
  charCount: number
}

/** 单份学习资料的结构化大纲 */
export interface StudyDocumentOutline {
  documentId: string
  fileName: string
  /** 资料原始绝对路径（本地引用） */
  sourcePath: string
  fileType: StudyDocumentType
  totalSections: number
  totalChars: number
  sections: StudyDocumentSection[]
  /** 供模型直接消费的轻量级大纲导航 Markdown（通常小于 800 字） */
  navigationMarkdown: string
  createdAt: number
  /**
   * 该资料是否处于「已激活」状态（默认 true）。
   * 未激活的资料静默排除在 RAG 检索切块与提示词大纲注入之外，仅在 UI 中淡化展示。
   */
  enabled?: boolean
}

/** 学生认知记忆档案：三维概念清单 */
export interface StudentCognitionProfile {
  /** 学科 / 课程主题 */
  subject: string
  /** 目标（如：期末考 90 分） */
  targetGoal?: string
  /** 考试日期（ISO 或自然语言） */
  examDate?: string
  /** 已掌握概念 */
  masteredConcepts: string[]
  /** 待学未知概念（先验守卫铁律：严禁用此清单术语解释新概念） */
  unlearnedConcepts: string[]
  /** 薄弱 / 易混淆概念 */
  fragileConcepts: string[]
  /** 最近更新时间戳 */
  lastUpdated: number
}

/** 模型查阅分块原文的入参（study_inspect_section） */
export interface StudyInspectSectionParams {
  documentId: string
  sectionId: string
  /** 可选查阅焦点，帮助主进程优先返回相关片段 */
  queryFocus?: string
}

/** 模型查阅分块原文的返回结构 */
export interface StudyInspectSectionResult {
  success: boolean
  documentId: string
  sectionId: string
  title: string
  pageRange?: [number, number]
  slideIndex?: number
  sheetName?: string
  /** 该分块完整原文 */
  content: string
  /** 查阅到的字符数 */
  charCount: number
  error?: string
}

// ===== 学习资料准入限制 =====

/**
 * 单个 AI 速课堂会话允许上传的资料文件数。
 * 现已全量解除上限（无限资料导入），保留常数以免破坏既有调用方。
 */
export const MAX_STUDY_DOCUMENTS_PER_SESSION = Number.POSITIVE_INFINITY
/**
 * 单个学习资料文件体积上限（字节）。
 * 现已全量解除大小限制，保留常数以免破坏既有调用方。
 */
export const MAX_STUDY_DOCUMENT_SIZE_BYTES = Number.POSITIVE_INFINITY
/** 速课堂资料白名单扩展名（非白名单直接拒绝，纯文本 / 图片本地纯化） */
export const ALLOWED_STUDY_EXTENSIONS = [
  '.ppt', '.pptx', '.ppsx', '.potx',
  '.pdf',
  '.doc', '.docx',
  '.xls', '.xlsx', '.xlsm',
  '.md', '.markdown',
  '.html', '.htm',
  '.txt',
  '.png', '.jpg', '.jpeg', '.webp', '.bmp',
] as const

// ===== 资料树知识图谱生成模式与成本估算 =====

/** 图谱生成模式：本地极速 / 云端智能精炼 / 云端全量深度 */
export type KnowledgeGraphGenerationMode = 'local_fast' | 'ai_smart' | 'ai_full'

/** 单档方案的 Token 与费用估算 */
export interface StudyGraphCostTier {
  tokens: number
  costCny: number
  estimatedSeconds: number
}

/** 资料树图谱生成的动态成本估算（面向弹窗看板展示） */
export interface StudyGraphCostEstimate {
  totalDocuments: number
  totalChars: number
  totalChunks: number
  smart: StudyGraphCostTier
  full: StudyGraphCostTier
}

// ===== 渲染进程 <-> 主进程 IPC 契约 =====

/** 导入学习资料入参（渲染端把拖拽/选择的文件绝对路径交给主进程解析） */
export interface StudyIngestDocumentsInput {
  sessionId: string
  filePaths: string[]
}

/** 资料树图谱生成入参（用户在前端弹窗确认后主动触发） */
export interface StudyGraphGenerateInput {
  sessionId: string
  mode: KnowledgeGraphGenerationMode
}

/** 查询 / 移除学习资料的入参 */
export interface StudyDocumentQueryInput {
  sessionId: string
  documentId: string
}

/** 切换单份资料激活状态的入参（勾选框即时落盘） */
export interface StudyToggleDocumentActiveInput {
  sessionId: string
  documentId: string
  enabled: boolean
}

/** 批量设置资料激活状态的入参（全选 / 全不选） */
export interface StudySetDocumentsActiveInput {
  sessionId: string
  documentIds: string[]
  enabled: boolean
}

export const STUDY_IPC_CHANNELS = {
  /** 导入并解析学习资料，返回结构化大纲 */
  INGEST_DOCUMENTS: 'study:ingest-documents',
  /** 列出当前会话已索引的学习资料大纲 */
  LIST_DOCUMENTS: 'study:list-documents',
  /** 读取单份资料完整大纲 */
  GET_OUTLINE: 'study:get-outline',
  /** 移除单份资料索引 */
  REMOVE_DOCUMENT: 'study:remove-document',
  /** 切换单份资料的激活（勾选）状态并落盘 */
  TOGGLE_DOCUMENT_ACTIVE: 'study:toggle-document-active',
  /** 批量设置资料激活状态并落盘 */
  SET_DOCUMENTS_ACTIVE: 'study:set-documents-active',

  // ===== Chrome 风格动态多 Tab 拓扑 =====
  /** 读取当前课堂打开的多 Tab 拓扑 */
  GET_TABS: 'study:get-tabs',
  /** 保存当前课堂的多 Tab 拓扑 */
  SAVE_TABS: 'study:save-tabs',

  // ===== 思维导图：生成、坐标持久化与 OPML 导出 =====
  /** 读取某个课堂的思维导图数据 */
  GET_MINDMAP: 'study:get-mindmap',
  /** 保存用户拖拽后的导图气泡坐标 */
  SAVE_MINDMAP_COORDS: 'study:save-mindmap-coords',
  /** 导出思维导图为 OPML 2.0 文档（调起系统保存对话框） */
  EXPORT_OPML: 'study:export-opml',

  // ===== 抽认卡与 FSRS-7 记忆调度 =====
  /** 读取某个课堂的抽认卡卡包（含 FSRS-7 学习状态） */
  GET_FLASHCARDS: 'study:get-flashcards',
  /** 提交一次卡片评分，驱动 FSRS-7 状态推进并落盘 */
  UPDATE_CARD_RATING: 'study:update-card-rating',

  // ===== 测验与 FIM 认知能力评估 =====
  /** 读取某个课堂的测验题库 */
  GET_QUIZ: 'study:get-quiz',
  /** 提交单题作答，实时判分并更新 FIM 潜伏能力估计 */
  SUBMIT_QUIZ_ANSWER: 'study:submit-quiz-answer',
  /** 重置测验：清空全部作答记录与判分状态，支持反复练习 */
  RESET_QUIZ: 'study:reset-quiz',

  // ===== 双轨联动生成（思维导图 / 抽认卡 / 测验）=====
  /** 依据当前课堂资料生成学习工件（导图 / 抽认卡 / 测验）并落盘 */
  GENERATE_ARTIFACT: 'study:generate-artifact',
  /** 列出当前课堂已生成的全部学习工件摘要 */
  LIST_ARTIFACTS: 'study:list-artifacts',
} as const

// ===== Chrome 风格动态多 Tab 右栏契约 =====

/** 速课堂右栏标签类型 */
export type AiClassTabType = 'home' | 'mindmap' | 'preview' | 'flashcard' | 'quiz'

/** 速课堂右栏单个动态标签 */
export interface AiClassRightTabItem {
  id: string
  type: AiClassTabType
  title: string
  /** 首页恒为 false，其余动态标签为 true */
  closable: boolean
  data: {
    docId?: string
    filePath?: string
    mindmapId?: string
    flashcardDeckId?: string
    quizSessionId?: string
    [key: string]: unknown
  }
}

/** 速课堂右栏多 Tab 拓扑（持久化于 ~/.cdutai/study-sessions/{sessionId}/tabs.json） */
export interface AiClassTabsState {
  sessionId: string
  tabs: AiClassRightTabItem[]
  activeTabId: string
}

/** 固定首页标签 ID */
export const AI_CLASS_HOME_TAB_ID = 'tab-home'

// ===== 认知子系统 A：思维导图契约 =====

/** 思维导图节点 */
export interface MindMapNode {
  id: string
  label: string
  notes?: string
  /** 点击复制到剪贴板的伴学 Prompt */
  studyPrompt?: string
  /** 拖拽保存的坐标（DIP，相对画布左上角） */
  position?: { x: number; y: number }
  children?: MindMapNode[]
}

/** 思维导图完整数据 */
export interface MindMapData {
  id: string
  title: string
  /** 关联的课程文件标识 */
  sourceDocs: string[]
  createdAt: number
  root: MindMapNode
}

// ===== 认知子系统 B：抽认卡与 FSRS-7 契约 =====

/** FSRS-7 卡片状态机 */
export type FlashcardFsrsState = 'new' | 'learning' | 'review' | 'relearning'

/** FSRS-7 记忆状态参数 */
export interface FlashcardFsrs {
  /** 记忆稳定性 S（天） */
  stability: number
  /** 卡片难度 D（1~10） */
  difficulty: number
  /** 复习次数 */
  reps: number
  /** 遗忘次数 */
  lapses: number
  /** 上次复习时间戳 */
  lastReview: number
  /** 下次到期时间戳 */
  nextReview: number
  state: FlashcardFsrsState
}

/** 单张原子抽认卡 */
export interface FlashcardItem {
  id: string
  /** 正面核心问题 / 术语 */
  front: string
  /** 背面精准解析 */
  back: string
  /** 所属细分主题 */
  topic: string
  /** 原文出处锚点 */
  sourceAnchor?: string
  fsrs: FlashcardFsrs
}

/** 抽认卡卡包 */
export interface FlashcardDeck {
  id: string
  title: string
  difficulty: 'easy' | 'medium' | 'hard'
  mode: 'concise' | 'standard' | 'in_depth'
  /** 创建时间戳（用于「已生成成果」列表按时间排序） */
  createdAt?: number
  cards: FlashcardItem[]
}

/** 抽认卡四挡评分 */
export type FlashcardRating = 'again' | 'hard' | 'good' | 'easy'

// ===== 认知子系统 C：测验与 FIM 认知评估契约 =====

/** 题型 */
export type QuizQuestionType = 'single' | 'multiple' | 'boolean'

/** 单个选项 */
export interface QuizOption {
  key: string
  text: string
}

/** 单道测验题 */
export interface QuizQuestion {
  id: string
  type: QuizQuestionType
  question: string
  options: QuizOption[]
  /** 正确答案 key 列表，如 ["B"] */
  answer: string[]
  /** 考点剖析与错误原因详析（判错溯源） */
  explanation: string
  /** 原文出处依据 */
  sourceTrace: string
  /** 用户作答结果 */
  userSelection?: string[]
  /** 批改结果 */
  isCorrect?: boolean
}

/** 一次测验会话 */
export interface QuizSession {
  id: string
  title: string
  totalQuestions: number
  difficulty: string
  completed: boolean
  /** 百分制得分 */
  score: number
  /** FIM 潜伏认知能力估计 θ ∈ [-3, +3] */
  estimatedTheta: number
  /** 创建时间戳（用于「已生成成果」列表按时间排序） */
  createdAt?: number
  questions: QuizQuestion[]
}

// ===== 学习工件生成契约（双轨联动）=====

/** 学习工件类型（对应右栏动态 Tab 类型） */
export type StudyArtifactKind = 'mindmap' | 'flashcard' | 'quiz'

/** 学习工件生成入参 */
export interface StudyGenerateArtifactInput {
  sessionId: string
  kind: StudyArtifactKind
  /** 定向学习主题（选填） */
  focusedTopic?: string
  /** 抽认卡：卡片数量模式 */
  cardMode?: 'concise' | 'standard' | 'in_depth'
  /** 抽认卡 / 测验：难度等级 */
  difficulty?: 'easy' | 'medium' | 'hard'
  /** 测验：题目数量 */
  questionCount?: number
  /** 测验：题型范围 */
  questionTypes?: QuizQuestionType[]
  /** 显式指定使用的渠道（优先级最高；缺省时回退会话绑定渠道，再回退全局默认渠道） */
  channelId?: string
  /** 显式指定使用的模型（优先级最高；缺省时回退会话绑定模型，再回退全局默认模型） */
  modelId?: string
}

/** 学习工件生成结果（联合体，按 kind 区分） */
export type StudyGenerateArtifactResult =
  | { kind: 'mindmap'; mindmap: MindMapData }
  | { kind: 'flashcard'; deck: FlashcardDeck }
  | { kind: 'quiz'; quiz: QuizSession }

/** 已生成学习工件摘要（右侧工作台「已生成成果」常驻列表消费） */
export interface StudyArtifactSummary {
  id: string
  kind: StudyArtifactKind
  title: string
  /** 创建时间戳（缺失视为 0，排序时排后） */
  createdAt: number
  /** 条目规模：导图节点数 / 卡片数 / 题目数 */
  itemCount: number
}

/** 抽认卡评分入参 */
export interface StudyCardRatingInput {
  sessionId: string
  deckId: string
  cardId: string
  rating: FlashcardRating
  /** 评分发生时间戳（缺省为当前时间） */
  reviewedAt?: number
}

/** 测验单题作答入参 */
export interface StudyQuizAnswerInput {
  sessionId: string
  quizId: string
  questionId: string
  selection: string[]
}

// ===== 资料树（跨资料知识图谱）契约 =====

/** 资料树跨资料语义关联类型 */
export type KnowledgeRelationType = 'prerequisite' | 'exercise' | 'extension' | 'reference'

/** 资料树关联边定义（连接两份资料的两个章节节点） */
export interface KnowledgeGraphEdge {
  edgeId: string
  sourceDocId: string
  sourceSectionId: string
  targetDocId: string
  targetSectionId: string
  relationType: KnowledgeRelationType
  /** 边上的微标签（如「前置」「题型」「延伸」） */
  label: string
  description?: string
}

/** 跨资料现代节点图谱完整数据 */
export interface KnowledgeGraphData {
  documents: StudyDocumentOutline[]
  edges: KnowledgeGraphEdge[]
  updatedAt: number
}

/** AI 速课堂历史课堂简报（会话选择弹窗消费） */
export interface AiClassSessionSummary {
  sessionId: string
  courseName: string
  createdAt: number
  lastActiveAt: number
  documentCount: number
  lastTopicSnippet?: string
}

// ===== 带教模式 / 回复强度 =====

/**
 * AI 速课堂带教模式 / 回复强度
 * - 'fast': ⚡ 轻快查证 — 极速直答，无随堂测验打断，无元思考负担
 * - 'balanced': 🎯 专项精讲 — 标准教学，输出考点对比与思维图谱，按需巩固（默认）
 * - 'strict': 🏆 考霸硬核 — 原版带教铁律，双轨锚点，强制 AskUserQuestion 闭环测验与认知回写
 */
export type StudyTeachingMode = 'fast' | 'balanced' | 'strict'
