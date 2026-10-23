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
import {
  CDUT_SECTION_PERIODS,
  computeBeijingTeachingWeek,
  evaluateCourseLiveStatus,
  getBeijingTimeInfo,
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

export interface ScheduleCourse {
  name: string
  dayOfWeek: number
  startSection: number
  endSection: number
  location: string
  teacher: string
  weeks: string
  /** 通用周次展开列表（如 "1-4,6-8(周)" → [1,2,3,4,6,7,8]） */
  weekList: number[]
  /** 授课班级（青果 ktmcstr 字段，可能为空） */
  className?: string
  /** 实时雷达：当前时段正在上课 */
  isOngoing?: boolean
  /** 实时雷达：下一节即将开始的课程 */
  isNext?: boolean
}

/**
 * 通用周次解析器：将青果课表「周次(节次)」文本展开为离散周次列表。
 * 兼容全部已知版式：
 *   - 连续周："1-16(周)" → [1..16]
 *   - 离散周："1-4,6-8(周)" → [1,2,3,4,6,7,8]；"9,11-13(周)" → [9,11,12,13]
 *   - 单双周："1-15(单)" → [1,3,5..15]；"2-16(双)" → [2,4,6..16]
 *   - 复合格式："14(周)[01-02节]" → [14]（节次方括号整体剔除，不参与周次解析）
 * 纯函数、零耦合：不含任何特定学期的硬编码字面量。
 */
export function parseWeekSpecification(text: string): number[] {
  if (!text) return []
  const weeks = new Set<number>()
  // 先剔除节次方括号组（如 "[01-02节]"），避免把节次数字误当周次
  const cleaned = text.replace(/\[[^\[\]]*\]/g, ' ')
  for (const seg of cleaned.split(/[,，、]+/)) {
    const s = seg.trim()
    if (!s) continue
    const parity = /单/.test(s) ? 'odd' : /双/.test(s) ? 'even' : null
    // 剔除括号注记与「周」字，仅保留数字与连接符
    const body = s
      .replace(/[（(][^）)]*[）)]/g, ' ')
      .replace(/周/g, ' ')
      .trim()
    for (const part of body.split(/\s+/)) {
      if (!part) continue
      const range = part.match(/^(\d+)\s*[-~－—]+\s*(\d+)$/)
      if (range?.[1] && range[2]) {
        const a = Number(range[1])
        const b = Number(range[2])
        for (let w = Math.min(a, b); w <= Math.max(a, b); w++) {
          if (parity === 'odd' && w % 2 === 0) continue
          if (parity === 'even' && w % 2 === 1) continue
          weeks.add(w)
        }
        continue
      }
      const single = part.match(/^(\d+)$/)
      if (single?.[1]) {
        const w = Number(single[1])
        if (parity === 'odd' && w % 2 === 0) continue
        if (parity === 'even' && w % 2 === 1) continue
        weeks.add(w)
      }
    }
  }
  return [...weeks].sort((a, b) => a - b)
}

/**
 * 成都理工大学官方作息表（11 节制契约，严禁出现第 12 节课）。
 * 事实源已迁移至 `@profer/shared`（主进程与渲染进程共用），此处保持同名再导出以兼容既有导入。
 */
export { CDUT_SECTION_PERIODS }

/**
 * 估算当前教学周次：严格按北京时间（Asia/Shanghai）计算，与宿主系统时区无关。
 * 以「秋学期 9 月首个周一 / 春学期 3 月首个周一」为第 1 周起点，周次夹取至 [1, 25]。
 */
export function computeCurrentWeek(now: Date = new Date()): number {
  return computeBeijingTeachingWeek(now)
}

/**
 * 实时课程雷达（24 小时精准窗口版）：严格按北京时间标记 isOngoing / isNext。
 *   - isOngoing：当前周次、今天、且课程节次区间与当前时刻相交（正在上课）；
 *   - isNext：未来 24 小时内最早开课且尚未开课的一门课（周日夜间自动衔接下周次与下周周单）；
 *     严格限定 courseStartMs - nowMs <= 24h，未来 24 小时无课程时不标记任何「下节课」。
 * 雷达算法收敛于 shared 纯函数；此处按下标写回原数组，维持「原地修改 + 同引用」契约。
 */
export function markOngoingAndNext<T extends ScheduleCourse>(courses: T[], now: Date = new Date()): T[] {
  const { markedCourses } = evaluateCourseLiveStatus(courses, getBeijingTimeInfo(now))
  courses.forEach((course, index) => {
    const marked = markedCourses[index]
    if (!marked) return
    if (marked.isOngoing) course.isOngoing = true
    else delete course.isOngoing
    if (marked.isNext) course.isNext = true
    else delete course.isNext
  })
  return courses
}

/**
 * 青果课表表头汉字节次映射字典（强健归一化，杜绝 `-1节--1节` 运算错误）。
 * CDUT 教务系统节次表头为汉字（第一二节 / 第三四节 / … / 九十节 / 十一节），
 * 纯 `\d+` 匹配会得到 undefined 并退化到行号回退公式，行号 0 时产出 `0*2-1 = -1` 的严重错误。
 */
const CN_SECTION_MAP: Readonly<Record<string, { start: number; end: number }>> = {
  一: { start: 1, end: 1 },
  二: { start: 2, end: 2 },
  三: { start: 3, end: 3 },
  四: { start: 4, end: 4 },
  五: { start: 5, end: 5 },
  六: { start: 6, end: 6 },
  七: { start: 7, end: 7 },
  八: { start: 8, end: 8 },
  九: { start: 9, end: 9 },
  十: { start: 10, end: 10 },
  十一: { start: 11, end: 11 },
  一二: { start: 1, end: 2 },
  三四: { start: 3, end: 4 },
  五六: { start: 5, end: 6 },
  七八: { start: 7, end: 8 },
  九十: { start: 9, end: 10 },
  九十十一: { start: 9, end: 11 },
  '九十、十一': { start: 9, end: 11 },
}

/** 解析「第1-2节 / 1-2节 / 3节 / 第一二节 / 三四节」等节次标签（汉字与阿拉伯数字双兼容） */
function parseSectionRange(label: string): { start: number; end: number } | undefined {
  // 1) 阿拉伯数字区间 / 单节
  const rangeMatch = label.match(/(\d+)\s*[-~－]\s*(\d+)/)
  if (rangeMatch && rangeMatch[1] && rangeMatch[2]) {
    return { start: Number(rangeMatch[1]), end: Number(rangeMatch[2]) }
  }
  const single = label.match(/(\d+)/)
  if (single && single[1]) return { start: Number(single[1]), end: Number(single[1]) }

  // 2) 汉字节次：剥离「第/节」后整串查表（先长键后短键，保证「九十十一」优先于「九十」）
  const normalized = label.replace(/第|节/g, '').replace(/\s+/g, '')
  if (!normalized) return undefined
  if (CN_SECTION_MAP[normalized]) return { ...CN_SECTION_MAP[normalized]! }
  for (const key of ['九十、十一', '九十十一', '一二', '三四', '五六', '七八', '九十', '十一']) {
    if (normalized.includes(key)) return { ...CN_SECTION_MAP[key]! }
  }
  return undefined
}

/** 从「周次(节次)」文本的方括号中提取节次规格（如 "[01-02-03-04节]" → {start:1,end:4}） */
function parseSectionSpecFromWeeks(weeksText: string): { start: number; end: number } | undefined {
  const bracket = weeksText.match(/\[([^\[\]]*)\]/)
  if (!bracket?.[1]) return undefined
  const nums = [...bracket[1].matchAll(/(\d+)/g)].map((m) => Number(m[1])).filter((n) => n > 0 && n <= 15)
  if (nums.length === 0) return undefined
  return { start: Math.min(...nums), end: Math.max(...nums) }
}

interface RawCourseEntry {
  name: string
  teacher: string
  weeksText: string
  location: string
  className: string
  startSection?: number
  endSection?: number
}

/** 单元格内多门课程的分隔线（青果以长横线切分同一网格中的多门课） */
const COURSE_CHUNK_SEPARATOR = /-{5,}/

/** 青果课表内嵌的噪声字段（name 属性）：通知单编号 / 网课信息 / 备注 / 考试标记 / 教学楼 */
const NOISE_FONT_NAMES = new Set(['tzdbh', 'wkxx', 'bzstr', 'xsks', 'jxlmc'])

/**
 * 从单个 kbcontent / kbcontent1 片段 HTML 中抽取课程条目。
 * 优先读取 <font title="教师/周次(节次)/教室"> 与 name="ktmcstr"（班级）语义字段，
 * 缺失时回退文本启发式匹配，兼容无 title 注记的精简版式。
 */
function extractCourseEntriesFromChunk(chunkHtml: string): RawCourseEntry[] {
  const $chunk = load(chunkHtml)
  const entries: RawCourseEntry[] = []
  $chunk('font').each((_, font) => {
    const $font = $chunk(font)
    const fontName = $font.attr('name') ?? ''
    if (NOISE_FONT_NAMES.has(fontName)) return
    const title = cleanText($font.attr('title') ?? '')
    const text = stripTags($font.html() ?? '')
    if (!text) return
    if (/^(通知单编号|备注)/.test(text) || /^[（(](理论|实践|实验)/.test(text)) return
    if (fontName === 'ktmcstr') {
      const last = entries[entries.length - 1]
      if (last) last.className = text.replace(/^班级[:：]\s*/, '')
      return
    }
    if (title === '教师' || title === '老师') {
      const last = entries[entries.length - 1]
      if (last && !last.teacher) last.teacher = text
      else entries.push({ name: '', teacher: text, weeksText: '', location: '', className: '' })
      return
    }
    if (title === '周次(节次)' || title.includes('周次')) {
      entries.push({ name: '', teacher: '', weeksText: text, location: '', className: '' })
      return
    }
    if (title === '教室' || title === '教学地点') {
      const last = entries[entries.length - 1]
      if (last && !last.location) last.location = text
      else entries.push({ name: '', teacher: '', weeksText: '', location: text, className: '' })
      return
    }
    if (title === '教学楼') return // 教学楼与教室重复，忽略
    // 无 title 注记的普通文本 font：视为课程名（新条目开始）
    entries.push({ name: text, teacher: '', weeksText: '', location: '', className: '' })
  })

  // 语义字段缺失时的文本启发式兜底（kbcontent1 精简版式）
  for (const entry of entries) {
    if (!entry.weeksText) {
      const m = entry.name.match(/\S*周\S*/)
      if (m?.[0] && /\d/.test(m[0])) {
        entry.weeksText = m[0]
        entry.name = entry.name.replace(m[0], '').trim()
      }
    }
    if (!entry.location) {
      const m = entry.name.match(/[（(]?[A-Za-z\d甲乙丙丁综基]-?\w*\d{3,4}[A-Za-z]?[）)]?/)
      if (m?.[0]) {
        entry.location = m[0]
        entry.name = entry.name.replace(m[0], '').trim()
      }
    }
  }

  // 合并碎片：同一门课的名称 / 教师 / 周次 / 教室可能被拆为多个 font 节点
  const merged: RawCourseEntry[] = []
  for (const entry of entries) {
    if (!entry.name && !entry.weeksText && !entry.teacher && !entry.location) continue
    const last = merged[merged.length - 1]
    const isFragment = !entry.name && (entry.weeksText || entry.teacher || entry.location)
    if (last && isFragment) {
      if (entry.weeksText && !last.weeksText) last.weeksText = entry.weeksText
      if (entry.teacher && !last.teacher) last.teacher = entry.teacher
      if (entry.location && !last.location) last.location = entry.location
      continue
    }
    merged.push(entry)
  }
  return merged.filter((e) => e.name && /\S/.test(e.name))
}

/**
 * 从课表 HTML 解析结构化课程列表（节次×星期网格 → 扁平课程数组）。
 *
 * 关键健壮性设计：
 *   1. 同一单元格可能同时渲染 kbcontent1（精简）与 kbcontent（完整）两套隐藏副本，
 *      解析后按「课程名+星期+周次+教室」去重，教师信息择优保留；
 *   2. 单元格内多门课程以长横线（-----）分隔，逐段拆分解析；
 *   3. 周次一律经 parseWeekSpecification 通用展开，不依赖服务端过滤。
 */
export function parseScheduleCourses(html: string): ScheduleCourse[] {
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

  const dedupe = new Map<string, ScheduleCourse>()
  let bodyRowIdx = 0 // 有效课表行计数（跳过表头行），用于「第一二节」类无数字标签的节次回退
  // 行号 → 标准大节兜底映射（0→1-2, 1→3-4, 2→5-6, 3→7-8, 4→9-11），绝不产出 <= 0 的节次
  const ROW_FALLBACK_SECTIONS: ReadonlyArray<{ start: number; end: number }> = [
    { start: 1, end: 2 },
    { start: 3, end: 4 },
    { start: 5, end: 6 },
    { start: 7, end: 8 },
    { start: 9, end: 11 },
  ]
  $target.find('tr').each((rowIdx, tr) => {
    const $cells = $(tr).children('td, th')
    if ($cells.length < 2) return
    const sectionLabelRaw = cleanText($cells.first().text())
    const range = parseSectionRange(sectionLabelRaw)
    // 有效课表行：含课程块，或节次标签形如「第一二节 / 3-4节」（表头行标签为空，不计入）
    const isBodyRow = $(tr).find('.kbcontent, .kbcontent1').length > 0 || /节|\d/.test(sectionLabelRaw)
    const rowBase = isBodyRow ? bodyRowIdx++ : rowIdx
    $cells.each((colIdx, cell) => {
      if (colIdx === 0 || colIdx > 7) return
      const day = colIdx
      $(cell)
        .find('.kbcontent, .kbcontent1')
        .each((_, content) => {
          const inner = $(content).html() ?? ''
          if (!inner || !/\S/.test(inner.replace(/&nbsp;/g, ' '))) return
          // 多门课程以长横线分隔，逐段解析
          const chunks = inner.split(COURSE_CHUNK_SEPARATOR)
          for (const chunk of chunks) {
            if (!/\S/.test(chunk.replace(/&nbsp;/g, ' '))) continue
            for (const entry of extractCourseEntriesFromChunk(chunk)) {
              const name = entry.name.trim()
              if (!name || name.includes('&nbsp')) continue
              const weekList = parseWeekSpecification(entry.weeksText)
              const spec = parseSectionSpecFromWeeks(entry.weeksText) ?? range
              const fallback = ROW_FALLBACK_SECTIONS[Math.min(Math.max(rowBase, 0), ROW_FALLBACK_SECTIONS.length - 1)] ?? { start: 1, end: 2 }
              const start = Math.max(1, spec?.start ?? range?.start ?? fallback.start)
              const end = Math.max(start, spec?.end ?? range?.end ?? fallback.end)
              const key = `${name}|${day}|${weekList.join(',')}|${entry.location}`
              const existing = dedupe.get(key)
              if (existing) {
                // 同一门课的重复渲染副本：教师/班级/节次信息择优合并
                if (!existing.teacher && entry.teacher) existing.teacher = entry.teacher
                if (!existing.className && entry.className) existing.className = entry.className
                continue
              }
              dedupe.set(key, {
                name,
                dayOfWeek: day,
                startSection: start,
                endSection: end,
                location: entry.location,
                teacher: entry.teacher,
                weeks: entry.weeksText,
                weekList,
                className: entry.className || undefined,
              })
            }
          }
        })
    })
  })
  return [...dedupe.values()]
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

/** 将课程数组转为精简 JSON 载荷（currentWeek 供抽屉默认选中当前教学周） */
function scheduleJson(courses: ScheduleCourse[], semester: string, week?: number): unknown {
  return {
    semester: semester || '当前学期',
    week: week ?? null,
    currentWeek: computeCurrentWeek(),
    courseCount: courses.length,
    courses,
  }
}

/**
 * Chrome view-source: 快照还原器。
 * 用户保存的 view-source 页面把每行原始 HTML 包进 <td class="line-content"> 并转义，
 * 真实抓取时不存在该包装；检测到包装后逐行取 text()（实体自动反转义）还原原始 HTML。
 */
export function decodeViewSourceSnapshot(html: string): string {
  if (!html.includes('line-content')) return html
  const $ = load(html)
  const $lines = $('.line-content')
  if ($lines.length === 0) return html
  const out: string[] = []
  $lines.each((_, el) => {
    out.push($(el).text())
  })
  return out.join('\n')
}

/** 其他班级课表明细条目（viewtable.do 的 td.detail 结构，无固定节次网格） */
export interface OtherClassCourse {
  name: string
  code: string
  credit: string
  teachers: string[]
  rooms: string[]
  classNames: string[]
  campus: string
  remark: string
  segments: string[]
}

/**
 * 解析全校班级课表（viewtable.do）：抽取全部 <td class="detail"> 课程明细，
 * 提取课程名/代码/学分与「师[…] 室[…] 班级 (校区) 备注」分段信息。
 * 归一化为通用课程对象数组，严禁与任何特定班级/专业字面量耦合。
 */
export function parseOtherClassSchedule(html: string): OtherClassCourse[] {
  const $ = load(decodeViewSourceSnapshot(html))
  const courses: OtherClassCourse[] = []
  $('td.detail').each((_, td) => {
    const $td = $(td)
    const bold = cleanText($td.find('b.fontcourse').first().text())
    const nameMatch = bold.match(/^(.*?)\[(.+?)\]\s*学分\[([^\]]*)\]\s*$/)
    const name = nameMatch ? cleanText(nameMatch[1]) : bold.replace(/学分\[.*$/, '').trim()
    if (!name) return
    const code = nameMatch?.[2] ?? ''
    const credit = nameMatch?.[3] ?? ''
    // 明细分段：<b>标题</b>L1[理] 时[40] 师[x] 室[y] 班级 (校区) 备注:… <br>...
    const bodyHtml = $td.html() ?? ''
    const segments = bodyHtml
      .split(/<br\s*\/?>/i)
      .map((seg) => stripTags(seg))
      .map((seg) => seg.replace(/^-----------------*/, '').trim())
      .filter((seg) => seg !== '')
    const course: OtherClassCourse = { name, code, credit, teachers: [], rooms: [], classNames: [], campus: '', remark: '', segments: [] }
    for (const seg of segments) {
      if (/^(L|R|X|S|T|W|Q)\d*\[/.test(seg) || /时\[/.test(seg) || /师\[/.test(seg) || /室\[/.test(seg)) {
        course.segments.push(seg)
        const teacherAll = [...seg.matchAll(/师\[([^\]]*)\]/g)].map((m) => m[1]?.trim() ?? '').filter(Boolean)
        course.teachers.push(...teacherAll)
        const roomAll = [...seg.matchAll(/室\[([^\]]*)\]/g)].map((m) => m[1]?.trim() ?? '').filter(Boolean)
        course.rooms.push(...roomAll)
        // 校区：段内任意位置的「(X校区)」括注（开闭括号可能半/全角混用）
        const campusMatch = seg.match(/[（(]([^）)]*校区)[）)]/)
        if (campusMatch?.[1]) course.campus = campusMatch[1].trim()
        // 教学班：剔除 师/室/时/学分 括注、校区括注与备注后的剩余 token（形如「年级代码-序号」的班级号串、"xx班"）
        const classNamesPart = seg
          .replace(/[A-Za-z]\d*\[[^\]]*\]/g, ' ')
          .replace(/[时师室]\[[^\]]*\]/g, ' ')
          .replace(/学分\[[^\]]*\]/g, ' ')
          .replace(/[（(][^）)]*校区[）)]/g, ' ')
          .replace(/备注[:：][\s\S]*$/, ' ')
        for (const token of classNamesPart.split(/[\s,，、]+/)) {
          const t = token.trim().replace(/班$/, '')
          if (/^\d{6,}(?:[-\d]+)?$/.test(t) && !course.classNames.includes(t)) course.classNames.push(t)
        }
        const remarkMatch = seg.match(/备注[:：]\s*([\s\S]+)$/)
        if (remarkMatch?.[1] && !course.remark) {
          course.remark = remarkMatch[1].trim().replace(/^备注[:：]\s*/, '')
        }
      }
    }
    courses.push(course)
  })
  return courses
}

/** 构造其他班级课表 Markdown */
function buildOtherClassMarkdown(courses: OtherClassCourse[], semester: string, classQuery: string): string {
  const rows = courses.map((c) => [
    `**${c.name}**`,
    c.code || '—',
    c.credit || '—',
    c.teachers.length ? c.teachers.join('、') : '—',
    c.rooms.length ? c.rooms.join('；') : '—',
    c.classNames.length ? c.classNames.join('、') : '—',
  ])
  const table = rows.length
    ? mdTable(['课程名称', '课程代码', '学分', '授课教师', '上课地点', '教学班'], rows)
    : `> 未检索到与「${classQuery}」匹配的班级课表，请确认班级名称或班号后重试`
  return `### 🗓️ 全校班级课表（${classQuery} · ${semester || '当前学期'}）\n\n${table}`
}

/** Tool 2 分发入口 */
export async function executeScheduleDomain(
  ses: Session,
  params: CdutScheduleParams,
): Promise<CdutDomainToolResult> {
  try {
    if (params.action === 'query_other_schedule') {
      // 产品红线：仅暴露「全校其他班级课表查询」，坚决屏蔽教师课表与教室课表查询入口
      const classQuery = params.classId || params.className || ''
      if (!classQuery) return errorResult('缺少目标班级：请提供 className（班级名称/班号）或 classId')
      const semester = params.semester ?? ''

      // 1) 先取查询页：拿「默认节次」模板 ID（kbjcmsid）与页面选中的默认学期
      let kbjcmsid = '7E5976C91D9A4146930951FD11516BCC'
      let defaultSemester = ''
      const queryPage = await fetchJwPage(ses, '/xskb/xsqtkb.do')
      if (queryPage.ok && !queryPage.expired) {
        const $ = load(queryPage.html)
        const templateVal = cleanText($('select[name="kbjcmsid"] option[selected]').first().attr('value') ?? '')
        if (templateVal) kbjcmsid = templateVal
        defaultSemester = cleanText($('select[name="xnxq01id"] option[selected]').first().attr('value') ?? '')
      }
      const effectiveSemester = semester || defaultSemester

      // 2) 班名/班号 → 完整定位参数组（xx04id + xx0301id + jx01ndid + rxnf + bjmc）。
      //    viewtable.do 的 URL 契约要求这一整组参数；仅传班名（非 UUID 的班号/班名）必然查询落空。
      //    教务 cxbj 自动补全接口：POST bjmc=<关键词>&maxRow=10 → { list: [{ bjmc, xx04id, ... }] }
      interface ClassHit {
        xx04id: string
        bjmc: string
        xx0301id?: string
        jx01ndid?: string
        rxnf?: string
        xx0301mc?: string
        zyfxmc?: string
      }
      let hit: ClassHit | null = /^[0-9A-F]{32}$/i.test(classQuery.trim())
        ? { xx04id: classQuery.trim(), bjmc: '' }
        : null
      if (!hit) {
        const lookup = await fetchJwPage(ses, '/xskb/cxbj', {
          method: 'POST',
          form: { bjmc: classQuery, maxRow: '10' },
          referer: `${JW_ROOT}/xskb/xsqtkb.do`,
        })
        if (lookup.ok && !lookup.expired) {
          const body = lookup.html.trim()
          // 2a) JSON 版式：{ list: [{ bjmc, xx04id, xx0301id, jx01ndid, ... }] }
          if (body.startsWith('{') || body.startsWith('[')) {
            try {
              const parsed = JSON.parse(body) as { list?: Array<Record<string, unknown>> }
              const list = Array.isArray(parsed.list) ? parsed.list : []
              const str = (v: unknown): string => (typeof v === 'string' ? cleanText(v) : '')
              const normalized = list
                .map((item) => ({
                  xx04id: str(item.xx04id),
                  bjmc: str(item.bjmc),
                  xx0301id: str(item.xx0301id) || undefined,
                  jx01ndid: str(item.jx01ndid) || undefined,
                  rxnf: str(item.rxnf) || undefined,
                  xx0301mc: str(item.xx0301mc) || undefined,
                  zyfxmc: str(item.zyfxmc) || undefined,
                }))
                .filter((item) => item.xx04id)
              // 优先精确班名，其次互相包含，最后取首条（教务已按关键词模糊返回）
              hit =
                normalized.find((item) => item.bjmc === classQuery) ??
                normalized.find((item) => item.bjmc.includes(classQuery) || classQuery.includes(item.bjmc)) ??
                normalized[0] ??
                null
            } catch {
              // 非 JSON，继续 HTML 兜底
            }
          }
          // 2b) HTML option 版式兜底：<option value="32位UUID">班级名称</option>
          if (!hit) {
            const $lookup = load(lookup.html)
            const candidates: Array<{ value: string; label: string }> = []
            $lookup('option').each((_, opt) => {
              const value = cleanText($lookup(opt).attr('value') ?? '')
              const label = cleanText($lookup(opt).text())
              if (/^[0-9A-F]{32}$/i.test(value)) candidates.push({ value, label })
            })
            const matched =
              candidates.find((c) => c.label === classQuery) ??
              candidates.find((c) => c.label.includes(classQuery) || classQuery.includes(c.label)) ??
              candidates[0]
            if (matched) hit = { xx04id: matched.value, bjmc: matched.label }
          }
        }
      }

      // 3) 以完整参数组直查班级课表（缺失的定位参数留空，由教务端按 xx04id 自行补全）
      const res = await fetchJwPage(ses, '/xskb/viewtable.do', {
        query: {
          xnxq01id: effectiveSemester,
          lx: 'xx04id',
          kbjcmsid,
          xx04id: hit?.xx04id ?? classQuery,
          xx0301id: hit?.xx0301id ?? '',
          rxnf: hit?.rxnf ?? '',
          jx01ndid: hit?.jx01ndid ?? '',
          bjmc: hit?.bjmc ?? classQuery,
        },
      })
      if (res.expired) return expiredResult()
      if (!res.ok) return errorResult(`其他班级课表接口返回 HTTP ${res.status}`)

      const courses = parseOtherClassSchedule(res.html)
      const matchedClassName = hit?.bjmc || classQuery
      const markdown = buildOtherClassMarkdown(courses, effectiveSemester, matchedClassName)
      return buildResult(markdown, {
        classQuery,
        matchedClassName,
        resolvedClassId: hit?.xx04id ?? '',
        semester: effectiveSemester || '当前学期',
        courseCount: courses.length,
        courses,
      })
    }

    // 个人课表：xskb_list.do（周次经通用解析器展开后严格客户端过滤，杜绝串课）
    const res = await fetchJwPage(ses, '/xskb/xskb_list.do', {
      query: { xnxq01id: params.semester, zcd: params.week },
    })
    if (res.expired) return expiredResult()
    if (!res.ok) return errorResult(`个人课表接口返回 HTTP ${res.status}`)

    let courses = parseScheduleCourses(res.html)
    if (params.week) {
      // 严格周次过滤：未在目标周开课的记录坚决丢弃
      courses = courses.filter((c) => c.weekList.length === 0 || c.weekList.includes(params.week as number))
    }
    if (params.isCurrentWeek) {
      // 实时雷达：仅在查询周即当前周时标记「正在上课 / 下节课程预告」
      markOngoingAndNext(courses)
    }
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

/** 解析成绩表为结构化课程数组（旧版式兜底路径） */
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

// ===== 历年成绩通用解析（#dataList 专用，支持表头重复列） =====

/** 历年成绩单条记录（cjcx_list / #dataList 结构） */
export interface GradeRecord {
  /** 开课学期（如 "2025-2026-2"） */
  semester: string
  courseCode: string
  courseName: string
  /** 综合成绩原始文本（可能为 "71"、"优"、"良" 等） */
  score: string
  /** 可数值化时的成绩（优/优秀→95、良/良好→85、中/中等→75、及格/合格/通过→65、不及格/不合格/不通过→50） */
  scoreNumber?: number
  scoreLabel: string
  credit: number
  /** 绩点（教务返回值；缺失时由 scoreNumber 推导） */
  gp?: number
  /** 补重学期（补考/重修记录标注，空为首次修读） */
  makeupSemester: string
  assessMode: string
  examNature: string
  /** 课程属性（必修/选修） */
  courseAttr: string
  /** 课程性质（如 通识必修课程） */
  courseNature: string
  electiveCategory: string
}

/** 五级制/两级制成绩通用映射（兼容单字与双字评级，任意学生通用，无个人耦合） */
const GRADE_WORD_SCORE: Readonly<Record<string, number>> = {
  优: 95,
  优秀: 95,
  良: 85,
  良好: 85,
  中: 75,
  中等: 75,
  及格: 65,
  合格: 65,
  通过: 65,
  不及格: 50,
  不合格: 50,
  不通过: 50,
}

/** 成绩文本与绩点文本统一换算：数值分优先，文本等级走 GRADE_WORD_SCORE，绩点缺失由分数推导。 */
function normalizeGradeScore(
  scoreText: string,
  gpText: string,
): { scoreNumber?: number; gp?: number } {
  const scoreNumber = parseNumber(scoreText) ?? GRADE_WORD_SCORE[scoreText]
  return {
    scoreNumber,
    gp: parseNumber(gpText) ?? (scoreNumber !== undefined ? scoreToGp(scoreNumber) : undefined),
  }
}

/** 解析历年成绩 #dataList 表为结构化记录数组（表头含重复列时按列序消歧） */
export function parseGradeRecords(html: string): GradeRecord[] {
  const $ = load(decodeViewSourceSnapshot(html))
  const $table = $('#dataList').length > 0 ? $('#dataList').first() : null
  if (!$table || $table.length === 0) return []

  // 表头：按出现顺序登记，重复列名追加序号消歧（如两个「课程性质」）
  const headers: string[] = []
  const headerIndexByName = new Map<string, number>()
  $table.find('tr').first().find('th, td').each((idx, th) => {
    const raw = cleanText($(th).text())
    const key = raw || `col${idx}`
    headers.push(key)
    if (!headerIndexByName.has(key)) headerIndexByName.set(key, idx)
  })
  const col = (name: string): number => headerIndexByName.get(name) ?? -1

  const records: GradeRecord[] = []
  $table.find('tr').each((rowIdx, tr) => {
    if (rowIdx === 0) return
    const cells = $(tr).find('td').toArray()
    if (cells.length < 4) return
    const cellText = (idx: number): string => (idx >= 0 && idx < cells.length ? cleanText($(cells[idx]).text()) : '')
    const name = cellText(col('课程名称'))
    if (!name) return
    const scoreText = cellText(col('成绩'))
    const gpText = cellText(col('绩点'))
    const { scoreNumber, gp } = normalizeGradeScore(scoreText, gpText)
    records.push({
      semester: cellText(col('开课学期')),
      courseCode: cellText(col('课程编号')),
      courseName: name,
      score: scoreText,
      scoreNumber,
      scoreLabel: cellText(col('成绩标识')),
      credit: parseNumber(cellText(col('学分'))) ?? 0,
      gp,
      makeupSemester: cellText(col('补重学期')),
      assessMode: cellText(col('考核方式')),
      examNature: cellText(col('考试性质')),
      courseAttr: cellText(col('课程属性')),
      courseNature: cellText(col('课程性质')) !== cellText(col('课程属性')) ? cellText(col('课程性质')) : '',
      electiveCategory: cellText(col('通选课类别')),
    })
  })
  return records
}

/** 单轨 GPA 统计摘要 */
export interface GpaTrackSummary {
  /** 取分策略：latest（同门课取最新） / highest（同门课取最高） */
  strategy: 'latest' | 'highest'
  courseCount: number
  totalCredits: number
  /** 必修课学分（课程属性含「必修」） */
  requiredCredits: number
  weightedAverage: number
  weightedGpa: number
  /** 不及格科目警示清单 */
  failed: Array<{ courseCode: string; courseName: string; semester: string; score: string }>
  /** 本轨采纳的课程记录 */
  records: GradeRecord[]
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/**
 * 补考/重修双轨加权 GPA 统计：
 *   1. 按课程代码（缺失时退化课程名）分组；
 *   2. 最新成绩轨（默认展示）：同门课程取开课学期最新（同学期取靠后记录）的一条；
 *   3. 最高成绩轨（可选切换）：同门课程取绩点/成绩最高的一条（同分取最新）；
 *   4. 分别计算总学分 / 必修学分 / 加权平均分 / 加权平均绩点与不及格警示。
 */
export function buildGpaTracks(records: GradeRecord[]): { latest: GpaTrackSummary; highest: GpaTrackSummary } {
  const groups = new Map<string, GradeRecord[]>()
  for (const record of records) {
    const key = record.courseCode || record.courseName
    if (!key) continue
    const list = groups.get(key) ?? []
    list.push(record)
    groups.set(key, list)
  }

  const buildTrack = (strategy: 'latest' | 'highest'): GpaTrackSummary => {
    const picked: GradeRecord[] = []
    for (const list of groups.values()) {
      const chosen = [...list].sort((a, b) => {
        if (strategy === 'latest') {
          // 开课学期字典序即时间序（"2025-2026-2" > "2025-2026-1"）；补重学期靠后视为更晚
          const sa = `${a.makeupSemester || a.semester}`
          const sb = `${b.makeupSemester || b.semester}`
          return sa === sb ? 0 : sa > sb ? 1 : -1
        }
        // 统一换算为绩点量纲：gp 为 0–5，scoreNumber 为 0–100，不能直接比较
        const ga = a.gp ?? (a.scoreNumber !== undefined ? scoreToGp(a.scoreNumber) : -Infinity)
        const gb = b.gp ?? (b.scoreNumber !== undefined ? scoreToGp(b.scoreNumber) : -Infinity)
        if (ga !== gb) return ga > gb ? 1 : -1
        // 绩点相同先比原始分，仍相同再比学期，落实「同分取最新」业务规则
        const sa = a.scoreNumber ?? -Infinity
        const sb = b.scoreNumber ?? -Infinity
        if (sa !== sb) return sa > sb ? 1 : -1
        const semA = `${a.makeupSemester || a.semester}`
        const semB = `${b.makeupSemester || b.semester}`
        return semA === semB ? 0 : semA > semB ? 1 : -1
      }).at(-1)
      if (chosen) picked.push(chosen)
    }

    let creditSum = 0
    let weightedScoreSum = 0
    let weightedGpSum = 0
    let requiredCredits = 0
    const failed: GpaTrackSummary['failed'] = []
    /** 不及格判定：数值 < 60、绩点为 0，或成绩文本含明确未通过语义 */
    const isFailedScore = (r: GradeRecord): boolean =>
      (r.scoreNumber !== undefined && r.scoreNumber < 60)
      || (r.gp !== undefined && r.gp === 0)
      || /不及格|不合格|不通过|缺考|零分/.test(r.score)
    for (const r of picked) {
      if (r.credit > 0 && r.scoreNumber !== undefined) {
        creditSum += r.credit
        weightedScoreSum += r.credit * r.scoreNumber
        weightedGpSum += r.credit * (r.gp ?? scoreToGp(r.scoreNumber))
        if (r.courseAttr.includes('必修')) requiredCredits += r.credit
      }
      if (isFailedScore(r)) {
        failed.push({ courseCode: r.courseCode, courseName: r.courseName, semester: r.semester, score: r.score })
      }
    }
    return {
      strategy,
      courseCount: picked.length,
      totalCredits: round2(creditSum),
      requiredCredits: round2(requiredCredits),
      weightedAverage: creditSum ? round2(weightedScoreSum / creditSum) : 0,
      weightedGpa: creditSum ? round2(weightedGpSum / creditSum) : 0,
      failed,
      records: picked,
    }
  }

  return { latest: buildTrack('latest'), highest: buildTrack('highest') }
}

/** 构造双轨 GPA 统计 Markdown（最新成绩轨 / 最高成绩轨） */
function buildGpaTracksMarkdown(tracks: { latest: GpaTrackSummary; highest: GpaTrackSummary }, semester: string): string {
  const describe = (t: GpaTrackSummary, label: string): string =>
    [
      `**${label}**：修读 ${t.courseCount} 门 | 总学分 ${t.totalCredits}（必修 ${t.requiredCredits}） | 加权平均分 ${t.weightedAverage} | 加权绩点 **${t.weightedGpa}**`,
    ].join('')
  const failedRows = tracks.latest.failed.map((f) => [f.courseName, f.semester || '—', f.score])
  const failedTable = failedRows.length
    ? mdTable(['不及格科目', '学期', '成绩'], failedRows)
    : '> 🟢 当前无不及格科目记录'
  return [
    `### 📊 ${semester || '全部学期'}成绩单（补考/重修双轨加权）`,
    '',
    describe(tracks.latest, '最新成绩轨（默认）'),
    describe(tracks.highest, '最高成绩轨'),
    '',
    '**不及格科目警示**',
    '',
    failedTable,
    '',
    '**详细课程清单**',
    '',
  ].join('\n')
}

/** 构造成绩明细表（双轨记录复用） */
function buildGradeRecordsTable(records: GradeRecord[]): string {
  const rows = records.map((r) => [
    `**${r.courseName}**`,
    r.semester || '—',
    r.courseAttr || r.courseNature || '—',
    r.credit ? String(r.credit) : '—',
    r.score ? `**${r.score}**` : '—',
    r.gp !== undefined ? String(r.gp) : '—',
    r.makeupSemester ? `补重 ${r.makeupSemester}` : '—',
  ])
  return rows.length
    ? mdTable(['课程名称', '开课学期', '课程属性', '学分', '综合分', '绩点', '补重标记'], rows)
    : '> 未查询到成绩记录'
}

/** Tool 3 分发入口 */
export async function executeGradesDomain(
  ses: Session,
  params: CdutGradesParams,
): Promise<CdutDomainToolResult> {
  try {
    switch (params.action) {
      case 'query_grades': {
        // 青果 cjcx_list 请求负载契约：仅允许 kksj（开课学期）变化，其余字段锁定；
        // kksj 传空字符串 "" 表示查询全部历史成绩。
        const form = {
          kksj: params.semester ?? '',
          kcxz: '',
          kcsx: '',
          kcmc: '',
          xsfs: 'all',
          sfxsbcxq1: '',
          mold: '',
        }
        // 青果网关按 Referer 判定表单来源：缺省沿用框架页会被部分网关判为非法提交并返回空表
        const gradesReferer = `${JW_ROOT}/kscj/cjcx_query`
        const res = await fetchJwPage(ses, '/kscj/cjcx_list', { method: 'POST', form, referer: gradesReferer })
        if (res.expired) return expiredResult()
        if (!res.ok) return errorResult(`成绩单接口返回 HTTP ${res.status}`)

        let records = parseGradeRecords(res.html)
        if (records.length === 0) {
          // 空表兜底 1：预热查询页，刷新页面级瑞数签名与会话后重试一次
          const warmup = await fetchJwPage(ses, '/kscj/cjcx_query')
          if (warmup.expired) return expiredResult()
          const retry = await fetchJwPage(ses, '/kscj/cjcx_list', {
            method: 'POST',
            form,
            referer: gradesReferer,
          })
          if (retry.expired) return expiredResult()
          if (retry.ok) records = parseGradeRecords(retry.html)
        }
        if (records.length === 0) {
          // 空表兜底 2：旧版式 /kscj/cj.do 宽表解析
          const fallback = await fetchJwPage(ses, '/kscj/cj.do', {
            method: 'POST',
            form,
            referer: gradesReferer,
          })
          if (fallback.expired) return expiredResult()
          if (fallback.ok) {
            const legacy = parseGradeCourses(fallback.html).map((c): GradeRecord => {
              const { scoreNumber, gp } = normalizeGradeScore(c.score, c.gp)
              return {
                semester: params.semester ?? '',
                courseCode: '',
                courseName: c.name,
                score: c.score,
                scoreNumber,
                scoreLabel: '',
                credit: c.credit,
                gp,
                makeupSemester: '',
                assessMode: '',
                examNature: '',
                courseAttr: c.category,
                courseNature: '',
                electiveCategory: '',
              }
            })
            if (legacy.length > 0) records = legacy
          }
        }
        // 空表绝不作为「在线成功」返回：避免渲染层以 0 条记录覆盖有效离线缓存
        if (records.length === 0) {
          return errorResult('成绩接口未返回任何记录（会话未就绪或网络波动），已保留本地离线成绩缓存')
        }

        const tracks = buildGpaTracks(records)
        const markdown = [
          buildGpaTracksMarkdown(tracks, params.semester ?? ''),
          buildGradeRecordsTable(records),
        ].join('\n')
        return buildResult(markdown, {
          semester: params.semester ?? '全部学期',
          latest: {
            courseCount: tracks.latest.courseCount,
            totalCredits: tracks.latest.totalCredits,
            requiredCredits: tracks.latest.requiredCredits,
            weightedAverage: tracks.latest.weightedAverage,
            weightedGpa: tracks.latest.weightedGpa,
            failed: tracks.latest.failed,
          },
          highest: {
            courseCount: tracks.highest.courseCount,
            totalCredits: tracks.highest.totalCredits,
            requiredCredits: tracks.highest.requiredCredits,
            weightedAverage: tracks.highest.weightedAverage,
            weightedGpa: tracks.highest.weightedGpa,
            failed: tracks.highest.failed,
          },
          records,
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

/** 期末考场日程单条记录 */
export interface ExamScheduleItem {
  campus: string
  session: string
  courseCode: string
  courseName: string
  teacher: string
  time: string
  room: string
  seat: string
  ticket: string
  remark: string
  form: string
}

/**
 * 解析期末考场日程（xsksap_query / #dataList）：
 * 提取考试场次、课程名称、考试时间、校区、考场（教学楼与教室）、座位号、准考证号。
 * 空数据（未排考）返回空数组，由上层输出友好提示。
 */
export function parseExamSchedule(html: string): ExamScheduleItem[] {
  const $ = load(decodeViewSourceSnapshot(html))
  const $table = $('#dataList').length > 0 ? $('#dataList').first() : null
  if (!$table || $table.length === 0) return []

  const headerIndexByName = new Map<string, number>()
  $table.find('tr').first().find('th, td').each((idx, th) => {
    const raw = cleanText($(th).text())
    const key = raw || `col${idx}`
    if (!headerIndexByName.has(key)) headerIndexByName.set(key, idx)
  })
  const col = (name: string, candidates: string[] = []): number => {
    const direct = headerIndexByName.get(name)
    if (direct !== undefined) return direct
    for (const cand of candidates) {
      const hit = headerIndexByName.get(cand)
      if (hit !== undefined) return hit
    }
    return -1
  }

  const items: ExamScheduleItem[] = []
  $table.find('tr').each((rowIdx, tr) => {
    if (rowIdx === 0) return
    const cells = $(tr).find('td').toArray()
    if (cells.length < 4) return
    const cellText = (idx: number): string => (idx >= 0 && idx < cells.length ? cleanText($(cells[idx]).text()) : '')
    const courseName = cellText(col('课程名称', ['考试科目', '课程']))
    if (!courseName) return
    items.push({
      campus: cellText(col('考试校区', ['校区'])),
      session: cellText(col('考试场次', ['场次'])),
      courseCode: cellText(col('课程编号', ['课程代码'])),
      courseName,
      teacher: cellText(col('授课教师', ['教师'])),
      time: cellText(col('考试时间', ['时间', '日期'])),
      room: cellText(col('考场', ['考试地点', '地点'])),
      seat: cellText(col('座位号', ['座位'])),
      ticket: cellText(col('准考证号', ['准考证'])),
      remark: cellText(col('备注')),
      form: cellText(col('考试形式', ['形式'])) || '期末统考',
    })
  })
  return items
}

/** Tool 4 分发入口 */
export async function executeExamDomain(
  ses: Session,
  params: CdutExamAffairsParams,
): Promise<CdutDomainToolResult> {
  try {
    switch (params.action) {
      case 'query_exam_schedule': {
        // 参数契约：仅允许修改 xnxqid（学期），其余入参锁定
        const res = await fetchJwPage(ses, '/xsks/xsksap_query', { query: { xnxqid: params.semester } })
        if (res.expired) return expiredResult()
        if (!res.ok) return errorResult(`考试日程接口返回 HTTP ${res.status}`)
        const exams = parseExamSchedule(res.html)
        const table = exams.length
          ? mdTable(
              ['考试科目', '考试时间', '考场位置', '座位号', '准考证号', '考试形式'],
              exams.map((e) => [
                `**${e.courseName}**`,
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

/** 空教室节次占用矩阵中的一列（节次区间） */
export interface ClassroomPeriodColumn {
  /** 表头显示文本（如 "01 02"） */
  label: string
  /** 青果 tdvalue 节次编码（如 "0102" / "12" / "091011"） */
  tdvalue: string
  /** 展开的节次编号列表 */
  sections: number[]
  /** 归属星期（1-7；教室周期 jszq 全周矩阵按表头分组，单日版式为 undefined） */
  day?: number
  /** 作息起止（如 "08:10" / "09:45"，可能为空） */
  startTime: string
  endTime: string
  /** 午休空档列（tdKssj=12:00 / tdvalue=12）：12:00-13:55 中午时段，严禁计作「第 12 节课」 */
  isNoonBreak: boolean
}

/** 空教室行：教室 + 各节次区间占用状态 */
export interface ClassroomFreeRoom {
  roomName: string
  capacity: number
  /** 与列一一对应的占用标记（true=占用：红 J 借用或黑 ◆ 排课） */
  occupied: boolean[]
  /** 按天归组的空闲节次（day 缺省归组为 0） */
  freeSectionsByDay: Record<string, number[]>
}

const DAY_NAME_TO_INDEX: Readonly<Record<string, number>> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 7,
  天: 7,
}

/**
 * 解析空教室节次矩阵（jsjy_query2 结果页）：
 *   - 教室周期（jszq）版式：表头三层 = 教室名 / 星期（colspan 分组）/ 节次区间 th[tdvalue]，
 *     7 天 × 6 时段 = 42 列；
 *   - 单日版式：仅一组节次区间列（无星期分组）；
 *   - 单元格出现红字 J（借用占用）或黑 ◆（排课占用）→ 占用；空单元格 → 自习空闲状态。
 */
export function parseClassroomFreeRooms(html: string): { periodColumns: ClassroomPeriodColumn[]; rooms: ClassroomFreeRoom[] } {
  const $ = load(decodeViewSourceSnapshot(html))
  // 定位含节次表头的数据表
  const $pre = $('#dataList').first()
  const $table =
    $pre.length > 0 && $('th[tdvalue]', $pre).length > 0 ? $pre : ($('th[tdvalue]').first().closest('table') as ReturnType<CheerioAPI>)
  if ($table.length === 0) return { periodColumns: [], rooms: [] }

  // 1) 节次区间列（th[tdvalue] 按 DOM 顺序）
  const periodColumns: ClassroomPeriodColumn[] = []
  $('th[tdvalue]', $table).each((_, th) => {
    const $th = $(th)
    const tdvalue = cleanText($th.attr('tdvalue') ?? '')
    if (!tdvalue) return
    const startTime = cleanText($th.attr('tdKssj') ?? '')
    const endTime = cleanText($th.attr('tdJssj') ?? '')
    // 中午 12:00-13:55 空档列：严禁解析为「第 12 节课」，仅作为午休标记
    const isNoonBreak = tdvalue === '12' || startTime === '12:00'
    const sections: number[] = []
    // tdvalue 以两位一组编码节次："0102" → [1,2]，"091011" → [9,10,11]，"12" → [12]
    for (let i = 0; i < tdvalue.length; i += 2) {
      const n = Number(tdvalue.slice(i, i + 2))
      if (Number.isFinite(n) && n > 0) sections.push(n)
    }
    periodColumns.push({
      label: cleanText($th.text()),
      tdvalue,
      sections,
      startTime,
      endTime,
      isNoonBreak,
    })
  })

  // 2) 星期分组：找「星期X」表头行（带 colspan），按 colspan 展开为每列归属日
  const columnDays: number[] = []
  $('tr', $table).each((_, tr) => {
    if (columnDays.length > 0) return
    const dayThs = $(tr)
      .find('th')
      .toArray()
      .filter((th) => /星期[一二三四五六日天]/.test(cleanText($(th).text())))
    if (dayThs.length < 2) return
    const expanded: number[] = []
    for (const th of dayThs) {
      const $th = $(th)
      const span = parseInt($th.attr('colspan') ?? '1', 10) || 1
      const dayText = cleanText($th.text())
      const dayIdx = Object.entries(DAY_NAME_TO_INDEX).find(([name]) => dayText.includes(`星期${name}`))?.[1] ?? 1
      for (let i = 0; i < span; i++) expanded.push(dayIdx)
    }
    if (expanded.length === periodColumns.length) columnDays.push(...expanded)
  })
  if (columnDays.length === periodColumns.length) {
    periodColumns.forEach((col, idx) => {
      col.day = columnDays[idx]
    })
  }

  // 3) 行：首列为教室名（含容量括注），后续占用列与表头一一对应
  const rooms: ClassroomFreeRoom[] = []
  $('tr', $table).each((_, tr) => {
    const $tr = $(tr)
    const $cells = $tr.find('td')
    if ($cells.length !== periodColumns.length + 1) return
    const label = cleanText($cells.first().text())
    if (!label || !/[A-Za-z\d]/.test(label)) return
    const capMatch = label.match(/[（(]\s*(\d{2,4})\s*[/／]\s*\d{2,4}\s*[）)]\s*$/)
    const roomName = cleanText(label.replace(/[（(]\s*\d{2,4}\s*[/／]\s*\d{2,4}\s*[）)]\s*$/, ''))
    if (!roomName) return
    const occupied: boolean[] = []
    const freeSectionsByDay: Record<string, number[]> = {}
    $cells.slice(1).each((cellIdx, cell) => {
      const text = cleanText($(cell).text())
      // 红 Ｊ/J（借用占用）或黑 ◆（排课占用）→ 占用；空单元格 → 空闲
      const isOccupied = /◆|[ＪJ]/.test(text)
      occupied.push(isOccupied)
      const column = periodColumns[cellIdx]
      // 午休列（12:00-13:55）空闲与否不纳入常规教学节次计数
      if (!isOccupied && column && !column.isNoonBreak) {
        const dayKey = String(column.day ?? 0)
        freeSectionsByDay[dayKey] = freeSectionsByDay[dayKey] ?? []
        freeSectionsByDay[dayKey].push(...column.sections)
      }
    })
    rooms.push({
      roomName,
      capacity: capMatch?.[1] ? Number(capMatch[1]) : 0,
      occupied,
      freeSectionsByDay,
    })
  })

  return { periodColumns, rooms }
}

/** 依据日期构造 jsjy_query2 所需的 yyyy-mm-dd 查询日期（默认北京时间当天） */
function buildJsjyDate(dayOfWeek?: number): string {
  const info = getBeijingTimeInfo()
  const pad = (n: number): string => String(n).padStart(2, '0')
  if (!dayOfWeek || dayOfWeek < 1 || dayOfWeek > 7) {
    return `${info.year}-${pad(info.month)}-${pad(info.day)}`
  }
  // 以北京时间当日为基准顺延到目标星期（周一为 1）
  const shift = (dayOfWeek - info.dayOfWeek + 7) % 7
  // midnightMs 已是北京零点，加 8h 后改用 UTC 字段读取，即为目标日的北京日历日
  const target = new Date(info.midnightMs + shift * 86400000 + 8 * 3600000)
  return `${target.getUTCFullYear()}-${pad(target.getUTCMonth() + 1)}-${pad(target.getUTCDate())}`
}

/** 教学楼条目（jsjy_processAjax 动态发现结果） */
export interface ClassroomBuilding {
  /** 楼宇名称（如「东区1教」「甲教A座」） */
  name: string
  /** 楼宇代码（jxlbh，jsjy_query2 POST 请求体必传） */
  code: string
}

/**
 * 动态拉取指定校区全部真实教学楼清单及其 jxlbh 代码。
 * GET /jsxsd/kbxx/jsjy_processAjax?xqid={xqbh}&requestType=jxl&queryType=
 * 兼容 JSON 数组与 HTML option 两种返回版式；失败返回空数组（由调用方兜底）。
 */
export async function fetchCampusBuildings(ses: Session, xqbh: string): Promise<ClassroomBuilding[]> {
  if (!xqbh) return []
  try {
    const res = await fetchJwPage(ses, '/kbxx/jsjy_processAjax', {
      query: { xqid: xqbh, requestType: 'jxl', queryType: '' },
      referer: `${JW_ROOT}/kbxx/jsjy_query`,
    })
    if (!res.ok) return []
    const body = res.html.trim()
    const pick = (name: unknown, code: unknown): ClassroomBuilding | null => {
      const n = cleanText(typeof name === 'string' ? name : '')
      const c = cleanText(typeof code === 'string' ? code : '')
      return n && c ? { name: n, code: c } : null
    }
    // 教务真实返回版式：JSON 数组 [{ dm: "楼宇代码", dmmc: "楼宇名称" }]（AddOptions 消费口径）
    if (body.startsWith('[') || body.startsWith('{')) {
      try {
        const parsed = JSON.parse(body) as unknown
        const list = Array.isArray(parsed) ? parsed : ((parsed as { list?: unknown[] }).list ?? [])
        const buildings: ClassroomBuilding[] = []
        for (const item of list) {
          if (!item || typeof item !== 'object') continue
          const o = item as Record<string, unknown>
          const hit = pick(
            o.dmmc ?? o.jxlmc ?? o.mc ?? o.buildingName ?? o.name,
            o.dm ?? o.jxlbh ?? o.bh ?? o.buildingCode ?? o.code ?? o.id,
          )
          if (hit) buildings.push(hit)
        }
        if (buildings.length > 0) return buildings
      } catch {
        // 非 JSON，继续 HTML 兜底
      }
    }
    // HTML option 版式兜底：<option value="jxlbh">楼名</option>
    const $ = load(res.html)
    const buildings: ClassroomBuilding[] = []
    $('option').each((_, opt) => {
      const code = cleanText($(opt).attr('value') ?? '')
      const name = cleanText($(opt).text())
      if (code && name) buildings.push({ name, code })
    })
    return buildings
  } catch {
    return []
  }
}

/**
 * 楼宇名与教室名的宽松匹配（仅在教务服务端 jxlbh 筛选不可用时的客户端兜底）。
 *
 * 教务返回的教室名与前端楼宇名口径并不一致（如楼宇「甲教A座」对应教室「(宜）甲A101」），
 * 朴素子串匹配必然落空。此处剥离「教/楼/座/栋/馆」等公共字后取显著前缀作为楼宇指纹
 * （甲教A座→甲A、东区9教→东区、乙教→乙、6教→6），再判断教室名是否包含该指纹。
 */
export function buildingMatchesRoom(building: string, roomName: string): boolean {
  const target = cleanText(building)
  const room = cleanText(roomName)
  if (!target || !room) return false
  if (room.includes(target) || target.includes(room)) return true
  const core = target.replace(/[（()）\s]/g, '').replace(/教学|实验楼|大楼|楼|教|座|栋|馆/g, '')
  if (!core) return false
  // 显著字符 ≥2 取前 2 位（东区/甲A/综合）；仅 1 位时直接用该字符（乙/6）
  const key = core.length >= 2 ? core.slice(0, 2) : core
  return room.includes(key)
}

/** 启发式推导当前学期代码（秋学期 7 月-次年 1 月；春学期 2-6 月） */
function guessCurrentSemester(now: Date = new Date()): string {
  const year = now.getFullYear()
  const month = now.getMonth() + 1
  if (month >= 7 || month <= 1) {
    const startYear = month <= 1 ? year - 1 : year
    return `${startYear}-${startYear + 1}-1`
  }
  return `${year - 1}-${year}-2`
}

/** 校区入参：成都校区 / 宜宾校区 */
type CdutCampus = 'chengdu' | 'yibin'

/** 校区中文名 */
function campusLabel(campus: CdutCampus): string {
  return campus === 'yibin' ? '宜宾校区' : '成都校区'
}

/** 空教室结果归一化（供 Markdown 与 JSON 双模输出） */
interface NormalizedRoom {
  roomName: string
  capacity: number
  availableSections: number[]
  hasAirConditioner: boolean
}

/** 判断教室是否满足请求节次：存在任意一天，其空闲节次覆盖全部请求时段 */
function roomSatisfiesSlots(freeSectionsByDay: Record<string, number[]>, slots: number[]): boolean {
  return Object.values(freeSectionsByDay).some((free) => {
    const unique = new Set(free)
    return slots.every((slot) => unique.has(slot))
  })
}

/** Tool 5 分发入口 */
export async function executeClassroomDomain(
  ses: Session,
  params: CdutClassroomParams,
): Promise<CdutDomainToolResult> {
  try {
    // 1) 查询页：拿校区 GUID（xqbh）与当前学期（xnxqh）
    let xqbh = ''
    let semester = ''
    const queryPage = await fetchJwPage(ses, '/kbxx/jsjy_query')
    if (queryPage.ok && !queryPage.expired) {
      const $ = load(queryPage.html)
      const campusLabelKeyword = params.campus === 'yibin' ? '宜宾' : '主校区'
      $('select[name="xqbh"] option').each((_, opt) => {
        if (xqbh) return
        const label = cleanText($(opt).text())
        const value = cleanText($(opt).attr('value') ?? '')
        if (value && label.includes(campusLabelKeyword)) xqbh = value
      })
      semester = cleanText($('input[name="xnxqh"]').first().attr('value') ?? '')
    }
    if (!xqbh) {
      // 查询页解析失败的兜底：按校区关键字使用系统级校区代码（非个人数据）
      xqbh = params.campus === 'yibin' ? '1AB638C5248B4502B1B07E9A29FCB535' : 'EB5F3F57ED784EC1B4A2CB43499787D7'
    }
    if (!semester) semester = guessCurrentSemester()

    // 2) 楼宇动态发现：取得当前校区全部真实楼宇名与 jxlbh 代码（供服务端权威筛选与前台动态楼宇 chips）
    const buildings = await fetchCampusBuildings(ses, xqbh)
    let jxlbh = ''
    if (params.building) {
      const target = params.building
      const hit =
        buildings.find((b) => b.name === target) ??
        buildings.find((b) => b.name.includes(target) || target.includes(b.name))
      jxlbh = hit?.code ?? ''
    }

    // 3) POST jsjy_query2：底层参数映射（typewhere=教室周期 / xqbh 校区 / xnxqh 学期 / 起止日期 / jxlbh 楼宇代码）。
    //    楼宇筛选由教务服务端按 jxlbh 权威完成——此前漏传 jxlbh 且前台子串匹配
    //    '甲教A座' vs '(宜）甲A101' 完全落空，是「仅全部教学楼可用」的根因。
    const dateStr = buildJsjyDate(params.dayOfWeek)
    const res = await fetchJwPage(ses, '/kbxx/jsjy_query2', {
      method: 'POST',
      form: {
        typewhere: 'jszq',
        xnxqh: semester,
        xqbh,
        jxlbh,
        qsrq: dateStr,
        jsrq: dateStr,
        gnq_mh: '',
        jsmc_mh: '',
        syjs0601id: '',
        queryType: '',
      },
    })
    if (res.expired) return expiredResult()
    if (!res.ok) return errorResult(`空闲教室接口返回 HTTP ${res.status}`)

    const { periodColumns, rooms } = parseClassroomFreeRooms(res.html)

    // 4) 归一化 + 节次/容量过滤。
    //    楼宇筛选已由教务服务端按 jxlbh 权威完成；仅当 jxlbh 解析失败时退回客户端子串匹配（尽力而为）。
    let normalized: NormalizedRoom[] = rooms.map((r) => ({
      roomName: r.roomName,
      capacity: r.capacity,
      availableSections: [...new Set(Object.values(r.freeSectionsByDay).flat())].sort((a, b) => a - b),
      hasAirConditioner: /空调/.test(r.roomName),
    }))
    if (params.building && !jxlbh) {
      // jxlbh 解析失败（或演示态）时的客户端兜底：使用宽松楼宇指纹匹配，杜绝朴素子串必然落空
      normalized = normalized.filter((r) => buildingMatchesRoom(params.building ?? '', r.roomName))
    }
    if (params.action === 'query_room_occupancy' && params.building) {
      const rows = normalized.map((r) => [
        `📍 **${r.roomName}**`,
        r.capacity ? `${r.capacity} 座` : '—',
        r.availableSections.length ? `第 ${r.availableSections.join(', ')} 节空闲` : '全时段占用',
      ])
      const table = rows.length
        ? mdTable(['教室', '座位容量', '空闲节次'], rows)
        : '> 未查询到指定教室占用信息'
      const markdown = `### 🚪 ${campusLabel(params.campus)}【${params.building}】教室占用明细（${dateStr}）\n\n${table}`
      return buildResult(markdown, { campus: params.campus, building: params.building, date: dateStr, semester, buildings, rooms: normalized })
    }

    if (params.timeSlots && params.timeSlots.length > 0) {
      // 存在任意一天其空闲节次覆盖全部请求时段即命中（按原始 freeSectionsByDay 判定）
      const byName = new Map(rooms.map((r) => [r.roomName, r]))
      normalized = normalized.filter((r) => {
        const source = byName.get(r.roomName)
        return source ? roomSatisfiesSlots(source.freeSectionsByDay, params.timeSlots!) : r.availableSections.length > 0
      })
    }
    if (params.minSeats && params.minSeats > 0) {
      normalized = normalized.filter((r) => r.capacity >= (params.minSeats ?? 0))
    }

    // 节次区间文案：午休列明确标注为中午时段，严禁称「第 12 节课」
    const periodText = periodColumns
      .map((p) => (p.isNoonBreak ? '中午(12:00-13:55)' : p.label.replace(/\s+/g, '-')))
      .filter(Boolean)
      .join(' / ')
    const rows = normalized.map((r) => [
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
      `### 🏫 ${campusLabel(params.campus)}${scope}空闲自习室（${dateStr}）`,
      '',
      `- **匹配空闲教室**：**${normalized.length} 间可用**`,
      periodText ? `- **节次区间**：${periodText}` : '',
      '',
      table,
    ]
      .filter((line) => line !== '')
      .join('\n')

    return buildResult(markdown, {
      campus: params.campus,
      building: params.building ?? '',
      date: dateStr,
      semester,
      buildings,
      emptyRooms: normalized,
    })
  } catch (err) {
    return errorResult(`空闲教室查询失败：${networkError(err)}`)
  }
}

// ===== Tool 6：培养方案与毕业学分 =====

/** 培养方案课程条目 */
export interface CurriculumPlanCourse {
  module: string
  courseCode: string
  courseName: string
  credit: number
  /** 完成状态：completed（已修，含成绩）/ pending（未修） */
  status: 'completed' | 'pending'
  /** 已修成绩（未修时为空） */
  score?: string
  /** 建议修读学期（开设学期） */
  semester: string
  /** 课程性质（如 专业核心课程） */
  nature: string
  /** 课程属性（必修/选修） */
  attr: string
}

/** 培养方案模块（通识必修 / 学科基础 / 专业核心 / 实践环节 等） */
export interface CurriculumPlanModule {
  name: string
  /** 模块应修学分（来自「应修 X / 已修 Y」注记） */
  requiredCredits?: number
  /** 模块已修学分注记 */
  completedCredits?: number
  courses: CurriculumPlanCourse[]
}

/**
 * 解析培养方案与完成情况（topyfamx / 嵌套 #mxh 表）：
 *   - 第一列 rowspan 合并的课程体系单元格携带模块名与「(应修 X / 已修 Y)」注记；
 *   - 完成情况列：出现「已修(成绩)」→ completed，空 → pending；
 *   - 通用模块归类，严禁与任何特定专业/模块名硬编码耦合。
 */
export function parseCurriculumPlan(html: string): { title: string; modules: CurriculumPlanModule[] } {
  const $ = load(decodeViewSourceSnapshot(html))
  const title = cleanText($('table#dataList caption').first().text()) || cleanText($('caption').first().text())

  // 定位嵌套明细表：#mxh 优先，兜底为包含「课程编号」表头的表格
  let $target = $('table#mxh').first()
  if ($target.length === 0) {
    $('table').each((_, table) => {
      if ($target.length > 0) return
      if (cleanText($(table).find('th').first().text()).includes('课程体系')) $target = $(table)
    })
  }
  if ($target.length === 0) return { title, modules: [] }

  const grid = parseTableToGrid($target, $)
  if (grid.length === 0) return { title, modules: [] }

  // 表头行 = 含「课程编号」的行；列索引按表头名定位
  const headerRowIdx = grid.findIndex((row) => row.some((c) => c === '课程编号' || c.includes('课程编号')))
  if (headerRowIdx < 0) return { title, modules: [] }
  const header = grid[headerRowIdx] ?? []
  const colIdx = (name: string): number => header.findIndex((h) => h === name || h.includes(name))

  const moduleCol = 0 // rowspan 填充后的课程体系列恒为首列
  const codeCol = colIdx('课程编号')
  const nameCol = colIdx('课程名称')
  const statusCol = colIdx('完成情况')
  const natureCol = colIdx('课程性质')
  const attrCol = colIdx('课程属性')
  const creditCol = colIdx('学分')
  const semesterCol = colIdx('开设学期')

  const modules: CurriculumPlanModule[] = []
  const moduleByText = new Map<string, CurriculumPlanModule>()

  // 表头可能占两行（首行 rowspan=2 + 次行 colspan 分组），虚拟网格填充后第二行会
  // 重复携带「课程体系 / 课程编号 / 课程名称」等表头文案，必须整体剔除，
  // 否则会凭空解析出一个名为「课程体系」、课程名为「课程名称」的幽灵模块。
  const HEADER_ROW_LABELS = /^(课程体系|选课组|课程编号|课程名称|完成情况|课程性质|课程属性|学分|学时|学时分类|开设学期|考核方式|备注)$/
  const isHeaderRow = (row: string[]): boolean => {
    const cells = row.filter((c) => c && c.trim() !== '')
    if (cells.length === 0) return true
    const labelCount = cells.filter((c) => HEADER_ROW_LABELS.test(cleanText(c))).length
    // 过半单元格都是表头文案 → 判定为表头行
    return labelCount >= Math.max(2, Math.ceil(cells.length / 2))
  }

  for (let r = headerRowIdx + 1; r < grid.length; r++) {
    const row = grid[r] ?? []
    if (isHeaderRow(row)) continue
    const moduleText = cleanText(row[moduleCol] ?? '')
    const code = codeCol >= 0 ? cleanText(row[codeCol] ?? '') : ''
    const courseName = nameCol >= 0 ? cleanText(row[nameCol] ?? '') : ''
    // 结构行过滤：表格底部的统计汇总结算行（课程体系/小计/合计/总计/最低修读/备注）
    // 不是真实课程条目，严禁误解析进课程清单
    if (!courseName || /^(课程体系|小计|合计|总计|最低修读|备注)/.test(courseName)) continue

    // 模块归属：rowspan 填充使模块文本在每行重复出现，按文本分组即可
    let module: CurriculumPlanModule | undefined
    if (moduleText) {
      const nameOnly = cleanText(moduleText.replace(/[（(]应修[\s\S]*$/, ''))
      module = moduleByText.get(nameOnly)
      if (!module) {
        const req = moduleText.match(/应修\s*(\d+(?:\.\d+)?)/)
        const done = moduleText.match(/已修\s*(\d+(?:\.\d+)?)/)
        module = {
          name: nameOnly,
          requiredCredits: req?.[1] ? Number(req[1]) : undefined,
          completedCredits: done?.[1] ? Number(done[1]) : undefined,
          courses: [],
        }
        moduleByText.set(nameOnly, module)
        modules.push(module)
      }
    }

    const statusText = statusCol >= 0 ? cleanText(row[statusCol] ?? '') : ''
    const completed = /已修/.test(statusText)
    const scoreMatch = statusText.match(/已修\s*[（(]\s*(\d+(?:\.\d+)?)\s*[）)]?/)
    const course: CurriculumPlanCourse = {
      module: module?.name ?? '',
      courseCode: code,
      courseName,
      credit: creditCol >= 0 ? (parseNumber(row[creditCol] ?? '') ?? 0) : 0,
      status: completed ? 'completed' : 'pending',
      score: completed ? (scoreMatch?.[1] ?? statusText.replace(/[^0-9.]/g, '')) : undefined,
      semester: semesterCol >= 0 ? cleanText(row[semesterCol] ?? '') : '',
      nature: natureCol >= 0 ? cleanText(row[natureCol] ?? '') : '',
      attr: attrCol >= 0 ? cleanText(row[attrCol] ?? '') : '',
    }
    if (module) module.courses.push(course)
  }

  // 剔除无任何课程条目的空模块（表头残留、结构行等噪声产生的幽灵模块）
  return { title, modules: modules.filter((m) => m.courses.length > 0) }
}

/** 构造培养方案 Markdown（模块化呈现 + 已修/未修全景） */
function buildCurriculumPlanMarkdown(plan: { title: string; modules: CurriculumPlanModule[] }): string {
  const lines: string[] = [`### 📘 培养方案与教学计划${plan.title ? `\n\n> ${plan.title}` : ''}`, '']
  for (const module of plan.modules) {
    const progress =
      module.requiredCredits !== undefined
        ? `（应修 ${module.requiredCredits} / 已修 ${module.completedCredits ?? 0}）`
        : ''
    lines.push(`**${module.name}**${progress}`)
    const rows = module.courses.map((c) => [
      c.courseCode || '—',
      `**${c.courseName}**`,
      c.credit ? String(c.credit) : '—',
      c.status === 'completed' ? `✅ 已修${c.score ? `(${c.score})` : ''}` : '⏳ 未修',
      c.semester || '—',
    ])
    lines.push(
      rows.length
        ? mdTable(['课程代码', '课程名称', '学分', '完成状态', '开设学期'], rows)
        : '> 该模块暂无课程明细',
    )
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

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
        const plan = parseCurriculumPlan(res.html)
        const markdown = buildCurriculumPlanMarkdown(plan)
        const filtered = params.moduleName
          ? plan.modules.filter((m) => m.name.includes(params.moduleName ?? ''))
          : plan.modules
        return buildResult(markdown, { title: plan.title, modules: filtered })
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
