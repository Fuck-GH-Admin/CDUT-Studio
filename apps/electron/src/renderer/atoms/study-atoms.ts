/**
 * AI 速课堂状态 Atom
 *
 * 全量采用 Jotai 原子化管理速课堂板块的 UI 状态：资料列表、当前选中资料、
 * 右侧留白边栏折叠态与解析中标记。子页面路由与主边栏折叠记忆另见 cdut-account-atoms。
 *
 * 右栏多 Tab 拓扑、生成中标记与已生成工件摘要均按 sessionId 隔离（Map 键控缓存），
 * 保证多课堂并行生成时状态互不串扰：会话 A 生成中切换至会话 B，B 保持空闲可用。
 */

import * as React from 'react'
import { atom, useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  AI_CLASS_HOME_TAB_ID,
  type AiClassRightTabItem,
  type KnowledgeGraphData,
  type KnowledgeGraphGenerationMode,
  type StudyArtifactKind,
  type StudyArtifactSummary,
  type StudyDocumentOutline,
  type StudyGenerateArtifactInput,
  type StudyGraphCostEstimate,
  type StudyGraphProgressEvent,
} from '@profer/shared'

/** 当前会话已索引的学习资料大纲列表 */
export const studyDocumentsAtom = atom<StudyDocumentOutline[]>([])

/** 当前左栏大纲树聚焦的资料标识 */
export const studyActiveDocumentIdAtom = atom<string | null>(null)

/** 右侧留白可折叠边栏是否收起（默认展开） */
export const studyRightPanelCollapsedAtom = atom<boolean>(false)

/** 右侧课程资料高保真预览栏宽度（px，拖拽左边缘实时调节） */
export const studyRightPanelWidthAtom = atom<number>(520)

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

// ===== Chrome 风格动态多 Tab 右栏（按会话隔离） =====

/** 固定首页标签（唯一不可关闭，恒居首位） */
export function createAiClassHomeTab(): AiClassRightTabItem {
  return { id: AI_CLASS_HOME_TAB_ID, type: 'home', title: '学习主页', closable: false, data: {} }
}

/** 默认标签拓扑（仅固定首页；未加载过磁盘拓扑的会话回退此值） */
const DEFAULT_AI_CLASS_TABS: AiClassRightTabItem[] = [createAiClassHomeTab()]

/** 按 sessionId 隔离的右栏标签拓扑缓存（sessionId → tabs） */
export const aiClassTabsMapAtom = atom<Map<string, AiClassRightTabItem[]>>(new Map())

/** 按 sessionId 隔离的激活标签 ID 缓存（sessionId → activeTabId） */
export const aiClassActiveTabIdMapAtom = atom<Map<string, string>>(new Map())

/** 按 sessionId 隔离的正在生成学习工件类型（sessionId → kind；无条目即空闲） */
export const aiClassGeneratingMapAtom = atom<Map<string, StudyArtifactKind>>(new Map())

/** 按 sessionId 隔离的已生成工件摘要缓存（sessionId → summaries） */
export const aiClassArtifactsMapAtom = atom<Map<string, StudyArtifactSummary[]>>(new Map())

/** 待提交的学习工件生成参数（首页弹窗确认后触发） */
export const aiClassPendingArtifactAtom = atom<StudyGenerateArtifactInput | null>(null)

// ===== 会话隔离辅助 Hook =====

/** 标签拓扑更新器（数组或函数式更新，与 useState 语义一致） */
type AiClassTabsUpdater = AiClassRightTabItem[] | ((prev: AiClassRightTabItem[]) => AiClassRightTabItem[])

/**
 * 读取指定会话的右栏标签拓扑（会话隔离）。
 * 无缓存时回退默认首页单标签；写入按需克隆 Map 以触发订阅更新。
 */
export function useAiClassTabs(sessionId: string): readonly [AiClassRightTabItem[], (updater: AiClassTabsUpdater) => void] {
  const [tabsMap, setTabsMap] = useAtom(aiClassTabsMapAtom)
  const tabs = tabsMap.get(sessionId) ?? DEFAULT_AI_CLASS_TABS
  const setTabs = React.useCallback(
    (updater: AiClassTabsUpdater): void => {
      setTabsMap((prev) => {
        const current = prev.get(sessionId) ?? DEFAULT_AI_CLASS_TABS
        const next = typeof updater === 'function' ? updater(current) : updater
        const map = new Map(prev)
        map.set(sessionId, next)
        return map
      })
    },
    [sessionId, setTabsMap],
  )
  return [tabs, setTabs]
}

/** 读取 / 设置指定会话的激活标签 ID（会话隔离） */
export function useAiClassActiveTabId(sessionId: string): readonly [string, (id: string) => void] {
  const [activeIdMap, setActiveIdMap] = useAtom(aiClassActiveTabIdMapAtom)
  const activeTabId = activeIdMap.get(sessionId) ?? AI_CLASS_HOME_TAB_ID
  const setActiveTabId = React.useCallback(
    (id: string): void => {
      setActiveIdMap((prev) => {
        if (prev.get(sessionId) === id) return prev
        const map = new Map(prev)
        map.set(sessionId, id)
        return map
      })
    },
    [sessionId, setActiveIdMap],
  )
  return [activeTabId, setActiveTabId]
}

/** 读取 / 设置指定会话的生成中标记（会话隔离；null 表示空闲） */
export function useAiClassGenerating(
  sessionId: string,
): readonly [StudyArtifactKind | null, (kind: StudyArtifactKind | null) => void] {
  const [generatingMap, setGeneratingMap] = useAtom(aiClassGeneratingMapAtom)
  const generating = generatingMap.get(sessionId) ?? null
  const setGenerating = React.useCallback(
    (kind: StudyArtifactKind | null): void => {
      setGeneratingMap((prev) => {
        const current = prev.get(sessionId) ?? null
        if (current === kind) return prev
        const map = new Map(prev)
        if (kind === null) map.delete(sessionId)
        else map.set(sessionId, kind)
        return map
      })
    },
    [sessionId, setGeneratingMap],
  )
  return [generating, setGenerating]
}

/** 读取 / 设置指定会话的已生成工件摘要（会话隔离） */
export function useAiClassArtifacts(sessionId: string): readonly [StudyArtifactSummary[], (list: StudyArtifactSummary[]) => void] {
  const [artifactsMap, setArtifactsMap] = useAtom(aiClassArtifactsMapAtom)
  const artifacts = artifactsMap.get(sessionId) ?? []
  const setArtifacts = React.useCallback(
    (list: StudyArtifactSummary[]): void => {
      setArtifactsMap((prev) => {
        const map = new Map(prev)
        map.set(sessionId, list)
        return map
      })
    },
    [sessionId, setArtifactsMap],
  )
  return [artifacts, setArtifacts]
}

// ===== 学习数据版本号（驱动只读派生视图实时刷新） =====

/**
 * 按 sessionId 隔离的学习数据版本号。
 *
 * 背景：「学习情况速览」等只读派生视图的数据来自 study IPC（测验得分 / FIM θ / 闪卡复习数），
 * 这些写操作**不会**改变「已生成工件摘要」（artifacts），因此仅靠 artifacts 变化无法触发刷新，
 * 表现为「作答后速览卡纹丝不动」。
 *
 * 约定：任何改变学习数据的行为（提交作答、重置测验、卡片评分、生成工件）完成后，
 * 调用 `useBumpStudyRevision` 返回的函数自增该版本号；消费方把版本号放进 useEffect 依赖即可。
 */
export const studyDataRevisionMapAtom = atom<Map<string, number>>(new Map())

/** 通知指定课堂的学习数据已变更（消费方据此重新拉取） */
export function useBumpStudyRevision(sessionId: string): () => void {
  const setRevisionMap = useSetAtom(studyDataRevisionMapAtom)
  return React.useCallback((): void => {
    setRevisionMap((prev) => {
      const map = new Map(prev)
      map.set(sessionId, (prev.get(sessionId) ?? 0) + 1)
      return map
    })
  }, [sessionId, setRevisionMap])
}

/** 读取指定课堂的学习数据版本号（作为 useEffect 依赖触发重拉） */
export function useStudyDataRevision(sessionId: string): number {
  return useAtomValue(studyDataRevisionMapAtom).get(sessionId) ?? 0
}
