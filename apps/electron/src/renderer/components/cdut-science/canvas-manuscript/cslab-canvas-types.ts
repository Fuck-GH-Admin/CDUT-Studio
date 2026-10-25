/**
 * Canvas 编辑器对外稳定契约
 *
 * 上层（StagePane / StageGrid / WorkspaceView）只依赖本文件，
 * 不再 import @tiptap/core 的 Editor 类型。
 */

import type { CsLabCapsule, CsLabCanvasData, CsLabManuscriptComment } from '@profer/shared'

export interface CsLabCapsuleAttrs {
  capsuleId: string
  label: string
  value: string
  unit: string
  tableUri: string
  column: string
  rowIndex: number
  revisionAtBind: number
  status: 'fresh' | 'stale' | 'orphan'
}

export interface CsLabCanvasSnapshot {
  canvasData: CsLabCanvasData
  /** 供 .md / .docx 导出使用的派生 TipTap JSON。 */
  docJson: unknown
  capsules: CsLabCapsule[]
  comments: CsLabManuscriptComment[]
}

/** 审稿意见（replace/delete/comment）→ Canvas 批注的统一入参。 */
export interface CsLabReviewCommentInput {
  kind: 'replace' | 'delete' | 'comment'
  quote: string
  replacement?: string
  comment?: string
  personaTitle: string
}

export type CsLabTitleLevel =
  | 'first'
  | 'second'
  | 'third'
  | 'fourth'
  | 'fifth'
  | 'sixth'
  | null

/** Ribbon 激活态；字段来自 canvas-editor 的 IRangeStyle。 */
export interface CsLabRangeStyle {
  bold: boolean
  italic: boolean
  underline: boolean
  strikeout: boolean
  level: CsLabTitleLevel
  listType: 'ul' | 'ol' | null
  undo: boolean
  redo: boolean
}

export interface CsLabCanvasMetrics {
  words: number
  chars: number
  capsules: number
  comments: number
}

export interface CsLabCanvasHandle {
  getSnapshot(): CsLabCanvasSnapshot
  getWordCount(): Promise<number>
  getCharCount(): number
  bold(): void
  italic(): void
  underline(): void
  strikeout(): void
  title(level: CsLabTitleLevel): void
  list(type: 'ul' | 'ol'): void
  separator(): void
  pageBreak(): void
  undo(): void
  redo(): void
  setPageScale(scale: number): void
  toggleRuler(show: boolean): void
  updateCapsule(capsule: CsLabCapsule): void
  markCapsulesStale(ids: Set<string>): void
  appendCapsule(attrs: CsLabCapsuleAttrs): void
  /** applied=已生成正文批注总数（含模糊命中）；fuzzy=其中模糊定位数；skipped=两级定位均未命中、收入审阅报告侧栏的建议数。 */
  applyReview(items: CsLabReviewCommentInput[]): { applied: number; fuzzy: number; skipped: number }
  getCommentCount(): number
  clearComments(): void
  focus(): void
  /** 在当前光标/选区处插入纯文本（文献引用等），并记入撤销历史。 */
  insertText(text: string): void
  /** 当前选区纯文本（无选区返回空串），供划词反向检索。 */
  getSelectedText(): string
  /** 插入图片元素（dataURL/URL + 像素尺寸），记入撤销历史。 */
  insertImage(payload: { value: string; width: number; height: number }): void
  /** 插入 LaTeX 公式元素（引擎内置 LaTeX→SVG 渲染器排版），记入撤销历史。 */
  insertLatex(latex: string): void
  /** 抓手平移开关：开启后拖拽平移画布视口（内部切只读防误编辑）。 */
  setHandTool(enabled: boolean): void
}
