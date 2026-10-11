/**
 * 文档序列化器
 *
 * 双层层输出中的「文本层」：把排版节点序列化为高保真学术 Markdown
 * （标题层级、LaTeX 公式、GFM 表格、脚注锚点），供大模型上下文与 Markdown 预览消费。
 */

import type { DocumentLayoutAST, DocumentLayoutBlock } from '@profer/shared'

/**
 * 序列化所需的最小结构（LayoutNode 与 DocumentLayoutBlock 均结构兼容）。
 * 这样引擎内部的排版节点与对外的契约块可以共用同一套序列化逻辑。
 */
export type SerializableBlock = Pick<
  DocumentLayoutBlock,
  | 'id'
  | 'pageNumber'
  | 'kind'
  | 'text'
  | 'bbox'
  | 'readingStreamId'
  | 'readingOrderIndex'
  | 'headingLevel'
  | 'equation'
  | 'table'
  | 'footnoteRef'
>

/** 大纲条目 */
export interface OutlineEntry {
  title: string
  level: number
  blockId: string
  page: number
}

/**
 * 人类可读位置描述：作为双轨定位引用中「人读」的那一轨。
 * 例如「第2页·左栏」「第3页·插图」「第4页·公式」。
 */
function getHumanLocation(node: SerializableBlock): string {
  const page = node.pageNumber
  const stream = node.readingStreamId
  const colDesc = stream === 1 ? '右栏' : stream === 0 ? '左栏' : '通栏'
  if (node.kind === 'figure') return `第${page}页·插图`
  if (node.kind === 'table') return `第${page}页·表格`
  if (node.kind === 'equation') return `第${page}页·公式`
  return `第${page}页·${colDesc}`
}

/** 单块 → Markdown 片段（返回空字符串表示该块不进入正文） */
function serializeBlock(node: SerializableBlock, includeAnchors = true): string {
  // 页眉/页脚脱离主正文流
  if (node.readingStreamId < 0 || node.kind === 'header' || node.kind === 'footer') return ''

  const text = node.text.trim()

  let body: string
  switch (node.kind) {
    case 'title':
      body = text.length > 0 ? `# ${text}` : ''
      break
    case 'section-heading': {
      if (text.length === 0) {
        body = ''
        break
      }
      const level = Math.min(6, Math.max(2, node.headingLevel ?? 2))
      body = `${'#'.repeat(level)} ${text}`
      break
    }
    case 'list-item':
      body = text.length > 0 ? `- ${text}` : ''
      break
    case 'equation': {
      const latex = node.equation?.latex.trim() || text
      if (latex.length === 0) {
        body = ''
        break
      }
      const tag = node.equation?.tag
      body = tag ? `$$\n${latex} \\tag{${tag}}\n$$` : `$$\n${latex}\n$$`
      break
    }
    case 'table':
      body = node.table?.markdown ?? ''
      break
    case 'figure':
      body = text.length > 0 ? `> **[${getHumanLocation(node)}]** ${text}` : `> **[${getHumanLocation(node)}]**`
      break
    case 'footnote': {
      if (text.length === 0) {
        body = ''
        break
      }
      const ref = node.footnoteRef ?? `fn-${node.pageNumber}-${node.readingOrderIndex}`
      body = `[^${ref}]: ${text}`
      break
    }
    case 'paragraph':
    default:
      body = text
      break
  }

  if (body.length === 0) return ''
  if (!includeAnchors) return body

  // 注入物理版面拓扑点（双平行双点唯一对应）：
  // 轻量 HTML span 锚点 + 注释元数据（页码 / 归一化 BBox / 人类可读 loc）
  const loc = getHumanLocation(node)
  const bboxText = node.bbox.map((value) => value.toFixed(3)).join(',')
  const anchorTag = `<span id="${node.id}" data-loc="${loc}"></span>\n<!-- anchor: ${node.id} [${bboxText}] loc="${loc}" -->`
  return `${anchorTag}\n${body}`
}

/**
 * 剥离双平行拓扑定位锚点（`<span id="..." data-loc="..."></span>` 与 `<!-- anchor: ... -->`），
 * 还原 100% 纯净无 HTML 污染的出版级 Markdown，供内核直接落盘至用户工作目录。
 */
export function stripDocumentTopologyAnchors(markdown: string): string {
  return markdown
    .replace(/^[ \t]*<span id="[^"]+" data-loc="[^"]*"><\/span>[ \t]*\r?\n?/gm, '')
    .replace(/^[ \t]*<!-- anchor: [^\n]*-->[ \t]*\r?\n?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 把阅读顺序节点序列化为学术 Markdown。
 */
export function serializeLayoutToMarkdown(
  nodes: readonly SerializableBlock[],
  options?: { includeAnchors?: boolean },
): string {
  const includeAnchors = options?.includeAnchors ?? true
  const parts: string[] = []
  for (const node of nodes) {
    const block = serializeBlock(node, includeAnchors)
    if (block.trim().length > 0) parts.push(block)
  }
  return parts.join('\n\n').trim()
}

/**
 * 从标题类节点构建文档大纲。
 */
export function buildOutline(nodes: readonly SerializableBlock[]): OutlineEntry[] {
  const outline: OutlineEntry[] = []
  for (const node of nodes) {
    if (node.kind !== 'title' && node.kind !== 'section-heading') continue
    if (node.text.trim().length === 0) continue
    outline.push({
      title: node.text.trim(),
      level: node.kind === 'title' ? 1 : Math.min(6, Math.max(2, node.headingLevel ?? 2)),
      blockId: node.id,
      page: node.pageNumber,
    })
  }
  return outline
}

/** 组装最终 AST 的文本/大纲字段（供引擎在收集完所有块后调用） */
export function finalizeAstText(ast: DocumentLayoutAST): DocumentLayoutAST {
  ast.markdown = serializeLayoutToMarkdown(ast.readingOrderedBlocks)
  ast.outline = buildOutline(ast.readingOrderedBlocks)
  return ast
}
