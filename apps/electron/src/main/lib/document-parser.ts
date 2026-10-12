/**
 * 文档解析服务
 *
 * 负责从各类办公文档中提取纯文本内容。
 * 支持的格式：
 * - PDF：使用 @profer/core 下一代非自回归高精解析引擎（分栏感知/表格重构/公式/TrapDoc 防御）
 * - DOC/WPS：使用 word-extractor 提取文本（旧版 Word/WPS Writer）
 * - DOCX/XLSX/PPTX/ODP/ODS/ODT 及宏/模板变体：使用 mammoth/officeparser 提取文本
 * - RTF：使用内置的 brace 感知解析器提取文本
 * - TXT/MD/CSV/JSON/XML/HTML/JS/TS/PY 等：直接 UTF-8 读取
 */

import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { resolveAttachmentPath } from './config-paths'

// ===== 文件类型分类 =====

/** officeparser 支持的格式 */
const OFFICE_EXTENSIONS = new Set([
  '.docx', '.xlsx', '.pptx',
  '.odt', '.odp', '.ods',
  '.docm', '.dotx', '.dotm',
  '.xlsm', '.xltx', '.xltm',
  '.pptm', '.potx', '.potm', '.ppsx', '.ppsm',
])

/** 旧版 Word/WPS Writer 格式 */
const LEGACY_WORD_EXTENSIONS = new Set([
  '.doc', '.dot', '.wps', '.wpt',
])

/** WPS 原生表格/演示格式：尽量交给 Office 解析器尝试 */
const WPS_OFFICE_EXTENSIONS = new Set([
  '.et', '.ett', '.dps', '.dpt',
])

/** RTF 文档 */
const RICH_TEXT_EXTENSIONS = new Set([
  '.rtf',
])

/** 纯文本格式（直接 UTF-8 读取） */
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.json', '.xml', '.html',
  '.js', '.ts', '.py', '.yaml', '.yml', '.toml',
  '.log', '.ini', '.cfg', '.conf', '.sh', '.bat',
  '.css', '.scss', '.less', '.sql', '.graphql',
  '.env', '.gitignore', '.dockerfile',
])

/** 所有支持文档解析的扩展名（不含图片） */
const SUPPORTED_DOCUMENT_EXTENSIONS = new Set([
  '.pdf',
  ...OFFICE_EXTENSIONS,
  ...LEGACY_WORD_EXTENSIONS,
  ...WPS_OFFICE_EXTENSIONS,
  ...RICH_TEXT_EXTENSIONS,
  ...TEXT_EXTENSIONS,
])

/**
 * 判断文件扩展名是否支持文本提取
 *
 * @param ext 文件扩展名（含点号，如 '.pdf'）
 */
export function isSupportedDocumentExtension(ext: string): boolean {
  return SUPPORTED_DOCUMENT_EXTENSIONS.has(ext.toLowerCase())
}

/**
 * 根据 MIME 类型判断是否为可解析文档（非图片附件）
 *
 * 排除图片类型，其余尝试按扩展名判断。
 */
export function isDocumentAttachment(mediaType: string): boolean {
  return !mediaType.startsWith('image/')
}

/**
 * 从文件中提取纯文本内容
 *
 * 根据文件扩展名选择合适的解析器：
 * - .pdf → @profer/core 下一代高精解析引擎（唯一路径）
 * - .doc/.dot/.wps/.wpt → word-extractor
 * - .docx/.xlsx/.pptx/.odt/.odp/.ods 等 → mammoth/officeparser
 * - .txt/.md/... → 直接 UTF-8 读取
 *
 * @param filePath 文件的完整路径
 * @returns 提取的纯文本内容
 * @throws 不支持的格式或解析失败时抛出错误
 */
export async function extractTextFromFile(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase()

  // PDF 文件
  if (ext === '.pdf') {
    return extractPdf(filePath)
  }

  // 旧版 Word/WPS Writer 文件
  if (LEGACY_WORD_EXTENSIONS.has(ext)) {
    return extractLegacyWord(filePath)
  }

  // Office 和 OpenDocument 格式
  if (OFFICE_EXTENSIONS.has(ext)) {
    return extractOffice(filePath)
  }

  // WPS 原生表格/演示格式
  if (WPS_OFFICE_EXTENSIONS.has(ext)) {
    return extractWpsOffice(filePath)
  }

  // 富文本格式（RTF 不是 OOXML，单独解析）
  if (RICH_TEXT_EXTENSIONS.has(ext)) {
    return extractRichText(filePath)
  }

  // 纯文本格式
  if (TEXT_EXTENSIONS.has(ext)) {
    return readFileSync(filePath, 'utf-8')
  }

  // 未知格式：尝试当作文本读取
  console.warn(`[文档解析] 未知格式 ${ext}，尝试作为文本读取: ${filePath}`)
  return readFileSync(filePath, 'utf-8')
}

/**
 * 提取 PDF 文本
 *
 * 唯一路径：@profer/core 的下一代非自回归高精解析引擎（分栏感知、表格重构、
 * 行间公式、TrapDoc 幽灵字符防御），产出高保真学术 Markdown。
 * 引擎异常向上抛出，由调用方如实标记解析失败；无文本层（扫描件）返回空串。
 */
async function extractPdf(filePath: string): Promise<string> {
  const buffer = readFileSync(filePath)
  const { parsePdfDocument } = await import('@profer/core/pdf-engine')
  const layoutAst = await parsePdfDocument(buffer, { fileName: basename(filePath) })
  console.log(
    `[文档解析] PDF 高精解析完成: ${layoutAst.pageCount} 页, `
    + `${layoutAst.readingOrderedBlocks.length} 块, 拦截幽灵字符 ${layoutAst.metrics.trapDocFilteredCount}`,
  )
  return layoutAst.markdown
}

/**
 * 提取旧版 Word/WPS Writer 文本
 */
async function extractLegacyWord(filePath: string): Promise<string> {
  const WordExtractor = (await import('word-extractor')).default
  const extractor = new WordExtractor()
  const extracted = await extractor.extract(filePath)
  const text = extracted.getBody()
  console.log(`[文档解析] 旧版 Word/WPS 提取完成: ${text.length} 字符`)
  return text
}

/**
 * 提取 Office/OpenDocument 文本（DOCX, XLSX, PPTX, ODT, ODP, ODS 及宏/模板变体）
 *
 * 统一使用 `@profer/core/office-engine` 双平面流式重排引擎按 ZIP 包内容自动嗅探并解析，
 * 零外部 mammoth/officeparser 依赖，支持全部宏启用（.docm/.xlsm/.pptm）、模板（.dotx/.xltx/.potx）与放映（.ppsx/.ppsm）变体。
 */
async function extractOffice(filePath: string): Promise<string> {
  const buffer = readFileSync(filePath)
  const {
    OoxmlZipReader,
    parseOfficeBuffer,
    findElements,
    getTextContent,
  } = await import('@profer/core/office-engine')

  if (!OoxmlZipReader.isZipBuffer(buffer)) {
    return extractLegacyWord(filePath)
  }

  const zip = new OoxmlZipReader(buffer)
  // 兼容 OpenDocument (.odt / .odp / .ods)
  if (zip.has('content.xml') && !zip.has('word/document.xml') && !zip.has('xl/workbook.xml') && !zip.has('ppt/presentation.xml')) {
    const contentRoot = zip.readXml('content.xml')
    const paragraphs = contentRoot
      ? findElements(contentRoot, 'p')
          .map((p) => getTextContent(p).trim())
          .filter(Boolean)
      : []
    const text = paragraphs.join('\n\n')
    console.log(`[文档解析] OpenDocument 提取完成: ${text.length} 字符`)
    return text
  }

  const ext = extname(filePath).toLowerCase()
  const result = parseOfficeBuffer(buffer, ext, {
    fileName: basename(filePath),
    includeAnchors: false,
  })
  console.log(
    `[文档解析] Office 双平面引擎解析完成 (${result.format}): ${result.ast.pageCount} 页/表, ${result.cleanMarkdown.length} 字符`,
  )
  return result.cleanMarkdown
}

/**
 * 提取 WPS 原生表格/演示文本
 */
async function extractWpsOffice(filePath: string): Promise<string> {
  try {
    return await extractOffice(filePath)
  } catch (error) {
    const ext = extname(filePath).toLowerCase()
    console.warn(`[文档解析] WPS 原生格式提取失败: ${filePath}`, error)
    throw new Error(`暂不支持解析 ${ext} 原生格式，请在 WPS 中另存为 DOCX/XLSX/PPTX 或 PDF 后重试`)
  }
}

/**
 * 提取 RTF 富文本
 *
 * RTF 不是 OOXML zip，officeparser/mammoth 都无法解析。这里用一个轻量的
 * brace 感知解析器：跳过字体表/颜色表/样式表等控制性分组，仅保留正文，
 * 并把 \par \line \tab 等转成对应的空白字符。无需引入额外依赖。
 */
async function extractRichText(filePath: string): Promise<string> {
  const raw = readFileSync(filePath, 'latin1')
  const text = parseRtf(raw)
  if (!text.trim()) {
    throw new Error('RTF 文档解析后内容为空，请在编辑器中另存为 DOCX 或 PDF 后重试')
  }
  console.log(`[文档解析] RTF 提取完成: ${text.length} 字符`)
  return text
}

/** 这些控制性分组（destination）只含元数据，不属于正文，整段跳过 */
const RTF_SKIP_DESTINATIONS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object',
  'themedata', 'colorschememapping', 'latentstyles', 'datastore',
  'generator', 'listtable', 'listoverridetable', 'rsidtbl',
  'mmathPr', 'wgrffmtfilter', 'xmlnstbl', 'fldinst',
])

/**
 * 把 RTF 源串解析为纯文本。
 *
 * 逐字符扫描，用 depth 跟踪分组层级；遇到 \*\<dest> 或已知的控制性
 * destination 时记录其所在层级，跳过该层级内的所有内容直到分组闭合。
 */
function parseRtf(rtf: string): string {
  let out = ''
  let depth = 0
  // 当前 skip 分组的起始 brace 层级；-1 表示未处于 skip 状态。
  // 用单一值而非计数栈：一旦进入 skip，就忽略其内部所有重复的 skip 标记
  // （例如 `{\*\generator ...}` 中 `\*` 与已知 destination `\generator` 会
  // 各想标记一次），直到引发 skip 的那个分组闭合才解除——从根上避免“多次
  // 标记、单次解除”导致的 skip 状态泄漏（会吞掉其后全部正文）。
  let skipDepth = -1
  // \ucN 指定每个 \uN 之后需要跳过的回退字符数，默认 1。
  let uc = 1
  let i = 0

  const isSkipping = () => skipDepth >= 0

  // 跳过 \uN 之后的 uc 个回退 token（一个 \'xx、一个转义字符或一个普通字符各算一个）
  const skipUnicodeFallback = () => {
    if (rtf[i] === ' ') i++ // 控制字与回退字符间的分隔空格
    let remaining = uc
    while (remaining > 0 && i < rtf.length) {
      if (rtf[i] === '{' || rtf[i] === '}') break // 不吞分组定界符
      if (rtf[i] === '\\' && rtf[i + 1] === '\'') i += 4 // \'xx
      else if (rtf[i] === '\\' && (rtf[i + 1] === '{' || rtf[i + 1] === '}' || rtf[i + 1] === '\\')) i += 2
      else i += 1
      remaining--
    }
  }

  while (i < rtf.length) {
    const ch = rtf[i]

    if (ch === '{') {
      depth++
      i++
      continue
    }

    if (ch === '}') {
      depth--
      // 退出引发 skip 的分组层级时解除 skip
      if (isSkipping() && depth < skipDepth) skipDepth = -1
      i++
      continue
    }

    if (ch === '\\') {
      const next = rtf[i + 1]

      // 转义字符 \{ \} \\
      if (next === '{' || next === '}' || next === '\\') {
        if (!isSkipping()) out += next
        i += 2
        continue
      }

      // \* 标记当前分组为可忽略的 destination（仅在尚未 skip 时记录层级）
      if (next === '*') {
        if (!isSkipping()) skipDepth = depth
        i += 2
        continue
      }

      // \uN 或 \uN- ：Unicode 字符（后跟 uc 个回退字符）
      const uMatch = /^\\u(-?\d+)/.exec(rtf.slice(i))
      if (uMatch) {
        if (!isSkipping()) {
          let code = parseInt(uMatch[1]!, 10)
          if (code < 0) code += 65536
          out += String.fromCharCode(code)
        }
        i += uMatch[0].length
        skipUnicodeFallback()
        continue
      }

      // \'xx ：单字节十六进制字符
      const hexMatch = /^\\'([0-9a-fA-F]{2})/.exec(rtf.slice(i))
      if (hexMatch) {
        if (!isSkipping()) out += String.fromCharCode(parseInt(hexMatch[1]!, 16))
        i += hexMatch[0].length
        continue
      }

      // 普通控制字：\word 后可跟可选数字参数，再跟可选的一个空格分隔符
      const wordMatch = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i))
      if (wordMatch) {
        const word = wordMatch[1]!
        if (word === 'uc') {
          // 即便处于 skip 状态也要跟踪 uc，确保退出 skip 后回退跳过仍准确
          const n = parseInt(wordMatch[2] ?? '1', 10)
          if (!Number.isNaN(n) && n >= 0) uc = n
        } else if (RTF_SKIP_DESTINATIONS.has(word)) {
          if (!isSkipping()) skipDepth = depth
        } else if (!isSkipping()) {
          if (word === 'par' || word === 'pard' || word === 'line' || word === 'sect' || word === 'page') {
            out += '\n'
          } else if (word === 'tab' || word === 'cell') {
            out += '\t'
          } else if (word === 'row' || word === 'trowd') {
            out += '\n'
          }
        }
        i += wordMatch[0].length
        continue
      }

      // 落单的反斜杠
      i++
      continue
    }

    // 普通字符
    if (!isSkipping()) {
      if (ch === '\n' || ch === '\r') {
        // RTF 源里的裸换行无意义，忽略
      } else {
        out += ch
      }
    }
    i++
  }

  return out
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/**
 * 从附件相对路径提取文本（IPC 层使用）
 *
 * 将附件的 localPath（如 {conversationId}/{uuid}.ext）
 * 解析为完整路径后提取文本。
 *
 * @param localPath 附件相对路径
 * @returns 提取的纯文本内容
 */
export async function extractTextFromAttachment(localPath: string): Promise<string> {
  const fullPath = resolveAttachmentPath(localPath)
  return extractTextFromFile(fullPath)
}

