/**
 * CSLab Word OOXML 无损引擎
 *
 * 三个核心契约：
 * 1. exportManuscriptToDocx —— 从 TipTap docJson 直接生成完整 docx 骨架（不再经由 Markdown 中转）；
 * 2. syncCapsulesToDocx —— 存量 docx 的外科手术：只重写 customXml/item*.xml，
 *    word/document.xml 保持解压字节不变，并报告新增/删除/缺失绑定；
 * 3. importDocx —— 结构化解析 document.xml，保留胶囊在正文中的原始位置。
 */

import JSZip from 'jszip'
import { DOMParser } from '@xmldom/xmldom'
import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const CSLAB_CUSTOM_XML_NS = 'urn:cdut:science:capsules'
const CUSTOM_XML_PATH = 'customXml/item1.xml'
const DOCUMENT_XML_PATH = 'word/document.xml'
const CUSTOM_XML_PART_RE = /^customXml\/item\d+\.xml$/i
const CAPSULE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const STORE_ITEM_ID = '{6F2C0A5E-6C8B-4A1F-9C7D-2B5E8A9D4C11}'

export interface OoxmlCapsuleValue {
  id: string
  label?: string
  unit?: string
  value: string
}

export interface OoxmlInspectResult {
  customXmlFiles: string[]
  capsuleIds: string[]
  hasDataBinding: boolean
}

export interface OoxmlSyncResult {
  buffer: Uint8Array
  documentXmlUnchanged: boolean
  updatedCapsuleIds: string[]
  addedCapsuleIds: string[]
  removedCapsuleIds: string[]
  missingDataBindingIds: string[]
}

export interface OoxmlExportInput {
  title: string
  docJson: unknown
  capsules: OoxmlCapsuleValue[]
}

export interface OoxmlTextMarks {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  code?: boolean
}

/** 评论正文（写入 word/comments.xml）。 */
export interface OoxmlCommentValue {
  id: number
  author: string
  date: string
  text: string
}

export interface OoxmlTrackMark {
  kind: 'insertion' | 'deletion'
  id: number
  author?: string
  date?: string
}

export interface OoxmlCommentMark {
  id: number
  author?: string
  text?: string
}

export type OoxmlImportInline =
  | {
      kind: 'text'
      text: string
      marks?: OoxmlTextMarks
      track?: OoxmlTrackMark
      comments?: OoxmlCommentMark[]
    }
  | { kind: 'capsule'; capsuleId: string }

/**
 * TipTap 字符串 suggestionId -> Word 唯一整数 id（FNV-1a 31 位）。
 * 同一文档内稳定，便于反复导出保持修订 id 一致。
 */
export function suggestionIdToWordId(id: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  const value = (hash >>> 1) & 0x7fffffff
  return value || 1
}

function normalizeIsoDate(raw: unknown): string {
  const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Date.parse(raw) : Number.NaN
  if (!Number.isFinite(parsed)) return new Date().toISOString()
  return new Date(parsed).toISOString()
}

export interface OoxmlImportBlock {
  type: 'paragraph' | 'heading'
  level?: number
  inlines: OoxmlImportInline[]
}

export interface OoxmlImportResult {
  title: string
  blocks: OoxmlImportBlock[]
  paragraphs: string[]
  capsules: OoxmlCapsuleValue[]
  unreferencedCapsuleIds: string[]
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function buildCustomXml(capsules: OoxmlCapsuleValue[]): string {
  const items = capsules
    .map((capsule) => {
      const attrs = [
        `id="${escapeXml(capsule.id)}"`,
        capsule.label ? `label="${escapeXml(capsule.label)}"` : '',
        capsule.unit ? `unit="${escapeXml(capsule.unit)}"` : '',
      ]
        .filter(Boolean)
        .join(' ')
      return `    <cs:capsule ${attrs}>${escapeXml(capsule.value)}</cs:capsule>`
    })
    .join('\n')
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<cs:capsules xmlns:cs="${CSLAB_CUSTOM_XML_NS}">`,
    items,
    '</cs:capsules>',
    '',
  ].join('\n')
}

interface ParsedCapsuleNode {
  id: string
  label?: string
  unit?: string
  value: string
}

function parseCustomXml(xml: string): ParsedCapsuleNode[] {
  const document = new DOMParser().parseFromString(xml, 'text/xml')
  const result: ParsedCapsuleNode[] = []
  const walk = (node: unknown): void => {
    const element = node as {
      localName?: string
      nodeName?: string
      getAttribute?: (name: string) => string | null
      textContent?: string | null
      childNodes?: ArrayLike<unknown>
    }
    const name = element.localName ?? element.nodeName ?? ''
    if (name === 'capsule') {
      const id = element.getAttribute?.('id') ?? ''
      if (id) {
        result.push({
          id,
          label: element.getAttribute?.('label') ?? undefined,
          unit: element.getAttribute?.('unit') ?? undefined,
          value: element.textContent ?? '',
        })
      }
    }
    const children = element.childNodes
    if (children) {
      for (let index = 0; index < children.length; index += 1) walk(children[index])
    }
  }
  walk(document)
  return result
}

// ===== DOM helpers =====

type XmlElement = {
  localName?: string | null
  nodeName?: string
  nodeType?: number
  textContent?: string | null
  childNodes?: ArrayLike<XmlElement>
  getAttribute?: (name: string) => string | null
  attributes?: ArrayLike<{ localName?: string; name?: string; value?: string }>
}

function elementChildren(node: XmlElement): XmlElement[] {
  const result: XmlElement[] = []
  const children = node.childNodes
  if (!children) return result
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]
    if (child && child.nodeType === 1) result.push(child)
  }
  return result
}

function localNameOf(node: XmlElement): string {
  return node.localName ?? node.nodeName?.split(':').pop() ?? ''
}

function findFirst(node: XmlElement, name: string): XmlElement | null {
  for (const child of elementChildren(node)) {
    if (localNameOf(child) === name) return child
    const nested = findFirst(child, name)
    if (nested) return nested
  }
  return null
}

function findChildren(node: XmlElement, name: string): XmlElement[] {
  return elementChildren(node).filter((child) => localNameOf(child) === name)
}

function getAttribute(node: XmlElement, name: string): string | null {
  const direct = node.getAttribute?.(name) ?? node.getAttribute?.(`w:${name}`)
  if (direct != null) return direct
  const attributes = node.attributes
  if (!attributes) return null
  for (let index = 0; index < attributes.length; index += 1) {
    const attr = attributes[index]
    const local = attr?.localName ?? attr?.name?.split(':').pop()
    if (local === name) return attr?.value ?? null
  }
  return null
}

function collectText(node: XmlElement): string {
  let text = ''
  for (const child of elementChildren(node)) {
    const name = localNameOf(child)
    if (name === 't') text += child.textContent ?? ''
    else if (name === 'tab') text += '\t'
    else if (name === 'br') text += '\n'
    else if (name === 'sdt') {
      // sdt 内部文本由胶囊逻辑处理，避免重复。
      continue
    } else text += collectText(child)
  }
  return text
}

// ===== 导出 =====

function renderTextRun(text: string, marks?: OoxmlTextMarks): string {
  return renderTextRunContent(text, marks, 'w:t')
}

function renderTextRunContent(
  text: string,
  marks: OoxmlTextMarks | undefined,
  textTag: 'w:t' | 'w:delText',
): string {
  if (!text) return ''
  const props: string[] = []
  if (marks?.code) props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>')
  if (marks?.bold) props.push('<w:b/>')
  if (marks?.italic) props.push('<w:i/>')
  if (marks?.underline) props.push('<w:u w:val="single"/>')
  const rPr = props.length > 0 ? `<w:rPr>${props.join('')}</w:rPr>` : ''
  return `<w:r>${rPr}<${textTag} xml:space="preserve">${escapeXml(text)}</${textTag}></w:r>`
}

interface RenderContext {
  comments: Map<number, OoxmlCommentValue>
}

interface RenderedMarkInfo {
  textMarks: OoxmlTextMarks
  insertion?: { id: number; author: string; date: string }
  deletion?: { id: number; author: string; date: string }
  comments: Array<{ id: number; author: string; date: string; text: string }>
}

function readMarkInfo(
  node: Record<string, unknown>,
  context: RenderContext,
): RenderedMarkInfo {
  const rawMarks = Array.isArray(node.marks)
    ? (node.marks as Array<Record<string, unknown>>)
    : []
  const info: RenderedMarkInfo = { textMarks: {}, comments: [] }

  for (const mark of rawMarks) {
    const type = String(mark.type ?? '')
    const attrs = (mark.attrs ?? {}) as Record<string, unknown>
    if (type === 'bold') info.textMarks.bold = true
    else if (type === 'italic') info.textMarks.italic = true
    else if (type === 'underline') info.textMarks.underline = true
    else if (type === 'code') info.textMarks.code = true
    else if (type === 'insertion' || type === 'deletion') {
      const suggestionId = String(attrs.suggestionId ?? '')
      if (!suggestionId) continue
      const payload = {
        id: suggestionIdToWordId(suggestionId),
        author: String(attrs.authorName ?? attrs.authorId ?? 'CDUT Science'),
        date: normalizeIsoDate(attrs.createdAt),
      }
      if (type === 'insertion') info.insertion = payload
      else info.deletion = payload
    } else if (type === 'comment') {
      const suggestionId = String(attrs.suggestionId ?? '')
      if (!suggestionId) continue
      const id = suggestionIdToWordId(`comment:${suggestionId}`)
      const author = String(attrs.authorName ?? attrs.authorId ?? 'CDUT Science')
      const date = normalizeIsoDate(attrs.createdAt)
      const text = String(attrs.commentText ?? '')
      info.comments.push({ id, author, date, text })
      if (!context.comments.has(id)) {
        context.comments.set(id, { id, author, date, text })
      }
    }
  }

  return info
}

function renderCapsuleSdt(capsule: OoxmlCapsuleValue): string {
  if (!CAPSULE_ID_RE.test(capsule.id)) {
    return renderTextRun(capsule.value)
  }
  const xpath = `cs:capsules/cs:capsule[@id='${capsule.id}']`
  return [
    '<w:sdt>',
    '<w:sdtPr>',
    `<w:dataBinding w:xpath="${escapeXml(xpath)}" w:storeItemID="${STORE_ITEM_ID}" w:prefixMappings="xmlns:cs='${CSLAB_CUSTOM_XML_NS}'"/>`,
    '<w:text/>',
    '</w:sdtPr>',
    '<w:sdtContent>',
    `<w:r><w:t xml:space="preserve">${escapeXml(capsule.value)}</w:t></w:r>`,
    '</w:sdtContent>',
    '</w:sdt>',
  ].join('')
}

function renderInlineNodes(
  content: Array<Record<string, unknown>>,
  capsuleMap: Map<string, OoxmlCapsuleValue>,
  context: RenderContext,
): string {
  const pieces: string[] = []
  const openComments = new Set<number>()

  const closeComment = (id: number): void => {
    pieces.push(`<w:commentRangeEnd w:id="${id}"/>`)
    pieces.push(`<w:r><w:commentReference w:id="${id}"/></w:r>`)
    openComments.delete(id)
  }

  for (const node of content) {
    const type = String(node.type ?? '')
    if (type === 'text') {
      const info = readMarkInfo(node, context)
      const ids = new Set(info.comments.map((comment) => comment.id))

      // 先关闭上一段连续评论文本里已经结束的批注。
      for (const id of [...openComments]) {
        if (!ids.has(id)) closeComment(id)
      }
      for (const comment of info.comments) {
        if (!openComments.has(comment.id)) {
          pieces.push(`<w:commentRangeStart w:id="${comment.id}"/>`)
          openComments.add(comment.id)
        }
      }

      let run = renderTextRunContent(
        String(node.text ?? ''),
        info.textMarks,
        info.deletion ? 'w:delText' : 'w:t',
      )
      if (info.deletion) {
        run = `<w:del w:id="${info.deletion.id}" w:author="${escapeXml(info.deletion.author)}" w:date="${info.deletion.date}">${run}</w:del>`
      }
      if (info.insertion) {
        run = `<w:ins w:id="${info.insertion.id}" w:author="${escapeXml(info.insertion.author)}" w:date="${info.insertion.date}">${run}</w:ins>`
      }
      pieces.push(run)
      continue
    }

    // 非文本节点（胶囊/换行等）结束当前批注范围，避免跨结构悬挂。
    for (const id of [...openComments]) closeComment(id)

    if (type === 'scienceCapsule') {
      const attrs = (node.attrs ?? {}) as Record<string, unknown>
      const capsule = capsuleMap.get(String(attrs.capsuleId ?? ''))
      pieces.push(capsule ? renderCapsuleSdt(capsule) : renderTextRun(String(attrs.value ?? '')))
      continue
    }
    if (type === 'hardBreak') {
      pieces.push('<w:r><w:br/></w:r>')
      continue
    }
    if (type === 'mention') {
      const attrs = (node.attrs ?? {}) as Record<string, unknown>
      pieces.push(renderTextRun(String(attrs['label'] ?? '')))
      continue
    }
    if (Array.isArray(node.content)) {
      pieces.push(
        renderInlineNodes(node.content as Array<Record<string, unknown>>, capsuleMap, context),
      )
    }
  }

  for (const id of [...openComments]) closeComment(id)
  return pieces.join('')
}

function renderParagraph(
  content: Array<Record<string, unknown>>,
  capsuleMap: Map<string, OoxmlCapsuleValue>,
  context: RenderContext,
  options: { style?: string; indent?: number; prefix?: string } = {},
): string {
  const pPr: string[] = []
  if (options.style) pPr.push(`<w:pStyle w:val="${options.style}"/>`)
  if (options.indent) pPr.push(`<w:ind w:left="${options.indent}"/>`)
  const pPrXml = pPr.length > 0 ? `<w:pPr>${pPr.join('')}</w:pPr>` : ''
  const prefix = options.prefix ? renderTextRun(options.prefix) : ''
  return `<w:p>${pPrXml}${prefix}${renderInlineNodes(content, capsuleMap, context)}</w:p>`
}

function renderList(
  node: Record<string, unknown>,
  capsuleMap: Map<string, OoxmlCapsuleValue>,
  context: RenderContext,
  ordered: boolean,
): string {
  const items = Array.isArray(node.content) ? (node.content as Array<Record<string, unknown>>) : []
  return items
    .map((item, index) => {
      const itemContent = Array.isArray(item.content)
        ? (item.content as Array<Record<string, unknown>>)
        : []
      const prefix = ordered ? `${index + 1}. ` : '• '
      const paragraphs = itemContent.filter((child) => child.type === 'paragraph')
      const content = paragraphs.length > 0 ? paragraphs : [{ type: 'paragraph', content: itemContent }]
      return content
        .map((child, childIndex) =>
          renderParagraph(
            Array.isArray(child.content) ? (child.content as Array<Record<string, unknown>>) : [],
            capsuleMap,
            context,
            { prefix: childIndex === 0 ? prefix : '  ', indent: 360 },
          ),
        )
        .join('')
    })
    .join('')
}

function renderTable(
  node: Record<string, unknown>,
  capsuleMap: Map<string, OoxmlCapsuleValue>,
  context: RenderContext,
): string {
  const rows = Array.isArray(node.content) ? (node.content as Array<Record<string, unknown>>) : []
  return rows
    .map((row) => {
      const cells = Array.isArray(row.content) ? (row.content as Array<Record<string, unknown>>) : []
      const text = cells
        .map((cell) => {
          const paragraphs = Array.isArray(cell.content)
            ? (cell.content as Array<Record<string, unknown>>)
            : []
          return paragraphs
            .map((paragraph) =>
              Array.isArray(paragraph.content)
                ? (paragraph.content as Array<Record<string, unknown>>)
                    .map((inline) => {
                      const attrs = (inline.attrs ?? {}) as Record<string, unknown>
                      return String(inline.text ?? attrs['value'] ?? '')
                    })
                    .join('')
                : '',
            )
            .join(' ')
        })
        .join('\t')
      return renderParagraph([], capsuleMap, context, { prefix: text })
    })
    .join('')
}

function renderBlockNode(
  node: Record<string, unknown>,
  capsuleMap: Map<string, OoxmlCapsuleValue>,
  context: RenderContext,
): string {
  const type = String(node.type ?? '')
  const content = Array.isArray(node.content) ? (node.content as Array<Record<string, unknown>>) : []

  switch (type) {
    case 'paragraph':
      return renderParagraph(content, capsuleMap, context)
    case 'heading': {
      const level = Number((node.attrs as Record<string, unknown> | undefined)?.['level'] ?? 1)
      return renderParagraph(content, capsuleMap, context, {
        style: `Heading${Math.max(1, Math.min(6, level))}`,
      })
    }
    case 'bulletList':
      return renderList(node, capsuleMap, context, false)
    case 'orderedList':
      return renderList(node, capsuleMap, context, true)
    case 'blockquote':
      return content
        .map((child) =>
          child.type === 'paragraph'
            ? renderParagraph(
                Array.isArray(child.content) ? (child.content as Array<Record<string, unknown>>) : [],
                capsuleMap,
                context,
                { indent: 720 },
              )
            : renderBlockNode(child, capsuleMap, context),
        )
        .join('')
    case 'codeBlock': {
      const text = content.map((child) => String(child.text ?? '')).join('')
      const pieces = text.split('\n')
      const runs = pieces
        .map((piece, index) =>
          `${renderTextRun(piece, { code: true })}${index < pieces.length - 1 ? '<w:r><w:br/></w:r>' : ''}`,
        )
        .join('')
      return `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr>${runs}</w:p>`
    }
    case 'table':
      return renderTable(node, capsuleMap, context)
    case 'horizontalRule':
      return renderParagraph([], capsuleMap, context, { prefix: '———' })
    default:
      if (content.length > 0) {
        return content.map((child) => renderBlockNode(child, capsuleMap, context)).join('')
      }
      return ''
  }
}

function buildDocumentXml(input: OoxmlExportInput): {
  xml: string
  comments: OoxmlCommentValue[]
} {
  const capsuleMap = new Map(input.capsules.map((capsule) => [capsule.id, capsule]))
  const context: RenderContext = { comments: new Map() }
  const root = input.docJson as Record<string, unknown> | null
  const content =
    root && Array.isArray(root.content) ? (root.content as Array<Record<string, unknown>>) : []
  const body = content.map((node) => renderBlockNode(node, capsuleMap, context)).join('')

  return {
    xml: [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
      '<w:body>',
      body || renderParagraph([], capsuleMap, context, { style: 'Heading1', prefix: input.title }),
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>',
      '</w:body>',
      '</w:document>',
    ].join(''),
    comments: [...context.comments.values()],
  }
}

function buildContentTypesXml(hasComments: boolean): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '  <Default Extension="xml" ContentType="application/xml"/>',
    '  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
    '  <Override PartName="/customXml/itemProps1.xml" ContentType="application/vnd.openxmlformats-officedocument.customXmlProperties+xml"/>',
    ...(hasComments
      ? [
          '  <Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>',
        ]
      : []),
    '</Types>',
  ].join('\n')
}

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

function buildDocumentRelsXml(hasComments: boolean): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml" Target="../customXml/item1.xml"/>',
    ...(hasComments
      ? [
          '  <Relationship Id="rIdComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>',
        ]
      : []),
    '</Relationships>',
  ].join('\n')
}

function buildCommentsXml(comments: OoxmlCommentValue[]): string {
  const body = comments
    .map(
      (comment) =>
        `  <w:comment w:id="${comment.id}" w:author="${escapeXml(comment.author)}" w:date="${escapeXml(comment.date)}" w:initials="${escapeXml(
          comment.author.slice(0, 3).toUpperCase(),
        )}"><w:p><w:r><w:t xml:space="preserve">${escapeXml(comment.text)}</w:t></w:r></w:p></w:comment>`,
    )
    .join('\n')
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    body,
    '</w:comments>',
    '',
  ].join('\n')
}

export interface CommentPartsInput {
  hasComments: boolean
  commentsXml?: string
  documentRels: string
  contentTypes: string
}

/**
 * 导出前自检：只要写入了评论，Part / Relationship / Content-Type 三件套必须齐全。
 * 缺任一项直接抛错，绝不产出会让 Word 弹「需要修复」的包。
 */
export function assertCommentsParts(parts: CommentPartsInput): void {
  if (!parts.hasComments) return
  if (!parts.commentsXml || !/<w:comments\b/.test(parts.commentsXml)) {
    throw new Error('comments.xml 缺失或根节点不正确')
  }
  if (!/relationships\/comments/.test(parts.documentRels)) {
    throw new Error('document.xml.rels 缺少 comments 关系声明')
  }
  if (!/PartName="\/word\/comments\.xml"/.test(parts.contentTypes)) {
    throw new Error('[Content_Types].xml 缺少 comments 覆盖声明')
  }
}

const CUSTOM_XML_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXmlProps" Target="itemProps1.xml"/>
</Relationships>`

const ITEM_PROPS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ds:datastoreItem ds:itemID="${STORE_ITEM_ID}" xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml">
  <ds:schemaRefs><ds:schemaRef ds:uri="${CSLAB_CUSTOM_XML_NS}"/></ds:schemaRefs>
</ds:datastoreItem>`

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:qFormat/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:qFormat/></w:style>
</w:styles>`

/** 读取 docx 内 customXml 胶囊与数据绑定信息。 */
export async function inspectDocx(buffer: Uint8Array): Promise<OoxmlInspectResult> {
  const zip = await JSZip.loadAsync(buffer)
  const customXmlFiles = Object.keys(zip.files).filter((name) => CUSTOM_XML_PART_RE.test(name))

  const capsuleIds: string[] = []
  let hasDataBinding = false

  for (const file of customXmlFiles) {
    const xml = await zip.file(file)?.async('string')
    if (!xml) continue
    for (const capsule of parseCustomXml(xml)) {
      if (!capsuleIds.includes(capsule.id)) capsuleIds.push(capsule.id)
    }
  }

  const documentXml = await zip.file(DOCUMENT_XML_PATH)?.async('string')
  if (documentXml) hasDataBinding = /<w:dataBinding\b/i.test(documentXml)

  return { customXmlFiles, capsuleIds, hasDataBinding }
}

function collectBoundCapsuleIds(documentXml: string): Set<string> {
  const bound = new Set<string>()
  for (const match of documentXml.matchAll(/<w:dataBinding\b[^>]*w:xpath="([^"]*)"/gi)) {
    const xpath = (match[1] ?? '')
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
    const idMatch = xpath.match(/@id=['"]([^'"]+)['"]/)
    if (idMatch?.[1]) bound.add(idMatch[1])
  }
  return bound
}

/**
 * 存量 docx 外科手术：重写全部 CSLab customXml 部件，document.xml 字节不变。
 */
export async function syncCapsulesToDocx(
  buffer: Uint8Array,
  capsules: OoxmlCapsuleValue[],
): Promise<OoxmlSyncResult> {
  const zip = await JSZip.loadAsync(buffer)
  const allParts = Object.keys(zip.files).filter((name) => CUSTOM_XML_PART_RE.test(name))
  const targetParts: string[] = []

  for (const part of allParts) {
    const xml = await zip.file(part)?.async('string')
    if (xml && /<cs:capsules\b/i.test(xml)) targetParts.push(part)
  }
  if (targetParts.length === 0) {
    throw new Error('该 docx 不含 CSLab customXml 胶囊存储，请先使用“导出为 Word”生成绑定骨架')
  }

  const documentEntry = zip.file(DOCUMENT_XML_PATH)
  const documentBefore = documentEntry ? await documentEntry.async('uint8array') : null
  const documentXml = documentEntry ? await documentEntry.async('string') : ''
  const boundIds = collectBoundCapsuleIds(documentXml)

  const existing = new Map<string, ParsedCapsuleNode>()
  for (const part of targetParts) {
    const xml = await zip.file(part)?.async('string')
    if (!xml) continue
    for (const capsule of parseCustomXml(xml)) {
      if (!existing.has(capsule.id)) existing.set(capsule.id, capsule)
    }
  }

  const validCapsules = capsules.filter((capsule) => CAPSULE_ID_RE.test(capsule.id))
  const nextIds = new Set(validCapsules.map((capsule) => capsule.id))

  const updatedCapsuleIds: string[] = []
  const addedCapsuleIds: string[] = []

  for (const capsule of validCapsules) {
    const previous = existing.get(capsule.id)
    if (!previous) addedCapsuleIds.push(capsule.id)
    else if (previous.value !== capsule.value) updatedCapsuleIds.push(capsule.id)
  }

  const removedCapsuleIds = [...existing.keys()].filter((id) => !nextIds.has(id))
  const missingDataBindingIds = validCapsules
    .filter((capsule) => !boundIds.has(capsule.id))
    .map((capsule) => capsule.id)

  const customXml = buildCustomXml(
    validCapsules.map((capsule) => ({
      id: capsule.id,
      label: capsule.label ?? existing.get(capsule.id)?.label,
      unit: capsule.unit ?? existing.get(capsule.id)?.unit,
      value: capsule.value,
    })),
  )
  for (const part of targetParts) zip.file(part, customXml)

  const output = (await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
  })) as Uint8Array

  let documentXmlUnchanged = true
  if (documentBefore) {
    const outputZip = await JSZip.loadAsync(output)
    const documentAfter = await outputZip.file(DOCUMENT_XML_PATH)?.async('uint8array')
    documentXmlUnchanged =
      !!documentAfter &&
      documentAfter.length === documentBefore.length &&
      documentAfter.every((byte, index) => byte === documentBefore[index])
  }

  return {
    buffer: output,
    documentXmlUnchanged,
    updatedCapsuleIds,
    addedCapsuleIds,
    removedCapsuleIds,
    missingDataBindingIds,
  }
}

/**
 * 全新文稿导出：从 TipTap docJson 直接生成完整合法 docx。
 * 若正文含 insertion / deletion / comment marks，会自动生成 Word 修订与批注部件。
 */
export async function exportManuscriptToDocx(input: OoxmlExportInput): Promise<Uint8Array> {
  const { xml: documentXml, comments } = buildDocumentXml(input)
  const hasComments = comments.length > 0
  const commentsXml = hasComments ? buildCommentsXml(comments) : undefined
  const contentTypes = buildContentTypesXml(hasComments)
  const documentRels = buildDocumentRelsXml(hasComments)

  // 三件套原子校验：缺任一项直接失败，不产出坏包。
  assertCommentsParts({ hasComments, commentsXml, documentRels, contentTypes })

  const zip = new JSZip()
  zip.file('[Content_Types].xml', contentTypes)
  zip.file('_rels/.rels', ROOT_RELS_XML)
  zip.file('word/document.xml', documentXml)
  zip.file('word/_rels/document.xml.rels', documentRels)
  zip.file('word/styles.xml', STYLES_XML)
  if (commentsXml) zip.file('word/comments.xml', commentsXml)
  zip.file(CUSTOM_XML_PATH, buildCustomXml(input.capsules))
  zip.file('customXml/_rels/item1.xml.rels', CUSTOM_XML_RELS_XML)
  zip.file('customXml/itemProps1.xml', ITEM_PROPS_XML)

  return (await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })) as Uint8Array
}

// ===== 导入 =====

function readRunMarks(run: XmlElement): OoxmlTextMarks | undefined {
  const rPr = findFirst(run, 'rPr')
  if (!rPr) return undefined
  const marks: OoxmlTextMarks = {}
  if (findFirst(rPr, 'b')) marks.bold = true
  if (findFirst(rPr, 'i')) marks.italic = true
  if (findFirst(rPr, 'u')) marks.underline = true
  const fonts = findFirst(rPr, 'rFonts')
  if (fonts && /consolas|courier/i.test(getAttribute(fonts, 'ascii') ?? '')) marks.code = true
  return Object.keys(marks).length > 0 ? marks : undefined
}

function extractCapsuleIdFromSdt(sdt: XmlElement): string | null {
  const dataBinding = findFirst(sdt, 'dataBinding')
  if (!dataBinding) return null
  const xpath = getAttribute(dataBinding, 'xpath') ?? ''
  return xpath.match(/@id=['"]([^'"]+)['"]/)?.[1] ?? null
}

interface ImportedComment {
  id: number
  author?: string
  text?: string
}

/** 解析 word/comments.xml（缺失或损坏时返回空表，不让整篇导入失败）。 */
function parseCommentsXml(xml: string): Map<number, ImportedComment> {
  const result = new Map<number, ImportedComment>()
  if (!xml) return result
  try {
    const document = new DOMParser().parseFromString(xml, 'text/xml')
    const walk = (node: unknown): void => {
      const element = node as XmlElement
      const name = localNameOf(element)
      if (name === 'comment') {
        const id = Number(getAttribute(element, 'id'))
        if (Number.isFinite(id) && id > 0) {
          result.set(id, {
            id,
            author: getAttribute(element, 'author') ?? undefined,
            text: collectText(element),
          })
        }
      }
      for (const child of elementChildren(element)) walk(child)
    }
    walk(document)
  } catch {
    return result
  }
  return result
}

function parseParagraphInlines(
  paragraph: XmlElement,
  capsuleMap: Map<string, ParsedCapsuleNode>,
  referenced: Set<string>,
  inlines: OoxmlImportInline[],
  commentsMap: Map<number, ImportedComment>,
): void {
  const activeComments = new Set<number>()

  const snapshotComments = (): OoxmlCommentMark[] | undefined => {
    if (activeComments.size === 0) return undefined
    return [...activeComments].map((id) => ({
      id,
      author: commentsMap.get(id)?.author,
      text: commentsMap.get(id)?.text,
    }))
  }

  const visit = (node: XmlElement, track?: OoxmlTrackMark): void => {
    for (const child of elementChildren(node)) {
      const name = localNameOf(child)

      if (name === 'commentRangeStart') {
        const id = Number(getAttribute(child, 'id'))
        if (Number.isFinite(id) && id > 0) activeComments.add(id)
        continue
      }
      if (name === 'commentRangeEnd') {
        const id = Number(getAttribute(child, 'id'))
        if (Number.isFinite(id)) activeComments.delete(id)
        continue
      }
      if (name === 'commentReference') continue

      if (name === 'sdt') {
        const capsuleId = extractCapsuleIdFromSdt(child)
        if (capsuleId && capsuleMap.has(capsuleId)) {
          inlines.push({ kind: 'capsule', capsuleId })
          referenced.add(capsuleId)
          continue
        }
        const content = findFirst(child, 'sdtContent')
        if (content) visit(content, track)
        continue
      }

      if (name === 'ins' || name === 'del') {
        const id = Number(getAttribute(child, 'id'))
        const author = getAttribute(child, 'author') ?? undefined
        const date = getAttribute(child, 'date') ?? undefined
        visit(child, {
          kind: name === 'ins' ? 'insertion' : 'deletion',
          id: Number.isFinite(id) ? id : 0,
          author,
          date,
        })
        continue
      }

      if (name === 'r') {
        const parts: string[] = []
        for (const runChild of elementChildren(child)) {
          const runName = localNameOf(runChild)
          if (runName === 't' || runName === 'delText') parts.push(runChild.textContent ?? '')
          else if (runName === 'tab') parts.push('\t')
          else if (runName === 'br' || runName === 'cr') parts.push('\n')
        }
        const text = parts.join('')
        if (text) {
          inlines.push({
            kind: 'text',
            text,
            marks: readRunMarks(child),
            track,
            comments: snapshotComments(),
          })
        }
        continue
      }

      if (name === 'hyperlink' || name === 'smartTag' || name === 'customXml') {
        visit(child, track)
      }
    }
  }

  visit(paragraph)
}

function parseParagraphBlock(
  paragraph: XmlElement,
  capsuleMap: Map<string, ParsedCapsuleNode>,
  referenced: Set<string>,
  commentsMap: Map<number, ImportedComment>,
): OoxmlImportBlock {
  const inlines: OoxmlImportInline[] = []
  parseParagraphInlines(paragraph, capsuleMap, referenced, inlines, commentsMap)

  let level: number | undefined
  const pPr = findFirst(paragraph, 'pPr')
  if (pPr) {
    const style = findFirst(pPr, 'pStyle')
    const val = style ? getAttribute(style, 'val') ?? '' : ''
    const match = val.match(/^Heading\s*([1-6])$/i)
    if (match?.[1]) level = Number(match[1])
  }

  return level
    ? { type: 'heading', level, inlines }
    : { type: 'paragraph', inlines }
}

function collectBlocks(
  container: XmlElement,
  capsuleMap: Map<string, ParsedCapsuleNode>,
  referenced: Set<string>,
  commentsMap: Map<number, ImportedComment>,
): OoxmlImportBlock[] {
  const blocks: OoxmlImportBlock[] = []

  for (const child of elementChildren(container)) {
    const name = localNameOf(child)
    if (name === 'p') {
      blocks.push(parseParagraphBlock(child, capsuleMap, referenced, commentsMap))
    } else if (name === 'sdt') {
      const content = findFirst(child, 'sdtContent')
      if (content) blocks.push(...collectBlocks(content, capsuleMap, referenced, commentsMap))
    } else if (name === 'tbl') {
      // Phase 1：表格按行压平为制表符文本。
      for (const row of findChildren(child, 'tr')) {
        const cells = findChildren(row, 'tc').map((cell) => collectText(cell))
        const text = cells.join('\t')
        if (text) blocks.push({ type: 'paragraph', inlines: [{ kind: 'text', text }] })
      }
    } else if (name === 'sectPr') {
      continue
    }
  }

  return blocks
}

/** 从 docx 读取胶囊值与结构化正文（保留胶囊位置）。 */
export async function importDocx(buffer: Uint8Array): Promise<OoxmlImportResult> {
  const zip = await JSZip.loadAsync(buffer)

  const customXmlFiles = Object.keys(zip.files).filter((name) => CUSTOM_XML_PART_RE.test(name))
  const capsuleMap = new Map<string, ParsedCapsuleNode>()
  for (const file of customXmlFiles) {
    const xml = await zip.file(file)?.async('string')
    if (!xml) continue
    for (const capsule of parseCustomXml(xml)) {
      if (!capsuleMap.has(capsule.id)) capsuleMap.set(capsule.id, capsule)
    }
  }

  const documentXml = (await zip.file(DOCUMENT_XML_PATH)?.async('string')) ?? ''
  const commentsXml = (await zip.file('word/comments.xml')?.async('string')) ?? ''
  const commentsMap = parseCommentsXml(commentsXml)
  const document = new DOMParser().parseFromString(documentXml, 'text/xml')
  const body = findFirst(document as unknown as XmlElement, 'body')

  const referenced = new Set<string>()
  const blocks = body ? collectBlocks(body, capsuleMap, referenced, commentsMap) : []

  const unreferencedCapsuleIds = [...capsuleMap.keys()].filter((id) => !referenced.has(id))
  if (unreferencedCapsuleIds.length > 0) {
    const inlines: OoxmlImportInline[] = [{ kind: 'text', text: '未绑定的数据胶囊：' }]
    unreferencedCapsuleIds.forEach((id, index) => {
      if (index > 0) inlines.push({ kind: 'text', text: ' ' })
      inlines.push({ kind: 'capsule', capsuleId: id })
    })
    blocks.push({ type: 'paragraph', inlines })
  }

  const paragraphs = blocks
    .map((block) =>
      block.inlines
        .map((inline) =>
          inline.kind === 'text'
            ? inline.text
            : capsuleMap.get(inline.capsuleId)?.value ?? '',
        )
        .join(''),
    )
    .filter((text) => text.trim().length > 0)

  const title =
    paragraphs[0]?.replace(/\s+/g, ' ').trim().slice(0, 40) || '导入文稿'

  return {
    title,
    blocks,
    paragraphs,
    capsules: [...capsuleMap.values()].map((capsule) => ({
      id: capsule.id,
      label: capsule.label,
      unit: capsule.unit,
      value: capsule.value,
    })),
    unreferencedCapsuleIds,
  }
}

// ===== Worker 契约 =====

export type CsLabOoxmlTask =
  | { type: 'inspect'; buffer: Uint8Array }
  | { type: 'sync'; buffer: Uint8Array; capsules: OoxmlCapsuleValue[] }
  | { type: 'export'; input: OoxmlExportInput }
  | { type: 'import'; buffer: Uint8Array }

export type CsLabOoxmlTaskResult =
  | { type: 'inspect'; result: OoxmlInspectResult }
  | { type: 'sync'; result: OoxmlSyncResult }
  | { type: 'export'; result: { buffer: Uint8Array } }
  | { type: 'import'; result: OoxmlImportResult }

export async function executeOoxmlTask(task: CsLabOoxmlTask): Promise<CsLabOoxmlTaskResult> {
  switch (task.type) {
    case 'inspect':
      return { type: 'inspect', result: await inspectDocx(task.buffer) }
    case 'sync':
      return { type: 'sync', result: await syncCapsulesToDocx(task.buffer, task.capsules) }
    case 'export':
      return { type: 'export', result: { buffer: await exportManuscriptToDocx(task.input) } }
    case 'import':
      return { type: 'import', result: await importDocx(task.buffer) }
  }
}

/** 优先在独立 Worker 线程执行；worker 产物缺失时进程内降级。 */
export async function runOoxmlTask(task: CsLabOoxmlTask): Promise<CsLabOoxmlTaskResult> {
  const workerPath = join(__dirname, 'cslab-ooxml-worker.cjs')
  if (!existsSync(workerPath)) return executeOoxmlTask(task)

  return new Promise<CsLabOoxmlTaskResult>((resolve, reject) => {
    const worker = new Worker(workerPath)
    const timer = setTimeout(() => {
      worker.terminate().catch(() => undefined)
      reject(new Error('OOXML Worker 执行超时（30s）'))
    }, 30_000)
    // 看门狗不应单独阻止进程退出。
    timer.unref?.()

    worker.once('message', (message: { ok: boolean; result?: CsLabOoxmlTaskResult; error?: string }) => {
      clearTimeout(timer)
      worker.terminate().catch(() => undefined)
      if (message.ok && message.result) resolve(message.result)
      else reject(new Error(message.error ?? 'OOXML Worker 执行失败'))
    })
    worker.once('error', (error) => {
      clearTimeout(timer)
      worker.terminate().catch(() => undefined)
      reject(error)
    })
    worker.postMessage(task)
  })
}
