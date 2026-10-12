/**
 * Office 统一空间拓扑 Markdown 序列化器
 *
 * 将 DOCX / PPTX / XLSX 的双平面布局 AST 转换为带精确空间锚点（p{page}-b{idx}）的富结构 Markdown：
 * - 为每个区块注入 `<span id="pX-bY" data-page="..." data-bbox="..." ...></span>`
 * - 为每个区块注入 `<!-- anchor: pX-bY [x0,y0,x1,y1] loc="..." ... -->` 供 LLM 引用溯源
 * - 支持一键剥离拓扑锚点，获得纯净人类可读 Markdown
 */

import type {
  DocumentLayoutAST,
  DocumentLayoutBlock,
  DocumentLayoutPage,
  LayoutRegionKind,
} from '@profer/shared'
import type {
  OfficeBlockType,
  OfficeDocumentLayoutAST,
  OfficeLayoutBlock,
  OfficePageLayout,
} from './types.ts'

export interface OfficeSerializeOptions {
  /** 是否注入 HTML span 与注释拓扑锚点（默认 true） */
  includeAnchors?: boolean
  /** 是否在每页/幻灯片/工作表头部注入分节标题（默认 true） */
  includePageHeaders?: boolean
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * 构造单区块的 HTML `<span>` + `<!-- anchor: ... -->` 双锚点前缀
 */
export function formatOfficeBlockAnchorPrefix(block: OfficeLayoutBlock): string {
  const [x0, y0, x1, y1] = block.bbox.map((n) => (Number.isFinite(n) ? n.toFixed(3) : '0.000'))
  const bboxStr = `${x0},${y0},${x1},${y1}`
  const locAttr = block.locLabel ? ` data-loc="${escapeHtmlAttr(block.locLabel)}"` : ''
  const sheetAttr = block.sheetName ? ` data-sheet="${escapeHtmlAttr(block.sheetName)}"` : ''
  const cellAttr = block.cellRef ? ` data-cell="${escapeHtmlAttr(block.cellRef)}"` : ''

  const spanTag = `<span id="${block.id}" data-page="${block.pageNumber}" data-bbox="${bboxStr}"${locAttr}${sheetAttr}${cellAttr}></span>`

  const commentLoc = block.locLabel ? ` loc="${escapeHtmlAttr(block.locLabel)}"` : ''
  const commentSheet = block.sheetName ? ` sheet="${escapeHtmlAttr(block.sheetName)}"` : ''
  const commentCell = block.cellRef ? ` cell="${escapeHtmlAttr(block.cellRef)}"` : ''
  const commentTag = `<!-- anchor: ${block.id} [${bboxStr}]${commentLoc}${commentSheet}${commentCell} -->`

  return `${spanTag}\n${commentTag}`
}

/**
 * 将单页/单幻灯片/单工作表布局序列化为 Markdown
 */
export function serializeOfficePageToMarkdown(
  page: OfficePageLayout,
  options?: OfficeSerializeOptions,
): string {
  const includeAnchors = options?.includeAnchors ?? true
  const parts: string[] = []

  for (const block of page.blocks) {
    const md = block.markdown.trim()
    if (!md) continue
    if (includeAnchors) {
      parts.push(`${formatOfficeBlockAnchorPrefix(block)}\n${md}`)
    } else {
      parts.push(md)
    }
  }

  return parts.join('\n\n')
}

/**
 * 将完整 Office 文档布局 AST 序列化为 Markdown
 */
export function serializeOfficeDocumentToMarkdown(
  ast: OfficeDocumentLayoutAST,
  options?: OfficeSerializeOptions,
): string {
  const includeAnchors = options?.includeAnchors ?? true
  const includePageHeaders = options?.includePageHeaders ?? true
  const pageSections: string[] = []

  for (const page of ast.pages) {
    const pageBody = serializeOfficePageToMarkdown(page, { includeAnchors, includePageHeaders })
    if (!pageBody.trim()) continue

    if (includePageHeaders) {
      let headerTitle = `第 ${page.pageNumber} 页`
      if (ast.format === 'pptx') {
        headerTitle = page.title ? `幻灯片 ${page.pageNumber}：${page.title}` : `幻灯片 ${page.pageNumber}`
      } else if (ast.format === 'xlsx') {
        headerTitle = page.sheetName ? `工作表：${page.sheetName}` : (page.title || `工作表 ${page.pageNumber}`)
      } else if (page.title) {
        headerTitle = `第 ${page.pageNumber} 页：${page.title}`
      }
      pageSections.push(`<!-- page: ${page.pageNumber} label="${escapeHtmlAttr(headerTitle)}" -->\n${pageBody}`)
    } else {
      pageSections.push(pageBody)
    }
  }

  return pageSections.join('\n\n---\n\n')
}

/**
 * 剥离 Office 拓扑锚点（`<span id="pX-bY" ...></span>`、`<!-- anchor: ... -->` 与 `<!-- page: ... -->`）
 */
export function stripOfficeTopologyAnchors(markdown: string): string {
  return markdown
    .replace(/<span\s+id="(?:[a-zA-Z0-9_-]+:)?p\d+-b\d+"[^>]*><\/span>\n?/g, '')
    .replace(/<!--\s*anchor:\s*(?:[a-zA-Z0-9_-]+:)?p\d+-b\d+\s+\[[^\]]*\][^>]*-->\n?/g, '')
    .replace(/<!--\s*page:\s*\d+[^>]*-->\n?/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function mapOfficeBlockTypeToSharedKind(type: OfficeBlockType, headingLevel?: number): LayoutRegionKind {
  switch (type) {
    case 'heading':
      return headingLevel === 1 ? 'title' : 'section-heading'
    case 'paragraph':
      return 'paragraph'
    case 'list':
      return 'list-item'
    case 'table':
      return 'table'
    case 'figure':
      return 'figure'
    case 'formula':
      return 'equation'
    case 'header':
      return 'header'
    case 'footer':
      return 'footer'
    case 'caption':
      return 'footnote'
    default:
      return 'paragraph'
  }
}

/**
 * 将 OfficeDocumentLayoutAST 转换为 `@profer/shared` 通用 `DocumentLayoutAST`
 */
export function officeAstToSharedLayoutAst(
  ast: OfficeDocumentLayoutAST,
  fileName: string,
): DocumentLayoutAST {
  let globalOrderIndex = 0
  const readingOrderedBlocks: DocumentLayoutBlock[] = []
  const outline: Array<{ title: string; level: number; blockId: string; page: number }> = []

  const pages: DocumentLayoutPage[] = ast.pages.map((page) => ({
    pageNumber: page.pageNumber,
    width: page.widthPt,
    height: page.heightPt,
    columnCount: 1,
    trappedTokensFiltered: 0,
    blocks: page.blocks.map((block): DocumentLayoutBlock => {
      const sharedBlock: DocumentLayoutBlock = {
        id: block.id,
        pageNumber: block.pageNumber,
        kind: mapOfficeBlockTypeToSharedKind(block.type, block.headingLevel),
        headingLevel: block.headingLevel,
        bbox: block.bbox,
        text: block.text,
        readingOrderIndex: globalOrderIndex++,
        readingStreamId: 0,
        confidence: 1,
      }
      readingOrderedBlocks.push(sharedBlock)
      if (block.type === 'heading' && block.text.trim()) {
        outline.push({
          title: block.text.trim(),
          level: block.headingLevel ?? 2,
          blockId: block.id,
          page: block.pageNumber,
        })
      }
      return sharedBlock
    }),
  }))

  return {
    fileName,
    pageCount: ast.pageCount,
    pages,
    readingOrderedBlocks,
    outline,
    markdown: serializeOfficeDocumentToMarkdown(ast, { includeAnchors: true }),
    metrics: {
      totalExtractionMs: 0,
      alignmentMs: 0,
      maxRegretSortMs: 0,
      tableParseMs: 0,
      trapDocFilteredCount: 0,
    },
  }
}
