/**
 * @profer/core/office-engine — 双平面流式重排与空间拓扑 Office 文档解析引擎
 *
 * 零外部重型依赖，支持 DOCX / PPTX / XLSX（含宏与模板变体）的：
 * 1. 平面 A（语义重排平面）：GDI 度量分行、2D 仿射变换拍平、动画因果序、Mermaid 图、LaTeX 公式、稀疏网格连接域切分
 * 2. 平面 B（坐标规范化平面）：统一以 1 pt = 12,700 EMUs 归一化 `[x0, y0, x1, y1]` 包围盒与 `p{page}-b{idx}` 拓扑锚点
 */

import {
  OoxmlZipReader,
  detectOfficeFormatFromZip,
} from './ooxml-zip-reader.ts'
import { solveDocxReflow } from './docx-reflow-solver.ts'
import { solvePptxTopology } from './pptx-topology-solver.ts'
import { solveXlsxGrid } from './xlsx-grid-solver.ts'
import {
  serializeOfficeDocumentToMarkdown,
  serializeOfficePageToMarkdown,
  stripOfficeTopologyAnchors,
  formatOfficeBlockAnchorPrefix,
  officeAstToSharedLayoutAst,
} from './office-serializer.ts'
import type {
  OfficeFormat,
  OfficeBlockType,
  OfficeLayoutBlock,
  OfficePageLayout,
  OfficeDocumentLayoutAST,
  OfficeParseOptions,
  OfficeParseResult,
} from './types.ts'

export * from './types.ts'
export * from './ooxml-zip-reader.ts'
export * from './docx-reflow-solver.ts'
export * from './pptx-topology-solver.ts'
export * from './xlsx-grid-solver.ts'
export * from './office-serializer.ts'

/**
 * 根据文件扩展名或路径推断 Office 格式
 */
export function inferOfficeFormatFromExtension(extOrPath?: string): OfficeFormat | undefined {
  if (!extOrPath) return undefined
  const lower = extOrPath.trim().toLowerCase()
  if (
    lower.endsWith('.docx') ||
    lower.endsWith('.docm') ||
    lower.endsWith('.dotx') ||
    lower.endsWith('.dotm') ||
    lower === 'docx'
  ) {
    return 'docx'
  }
  if (
    lower.endsWith('.pptx') ||
    lower.endsWith('.pptm') ||
    lower.endsWith('.potx') ||
    lower.endsWith('.potm') ||
    lower.endsWith('.ppsx') ||
    lower.endsWith('.ppsm') ||
    lower === 'pptx'
  ) {
    return 'pptx'
  }
  if (
    lower.endsWith('.xlsx') ||
    lower.endsWith('.xlsm') ||
    lower.endsWith('.xltx') ||
    lower.endsWith('.xltm') ||
    lower === 'xlsx'
  ) {
    return 'xlsx'
  }
  return undefined
}

/**
 * 解析 OOXML Office 文档二进制数据（DOCX / PPTX / XLSX），输出双平面 AST 与带锚点/纯文本 Markdown
 */
export function parseOfficeBuffer(
  buffer: Buffer | Uint8Array,
  formatOrHint?: OfficeFormat | string,
  options?: OfficeParseOptions,
): OfficeParseResult {
  const zip = new OoxmlZipReader(buffer)
  const fallbackFormat =
    formatOrHint === 'docx' || formatOrHint === 'pptx' || formatOrHint === 'xlsx'
      ? formatOrHint
      : inferOfficeFormatFromExtension(formatOrHint) ?? inferOfficeFormatFromExtension(options?.fileName)

  const detectedFormat = detectOfficeFormatFromZip(zip, fallbackFormat)

  let ast: OfficeDocumentLayoutAST
  switch (detectedFormat) {
    case 'docx':
      ast = solveDocxReflow(zip, options)
      break
    case 'pptx':
      ast = solvePptxTopology(zip, options)
      break
    case 'xlsx':
      ast = solveXlsxGrid(zip, options)
      break
  }

  const includeAnchors = options?.includeAnchors ?? true
  const anchoredMarkdown = serializeOfficeDocumentToMarkdown(ast, {
    includeAnchors: true,
    includePageHeaders: true,
  })
  const cleanMarkdown = serializeOfficeDocumentToMarkdown(ast, {
    includeAnchors: false,
    includePageHeaders: false,
  })

  return {
    format: detectedFormat,
    ast,
    markdown: includeAnchors ? anchoredMarkdown : cleanMarkdown,
    cleanMarkdown,
  }
}

/**
 * 异步兼容包装器：解析 Office 文档二进制数据
 */
export async function parseOfficeDocument(
  buffer: Buffer | Uint8Array,
  formatOrHint?: OfficeFormat | string,
  options?: OfficeParseOptions,
): Promise<OfficeParseResult> {
  return parseOfficeBuffer(buffer, formatOrHint, options)
}
