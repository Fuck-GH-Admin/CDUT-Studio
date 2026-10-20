/**
 * CSLab 论文修订（Track Changes）主进程封装
 *
 * - 复用 OOXML 引擎导出/导入带 Word 修订与批注的 docx；
 * - 切片计划（planSuggestionApplication）放在 @profer/shared，
 *   供渲染层与主进程共用同一套「绝不跨 Block 加 Mark」的纯函数。
 */

import type { OoxmlExportInput, OoxmlImportResult } from './cslab-ooxml'
import { runOoxmlTask, suggestionIdToWordId } from './cslab-ooxml'

export { suggestionIdToWordId }

export {
  describeSuggestionPlanFailure,
  planSuggestionApplication,
} from '@profer/shared'
export type {
  CsLabDocBlock,
  CsLabSuggestionPlan,
  CsLabSuggestionSlice,
} from '@profer/shared'

/** 导出带修订/批注的 docx（优先在 Worker 线程执行）。 */
export async function exportTrackedDocx(input: OoxmlExportInput): Promise<Uint8Array> {
  const result = await runOoxmlTask({ type: 'export', input })
  if (result.type !== 'export') throw new Error('OOXML 导出返回了意外结果')
  return result.result.buffer
}

/** 导入 docx（保留 Word 修订与批注语义）。 */
export async function importTrackedDocx(buffer: Uint8Array): Promise<OoxmlImportResult> {
  const result = await runOoxmlTask({ type: 'import', buffer })
  if (result.type !== 'import') throw new Error('OOXML 导入返回了意外结果')
  return result.result
}
