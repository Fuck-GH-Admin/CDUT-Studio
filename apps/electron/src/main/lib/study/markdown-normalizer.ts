/**
 * markdown-normalizer.ts — 学习资料本地纯化器（离线 RAG Domain 0：输入纯化）
 *
 * 职责：把 Office / PDF / OCR / 纯文本等异构解析产物，统一规范为「纯净、高可读性」
 * 的 Markdown 纯文本，作为后续统计语义切块与落盘全文的唯一输入源。
 *
 * 设计红线：
 *   - 全流程 100% 本地，不引入任何云端调用；
 *   - 绝不伪造内容：仅在既有文本上做清洗、补全结构标记，不新增/猜测语义；
 *   - 输出标准 Markdown（标题补全 `#`、表格转为 `|` 语法、控制字符与乱码剥离），
 *     确保下游切块引擎能稳定识别 Markdown AST 骨架。
 */

/** 不可见控制字符与 Word 残留乱码（保留 \t \n） */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

/** 中文序号标题正则（第一章 / 第1节 / 第三讲 …） */
const CN_HEADING = /^第\s*[0-9一二三四五六七八九十百零两]+\s*[章节讲篇部]\s*[\s、.．:：]*/
/** 阿拉伯数字多级编号标题正则（1.1 / 2.3.4，至少含一个点号，排除数量词与年份） */
const MULTI_NUM_HEADING = /^(\d+(?:\.\d+)+)(?:\s*[\s、.．:：]\s*|\s+)(?![0-9年月日万亿个条项名人元点%度是为])\S/
/**
 * 阿拉伯数字单级编号标题正则（1. / 2、 / 3: / 1 引言）。
 *
 * 允许单空格分隔，但要求其后标题正文至少 2 个非空白字符，并排除年份 / 数量词 / 常见计量单位，
 * 以防「2023年…」「3.5 万人」「5 分钟」等普通正文被误升格为标题。
 */
const SINGLE_NUM_HEADING = /^([1-9]\d?)(?:[、.．:：]|\s+)\s*(?![0-9年月日万亿个条项名人元点%度是为分秒米克吨页步倍层遍期题张])\S{2,}/

/** 单行是否为 Markdown 标题（已带 # 前缀） */
function isMarkdownHeading(line: string): boolean {
  return /^#{1,6}\s+\S/.test(line)
}

/** 依据文本是否为表格候选行（含制表符或多列双空格分隔） */
function splitColumns(line: string): string[] | null {
  if (line.includes('\t')) {
    return line.split('\t').map((cell) => cell.trim())
  }
  // 以两个及以上空格作为列分隔（Office 复制粘贴常见形态）
  if (/\S {2,}\S/.test(line)) {
    const cells = line.split(/ {2,}/).map((cell) => cell.trim()).filter((cell) => cell.length > 0)
    if (cells.length >= 2) return cells
  }
  return null
}

/** 把连续的表格候选行规范为标准 Markdown 表格 */
function normalizeTables(lines: string[]): string[] {
  const result: string[] = []
  let index = 0
  while (index < lines.length) {
    const columns = splitColumns(lines[index]!)
    if (columns && columns.length >= 2) {
      // 收集连续表格行
      const rows: string[][] = [columns]
      let cursor = index + 1
      while (cursor < lines.length) {
        const nextColumns = splitColumns(lines[cursor]!)
        if (!nextColumns || nextColumns.length < 2) break
        rows.push(nextColumns)
        cursor++
      }
      if (rows.length >= 2) {
        const width = Math.max(...rows.map((row) => row.length))
        const toLine = (row: string[]): string =>
          `| ${Array.from({ length: width }, (_, i) => row[i] ?? '').join(' | ')} |`
        result.push(toLine(rows[0]!))
        result.push(`| ${Array.from({ length: width }, () => '---').join(' | ')} |`)
        for (let r = 1; r < rows.length; r++) result.push(toLine(rows[r]!))
        index = cursor
        continue
      }
    }
    result.push(lines[index]!)
    index++
  }
  return result
}

/** 为乱序/缺失层级的标题行补全标准 `#` 前缀 */
function normalizeHeadings(lines: string[]): string[] {
  return lines.map((line) => {
    const trimmed = line.trim()
    if (!trimmed || isMarkdownHeading(trimmed)) return line
    // 排除以句末标点结尾的普通陈述句
    if (/[。！？；]$/.test(trimmed)) return line
    if (CN_HEADING.test(trimmed)) {
      // 章节级标题统一补为二级标题，避免与文档主标题冲突
      return `## ${trimmed}`
    }
    if (trimmed.length <= 60) {
      const multiMatch = MULTI_NUM_HEADING.exec(trimmed)
      if (multiMatch) {
        const level = Math.min(multiMatch[1]!.split('.').length + 1, 6)
        return `${'#'.repeat(level)} ${trimmed}`
      }
      const singleMatch = SINGLE_NUM_HEADING.exec(trimmed)
      if (singleMatch) {
        return `## ${trimmed}`
      }
    }
    return line
  })
}

/**
 * 把任意解析产物纯化为标准 Markdown 纯文本。
 *
 * @param input 原始文本（来自 Office / PDF / OCR / 纯文本解析）
 * @returns 规范化后的 Markdown 纯文本
 */
export function normalizeToMarkdown(input: string): string {
  if (!input) return ''
  let text = input.replace(/^\uFEFF/, '')
  // 统一换行符并剥离不可见控制字符
  text = text.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '')
  // 去除每行尾部空白
  let lines = text.split('\n').map((line) => line.replace(/[ \t]+$/, ''))

  lines = normalizeTables(lines)
  lines = normalizeHeadings(lines)

  // 折叠连续空白行：最多保留一个空行（即最多连续 2 个换行符）
  const collapsed: string[] = []
  let blankRun = 0
  for (const line of lines) {
    if (line.trim() === '') {
      blankRun++
      if (blankRun > 1) continue
      collapsed.push('')
    } else {
      blankRun = 0
      collapsed.push(line)
    }
  }

  return collapsed.join('\n').trim()
}
