/**
 * Preview Atoms — 内联预览/Diff 面板状态管理
 *
 * 每个 Agent 会话拥有独立的预览面板状态（选中文件、开关）。
 */

import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type { AgentEndReason } from '@profer/shared'
import { currentAgentSessionIdAtom } from './agent-atoms'

// ===== 类型定义 =====

/** 当前预览的文件信息 */
export interface PreviewFile {
  filePath: string
  dirPath?: string
  gitRoot?: string
  /** true = 纯文件预览（不显示 diff 控件），false/undefined = diff 模式 */
  previewOnly?: boolean
  /** true = 预览只读，不允许从预览面板写回临时/源文件 */
  readOnly?: boolean
  /** 候选基础目录（用于相对路径解析） */
  basePaths?: string[]
  /** 文件是否落在当前会话的 diff scope 内（与 getUnstagedChanges 的 candidates 对齐） */
  inDiffScope?: boolean
  /** 基准 ref（如 "origin/main"），用于 worktree vs main 模式的 diff 对比 */
  baseRef?: string
  /** Agent 正式预览请求 ID；存在时 OfficePreview 必须回传 ready/error。 */
  previewRequestId?: string
  /** 本次正式预览绑定的磁盘 revision；同路径新 revision 用于强制 remount。 */
  previewRevision?: string
  /** 打开后需要定位的初始行号（1-based，代码/文本文件跳转定位） */
  initialTargetLine?: number
}

// ===== Atoms =====

/** 每会话当前预览的文件（null 时显示 DiffChangesList）；语义 = 该会话最近打开/聚焦的文件，供高亮与刷新检测 */
export const previewFileMapAtom = atom<Map<string, PreviewFile | null>>(new Map())

/** 自动预览开关，持久化（默认关闭以减轻设备性能负担，老用户保留已设置的偏好） */
export const autoPreviewEnabledAtom = atomWithStorage<boolean>('profer-auto-preview-enabled', false)

// ===== 引用选中文本（Quoted Selection）=====

/** 选中文本引用的来源 */
export type QuotedSelectionSourceType = 'file' | 'agent-history' | 'scratch-pad' | 'agent-interruption'

/** 从预览面板或 Agent 历史中选中的文本引用 */
export interface QuotedSelection {
  /** 选中的文本内容 */
  text: string
  /** 来源文件路径；历史引用时作为兼容展示字段 */
  filePath: string
  /** 引用来源类型 */
  sourceType?: QuotedSelectionSourceType
  /** 面向用户展示的来源名称 */
  sourceLabel?: string
  /** Agent 历史消息 ID */
  messageId?: string
  /** Agent 历史消息角色 */
  messageRole?: 'user' | 'assistant' | 'system'
  /** 起始行号（1-based，代码文件可计算，markdown 等无法计算时为 undefined） */
  startLine?: number
  /** 结束行号（1-based） */
  endLine?: number
  /** 捕获时间戳 */
  capturedAt: number
}

/** 每会话的引用选中文本 Map（每次新选中覆盖旧值） */
export const quotedSelectionMapAtom = atom<Map<string, QuotedSelection>>(new Map())

/** 当前会话的引用选中文本（派生） */
export const currentQuotedSelectionAtom = atom<QuotedSelection | null>((get) => {
  const sessionId = get(currentAgentSessionIdAtom)
  if (!sessionId) return null
  return get(quotedSelectionMapAtom).get(sessionId) ?? null
})

// ===== 中断说明 chip（Agent 任务非正常结束时显示）=====

/**
 * 中断说明 chip 状态：会话级「待注入前缀」
 *
 * 独立于用户主动引用（quotedSelectionMapAtom），两者在同一 chip 行并排显示、
 * 各自独立移除/注入，互不覆盖。
 */
export interface AgentInterruptionState {
  /** 中断原因（completed 不会进入此状态） */
  reason: AgentEndReason
  /** 可读短文案（AGENT_END_REASON_LABELS 之一） */
  label: string
  /** 中断时间戳 */
  at: number
}

/** 每会话的中断说明 Map（仅置位未消费的中断；消费/移除时删除） */
export const agentInterruptionMapAtom = atom<Map<string, AgentInterruptionState>>(new Map())

/** 当前会话的中断说明（派生） */
export const currentAgentInterruptionAtom = atom<AgentInterruptionState | null>((get) => {
  const sessionId = get(currentAgentSessionIdAtom)
  if (!sessionId) return null
  return get(agentInterruptionMapAtom).get(sessionId) ?? null
})

/** 中断类型 → 视觉基调：error 用红，其余非错误中断用琥珀，unknown 用灰 */
export type AgentInterruptionTone = 'amber' | 'red' | 'muted'

/** 中断类型 → 视觉基调：error 用红，其余非错误中断用琥珀，unknown 用灰 */
export function getAgentInterruptionTone(reason: AgentEndReason): AgentInterruptionTone {
  if (reason === 'error') return 'red'
  if (reason === 'unknown') return 'muted'
  return 'amber'
}

// ===== 双平行拓扑引用精确坐标聚光灯（Citation Spotlight）=====

/**
 * 点击聊天消息中的拓扑引用胶囊（如 `[第1页·左栏](#f1:p1-b11)`、
 * `[幻灯片5·核心定理](#f2:p5-b02)`、`[Sheet1·B4:F12](#f3:p1-b01)`）后触发的
 * 全文档通用定位与坐标高亮状态（PDF / Word / PPT / Excel 共用）。
 */
export interface DocumentHighlightTarget {
  /** 唯一请求递增戳，确保连续点击同一个引用胶囊也能重新触发脉冲高亮 */
  requestId: number
  /** 所属会话 ID */
  sessionId: string
  /** 会话级唯一文件标识（如 "f1"） */
  fileId?: string
  /** 目标文档绝对路径 */
  filePath: string
  /** 文档格式 */
  format: 'pdf' | 'docx' | 'pptx' | 'xlsx'
  /** 页码 / 幻灯片序号 / 工作表序号（1-indexed） */
  pageNumber: number
  /** 块 ID（如 "p1-b11"、"p2-tbl1"、"p1-cB4"） */
  blockId: string
  /** 归一化页面坐标 [x0, y0, x1, y1]（左上角原点，0..1） */
  bbox?: [number, number, number, number]
  /** XLSX 专属：目标单元格或区域引用（如 "B4" 或 "A1:F12"） */
  cellRef?: string
  /** 匹配文本片段（用于 Silurus Run 级高精度辅助定位） */
  snippet?: string
  /** 人类可读位置标签（如 "第2页·左栏"、"幻灯片3·右上"、"财务表·B4:E10"） */
  label?: string
}

/** 当前待派发或激活中的文档聚光灯定位目标（PDF / Office 通用） */
export const documentHighlightTargetAtom = atom<DocumentHighlightTarget | null>(null)

/** @deprecated 使用 documentHighlightTargetAtom；保留别名以兼容既有 PDF 调用点。 */
export const pdfHighlightTargetAtom = documentHighlightTargetAtom

// ===== 预览视口状态记忆（Viewport State Memory）=====

/**
 * 单个文件在右侧预览视口中的交互状态快照。
 *
 * 以 `${sessionId}:${normalizedFilePath}` 为键记忆，用户切换文件 / 会话 / 关闭再打开
 * 时自动恢复上一次的缩放比例与滚动位置，避免每次都回到原点。
 */
export interface PreviewViewportState {
  /** 内容缩放比（1 = 100%）；由内容控制器上报 */
  scale: number
  /** 主内容滚动宿主的垂直滚动偏移 */
  scrollTop: number
  /** 主内容滚动宿主的水平滚动偏移 */
  scrollLeft: number
  /** 最近一次更新时间戳 */
  updatedAt: number
}

/** 预览视口状态记忆表（会话 + 文件维度） */
export const previewViewportStateMapAtom = atom<Map<string, PreviewViewportState>>(new Map())

/** 归一化路径 + 会话，生成视口记忆键（Windows 反斜杠与大小写差异统一） */
export function previewViewportMemoryKey(sessionId: string, filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase()
  return `${sessionId}:${normalized}`
}

