/**
 * OOXML 零外部依赖高速 ZIP 与 XML 解析器
 *
 * 采用 Node.js 原生 `node:zlib` (`inflateRawSync`) 解析 ZIP 中央目录（Central Directory），
 * 搭配面向 ECMA-376 的轻量级命名空间感知 XML AST 解析器与 `.rels` 关系映射器，
 * 保证 `@profer/core` 零第三方冗余依赖且具备毫秒级流式解析性能。
 */

import { inflateRawSync } from 'node:zlib'
import { posix as pathPosix } from 'node:path'
import type { OfficeFormat } from './types.ts'

// ─── ZIP 中央目录解析器 ───

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_DIR_SIGNATURE = 0x02014b50
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50

interface ZipEntryMeta {
  name: string
  compressionMethod: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

export class OoxmlZipReader {
  private readonly buf: Buffer
  private readonly entries = new Map<string, ZipEntryMeta>()
  private readonly lowerEntries = new Map<string, ZipEntryMeta>()
  private readonly textCache = new Map<string, string>()

  constructor(input: Buffer | Uint8Array | ArrayBuffer) {
    if (Buffer.isBuffer(input)) {
      this.buf = input
    } else if (input instanceof Uint8Array) {
      this.buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
    } else {
      this.buf = Buffer.from(input)
    }
    this.parseArchive()
  }

  /** 判断输入缓冲区是否具有 ZIP 魔数 (`PK\x03\x04` 或空包 `PK\x05\x06`) */
  static isZipBuffer(input: Buffer | Uint8Array): boolean {
    if (input.byteLength < 4) return false
    return (
      input[0] === 0x50 &&
      input[1] === 0x4b &&
      ((input[2] === 0x03 && input[3] === 0x04) || (input[2] === 0x05 && input[3] === 0x06))
    )
  }

  private normalizeEntryName(name: string): string {
    return name.replace(/\\/g, '/').replace(/^\/+/, '')
  }

  private parseArchive(): void {
    if (this.buf.length < 22) {
      throw new Error('无效的 OOXML ZIP 容器：文件长度不足')
    }

    // 从末尾向前扫描 End of Central Directory (EOCD)
    const minEocdOffset = Math.max(0, this.buf.length - 65557)
    let eocdOffset = -1
    for (let i = this.buf.length - 22; i >= minEocdOffset; i--) {
      if (this.buf.readUInt32LE(i) === EOCD_SIGNATURE) {
        eocdOffset = i
        break
      }
    }

    if (eocdOffset === -1) {
      throw new Error('无效的 OOXML ZIP 容器：未找到中央目录结束标记 (EOCD)')
    }

    const totalEntries = this.buf.readUInt16LE(eocdOffset + 10)
    const centralDirSize = this.buf.readUInt32LE(eocdOffset + 12)
    const centralDirOffset = this.buf.readUInt32LE(eocdOffset + 16)

    let offset = centralDirOffset
    const endOffset = Math.min(this.buf.length, centralDirOffset + centralDirSize)

    for (let i = 0; i < totalEntries && offset + 46 <= endOffset; i++) {
      const sig = this.buf.readUInt32LE(offset)
      if (sig !== CENTRAL_DIR_SIGNATURE) break

      const compressionMethod = this.buf.readUInt16LE(offset + 10)
      const compressedSize = this.buf.readUInt32LE(offset + 20)
      const uncompressedSize = this.buf.readUInt32LE(offset + 24)
      const fileNameLen = this.buf.readUInt16LE(offset + 28)
      const extraFieldLen = this.buf.readUInt16LE(offset + 30)
      const fileCommentLen = this.buf.readUInt16LE(offset + 32)
      const localHeaderOffset = this.buf.readUInt32LE(offset + 42)

      const nameStart = offset + 46
      const rawName = this.buf.toString('utf8', nameStart, nameStart + fileNameLen)
      const normalized = this.normalizeEntryName(rawName)

      const meta: ZipEntryMeta = {
        name: normalized,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      }
      this.entries.set(normalized, meta)
      this.lowerEntries.set(normalized.toLowerCase(), meta)

      offset = nameStart + fileNameLen + extraFieldLen + fileCommentLen
    }
  }

  /** 获取包内所有文件路径列表 */
  listEntries(): string[] {
    return Array.from(this.entries.keys())
  }

  /** 判断指定路径是否存在于包内 */
  has(entryPath: string): boolean {
    const normalized = this.normalizeEntryName(entryPath)
    return this.entries.has(normalized) || this.lowerEntries.has(normalized.toLowerCase())
  }

  /** 读取包内指定路径的解压二进制内容 */
  readBinary(entryPath: string): Buffer | null {
    const normalized = this.normalizeEntryName(entryPath)
    const meta = this.entries.get(normalized) ?? this.lowerEntries.get(normalized.toLowerCase())
    if (!meta) return null

    const lhOffset = meta.localHeaderOffset
    if (lhOffset + 30 > this.buf.length) return null
    if (this.buf.readUInt32LE(lhOffset) !== LOCAL_FILE_HEADER_SIGNATURE) return null

    const fileNameLen = this.buf.readUInt16LE(lhOffset + 26)
    const extraFieldLen = this.buf.readUInt16LE(lhOffset + 28)
    const dataStart = lhOffset + 30 + fileNameLen + extraFieldLen
    const dataEnd = dataStart + meta.compressedSize
    if (dataEnd > this.buf.length) return null

    const rawSlice = this.buf.subarray(dataStart, dataEnd)
    if (meta.compressionMethod === 0) {
      return Buffer.from(rawSlice)
    }
    if (meta.compressionMethod === 8) {
      return inflateRawSync(rawSlice)
    }
    throw new Error(`不支持的 ZIP 压缩算法 (method=${meta.compressionMethod}): ${meta.name}`)
  }

  /** 读取包内指定路径的 UTF-8 文本（带缓存） */
  readText(entryPath: string): string | null {
    const normalized = this.normalizeEntryName(entryPath)
    const cached = this.textCache.get(normalized)
    if (cached !== undefined) return cached

    const bin = this.readBinary(normalized)
    if (!bin) return null
    // 移除可能的 UTF-8 BOM
    const text = bin.toString('utf8').replace(/^\uFEFF/, '')
    this.textCache.set(normalized, text)
    return text
  }

  /** 读取并解析 XML 文档节点 */
  readXml(entryPath: string): XmlElement | null {
    const text = this.readText(entryPath)
    if (!text) return null
    return parseXmlDocument(text)
  }
}

// ─── OOXML 格式嗅探与关系（.rels）解析 ───

/**
 * 从 OOXML 容器内容自动嗅探真实格式（兼容 `.docm/.dotx/.xlsm/.ppsx` 等变体扩展名）。
 */
export function detectOfficeFormatFromZip(
  zip: OoxmlZipReader,
  fallbackFormat?: OfficeFormat,
): OfficeFormat {
  if (zip.has('word/document.xml')) return 'docx'
  if (zip.has('xl/workbook.xml')) return 'xlsx'
  if (zip.has('ppt/presentation.xml')) return 'pptx'

  const contentTypes = zip.readText('[Content_Types].xml') ?? ''
  if (contentTypes.includes('wordprocessingml')) return 'docx'
  if (contentTypes.includes('spreadsheetml')) return 'xlsx'
  if (contentTypes.includes('presentationml')) return 'pptx'

  return fallbackFormat ?? 'docx'
}

export interface OoxmlRelationship {
  id: string
  type: string
  target: string
  targetMode?: string
}

/**
 * 解析 `.rels` 关系文件，将相对路径归一化为包内根路径（如 `word/media/image1.png`）。
 */
export function parseOoxmlRelationships(
  zip: OoxmlZipReader,
  relsPath: string,
  baseDir: string,
): Map<string, OoxmlRelationship> {
  const map = new Map<string, OoxmlRelationship>()
  const root = zip.readXml(relsPath)
  if (!root) return map

  const relNodes = findElements(root, 'Relationship')
  for (const node of relNodes) {
    const id = getAttr(node, 'Id')
    const target = getAttr(node, 'Target')
    const type = getAttr(node, 'Type') ?? ''
    const targetMode = getAttr(node, 'TargetMode')
    if (!id || !target) continue

    let resolvedTarget = target.replace(/\\/g, '/')
    if (targetMode !== 'External') {
      if (resolvedTarget.startsWith('/')) {
        resolvedTarget = resolvedTarget.replace(/^\/+/, '')
      } else {
        resolvedTarget = pathPosix.normalize(
          baseDir ? pathPosix.join(baseDir, resolvedTarget) : resolvedTarget,
        )
      }
    }
    map.set(id, { id, type, target: resolvedTarget, targetMode })
  }

  return map
}

/**
 * 提取 `docProps/core.xml` 中的文档标题与作者信息。
 */
export function parseCoreMetadata(zip: OoxmlZipReader): { title?: string; author?: string } {
  const coreRoot = zip.readXml('docProps/core.xml')
  if (!coreRoot) return {}

  const titleNode = findFirstElement(coreRoot, 'title')
  const creatorNode = findFirstElement(coreRoot, 'creator')
  const title = titleNode ? getTextContent(titleNode).trim() : ''
  const author = creatorNode ? getTextContent(creatorNode).trim() : ''

  return {
    ...(title ? { title } : {}),
    ...(author ? { author } : {}),
  }
}

// ─── 轻量级命名空间感知 XML 解析器 ───

export interface XmlElement {
  /** 原始标签名，如 `w:p`、`a:xfrm` */
  tag: string
  /** 剥离命名空间前缀后的本地名，如 `p`、`xfrm` */
  localName: string
  /** 属性表（保留原始键名如 `w:val`、`r:id`） */
  attrs: Record<string, string>
  /** 有序子节点列表（元素节点或文本字符串） */
  children: Array<XmlElement | string>
}

const XML_ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

/** 解码 XML 实体（含十进制 `&#123;` 与十六进制 `&#x1F600;`） */
export function decodeXmlEntities(raw: string): string {
  if (!raw || !raw.includes('&')) return raw
  return raw.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (full, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = parseInt(entity.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : full
    }
    if (entity.startsWith('#')) {
      const code = parseInt(entity.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : full
    }
    return XML_ENTITY_MAP[entity] ?? full
  })
}

function getLocalTagName(tag: string): string {
  const colonIdx = tag.indexOf(':')
  return colonIdx >= 0 ? tag.slice(colonIdx + 1) : tag
}

function parseAttributes(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  if (!attrString.trim()) return attrs
  const attrRe = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let m: RegExpExecArray | null
  while ((m = attrRe.exec(attrString)) !== null) {
    const key = m[1]!
    const val = decodeXmlEntities(m[2] ?? m[3] ?? '')
    attrs[key] = val
  }
  return attrs
}

/**
 * 将 XML 字符串解析为树状 `XmlElement`（保留完整子元素与文本顺序）。
 */
export function parseXmlDocument(xml: string): XmlElement {
  const root: XmlElement = {
    tag: '#document',
    localName: '#document',
    attrs: {},
    children: [],
  }
  const stack: XmlElement[] = [root]

  const tokenRe =
    /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<\/([A-Za-z_][\w:.-]*)\s*>|<([A-Za-z_][\w:.-]*)((?:\s+[^<>]*?)?)(\/?)>/g

  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = tokenRe.exec(xml)) !== null) {
    if (match.index > lastIndex) {
      const rawText = xml.slice(lastIndex, match.index)
      // 保留文本节点（若全为空白且不在文本标签内，后续由调用方决定是否忽略）
      if (rawText.length > 0) {
        const parent = stack[stack.length - 1]!
        if (rawText.trim().length > 0 || parent.localName === 't' || parent.attrs['xml:space'] === 'preserve') {
          parent.children.push(decodeXmlEntities(rawText))
        }
      }
    }
    lastIndex = tokenRe.lastIndex

    // CDATA
    if (match[1] !== undefined) {
      stack[stack.length - 1]!.children.push(match[1])
      continue
    }

    // 闭合标签 </tag>
    const closingTag = match[2]
    if (closingTag !== undefined) {
      const closingLocal = getLocalTagName(closingTag)
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i]!.tag === closingTag || stack[i]!.localName === closingLocal) {
          stack.length = i
          break
        }
      }
      continue
    }

    // 开始标签 <tag ...> 或自闭合 <tag .../>
    const openTag = match[3]
    if (openTag !== undefined) {
      const attrPart = match[4] ?? ''
      const selfClosing = match[5] === '/'
      const element: XmlElement = {
        tag: openTag,
        localName: getLocalTagName(openTag),
        attrs: parseAttributes(attrPart),
        children: [],
      }
      stack[stack.length - 1]!.children.push(element)
      if (!selfClosing) {
        stack.push(element)
      }
    }
  }

  return root
}

/**
 * 读取元素属性：同时匹配完整属性名（如 `w:val`）与去前缀属性名（如 `val`）。
 */
export function getAttr(el: XmlElement | null | undefined, name: string): string | undefined {
  if (!el) return undefined
  if (name in el.attrs) return el.attrs[name]
  const localTarget = getLocalTagName(name)
  for (const [k, v] of Object.entries(el.attrs)) {
    if (getLocalTagName(k) === localTarget) return v
  }
  return undefined
}

function unwrapDocumentRoot(el: XmlElement, tagOrLocalName?: string): XmlElement {
  if (el.tag !== '#document') return el
  const firstChildEl = el.children.find((c): c is XmlElement => typeof c !== 'string')
  if (!firstChildEl) return el
  if (tagOrLocalName) {
    const targetLocal = getLocalTagName(tagOrLocalName)
    if (firstChildEl.tag === tagOrLocalName || firstChildEl.localName === targetLocal) {
      return el
    }
  }
  return firstChildEl
}

/** 获取直接子元素列表（可按 localName 或完整 tag 过滤） */
export function getDirectChildren(el: XmlElement | null | undefined, tagOrLocalName?: string): XmlElement[] {
  if (!el) return []
  const target = unwrapDocumentRoot(el, tagOrLocalName)
  const targetLocal = tagOrLocalName ? getLocalTagName(tagOrLocalName) : undefined
  const out: XmlElement[] = []
  for (const child of target.children) {
    if (typeof child === 'string') continue
    if (!tagOrLocalName || child.tag === tagOrLocalName || child.localName === targetLocal) {
      out.push(child)
    }
  }
  return out
}

/** 获取第一个匹配的子元素（仅在直接子节点中查找） */
export function getFirstDirectChild(el: XmlElement | null | undefined, tagOrLocalName: string): XmlElement | null {
  if (!el) return null
  const target = unwrapDocumentRoot(el, tagOrLocalName)
  const targetLocal = getLocalTagName(tagOrLocalName)
  for (const child of target.children) {
    if (typeof child === 'string') continue
    if (child.tag === tagOrLocalName || child.localName === targetLocal) return child
  }
  return null
}

/** 深度优先搜索所有匹配 `tagOrLocalName` 的后代元素 */
export function findElements(root: XmlElement | null | undefined, tagOrLocalName: string): XmlElement[] {
  if (!root) return []
  const targetLocal = getLocalTagName(tagOrLocalName)
  const result: XmlElement[] = []

  function walk(node: XmlElement): void {
    for (const child of node.children) {
      if (typeof child === 'string') continue
      if (child.tag === tagOrLocalName || child.localName === targetLocal) {
        result.push(child)
      }
      walk(child)
    }
  }

  walk(root)
  return result
}

/** 深度优先搜索第一个匹配 `tagOrLocalName` 的后代元素 */
export function findFirstElement(root: XmlElement | null | undefined, tagOrLocalName: string): XmlElement | null {
  if (!root) return null
  const targetLocal = getLocalTagName(tagOrLocalName)

  function walk(node: XmlElement): XmlElement | null {
    for (const child of node.children) {
      if (typeof child === 'string') continue
      if (child.tag === tagOrLocalName || child.localName === targetLocal) {
        return child
      }
      const found = walk(child)
      if (found) return found
    }
    return null
  }

  return walk(root)
}

/** 递归拼接元素内部的所有纯文本节点 */
export function getTextContent(el: XmlElement | null | undefined): string {
  if (!el) return ''
  let out = ''
  for (const child of el.children) {
    if (typeof child === 'string') {
      out += child
    } else {
      out += getTextContent(child)
    }
  }
  return out
}
