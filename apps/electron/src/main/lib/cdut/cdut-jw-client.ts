/**
 * CDUT 青果教务系统底层客户端（jw.cdut.edu.cn/jsxsd）
 *
 * 职责：
 *   - 基于青果教务底层 HTTP 规范实现统一请求器（GET/POST，经专属分区 Session 携带 Cookie）；
 *   - 使用 Cheerio 解析传统 HTML 嵌套表格，清洗为「精简 Markdown 表格 + 结构化 JSON」双模结果；
 *   - 封装 8 大业务域执行器（学籍/课表/成绩/考务/教室/培养方案/选课/通知）。
 *
 * 范围声明（如实标注，不做过度承诺）：
 *   - 本模块仅负责发起 HTTP 与解析，不持有明文密码、不嗅探 Cookie；
 *   - 写操作（报名、选退课、改密等）是否放行由上游 Pi Tool 层二次确认拦截决定，
 *     本模块仅在收到调用后忠实执行 POST，不自行判定权限。
 */

import type { Session } from 'electron'
import { load } from 'cheerio'
import type { CheerioAPI } from 'cheerio'
import type {
  CdutAcademicProfileParams,
  CdutClassroomParams,
  CdutCourseSelectionParams,
  CdutCurriculumPlanParams,
  CdutDomainToolResult,
  CdutExamAffairsParams,
  CdutGradesParams,
  CdutNoticesParams,
  CdutScheduleParams,
  CdutToolDomain,
  CdutToolParamsMap,
} from '@profer/shared'
import { stripStaleRuiShuCookies } from './yanhu/yanhu-cookie-utils'

/** 青果教务系统站点根 */
const JW_BASE = 'https://jw.cdut.edu.cn'
/** 青果教务系统应用根（所有业务端点均挂载其下） */
const JW_ROOT = `${JW_BASE}/jsxsd`
/** 默认 Referer，规避部分端点的同源校验 */
const JW_REFERER = `${JW_ROOT}/framework/xsMainV.htmlx`

// ===== 通用文本与表格工具 =====

/** 归一化文本：去 NBSP、折叠空白并裁剪两端 */
function cleanText(input: string | undefined | null): string {
  if (!input) return ''
  return input.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
}

/** 去除 HTML 标签并解码常见实体（用于 <br> 分片文本） */
function stripTags(html: string): string {
  return cleanText(
    html
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'"),
  )
}

/** 从字符串中提取首个数字 */
function parseNumber(input: string | undefined): number | undefined {
  if (!input) return undefined
  const m = input.match(/-?\d+(?:\.\d+)?/)
  if (!m) return undefined
  const n = Number(m[0])
  return Number.isFinite(n) ? n : undefined
}

/** 转义 Markdown 表格单元格内的竖线与换行 */
function mdCell(value: string): string {
  return cleanText(value).replace(/\|/g, '\\|')
}

/** 构造 Markdown 表格 */
function mdTable(headers: string[], rows: string[][]): string {
  if (headers.length === 0) return ''
  const head = `| ${headers.map(mdCell).join(' | ')} |`
  const sep = `| ${headers.map(() => ':---').join(' | ')} |`
  const body = rows.map((r) => `| ${r.map(mdCell).join(' | ')} |`).join('\n')
  return body ? `${head}\n${sep}\n${body}` : `${head}\n${sep}`
}

/** 成功结果：Markdown 正文 + 底部结构化 JSON 代码块 */
function buildResult(markdown: string, json?: unknown, mutated = false): CdutDomainToolResult {
  const jsonBlock =
    json === undefined ? '' : `\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\``
  return { success: true, markdown: `${markdown}${jsonBlock}`, json, mutated }
}

/** 失败结果 */
function errorResult(error: string): CdutDomainToolResult {
  return { success: false, markdown: `> ⚠️ ${error}`, error }
}

/** 会话失效的统一提示 */
function expiredResult(): CdutDomainToolResult {
  return {
    success: false,
    markdown: '> ⚠️ 特区账户登录态已失效，请先在「CDUT 专区」重新登录后再试。',
    error: 'CDUT 特区账户未登录或会话已失效',
  }
}

/** 将未知异常转为可读文案 */
function networkError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ===== 统一请求器（经专属分区 Session 携带 Cookie） =====

interface JwFetchOptions {
  method?: 'GET' | 'POST'
  /** URL 查询参数（自动忽略 undefined / 空值） */
  query?: Record<string, string | number | undefined>
  /** POST 表单参数 */
  form?: Record<string, string | number | undefined>
  /** 自定义 Referer，默认教务主页 */
  referer?: string
}

interface JwFetchResult {
  ok: boolean
  status: number
  html: string
  finalUrl: string
  /** 是否被重定向回统一身份认证（判定登录态失效） */
  expired: boolean
}

/** 判定落点是否已回落到统一身份认证登录页 */
function isSessionExpired(finalUrl: string, html: string): boolean {
  try {
    const u = new URL(finalUrl)
    if (u.hostname === 'cas.paas.cdut.edu.cn') return true
    if (u.pathname.toLowerCase().includes('/cas/login')) return true
  } catch {
    // finalUrl 非法时忽略，继续做正文特征判断
  }
  return html.includes('统一身份认证') && /name=["']password["']/i.test(html)
}

/**
 * 清理专属分区中导致青果瑞数 WAF 误判并拒绝连接（HTTP 400）的陈旧动态签名 Cookie。
 *
 * 实现已抽取至 `yanhu/yanhu-cookie-utils.ts`，供智联万站浏览器与教务客户端共用，
 * 避免同一安全策略出现多份实现。此处保持同名再导出，默认目标域语义（jw.cdut.edu.cn）不变。
 */
export { stripStaleRuiShuCookies }

/**
 * 发起一次教务请求并返回原始 HTML。
 * 必须使用传入的专属分区 Session（net.fetch 恒走默认分区，无法携带本分区 Cookie）。
 */
async function fetchJwPage(
  ses: Session,
  path: string,
  options: JwFetchOptions = {},
): Promise<JwFetchResult> {
  const fullUrl = path.startsWith('http') ? path : `${JW_ROOT}${path}`
  const url = new URL(fullUrl)
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value === undefined || value === null || `${value}` === '') continue
      url.searchParams.set(key, String(value))
    }
  }

  // 关键防御：剔除陈旧的瑞数 P 动态签名，彻底杜绝网关 HTTP 400 阻断
  await stripStaleRuiShuCookies(ses)

  const headers: Record<string, string> = {
    Referer: options.referer ?? JW_REFERER,
    'User-Agent': ses.getUserAgent(),
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  }
  let body: string | undefined
  if (options.method === 'POST') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(options.form ?? {})) {
      if (value === undefined || value === null) continue
      params.set(key, String(value))
    }
    body = params.toString()
  }

  const res = await ses.fetch(url.toString(), {
    method: options.method ?? 'GET',
    headers,
    body,
    redirect: 'follow',
  })
  const html = await res.text()
  const finalUrl = res.url || url.toString()
  // 显式记录失败请求（此前 !res.ok 被静默吞没，导致画像抓取落空却无从排查）
  if (!res.ok) {
    console.warn(
      '[CdutJw] 教务请求未成功:',
      url.toString(),
      'HTTP',
      res.status,
      '响应片段:',
      cleanText(html).slice(0, 160),
    )
  }
  return {
    ok: res.ok,
    status: res.status,
    html,
    finalUrl,
    expired: isSessionExpired(finalUrl, html),
  }
}

/** 常见图片魔数嗅探，避免把服务端返回的 HTML / 登录页误当证件照落盘 */
function isImageBuffer(buffer: Buffer): boolean {
  if (buffer.length < 4) return false
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true // JPEG
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return true // PNG
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return true // GIF
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return true // BMP
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  )
    return true // WEBP
  return false
}

/**
 * 将图片（相对/绝对地址）经专属分区 Session 下载并转为 Base64 DataURL。
 * @param baseUrl 图片所在页面的最终 URL；相对路径（含 ../ 形式）一律按此基准解析，
 *                避免固定拼接 JW_ROOT 造成的路径错位（证件照 404 或落回登录页）。
 */
export async function fetchImageAsBase64(
  ses: Session,
  imageUrl: string,
  baseUrl?: string,
): Promise<string | undefined> {
  if (!imageUrl) return undefined

  let absolute: string
  try {
    absolute = new URL(imageUrl, baseUrl ?? JW_REFERER).toString()
  } catch {
    return undefined
  }

  try {
    await stripStaleRuiShuCookies(ses)
    const res = await ses.fetch(absolute, {
      headers: { Referer: baseUrl ?? JW_REFERER },
      redirect: 'follow',
    })
    if (!res.ok) {
      console.warn('[CdutJw] 证件照下载失败: HTTP', res.status, absolute)
      return undefined
    }
    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.length === 0 || !isImageBuffer(buffer)) {
      console.warn('[CdutJw] 证件照响应非图片（长度', buffer.length, '），已忽略:', absolute)
      return undefined
    }
    const rawMime = (res.headers.get('content-type') || '').split(';')[0]?.trim() || ''
    const mime = rawMime.startsWith('image/') ? rawMime : 'image/jpeg'
    console.log('[CdutJw] 证件照下载成功:', absolute, mime, buffer.length, 'bytes')
    return `data:${mime};base64,${buffer.toString('base64')}`
  } catch (err) {
    console.warn('[CdutJw] 证件照下载异常:', absolute, err)
    return undefined
  }
}

// ===== HTML 表格与字段解析工具 =====

/**
 * 虚拟网格（Virtual Grid）表格解析引擎。
 * 针对青果教务系统广泛出现的 rowspan 和 colspan：
 * 采用 2D 坐标投影槽位填充，杜绝后续行单元格因跨行跨列发生索引错位或内容左移。
 */
function parseTableToGrid($table: ReturnType<CheerioAPI>, $: CheerioAPI): string[][] {
  const grid: string[][] = []

  $table.find('tr').each((rIdx, tr) => {
    const currentRow = grid[rIdx] ?? (grid[rIdx] = [])
    let cIdx = 0

    $(tr)
      .find('th, td')
      .each((_, cell) => {
        // 寻找当前行第一个未被上一行 rowspan 占用的列槽位
        while (currentRow[cIdx] !== undefined) {
          cIdx++
        }

        const text = cleanText($(cell).text())
        const rowspan = parseInt($(cell).attr('rowspan') || '1', 10) || 1
        const colspan = parseInt($(cell).attr('colspan') || '1', 10) || 1

        for (let r = 0; r < rowspan; r++) {
          const targetR = rIdx + r
          const row = grid[targetR] ?? (grid[targetR] = [])
          for (let c = 0; c < colspan; c++) {
            row[cIdx + c] = text
          }
        }
        cIdx += colspan
      })
  })

  return grid.filter((row) => row && row.some((c) => c && c.trim() !== ''))
}

/** 将整份 HTML 的某张表解析为二维文本矩阵（单元格内 <br> 折叠为空格，支持跨行跨列对齐） */
function parseTable(html: string, selector?: string): string[][] {
  const $ = load(html)
  const target = selector ? $(selector).first() : $('table').first()
  return parseTableToGrid(target, $)
}

/** 页面上所有表格（按出现顺序）的二维矩阵数组 */
function parseAllTables(html: string): string[][][] {
  const $ = load(html)
  const tables: string[][][] = []
  $('table').each((_, table) => {
    const grid = parseTableToGrid($(table), $)
    if (grid.length > 0) tables.push(grid)
  })
  return tables
}

/** 选取行数最多的一张表（多数列表页的主数据表） */
function parseLargestTable(html: string): { headers: string[]; rows: string[][] } {
  const tables = parseAllTables(html)
  let best: string[][] = []
  for (const t of tables) {
    if (t.length > best.length) best = t
  }
  const [headerRow, ...body] = best
  const headers = headerRow ?? []
  return { headers, rows: body }
}

/** 按表头名（容错包含匹配）取字段值 */
function pickField(obj: Record<string, string>, candidates: string[]): string {
  for (const key of Object.keys(obj)) {
    const normalized = key.replace(/\s+/g, '')
    for (const cand of candidates) {
      if (normalized.includes(cand)) return obj[key] ?? ''
    }
  }
  return ''
}

/** 将二维矩阵按首行表头转成对象数组 */
function rowsToObjects(
  headers: string[],
  rows: string[][],
): Record<string, string>[] {
  return rows.map((cells) => {
    const obj: Record<string, string> = {}
    headers.forEach((header, idx) => {
      obj[header] = cells[idx] ?? ''
    })
    return obj
  })
}

/** 解析列表型页面（无表格时的 ul/li 兜底）：返回 [标题, 日期] 二元组 */
function parseListItems(html: string): { title: string; href: string; date: string }[] {
  const $ = load(html)
  const items: { title: string; href: string; date: string }[] = []
  $('ul li a, .list li a, .news-list a').each((_, a) => {
    const $a = $(a)
    const title = cleanText($a.attr('title') || $a.text())
    if (!title) return
    const parentText = cleanText($a.closest('li').text())
    const dateMatch = parentText.match(/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/)
    items.push({ title, href: cleanText($a.attr('href')), date: dateMatch ? dateMatch[0] : '' })
  })
  return items
}

/**
 * 拆分「标签：值」型单元格文本。
 * 纯数字标签（如时间 "08:00"）视为值，不拆分，避免把时间误判为标签。
 */
function splitLabelValue(text: string): { label: string; value: string } | null {
  const m = text.match(/^([^:：]{1,16})[:：]\s*([\s\S]*)$/)
  if (!m) return null
  const label = (m[1] ?? '').trim()
  if (!label || /^\d+$/.test(label)) return null
  return { label, value: (m[2] ?? '').trim() }
}

/**
 * 解析「标签: 值」型学籍页表格为键值映射。
 * 兼容青果两种常见版式：
 *   1. 标签与值分列：<td>学院：</td><td>地球物理学院</td>；
 *   2. 标签与值同格：<td>学院：地球物理学院</td><td>专业：工程管理</td>。
 * 若仍按「相邻两格为一组」硬配对，版式 2 会把下一格的「专业：工程管理」
 * 错当成「学院」的值（历史 Bug：学院显示为“专业：工程管理”）。
 */
function parseKeyValueRows(html: string): Record<string, string> {
  const $ = load(html)
  const map: Record<string, string> = {}

  const register = (key: string, value: string): void => {
    const k = cleanText(key).replace(/[:：]\s*$/, '')
    if (!k || Object.prototype.hasOwnProperty.call(map, k)) return
    map[k] = cleanText(value)
  }

  $('table tr').each((_, tr) => {
    const texts = $(tr)
      .find('td, th')
      .toArray()
      .map((cell) => {
        const $cell = $(cell)
        // 青果学籍页大量字段为只读表单项（<input readonly> / <select> / <textarea>），
        // 纯 text() 会得到空串，故优先读取控件的当前值，取不到再退回单元格文本。
        const $control = $cell.find('input, select, textarea').first()
        if ($control.length > 0) {
          const tag = ($control.prop('tagName') ?? '').toString().toLowerCase()
          const rawValue = $control.val()
          const controlValue = typeof rawValue === 'string' ? rawValue : undefined
          if (tag === 'select') {
            const selectedText = cleanText($control.find('option:selected').text())
            const resolved = selectedText || cleanText(controlValue)
            if (resolved) return resolved
          } else if (tag === 'textarea') {
            const resolved = cleanText($control.text()) || cleanText(controlValue)
            if (resolved) return resolved
          } else {
            const resolved = cleanText($control.attr('value')) || cleanText(controlValue)
            if (resolved) return resolved
          }
        }
        return cleanText($cell.text())
      })

    let i = 0
    while (i < texts.length) {
      const current = texts[i] ?? ''
      if (!current) {
        i++
        continue
      }

      const split = splitLabelValue(current)
      if (split && split.value) {
        // 同格「标签：值」，直接登记
        register(split.label, split.value)
        i++
        continue
      }
      if (split) {
        // 纯标签：值在下一格；若下一格本身是「标签：值」，则本标签留空以防错位
        const next = texts[i + 1]
        if (next !== undefined && next !== '' && !splitLabelValue(next)) {
          register(split.label, next)
          i += 2
          continue
        }
        i++
        continue
      }

      // 无冒号：退回原始「相邻两格为一组」的标签/值配对
      register(current, texts[i + 1] ?? '')
      i += 2
    }
  })
  return map
}

/** 排除站点图标 / 占位图，避免把 logo、空白图或二维码误认成证件照 */
function isPlaceholderPhoto(src: string): boolean {
  return /logo|icon|banner|bg|arrow|blank|btn|nophoto|no-photo|no_photo|default|placeholder|qrcode|erweima|loading|spacer|shadow/i.test(
    src,
  )
}

/** 从学籍页提取证件照地址（优先青果证件照容器，兜底全图扫描并排除站点图标） */
export function extractProfilePhotoUrl(html: string): string {
  const $ = load(html)

  // 1) 优先命中青果常见证件照元素：id / class / src 关键字
  const selectors = [
    'img#xjkp',
    '#xjkp img',
    'img[id*="xjkp"]',
    '#xsxxPhoto img',
    '#xsxxPhoto',
    '.xsxxPhoto img',
    '.xsxxPhoto',
    'img#zp',
    'img#xszp',
    'img#pic',
    'img#photo',
    'img[id*="zp"]',
    'img[name*="zp"]',
    'img[id*="photo"]',
    'img[name*="photo"]',
    'img[src*="xjkp"]',
    'img[src*="xsxx"]',
    'img[src*="grxx"]',
    'img[src*="photo"]',
    'img[src*="avatar"]',
    'img[src*="zp"]',
    'img[src*="pic"]',
    '.photo-box img',
    '.photo img',
    '.zp img',
    '.avatar img',
    '.touxiang img',
    'td[rowspan] img',
    'th[rowspan] img',
    'table img',
  ]
  for (const sel of selectors) {
    const src = cleanText($(sel).first().attr('src'))
    if (src && !isPlaceholderPhoto(src)) return src
  }

  // 2) 兜底：扫描全部图片，排除图标/占位图，保留疑似证件照
  let found = ''
  $('img').each((_, img) => {
    if (found) return
    const src = cleanText($(img).attr('src'))
    if (!src || isPlaceholderPhoto(src)) return
    if (/photo|xsxx|grxx|xjkp|avatar|zp|pic|touxiang|head|user/i.test(src)) {
      found = src
      return
    }
  })
  if (found) return found

  // 3) 链接兜底：查看照片等链接
  $('a[href*="zp"], a[href*="photo"], a[href*="pic"]').each((_, a) => {
    if (found) return
    const href = cleanText($(a).attr('href'))
    if (!href || isPlaceholderPhoto(href)) return
    found = href
  })

  return found
}

// ===== Tool 1：学籍与个人档案 =====

async function profileGetProfile(ses: Session): Promise<CdutDomainToolResult> {
  const res = await fetchJwPage(ses, '/grxx/xsxx')
  if (res.expired) return expiredResult()
  if (!res.ok) return errorResult(`学籍卡片接口返回 HTTP ${res.status}`)

  const info = parseKeyValueRows(res.html)
  const studentId = pickField(info, ['学号'])
  const name = pickField(info, ['姓名'])
  const college = pickField(info, ['学院', '院系', '系所'])
  const major = pickField(info, ['专业'])
  const className = pickField(info, ['班级', '行政班'])
  const educationLength = pickField(info, ['学制'])
  const status = pickField(info, ['学籍状态', '学籍']) || '在校'
  const gender = pickField(info, ['性别'])
  const photoUrl = extractProfilePhotoUrl(res.html)
  const photoBase64 = photoUrl ? await fetchImageAsBase64(ses, photoUrl, res.finalUrl) : undefined

  const markdown = [
    '### 👤 学生学籍档案信息',
    '',
    `- **姓名**：${name || '—'}`,
    `- **学号**：${studentId || '—'}`,
    `- **所属学院**：${college || '—'}`,
    `- **录取专业**：${major || '—'}`,
    `- **行政班级**：${className || '—'}`,
    `- **学制**：${educationLength ? `${educationLength} 年` : '—'}`,
    `- **学籍状态**：${status}`,
    gender ? `- **性别**：${gender}` : '',
  ]
    .filter((line) => line !== '')
    .join('\n')

  return buildResult(markdown, {
    studentId,
    name,
    college,
    major,
    className,
    educationLength,
    status,
    photoUrl: photoBase64 ? '(base64-embedded)' : '',
  })
}

async function profileGetContact(ses: Session): Promise<CdutDomainToolResult> {
  const res = await fetchJwPage(ses, '/xsxj/xjxxgl.do')
  if (res.expired) return expiredResult()
  if (!res.ok) return errorResult(`联系方式接口返回 HTTP ${res.status}`)

  const info = parseKeyValueRows(res.html)
  const entries = Object.entries(info).filter(([, v]) => v !== '')
  const rows = entries.map(([k, v]) => [k, v])
  const markdown = `### 📇 个人联系方式与家庭信息\n\n${mdTable(['项目', '内容'], rows)}`
  return buildResult(markdown, { contact: info })
}

async function profileStatusChanges(ses: Session): Promise<CdutDomainToolResult> {
  const res = await fetchJwPage(ses, '/xsxj/xsydxx.do')
  if (res.expired) return expiredResult()
  if (!res.ok) return errorResult(`学籍异动接口返回 HTTP ${res.status}`)

  const { headers, rows } = parseLargestTable(res.html)
  const objects = rowsToObjects(headers, rows)
  const items = objects.map((o) => ({
    type: pickField(o, ['异动类型', '异动']),
    date: pickField(o, ['异动日期', '日期', '时间']),
    detail: pickField(o, ['异动原因', '原因', '说明']),
  }))
  const table = items.length
    ? mdTable(
        ['异动类型', '发生日期', '说明'],
        items.map((i) => [i.type || '—', i.date || '—', i.detail || '—']),
      )
    : '> 暂无学籍异动记录'
  const markdown = `### 🔄 学籍异动历史记录\n\n${table}`
  return buildResult(markdown, { statusChanges: items })
}

async function profileMajorSplit(ses: Session): Promise<CdutDomainToolResult> {
  const res = await fetchJwPage(ses, '/xsxj/toQueryZyfl.do')
  if (res.expired) return expiredResult()
  if (!res.ok) return errorResult(`大类分流接口返回 HTTP ${res.status}`)

  const { headers, rows } = parseLargestTable(res.html)
  const objects = rowsToObjects(headers, rows)
  const majors = objects.map((o) => ({
    code: pickField(o, ['专业代号', '代号', '代码']),
    name: pickField(o, ['专业名称', '专业']),
    plan: pickField(o, ['计划', '名额']),
  }))
  const table = majors.length
    ? mdTable(
        ['专业代号', '专业名称', '招生计划'],
        majors.map((m) => [m.code || '—', m.name || '—', m.plan || '—']),
      )
    : '> 当前未开放大类分流或无可选专业'
  const markdown = `### 🧭 大类专业分流专业列表\n\n${table}`
  return buildResult(markdown, { majors })
}

async function profileSubmitMajorPreference(
  ses: Session,
  params: CdutAcademicProfileParams,
): Promise<CdutDomainToolResult> {
  const order = params.payload?.volunteerOrder ?? []
  if (order.length === 0) return errorResult('缺少大类分流志愿排序（payload.volunteerOrder）')
  const res = await fetchJwPage(ses, '/xsxj/saveZyfl.do', {
    method: 'POST',
    form: { zydm: order.join(','), volunteerOrder: order.join(',') },
  })
  if (res.expired) return expiredResult()
  const ok = res.ok && !/失败|错误|不存在/.test(res.html)
  return buildResult(
    ok
      ? `### ✅ 大类分流志愿提交成功\n\n- **志愿排序**：${order.join(' → ')}`
      : '### ⚠️ 大类分流志愿提交未确认成功',
    { volunteerOrder: order, submitted: ok },
    true,
  )
}

async function profileMinorSignup(ses: Session): Promise<CdutDomainToolResult> {
  const res = await fetchJwPage(ses, '/fxgl/fxbmxx_query')
  if (res.expired) return expiredResult()
  if (!res.ok) return errorResult(`辅修报名接口返回 HTTP ${res.status}`)

  const { headers, rows } = parseLargestTable(res.html)
  const objects = rowsToObjects(headers, rows)
  const minors = objects.map((o) => ({
    code: pickField(o, ['辅修专业代码', '专业代码', '代码']),
    name: pickField(o, ['辅修专业', '专业名称', '名称']),
    status: pickField(o, ['报名状态', '状态']),
  }))
  const table = minors.length
    ? mdTable(
        ['辅修专业代码', '辅修专业名称', '报名状态'],
        minors.map((m) => [m.code || '—', m.name || '—', m.status || '—']),
      )
    : '> 当前无辅修专业开课信息'
  const markdown = `### 📚 辅修专业开课与报名信息\n\n${table}`
  return buildResult(markdown, { minors })
}

async function profileApplyMinor(
  ses: Session,
  params: CdutAcademicProfileParams,
): Promise<CdutDomainToolResult> {
  const code = params.payload?.minorMajorCode
  if (!code) return errorResult('缺少辅修专业代码（payload.minorMajorCode）')
  const res = await fetchJwPage(ses, '/fxgl/fxbmxx_save.do', {
    method: 'POST',
    form: { fxzydm: code },
  })
  if (res.expired) return expiredResult()
  const ok = res.ok && !/失败|错误|不存在/.test(res.html)
  return buildResult(
    ok
      ? `### ✅ 辅修专业报名提交成功\n\n- **辅修专业代码**：${code}`
      : '### ⚠️ 辅修专业报名提交未确认成功',
    { minorMajorCode: code, submitted: ok },
    true,
  )
}

/** Tool 1 分发入口 */
export async function executeProfileDomain(
  ses: Session,
  params: CdutAcademicProfileParams,
): Promise<CdutDomainToolResult> {
  try {
    switch (params.action) {
      case 'get_profile':
        return await profileGetProfile(ses)
      case 'get_contact_info':
        return await profileGetContact(ses)
      case 'query_status_changes':
        return await profileStatusChanges(ses)
      case 'query_major_split':
        return await profileMajorSplit(ses)
      case 'submit_major_preference':
        return await profileSubmitMajorPreference(ses, params)
      case 'query_minor_signup':
        return await profileMinorSignup(ses)
      case 'apply_minor':
        return await profileApplyMinor(ses, params)
      default:
        return errorResult(`不支持的学籍档案操作: ${String(params.action)}`)
    }
  } catch (err) {
    return errorResult(`学籍档案查询失败：${networkError(err)}`)
  }
}

// ===== Tool 2：课表与作息日程 =====

interface ScheduleCourse {
  name: string
  dayOfWeek: number
  startSection: number
  endSection: number
  location: string
  teacher: string
  weeks: string
}

/** 解析「第1-2节 / 1-2节 / 3节」等节次标签 */
function parseSectionRange(label: string): { start: number; end: number } | undefined {
  const rangeMatch = label.match(/(\d+)\s*[-~－]\s*(\d+)/)
  if (rangeMatch && rangeMatch[1] && rangeMatch[2]) {
    return { start: Number(rangeMatch[1]), end: Number(rangeMatch[2]) }
  }
  const single = label.match(/(\d+)/)
  if (single && single[1]) return { start: Number(single[1]), end: Number(single[1]) }
  return undefined
}

/** 从课表 HTML 解析结构化课程列表（节次×星期网格 → 扁平课程数组） */
function parseScheduleCourses(html: string): ScheduleCourse[] {
  const $ = load(html)
  const courses: ScheduleCourse[] = []
  const $tables = $('table')
  let $target = $tables.first()
  let bestCount = -1
  $tables.each((_, table) => {
    // 兼容青果两种课程块类名：.kbcontent（常规）与 .kbcontent1（交替周 / 冲突课程）
    const count = $(table).find('.kbcontent, .kbcontent1').length
    if (count > bestCount) {
      bestCount = count
      $target = $(table)
    }
  })

  $target.find('tr').each((rowIdx, tr) => {
    const $cells = $(tr).children('td, th')
    if ($cells.length < 2) return
    const sectionLabelRaw = cleanText($cells.first().text())
    const range = parseSectionRange(sectionLabelRaw)
    $cells.each((colIdx, cell) => {
      if (colIdx === 0 || colIdx > 7) return
      const day = colIdx
      $(cell)
        .find('.kbcontent, .kbcontent1')
        .each((_, content) => {
          const inner = $(content).html() ?? ''
          const lines = inner
            .split(/<br\s*\/?>/i)
            .map(stripTags)
            .filter((line) => line !== '')
          const name = lines[0] ?? ''
          if (!name || name.includes('&nbsp')) return
          let weeks = ''
          let teacher = ''
          let location = ''
          for (const line of lines.slice(1)) {
            if (!weeks && /周/.test(line)) {
              weeks = line
              continue
            }
            if (!teacher && /(老师|教师|教授|讲师|助教)/.test(line)) {
              teacher = line
              continue
            }
            if (!location && /\d+[A-Za-z]?[-－]\d+/.test(line)) {
              location = line
              continue
            }
          }
          const rest = lines.slice(1).filter((l) => l !== weeks && l !== teacher && l !== location)
          if (!teacher && rest[0]) teacher = rest[0]
          if (!location && rest[1]) location = rest[1]
          const start = range?.start ?? rowIdx + 1
          const end = range?.end ?? start
          courses.push({ name, dayOfWeek: day, startSection: start, endSection: end, location, teacher, weeks })
        })
    })
  })
  return courses
}

/** 构造课表 Markdown 网格 */
function buildScheduleMarkdown(courses: ScheduleCourse[], semester: string, week?: number): string {
  const dayNames = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日']
  const buckets = new Map<number, number>()
  for (const c of courses) {
    const existing = buckets.get(c.startSection)
    if (existing === undefined || c.endSection > existing) buckets.set(c.startSection, c.endSection)
  }
  const ordered = [...buckets.entries()].sort((a, b) => a[0] - b[0])
  const rows: string[][] = ordered.map(([start, end]) => {
    const row: string[] = [`**${start}-${end} 节**`]
    for (let day = 1; day <= 7; day++) {
      const cellCourses = courses.filter((c) => c.dayOfWeek === day && c.startSection === start)
      row.push(
        cellCourses.length
          ? cellCourses
              .map((c) => `${c.name}<br>📍 ${c.location || '待定'}<br>👨‍🏫 ${c.teacher || '待定'}`)
              .join('<br>')
          : '-',
      )
    }
    return row
  })
  const title = week ? `📅 第 ${week} 周课表日程` : '📅 本学期完整课表'
  const table = rows.length
    ? mdTable(['节次', ...dayNames], rows)
    : '> 本周暂无排课记录（可能为假期或未开始）'
  return `### ${title}（${semester || '当前学期'}）\n\n${table}`
}

/** 将课程数组转为精简 JSON 载荷 */
function scheduleJson(courses: ScheduleCourse[], semester: string, week?: number): unknown {
  return {
    semester: semester || '当前学期',
    week: week ?? null,
    courseCount: courses.length,
    courses,
  }
}

/** Tool 2 分发入口 */
export async function executeScheduleDomain(
  ses: Session,
  params: CdutScheduleParams,
): Promise<CdutDomainToolResult> {
  try {
    if (params.action === 'query_other_schedule') {
      const res = await fetchJwPage(ses, '/xskb/xsqtkb.do', {
        query: {
          type: params.queryType ?? 'class',
          keyword: params.queryKeyword,
          xnxq01id: params.semester,
          zcd: params.week,
        },
      })
      if (res.expired) return expiredResult()
      if (!res.ok) return errorResult(`其他课表查询接口返回 HTTP ${res.status}`)
      const courses = parseScheduleCourses(res.html)
      const markdown = buildScheduleMarkdown(courses, params.semester ?? '', params.week)
      return buildResult(markdown, scheduleJson(courses, params.semester ?? '', params.week))
    }

    const res = await fetchJwPage(ses, '/xskb/xskb_list.do', {
      query: { xnxq01id: params.semester, zcd: params.week },
    })
    if (res.expired) return expiredResult()
    if (!res.ok) return errorResult(`个人课表接口返回 HTTP ${res.status}`)
    const courses = parseScheduleCourses(res.html)
    const markdown = buildScheduleMarkdown(courses, params.semester ?? '', params.week)
    return buildResult(markdown, scheduleJson(courses, params.semester ?? '', params.week))
  } catch (err) {
    return errorResult(`课表查询失败：${networkError(err)}`)
  }
}

// ===== Tool 3：成绩与考核评定 =====

/** 百分制成绩 → 绩点（CDUT 常用换算：(score-50)/10，60 分以下记 0） */
function scoreToGp(score: number): number {
  if (score < 60) return 0
  return Math.min(5, Math.round(((score - 50) / 10) * 10) / 10)
}

interface GradeCourse {
  name: string
  category: string
  credit: number
  usualScore: string
  examScore: string
  score: string
  gp: string
}

/** 解析成绩表为结构化课程数组 */
function parseGradeCourses(html: string): GradeCourse[] {
  const { headers, rows } = parseLargestTable(html)
  const objects = rowsToObjects(headers, rows)
  const courses: GradeCourse[] = []
  for (const o of objects) {
    const name = pickField(o, ['课程名称', '课程名', '科目', '课程'])
    if (!name) continue
    courses.push({
      name,
      category: pickField(o, ['课程性质', '性质', '类别', '课程属性']),
      credit: parseNumber(pickField(o, ['学分'])) ?? 0,
      usualScore: pickField(o, ['平时']),
      examScore: pickField(o, ['卷面', '期末']),
      score: pickField(o, ['综合', '总评', '最终成绩', '成绩']),
      gp: pickField(o, ['绩点']),
    })
  }
  return courses
}

/** 汇总学分、加权平均分与 GPA */
function summarizeGrades(courses: GradeCourse[]): {
  totalCredits: number
  weightedAverage: number
  gpa: number
} {
  let creditSum = 0
  let weightedScoreSum = 0
  let weightedGpSum = 0
  for (const c of courses) {
    const score = parseNumber(c.score)
    const credit = c.credit
    if (credit <= 0 || score === undefined) continue
    creditSum += credit
    weightedScoreSum += score * credit
    const gp = parseNumber(c.gp) ?? scoreToGp(score)
    weightedGpSum += gp * credit
  }
  const round1 = (n: number) => Math.round(n * 10) / 10
  return {
    totalCredits: round1(creditSum),
    weightedAverage: creditSum ? round1(weightedScoreSum / creditSum) : 0,
    gpa: creditSum ? Math.round((weightedGpSum / creditSum) * 100) / 100 : 0,
  }
}

/** 构造成绩 Markdown */
function buildGradesMarkdown(courses: GradeCourse[], semester: string): string {
  const summary = summarizeGrades(courses)
  const rows = courses.map((c) => [
    `**${c.name}**`,
    c.category || '—',
    c.credit ? String(c.credit) : '—',
    c.usualScore || '—',
    c.examScore || '—',
    c.score ? `**${c.score}**` : '—',
    c.gp || '—',
  ])
  const table = rows.length
    ? mdTable(['课程名称', '课程性质', '学分', '平时分', '卷面分', '综合分', '绩点'], rows)
    : '> 未查询到成绩记录'
  return [
    `### 📊 ${semester || '全部学期'}成绩单`,
    '',
    `- **修读门数**：${courses.length} 门 | **总学分**：${summary.totalCredits} | **加权平均分**：${summary.weightedAverage} | **GPA**：${summary.gpa}`,
    '',
    table,
  ].join('\n')
}

/** Tool 3 分发入口 */
export async function executeGradesDomain(
  ses: Session,
  params: CdutGradesParams,
): Promise<CdutDomainToolResult> {
  try {
    switch (params.action) {
      case 'query_grades': {
        // 双轨查询：优先标准成绩查询端点 /kscj/cjcx_list，未命中则回退旧端点 /kscj/cj.do。
        // 表单参数补齐 kksj（开课时间/学期）与 xsfs=all（显示方式），对齐青果实际入参。
        const form = {
          xnxq01id: params.semester,
          kcxz: params.courseType,
          kksj: params.semester ?? '',
          xsfs: 'all',
        }
        let res = await fetchJwPage(ses, '/kscj/cjcx_list', { method: 'POST', form })
        if (res.expired) return expiredResult()
        let courses = res.ok ? parseGradeCourses(res.html) : []
        if (courses.length === 0) {
          const fallback = await fetchJwPage(ses, '/kscj/cj.do', { method: 'POST', form })
          if (fallback.expired) return expiredResult()
          if (fallback.ok) {
            res = fallback
            courses = parseGradeCourses(fallback.html)
          }
        }
        if (!res.ok && courses.length === 0) return errorResult(`成绩单接口返回 HTTP ${res.status}`)
        const summary = summarizeGrades(courses)
        return buildResult(buildGradesMarkdown(courses, params.semester ?? ''), {
          semester: params.semester ?? '全部学期',
          ...summary,
          courses: courses.map((c) => ({
            name: c.name,
            category: c.category,
            credit: c.credit,
            score: c.score,
            gp: c.gp,
          })),
        })
      }
      case 'query_level_exams': {
        const res = await fetchJwPage(ses, '/kscj/djkscj_list')
        if (res.expired) return expiredResult()
        if (!res.ok) return errorResult(`等级考试接口返回 HTTP ${res.status}`)
        const { headers, rows } = parseLargestTable(res.html)
        const objects = rowsToObjects(headers, rows)
        const exams = objects.map((o) => ({
          examName: pickField(o, ['考试名称', '项目名称', '科目', '名称']),
          score: pickField(o, ['成绩', '分数']),
          examDate: pickField(o, ['考试时间', '时间', '日期']),
          certificate: pickField(o, ['证书号', '证书']),
        }))
        const table = exams.length
          ? mdTable(
              ['考试名称', '成绩', '考试时间', '证书号'],
              exams.map((e) => [e.examName || '—', e.score || '—', e.examDate || '—', e.certificate || '—']),
            )
          : '> 暂无等级考试成绩记录'
        return buildResult(`### 🏆 等级考试成绩记录\n\n${table}`, { levelExams: exams })
      }
      case 'query_social_exam_replace': {
        const res = await fetchJwPage(ses, '/kscj/skrd_add_framset')
        if (res.expired) return expiredResult()
        if (!res.ok) return errorResult(`社考认定接口返回 HTTP ${res.status}`)
        const { headers, rows } = parseLargestTable(res.html)
        const table = rows.length ? mdTable(headers, rows) : '> 暂无社考成绩认定记录'
        return buildResult(`### 📝 社考成绩认定与置换记录\n\n${table}`, { replaceRecords: rowsToObjects(headers, rows) })
      }
      case 'apply_social_exam_replace': {
        const res = await fetchJwPage(ses, '/kscj/skrd_add.do', {
          method: 'POST',
          form: { xnxq01id: params.semester },
        })
        if (res.expired) return expiredResult()
        const ok = res.ok && !/失败|错误|不存在/.test(res.html)
        return buildResult(
          ok ? '### ✅ 社考成绩认定申请已提交' : '### ⚠️ 社考成绩认定申请未确认成功',
          { submitted: ok },
          true,
        )
      }
      case 'query_grade_review': {
        const res = await fetchJwPage(ses, '/kscj/cjfh_list')
        if (res.expired) return expiredResult()
        if (!res.ok) return errorResult(`查卷结果接口返回 HTTP ${res.status}`)
        const { headers, rows } = parseLargestTable(res.html)
        const table = rows.length ? mdTable(headers, rows) : '> 暂无查卷/成绩复核记录'
        return buildResult(`### 🔍 期末查卷与成绩复核记录\n\n${table}`, { reviews: rowsToObjects(headers, rows) })
      }
      case 'apply_grade_review': {
        const payload = params.reviewPayload
        if (!payload?.courseId) return errorResult('缺少查卷课程代码（reviewPayload.courseId）')
        const res = await fetchJwPage(ses, '/kscj/cjfh_save.do', {
          method: 'POST',
          form: { kcdm: payload.courseId, cjfhly: payload.reason ?? '' },
        })
        if (res.expired) return expiredResult()
        const ok = res.ok && !/失败|错误|不存在/.test(res.html)
        return buildResult(
          ok
            ? `### ✅ 查卷复核申请提交成功\n\n- **课程代码**：${payload.courseId}\n- **申请理由**：${payload.reason || '—'}`
            : '### ⚠️ 查卷复核申请未确认成功',
          { ...payload, submitted: ok },
          true,
        )
      }
      default:
        return errorResult(`不支持的成绩操作: ${String(params.action)}`)
    }
  } catch (err) {
    return errorResult(`成绩查询失败：${networkError(err)}`)
  }
}

// ===== Tool 4：考务安排与报名 =====

/** Tool 4 分发入口 */
export async function executeExamDomain(
  ses: Session,
  params: CdutExamAffairsParams,
): Promise<CdutDomainToolResult> {
  try {
    switch (params.action) {
      case 'query_exam_schedule': {
        const res = await fetchJwPage(ses, '/xsks/xsksap_query', { query: { xnxq01id: params.semester } })
        if (res.expired) return expiredResult()
        if (!res.ok) return errorResult(`考试日程接口返回 HTTP ${res.status}`)
        const { headers, rows } = parseLargestTable(res.html)
        const objects = rowsToObjects(headers, rows)
        const exams = objects.map((o) => ({
          courseName: pickField(o, ['课程名称', '科目', '考试科目', '课程']),
          time: pickField(o, ['考试时间', '时间', '日期']),
          room: pickField(o, ['考场', '考试地点', '地点']),
          seat: pickField(o, ['座位', '座位号']),
          ticket: pickField(o, ['准考证', '准考证号']),
          form: pickField(o, ['考试形式', '形式']),
        }))
        const table = exams.length
          ? mdTable(
              ['考试科目', '考试时间', '考场位置', '座位号', '准考证号', '考试形式'],
              exams.map((e) => [
                `**${e.courseName || '—'}**`,
                e.time || '—',
                e.room ? `📍 **${e.room}**` : '—',
                e.seat ? `**${e.seat}**` : '—',
                e.ticket || '—',
                e.form || '—',
              ]),
            )
          : '> 暂无考试日程安排（可能尚未排考或已结束）'
        const markdown = [
          '### 📝 期末考试考场日程安排',
          '',
          table,
          '',
          '> ⚠️ 请提前 15 分钟携带身份证及学生证到达考场。',
        ].join('\n')
        return buildResult(markdown, { exams })
      }
      case 'query_makeup_exams': {
        const res = await fetchJwPage(ses, '/kscj/bkbm_query', { query: { xnxq01id: params.semester } })
        if (res.expired) return expiredResult()
        if (!res.ok) return errorResult(`补考名单接口返回 HTTP ${res.status}`)
        const { headers, rows } = parseLargestTable(res.html)
        const table = rows.length ? mdTable(headers, rows) : '> 暂无补考名单与资格记录'
        return buildResult(`### 📋 期初补考名单与资格\n\n${table}`, { makeupExams: rowsToObjects(headers, rows) })
      }
      case 'signup_makeup_exam': {
        const code = params.payload?.courseCode
        if (!code) return errorResult('缺少补考课程代码（payload.courseCode）')
        const res = await fetchJwPage(ses, '/kscj/bkbm_save.do', {
          method: 'POST',
          form: { kcdm: code, xnxq01id: params.semester },
        })
        if (res.expired) return expiredResult()
        const ok = res.ok && !/失败|错误|不存在/.test(res.html)
        return buildResult(
          ok ? `### ✅ 补考报名提交成功\n\n- **课程代码**：${code}` : '### ⚠️ 补考报名未确认成功',
          { courseCode: code, submitted: ok },
          true,
        )
      }
      case 'query_retake_courses': {
        const res = await fetchJwPage(ses, '/kscj/cxbmxk_query', { query: { xnxq01id: params.semester } })
        if (res.expired) return expiredResult()
        if (!res.ok) return errorResult(`重修课程接口返回 HTTP ${res.status}`)
        const { headers, rows } = parseLargestTable(res.html)
        const table = rows.length ? mdTable(headers, rows) : '> 暂无重修开课与可报名科目'
        return buildResult(`### 🔁 重修开课与可报名科目\n\n${table}`, { retakeCourses: rowsToObjects(headers, rows) })
      }
      case 'signup_retake_course': {
        const code = params.payload?.courseCode
        if (!code) return errorResult('缺少重修课程代码（payload.courseCode）')
        const res = await fetchJwPage(ses, '/kscj/cxbmxk_save.do', {
          method: 'POST',
          form: { kcdm: code, xnxq01id: params.semester },
        })
        if (res.expired) return expiredResult()
        const ok = res.ok && !/失败|错误|不存在/.test(res.html)
        return buildResult(
          ok ? `### ✅ 重修报名提交成功\n\n- **课程代码**：${code}` : '### ⚠️ 重修报名未确认成功',
          { courseCode: code, submitted: ok },
          true,
        )
      }
      case 'query_deferral_status': {
        const res = await fetchJwPage(ses, '/kscj/hksq_query', { query: { xnxq01id: params.semester } })
        if (res.expired) return expiredResult()
        if (!res.ok) return errorResult(`缓考记录接口返回 HTTP ${res.status}`)
        const { headers, rows } = parseLargestTable(res.html)
        const table = rows.length ? mdTable(headers, rows) : '> 暂无缓考申请记录'
        return buildResult(`### 🩺 缓考申请记录\n\n${table}`, { deferrals: rowsToObjects(headers, rows) })
      }
      case 'apply_exam_deferral': {
        const payload = params.payload
        if (!payload?.courseCode) return errorResult('缺少缓考课程代码（payload.courseCode）')
        const res = await fetchJwPage(ses, '/kscj/hksq_save.do', {
          method: 'POST',
          form: {
            kcdm: payload.courseCode,
            hkly: payload.deferralReason ?? '',
            lxdh: payload.contactTel ?? '',
            xnxq01id: params.semester,
          },
        })
        if (res.expired) return expiredResult()
        const ok = res.ok && !/失败|错误|不存在/.test(res.html)
        return buildResult(
          ok
            ? `### ✅ 缓考申请提交成功\n\n- **课程代码**：${payload.courseCode}\n- **缓考原因**：${payload.deferralReason || '—'}`
            : '### ⚠️ 缓考申请未确认成功',
          { ...payload, submitted: ok },
          true,
        )
      }
      default:
        return errorResult(`不支持的考务操作: ${String(params.action)}`)
    }
  } catch (err) {
    return errorResult(`考务查询失败：${networkError(err)}`)
  }
}

// ===== Tool 5：教室资源与自习雷达 =====

interface EmptyRoom {
  roomName: string
  capacity: number
  availableSections: number[]
  hasAirConditioner: boolean
}

/** 校区入参：成都校区 / 宜宾校区 */
type CdutCampus = 'chengdu' | 'yibin'

/** 校区代号映射（01 成都校区、02 宜宾校区） */
function campusCode(campus: CdutCampus): string {
  return campus === 'yibin' ? '02' : '01'
}

/** 校区中文名 */
function campusLabel(campus: CdutCampus): string {
  return campus === 'yibin' ? '宜宾校区' : '成都校区'
}

/** 解析空闲教室网格表：行=教室，列=节次，空单元格视为空闲 */
function parseClassrooms(html: string): EmptyRoom[] {
  const { headers, rows } = parseLargestTable(html)
  const capacityCol = headers.findIndex((h) => /座位|容量|人数/.test(h))
  const sectionCols: { idx: number; section: number }[] = []
  headers.forEach((h, idx) => {
    if (idx === 0 || idx === capacityCol) return
    if (!/节|第/.test(h) && !/^\d+$/.test(h.trim())) return
    const m = h.match(/(\d+)/)
    if (m && m[1]) sectionCols.push({ idx, section: Number(m[1]) })
  })

  const rooms: EmptyRoom[] = []
  for (const cells of rows) {
    const roomName = cleanText(cells[0] ?? '')
    if (!roomName) continue
    let capacity = capacityCol >= 0 ? (parseNumber(cells[capacityCol]) ?? 0) : 0
    if (!capacity) {
      const capMatch = roomName.match(/[（(]?\s*(\d{2,4})\s*(?:座|人)/)
      if (capMatch && capMatch[1]) capacity = Number(capMatch[1])
    }
    const availableSections: number[] = []
    for (const col of sectionCols) {
      const text = cleanText(cells[col.idx] ?? '')
      if (text === '' || text === '-' || text === '—' || /空闲|无课/.test(text)) {
        availableSections.push(col.section)
      }
    }
    rooms.push({
      roomName,
      capacity,
      availableSections,
      hasAirConditioner: /空调/.test(roomName),
    })
  }
  return rooms
}

/** 按节次区间过滤：要求请求节次全部空闲 */
function filterByTimeSlots(rooms: EmptyRoom[], timeSlots?: number[]): EmptyRoom[] {
  if (!timeSlots || timeSlots.length === 0) {
    return rooms.filter((r) => r.availableSections.length > 0)
  }
  return rooms.filter((r) => timeSlots.every((slot) => r.availableSections.includes(slot)))
}

/** Tool 5 分发入口 */
export async function executeClassroomDomain(
  ses: Session,
  params: CdutClassroomParams,
): Promise<CdutDomainToolResult> {
  try {
    const res = await fetchJwPage(ses, '/kbxx/jsjy_query', {
      query: {
        xq: campusCode(params.campus),
        jxl: params.building,
        zcd: params.week,
        xqj: params.dayOfWeek,
        jc: params.timeSlots?.join(','),
      },
    })
    if (res.expired) return expiredResult()
    if (!res.ok) return errorResult(`空闲教室接口返回 HTTP ${res.status}`)

    let rooms = parseClassrooms(res.html)

    if (params.action === 'query_room_occupancy' && params.building) {
      rooms = rooms.filter((r) => r.roomName.includes(params.building ?? ''))
      const table = rooms.length
        ? mdTable(
            ['教室', '座位容量', '空闲节次'],
            rooms.map((r) => [
              `📍 **${r.roomName}**`,
              r.capacity ? `${r.capacity} 座` : '—',
              r.availableSections.length ? `第 ${r.availableSections.join(', ')} 节` : '全时段占用',
            ]),
          )
        : '> 未查询到指定教室占用信息'
      const markdown = `### 🚪 ${campusLabel(params.campus)}【${params.building}】教室占用明细\n\n${table}`
      return buildResult(markdown, { campus: params.campus, building: params.building, rooms })
    }

    rooms = filterByTimeSlots(rooms, params.timeSlots)
    if (params.minSeats && params.minSeats > 0) {
      rooms = rooms.filter((r) => r.capacity >= (params.minSeats ?? 0))
    }

    const rows = rooms.map((r) => [
      `📍 **${r.roomName}**`,
      r.capacity ? `${r.capacity} 座` : '—',
      r.hasAirConditioner ? '空调' : '—',
      r.availableSections.length ? `第 ${r.availableSections.join(', ')} 节` : '—',
    ])
    const table = rows.length
      ? mdTable(['教学楼/教室', '座位容量', '设备', '空闲节次'], rows)
      : '> 当前条件下未找到空闲教室，请调整教学楼、周次或节次'
    const scope = params.building ? `【${params.building}】` : ''
    const markdown = [
      `### 🏫 ${campusLabel(params.campus)}${scope}空闲自习室`,
      '',
      `- **匹配空闲教室**：**${rooms.length} 间可用**`,
      '',
      table,
    ].join('\n')

    return buildResult(markdown, {
      campus: params.campus,
      building: params.building ?? '',
      emptyRooms: rooms.map((r) => ({
        roomName: r.roomName,
        capacity: r.capacity,
        availableSections: r.availableSections,
        hasAirConditioner: r.hasAirConditioner,
      })),
    })
  } catch (err) {
    return errorResult(`空闲教室查询失败：${networkError(err)}`)
  }
}

// ===== Tool 6：培养方案与毕业学分 =====

/** Tool 6 分发入口 */
export async function executeCurriculumDomain(
  ses: Session,
  params: CdutCurriculumPlanParams,
): Promise<CdutDomainToolResult> {
  try {
    switch (params.action) {
      case 'get_training_plan': {
        const res = await fetchJwPage(ses, '/pyfa/topyfamx')
        if (res.expired) return expiredResult()
        if (!res.ok) return errorResult(`培养方案接口返回 HTTP ${res.status}`)
        const { headers, rows } = parseLargestTable(res.html)
        const table = rows.length ? mdTable(headers, rows) : '> 暂无指导性培养方案数据'
        const markdown = `### 📘 主修专业指导性培养方案${params.moduleName ? `（模块：${params.moduleName}）` : ''}\n\n${table}`
        return buildResult(markdown, { plan: rowsToObjects(headers, rows) })
      }
      case 'check_graduation_requirements': {
        const res = await fetchJwPage(ses, '/xxwcqk/xxwcqkOnkcxz.do')
        if (res.expired) return expiredResult()
        if (!res.ok) return errorResult(`学业完成情况接口返回 HTTP ${res.status}`)
        const { headers, rows } = parseLargestTable(res.html)
        const objects = rowsToObjects(headers, rows)
        const modules = objects
          .map((o) => {
            const name = pickField(o, ['模块', '课程模块', '课程类别', '类别'])
            const required = parseNumber(pickField(o, ['规定学分', '要求学分', '应修'])) ?? 0
            const completed = parseNumber(pickField(o, ['已修学分', '已获得', '实修'])) ?? 0
            const missing = parseNumber(pickField(o, ['尚欠', '未修', '差额'])) ?? Math.max(0, required - completed)
            return { name, required, completed, missing, isSatisfied: missing <= 0 && required > 0 }
          })
          .filter((m) => m.name)
        const requiredTotal = modules.reduce((sum, m) => sum + m.required, 0)
        const completedTotal = modules.reduce((sum, m) => sum + m.completed, 0)
        const remainingTotal = modules.reduce((sum, m) => sum + m.missing, 0)
        const rate = requiredTotal ? Math.round((completedTotal / requiredTotal) * 1000) / 10 : 0
        const table = modules.length
          ? mdTable(
              ['课程模块', '规定学分', '已修学分', '尚欠学分', '状态'],
              modules.map((m) => [
                `**${m.name}**`,
                String(m.required),
                String(m.completed),
                m.missing > 0 ? `**${m.missing}**` : '0',
                m.isSatisfied ? '✅ 已达标' : '⏳ 进行中',
              ]),
            )
          : '> 暂未获取到毕业学分要求数据'
        const markdown = [
          '### 🎓 毕业学分完成情况核查',
          '',
          `- **毕业总学分要求**：**${requiredTotal} 学分**`,
          `- **当前已修得**：**${completedTotal} 学分** | **剩余待修**：**${remainingTotal} 学分** | **完成率**：**${rate}%**`,
          '',
          table,
        ].join('\n')
        return buildResult(markdown, { requiredTotal, completedTotal, remainingTotal, rate, modules })
      }
      case 'query_degree_application': {
        const res = await fetchJwPage(ses, '/bygl/bysxx_xwsq')
        if (res.expired) return expiredResult()
        if (!res.ok) return errorResult(`学位申请接口返回 HTTP ${res.status}`)
        const { headers, rows } = parseLargestTable(res.html)
        const table = rows.length ? mdTable(headers, rows) : '> 暂无学位申请记录'
        return buildResult(`### 🎖️ 学士学位申请资格与进度\n\n${table}`, { degreeApplication: rowsToObjects(headers, rows) })
      }
      case 'apply_degree': {
        const res = await fetchJwPage(ses, '/bygl/bysxx_xwsq_save.do', { method: 'POST', form: {} })
        if (res.expired) return expiredResult()
        const ok = res.ok && !/失败|错误|不存在|不符合/.test(res.html)
        return buildResult(
          ok ? '### ✅ 学士学位申请提交成功' : '### ⚠️ 学位申请未确认成功（可能暂不满足申请条件）',
          { submitted: ok },
          true,
        )
      }
      case 'query_delay_graduation': {
        const res = await fetchJwPage(ses, '/tsbygl/yhby_sq')
        if (res.expired) return expiredResult()
        if (!res.ok) return errorResult(`延毕申请接口返回 HTTP ${res.status}`)
        const { headers, rows } = parseLargestTable(res.html)
        const table = rows.length ? mdTable(headers, rows) : '> 暂无延后毕业申请记录'
        return buildResult(`### ⏳ 延后毕业申请记录\n\n${table}`, { delayGraduation: rowsToObjects(headers, rows) })
      }
      case 'apply_delay_graduation': {
        const payload = params.payload
        if (!payload?.delayReason) return errorResult('缺少延毕原因（payload.delayReason）')
        const res = await fetchJwPage(ses, '/tsbygl/yhby_sq_save.do', {
          method: 'POST',
          form: {
            ybyy: payload.delayReason,
            expectedGraduationYear: payload.expectedGraduationYear ?? '',
          },
        })
        if (res.expired) return expiredResult()
        const ok = res.ok && !/失败|错误|不存在/.test(res.html)
        return buildResult(
          ok
            ? `### ✅ 延后毕业申请提交成功\n\n- **延毕原因**：${payload.delayReason}\n- **期望毕业年份**：${payload.expectedGraduationYear || '—'}`
            : '### ⚠️ 延后毕业申请未确认成功',
          { ...payload, submitted: ok },
          true,
        )
      }
      default:
        return errorResult(`不支持的培养方案操作: ${String(params.action)}`)
    }
  } catch (err) {
    return errorResult(`培养方案查询失败：${networkError(err)}`)
  }
}

// ===== Tool 7：选课中心与选课结果 =====

/** Tool 7 分发入口 */
export async function executeSelectionDomain(
  ses: Session,
  params: CdutCourseSelectionParams,
): Promise<CdutDomainToolResult> {
  try {
    switch (params.action) {
      case 'query_selection_rounds': {
        const res = await fetchJwPage(ses, '/xsxk/xklc_list')
        if (res.expired) return expiredResult()
        if (!res.ok) return errorResult(`选课轮次接口返回 HTTP ${res.status}`)
        const { headers, rows } = parseLargestTable(res.html)
        const table = rows.length ? mdTable(headers, rows) : '> 当前无开放的选课轮次'
        return buildResult(`### 🕐 选课轮次列表\n\n${table}`, { rounds: rowsToObjects(headers, rows) })
      }
      case 'query_available_courses': {
        const res = await fetchJwPage(ses, '/xsxk/xklc_list', {
          query: { xklcdm: params.roundCode, kcmc: params.courseFilter?.keyword },
        })
        if (res.expired) return expiredResult()
        if (!res.ok) return errorResult(`可选课程接口返回 HTTP ${res.status}`)
        const { headers, rows } = parseLargestTable(res.html)
        const objects = rowsToObjects(headers, rows)
        let courses = objects.map((o) => ({
          classId: pickField(o, ['教学班', '教学班号', '班号', '课程号']),
          name: pickField(o, ['课程名称', '课程名', '课程']),
          category: pickField(o, ['课程类别', '类别', '性质']),
          credit: parseNumber(pickField(o, ['学分'])) ?? 0,
          teacher: pickField(o, ['教师', '任课教师', '老师']),
          timePlace: pickField(o, ['上课时间', '时间地点', '地点']),
          remaining: parseNumber(pickField(o, ['余量', '剩余', '可选人数'])),
          capacity: parseNumber(pickField(o, ['容量', '总人数', '课容量'])),
        }))
        if (params.courseFilter?.keyword) {
          const kw = params.courseFilter.keyword
          courses = courses.filter((c) => c.name.includes(kw) || c.teacher.includes(kw))
        }
        if (params.courseFilter?.courseCategory) {
          const cat = params.courseFilter.courseCategory
          courses = courses.filter((c) => c.category.includes(cat))
        }
        if (params.courseFilter?.onlyWithRemainingSeats) {
          courses = courses.filter((c) => (c.remaining ?? 0) > 0)
        }
        const rowsOut = courses.map((c) => [
          c.classId || '—',
          `**${c.name || '—'}**`,
          c.category || '—',
          c.credit ? String(c.credit) : '—',
          c.teacher || '—',
          c.timePlace || '—',
          `${c.remaining ?? '—'} / ${c.capacity ?? '—'}`,
        ])
        const table = rowsOut.length
          ? mdTable(['教学班号', '课程名称', '课程类别', '学分', '任课教师', '上课时间地点', '余量/容量'], rowsOut)
          : '> 当前轮次暂无可选课程'
        const markdown = `### 🎯 ${params.roundCode ? `轮次 ${params.roundCode} ` : ''}可选课程与余量\n\n${table}`
        return buildResult(markdown, { availableCourses: courses })
      }
      case 'select_course': {
        const payload = params.operatePayload
        if (!payload?.courseId) return errorResult('缺少选课教学班 ID（operatePayload.courseId）')
        const res = await fetchJwPage(ses, '/xsxk/xsxkzc.do', {
          method: 'POST',
          form: { jx0404id: payload.courseId },
        })
        if (res.expired) return expiredResult()
        const ok = res.ok && !/失败|错误|冲突|已满|不存在/.test(res.html)
        return buildResult(
          ok
            ? `### ✅ 选课提交成功\n\n- **课程**：${payload.courseName || payload.courseId}`
            : '### ⚠️ 选课未确认成功（可能名额已满或时间冲突）',
          { ...payload, submitted: ok },
          true,
        )
      }
      case 'drop_course': {
        const payload = params.operatePayload
        if (!payload?.courseId) return errorResult('缺少退课教学班 ID（operatePayload.courseId）')
        const res = await fetchJwPage(ses, '/xsxk/xstkzc.do', {
          method: 'POST',
          form: { jx0404id: payload.courseId },
        })
        if (res.expired) return expiredResult()
        const ok = res.ok && !/失败|错误|不存在/.test(res.html)
        return buildResult(
          ok
            ? `### ✅ 退课提交成功\n\n- **课程**：${payload.courseName || payload.courseId}`
            : '### ⚠️ 退课未确认成功',
          { ...payload, submitted: ok },
          true,
        )
      }
      case 'query_selected_results': {
        const res = await fetchJwPage(ses, '/xkgl/xsxkjgcx')
        if (res.expired) return expiredResult()
        if (!res.ok) return errorResult(`已选结果接口返回 HTTP ${res.status}`)
        const { headers, rows } = parseLargestTable(res.html)
        const objects = rowsToObjects(headers, rows)
        const totalCredit = objects.reduce((sum, o) => sum + (parseNumber(pickField(o, ['学分'])) ?? 0), 0)
        const table = rows.length ? mdTable(headers, rows) : '> 暂无已选课程记录'
        const markdown = `### 📌 已选课程名单\n\n- **已选总学分**：**${totalCredit}**\n\n${table}`
        return buildResult(markdown, { totalCredit, selected: objects })
      }
      default:
        return errorResult(`不支持的选课操作: ${String(params.action)}`)
    }
  } catch (err) {
    return errorResult(`选课查询失败：${networkError(err)}`)
  }
}

// ===== Tool 8：教务通知、学业预警与系统服务 =====

interface NoticeItem {
  id: string
  title: string
  date: string
  dept: string
}

/** 解析通知/公告/留言列表（表格优先，ul/li 兜底） */
function parseNoticeItems(html: string): NoticeItem[] {
  const { headers, rows } = parseLargestTable(html)
  const objects = rowsToObjects(headers, rows)
  const items: NoticeItem[] = []
  for (const o of objects) {
    const title = pickField(o, ['标题', '主题', '通知标题', '名称', '问题'])
    if (!title) continue
    items.push({
      id: pickField(o, ['编号', '序号', 'ID', 'id']),
      title,
      date: pickField(o, ['日期', '时间', '发布']),
      dept: pickField(o, ['部门', '单位', '发布单位', '来源']),
    })
  }
  if (items.length === 0) {
    for (const li of parseListItems(html)) {
      items.push({ id: '', title: li.title, date: li.date, dept: '' })
    }
  }
  return items
}

/** 构造通知列表 Markdown */
function buildNoticeMarkdown(title: string, items: NoticeItem[]): string {
  const table = items.length
    ? mdTable(
        ['发布日期', '标题', '发布单位'],
        items.map((i) => [i.date || '—', `**${i.title}**`, i.dept || '—']),
      )
    : '> 暂无相关记录'
  return `### ${title}\n\n${table}`
}

/** 从教务顶栏主页提取明文姓名 */
async function noticesQuickIdentity(ses: Session): Promise<CdutDomainToolResult> {
  const res = await fetchJwPage(ses, '/framework/xsMainV.htmlx')
  if (res.expired) return expiredResult()
  if (!res.ok) return errorResult(`教务主页接口返回 HTTP ${res.status}`)

  const $ = load(res.html)
  let name = ''
  const selectors = [
    '.top li.user + li span',
    '.top .user ~ li span',
    '.top li.user + li',
    '#userName',
    '.username',
    '.user-name',
    '.top-user .name',
    '.head .name',
  ]
  for (const sel of selectors) {
    const text = cleanText($(sel).first().text())
    if (text) {
      name = text
      break
    }
  }
  if (!name) {
    const bodyText = cleanText($('body').text())
    const m = bodyText.match(/欢迎[您，, ]*([\u4e00-\u9fa5]{2,4})/)
    if (m && m[1]) name = m[1]
  }
  const markdown = `### 🪪 教务系统当前登录身份\n\n- **姓名**：${name || '（未能识别）'}`
  return buildResult(markdown, { name })
}

/** Tool 8 分发入口 */
export async function executeNoticesDomain(
  ses: Session,
  params: CdutNoticesParams,
): Promise<CdutDomainToolResult> {
  try {
    switch (params.action) {
      case 'query_notices': {
        const res = await fetchJwPage(ses, '/ggly/xxtz_query', { query: { pageIndex: params.page, keyword: params.keyword } })
        if (res.expired) return expiredResult()
        if (!res.ok) return errorResult(`通知接口返回 HTTP ${res.status}`)
        const items = parseNoticeItems(res.html)
        return buildResult(buildNoticeMarkdown('📢 教务消息通知列表', items), { notices: items })
      }
      case 'query_bulletins': {
        const res = await fetchJwPage(ses, '/ggly/ysgg_query', { query: { pageIndex: params.page } })
        if (res.expired) return expiredResult()
        if (!res.ok) return errorResult(`公告接口返回 HTTP ${res.status}`)
        const items = parseNoticeItems(res.html)
        return buildResult(buildNoticeMarkdown('📰 已收教务公告', items), { bulletins: items })
      }
      case 'query_messages': {
        const res = await fetchJwPage(ses, '/ggly/ysly_query', { query: { pageIndex: params.page } })
        if (res.expired) return expiredResult()
        if (!res.ok) return errorResult(`留言接口返回 HTTP ${res.status}`)
        const items = parseNoticeItems(res.html)
        return buildResult(buildNoticeMarkdown('💬 已收留言与教师沟通反馈', items), { messages: items })
      }
      case 'query_faq': {
        const res = await fetchJwPage(ses, '/zxwd/zxwd_opt', { query: { pageIndex: params.page } })
        if (res.expired) return expiredResult()
        if (!res.ok) return errorResult(`在线问答接口返回 HTTP ${res.status}`)
        const items = parseNoticeItems(res.html)
        return buildResult(buildNoticeMarkdown('❓ 教务在线问答与指南', items), { faq: items })
      }
      case 'post_question': {
        if (!params.keyword) return errorResult('缺少提问内容（keyword）')
        const res = await fetchJwPage(ses, '/zxwd/zxwd_save.do', { method: 'POST', form: { wt: params.keyword } })
        if (res.expired) return expiredResult()
        const ok = res.ok && !/失败|错误|不存在/.test(res.html)
        return buildResult(
          ok ? `### ✅ 在线提问已提交\n\n- **问题**：${params.keyword}` : '### ⚠️ 在线提问未确认成功',
          { question: params.keyword, submitted: ok },
          true,
        )
      }
      case 'query_documents': {
        const res = await fetchJwPage(ses, '/wdgl/wdnr_list', { query: { pageIndex: params.page } })
        if (res.expired) return expiredResult()
        if (!res.ok) return errorResult(`文档列表接口返回 HTTP ${res.status}`)
        const items = parseNoticeItems(res.html)
        return buildResult(buildNoticeMarkdown('📁 教务公共下载文档列表', items), { documents: items })
      }
      case 'query_academic_warnings': {
        const res = await fetchJwPage(ses, '/xsxj/gxyjxx.do')
        if (res.expired) return expiredResult()
        if (!res.ok) return errorResult(`学业预警接口返回 HTTP ${res.status}`)
        const { headers, rows } = parseLargestTable(res.html)
        const table = rows.length ? mdTable(headers, rows) : '> 🟢 正常（无任何学业或考纪预警）'
        const hasWarning = rows.length > 0
        const markdown = `### 🚨 学籍与学业预警状态\n\n- **预警状态**：${hasWarning ? '🔴 存在预警记录' : '🟢 正常（无任何学业或考纪预警）'}\n\n${table}`
        return buildResult(markdown, { academicWarning: { hasWarning, level: hasWarning ? 'warning' : 'none' }, records: rowsToObjects(headers, rows) })
      }
      case 'get_password_policy': {
        const res = await fetchJwPage(ses, '/grsz/grsz_xgmm')
        if (res.expired) return expiredResult()
        if (!res.ok) return errorResult(`密码策略接口返回 HTTP ${res.status}`)
        const $ = load(res.html)
        const text = cleanText($('body').text())
        const policyMatch = text.match(/密码[^。；\n]{4,80}/)
        const policy = policyMatch ? policyMatch[0] : '请遵循学校教务系统密码复杂度要求（一般不少于 8 位，含字母与数字）'
        return buildResult(`### 🔐 教务密码安全策略\n\n> ${policy}`, { policy })
      }
      case 'change_password': {
        const payload = params.changePasswordPayload
        if (!payload?.newPassword) return errorResult('缺少新密码（changePasswordPayload.newPassword）')
        const res = await fetchJwPage(ses, '/grsz/grsz_xgmm_save.do', {
          method: 'POST',
          form: { oldPassword: payload.oldPassword ?? '', newPassword: payload.newPassword },
        })
        if (res.expired) return expiredResult()
        const ok = res.ok && !/失败|错误|不一致|不正确/.test(res.html)
        return buildResult(
          ok ? '### ✅ 教务系统密码修改成功，请牢记新密码' : '### ⚠️ 密码修改未确认成功（请核验原密码）',
          { submitted: ok },
          true,
        )
      }
      case 'get_quick_identity':
        return await noticesQuickIdentity(ses)
      default:
        return errorResult(`不支持的通知系统操作: ${String(params.action)}`)
    }
  } catch (err) {
    return errorResult(`通知系统查询失败：${networkError(err)}`)
  }
}

// ===== 写操作登记表与统一分发 =====

/** 需要二次确认的写操作登记表：业务域 -> 高危 action 集合 */
const CDUT_MUTATION_ACTIONS: Record<CdutToolDomain, readonly string[]> = {
  profile: ['submit_major_preference', 'apply_minor'],
  schedule: [],
  grades: ['apply_social_exam_replace', 'apply_grade_review'],
  exams: ['signup_makeup_exam', 'signup_retake_course', 'apply_exam_deferral'],
  classrooms: [],
  curriculum: ['apply_degree', 'apply_delay_graduation'],
  selection: ['select_course', 'drop_course'],
  notices: ['post_question', 'change_password'],
}

/** 判断某业务域的某 action 是否属于需二次确认的写操作 */
export function isCdutMutationAction(domain: CdutToolDomain, action: string): boolean {
  return CDUT_MUTATION_ACTIONS[domain].includes(action)
}

/** 写操作中文描述表，用于二次确认弹窗文案 */
const CDUT_MUTATION_LABELS: Record<string, string> = {
  'profile:submit_major_preference': '提交大类专业分流志愿',
  'profile:apply_minor': '报名辅修专业',
  'grades:apply_social_exam_replace': '提交社考成绩认定申请',
  'grades:apply_grade_review': '提交查卷成绩复核申请',
  'exams:signup_makeup_exam': '报名补考科目',
  'exams:signup_retake_course': '报名重修选课',
  'exams:apply_exam_deferral': '提交缓考申请',
  'curriculum:apply_degree': '提交学士学位申请',
  'curriculum:apply_delay_graduation': '提交延后毕业申请',
  'selection:select_course': '提交选课请求',
  'selection:drop_course': '提交退课请求',
  'notices:post_question': '发起在线问答提问',
  'notices:change_password': '修改教务系统登录密码',
}

/** 生成写操作二次确认的标题文案 */
export function describeCdutMutation(domain: CdutToolDomain, action: string): string {
  return CDUT_MUTATION_LABELS[`${domain}:${action}`] ?? `执行 ${domain} 域的写操作（${action}）`
}

/** 统一分发入口：按业务域路由到对应执行器 */
export async function executeDomainTool(
  domain: CdutToolDomain,
  ses: Session,
  params: CdutToolParamsMap[CdutToolDomain],
): Promise<CdutDomainToolResult> {
  switch (domain) {
    case 'profile':
      return executeProfileDomain(ses, params as CdutAcademicProfileParams)
    case 'schedule':
      return executeScheduleDomain(ses, params as CdutScheduleParams)
    case 'grades':
      return executeGradesDomain(ses, params as CdutGradesParams)
    case 'exams':
      return executeExamDomain(ses, params as CdutExamAffairsParams)
    case 'classrooms':
      return executeClassroomDomain(ses, params as CdutClassroomParams)
    case 'curriculum':
      return executeCurriculumDomain(ses, params as CdutCurriculumPlanParams)
    case 'selection':
      return executeSelectionDomain(ses, params as CdutCourseSelectionParams)
    case 'notices':
      return executeNoticesDomain(ses, params as CdutNoticesParams)
    default:
      return errorResult(`未知业务域: ${String(domain)}`)
  }
}

// ===== 登录后画像摘要（供认证管理器直接调用） =====

export interface JwProfileSummary {
  name: string
  studentId: string
  college: string
  major: string
  className: string
  avatar?: string
  photoUrl?: string
}

/** 登录成功后直取学籍画像：姓名/学号/学院/专业/班级 + 证件照 Base64 */
export async function fetchJwProfileSummary(ses: Session): Promise<JwProfileSummary> {
  const summary: JwProfileSummary = { name: '', studentId: '', college: '', major: '', className: '' }

  // 主端点：青果学籍卡片 /grxx/xsxx
  try {
    const res = await fetchJwPage(ses, '/grxx/xsxx')
    if (res.expired) {
      console.warn('[CdutJw] 学籍卡片端点落回登录页，会话可能已失效')
    } else if (!res.ok) {
      console.warn('[CdutJw] 学籍卡片端点 /grxx/xsxx 返回 HTTP', res.status)
    } else {
      const info = parseKeyValueRows(res.html)
      summary.name = pickField(info, ['姓名'])
      summary.studentId = pickField(info, ['学号'])
      summary.college = pickField(info, ['学院', '院系', '系所'])
      summary.major = pickField(info, ['专业'])
      summary.className = pickField(info, ['班级', '行政班'])
      const photoUrl = extractProfilePhotoUrl(res.html)
      if (photoUrl) {
        summary.photoUrl = photoUrl
        console.log('[CdutJw] 学籍卡片页定位到证件照地址:', photoUrl)
        summary.avatar = await fetchImageAsBase64(ses, photoUrl, res.finalUrl)
      } else {
        console.warn('[CdutJw] 学籍卡片页未定位到证件照元素')
      }
    }
  } catch (err) {
    console.warn('[CdutJw] 学籍卡片端点请求异常:', networkError(err))
  }

  // 备用端点：学籍信息管理 /xsxj/xjxxgl.do。
  // 部分版式下 /grxx/xsxx 仅返回空框架，学院/专业需从该端点补齐。
  if (!summary.college || !summary.major || !summary.name || !summary.avatar) {
    try {
      const res = await fetchJwPage(ses, '/xsxj/xjxxgl.do')
      if (res.expired) {
        console.warn('[CdutJw] 学籍信息管理端点落回登录页，会话可能已失效')
      } else if (!res.ok) {
        console.warn('[CdutJw] 学籍信息管理端点 /xsxj/xjxxgl.do 返回 HTTP', res.status)
      } else {
        const info = parseKeyValueRows(res.html)
        if (!summary.name) summary.name = pickField(info, ['姓名'])
        if (!summary.studentId) summary.studentId = pickField(info, ['学号'])
        if (!summary.college) summary.college = pickField(info, ['学院', '院系', '系所'])
        if (!summary.major) summary.major = pickField(info, ['专业'])
        if (!summary.className) summary.className = pickField(info, ['班级', '行政班'])
        if (!summary.avatar) {
          const photoUrl = extractProfilePhotoUrl(res.html)
          if (photoUrl) {
            summary.photoUrl = photoUrl
            console.log('[CdutJw] 学籍信息管理页定位到证件照地址:', photoUrl)
            summary.avatar = await fetchImageAsBase64(ses, photoUrl, res.finalUrl)
          }
        }
        console.log('[CdutJw] 学籍信息管理端点补漏完成:', {
          hasName: !!summary.name,
          hasCollege: !!summary.college,
          hasMajor: !!summary.major,
          hasAvatar: !!summary.avatar,
        })
      }
    } catch (err) {
      console.warn('[CdutJw] 学籍信息管理端点请求异常:', networkError(err))
    }
  }

  // 姓名兜底：从教务顶栏主页明文提取
  if (!summary.name) {
    try {
      const home = await fetchJwPage(ses, '/framework/xsMainV.htmlx')
      if (home.ok && !home.expired) {
        const $ = load(home.html)
        const topName = cleanText(
          $('.top li.user + li span, .top .user ~ li span, #userName, .username, .user-name')
            .first()
            .text(),
        )
        const text = topName || cleanText($('body').text())
        const m = text.match(/欢迎[您，, ]*([\u4e00-\u9fa5]{2,4})/)
        if (m && m[1]) summary.name = m[1]
      }
    } catch {
      // 顶栏兜底失败无妨
    }
  }
  return summary
}
