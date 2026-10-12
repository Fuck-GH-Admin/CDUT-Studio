/**
 * AI 速课堂状态 Atom
 *
 * 全量采用 Jotai 原子化管理速课堂板块的 UI 状态：资料列表、当前选中资料、
 * 右侧留白边栏折叠态与解析中标记。子页面路由与主边栏折叠记忆另见 cdut-account-atoms。
 */

import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type {
  KnowledgeGraphData,
  KnowledgeGraphGenerationMode,
  StudyDocumentOutline,
  StudyGraphCostEstimate,
  StudyGraphProgressEvent,
} from '@profer/shared'

/** 当前会话已索引的学习资料大纲列表 */
export const studyDocumentsAtom = atom<StudyDocumentOutline[]>([])

/** 当前左栏大纲树聚焦的资料标识 */
export const studyActiveDocumentIdAtom = atom<string | null>(null)

/** 右侧留白可折叠边栏是否收起（默认展开） */
export const studyRightPanelCollapsedAtom = atom<boolean>(false)

/** 右侧课程资料高保真预览栏宽度（px，拖拽左边缘调节后持久化） */
export const studyRightPanelWidthAtom = atomWithStorage<number>('profer-study-right-panel-width', 520)

/** 是否正在解析导入的学习资料 */
export const studyIngestingAtom = atom<boolean>(false)

/** 左侧资料栏在窄屏下的折叠态（默认展开） */
export const studyLeftPanelCollapsedAtom = atom<boolean>(false)

/** 资料树跨资料知识图谱（本地节点 + 用户按需生成的关联边） */
export const studyKnowledgeGraphAtom = atom<KnowledgeGraphData | null>(null)

/** 是否正在生成跨资料关联（用户主动触发的图谱构建中） */
export const studyGraphUpdatingAtom = atom<boolean>(false)

/** 资料树「开始生成」方案选择弹窗开关 */
export const studyGraphModalOpenAtom = atom<boolean>(false)

/** 资料树图谱生成的动态成本估算缓存（弹窗看板消费） */
export const studyGraphCostEstimateAtom = atom<StudyGraphCostEstimate | null>(null)

/** 当前选中的图谱生成模式（默认智能精炼） */
export const studyGraphModeAtom = atom<KnowledgeGraphGenerationMode>('ai_smart')

/** 图谱推演实时进度（资料树顶部进度胶囊消费；空闲时为 null） */
export const studyGraphProgressAtom = atom<StudyGraphProgressEvent | null>(null)
