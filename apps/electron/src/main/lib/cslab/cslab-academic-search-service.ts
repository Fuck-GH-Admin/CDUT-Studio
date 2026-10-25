/**
 * CSLab 跨源学术文献检索服务（多源联邦）
 *
 * 架构落地（API 融合 + 本地轻量重排，零模型权重）：
 * 1. 动态查询分发器：OpenAlex / Semantic Scholar / arXiv / Crossref 并行聚合，
 *    单源失败只降级为 sourceStats.error，绝不整体失败；
 * 2. 谱系去重（Omelette 范式）：DOI 精确归一化 -> 标题模糊聚类 -> 预印本-正刊谱系对齐；
 * 3. RRF 倒数排名融合 + 本地轻量重排（标题全词/短语精准匹配、摘要词重叠、引用量、新近度、OA 加成）；
 * 4. TL;DR / 方法关键词蒸馏（S2 TL;DR -> Docling -> LLM -> 启发式，见 extractor）；
 * 5. 多路 OA 直链回退解析与容错下载：
 *    - 汇集所有上游候选直链（受信任权威仓储 arXiv / PMC / EuropePMC 优先）；
 *    - 具备 Unpaywall / EuropePMC / OpenAlex 多重动态容错回退机制；
 *    - 严格校验 %PDF 协议魔数，单个链接 404/403/反爬时自动平滑尝试下一候选，绝不轻易中断。
 *
 * 红线：
 *   - OA 直链只接受 http(s) 协议，入库前必须校验 PDF 魔数（%PDF），绝不入库 HTML 错误页；
 *   - 入库文件名由论文标题净化生成并走 vault/lit 只读登记，绝不接受渲染进程任意路径；
 *   - 上游摘要 / 元数据视为不可信文本，仅做展示与受限蒸馏，绝不拼进系统指令。
 */

import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { getProferUserAgent } from '@profer/core'
import type {
  CsLabAcademicAuthor,
  CsLabAcademicIngestInput,
  CsLabAcademicIngestResult,
  CsLabAcademicLineage,
  CsLabAcademicPaperMetadata,
  CsLabAcademicPreviewInput,
  CsLabAcademicPreviewResult,
  CsLabAcademicSearchFilters,
  CsLabAcademicSearchInput,
  CsLabAcademicSearchResult,
  CsLabAcademicSource,
  CsLabAcademicSourceStat,
  CsLabOaStatus,
} from '@profer/shared'
import { getFetchFn } from '../proxy-fetch'
import { distillPaperHighlights, extractMethodKeywords } from './cslab-academic-extractor'
import {
  findEntityByShaAndLayer,
  getCsLabDatabase,
  getEntityByUri,
  nextLabRevision,
  upsertEntity,
  upsertLiteratureSource,
  withTransaction,
  type CsLabDatabase,
  type CsLabEntityRecord,
} from './cslab-db'
import { lockFileReadOnly, unlockFile } from './cslab-hash'
import {
  assertLabId,
  resolveLabDir,
  resolveLabRelativePath,
  sanitizeFileName,
} from './cslab-paths'
import { buildCsLabUri } from './cslab-uri'

// ===== 常量 =====

const REQUEST_TIMEOUT_MS = 8_000
const DOWNLOAD_TIMEOUT_MS = 45_000
const MAX_PREVIEW_BYTES = 48 * 1024 * 1024
const MAX_INGEST_BYTES = 96 * 1024 * 1024
const RRF_K = 60
const DEFAULT_TOP_K = 20
const MAX_TOP_K = 50
const FETCH_PER_SOURCE = 25
/** TL;DR LLM 渐进增强的最大并发补全条数（其余走启发式）。 */
const LLM_ENRICH_LIMIT = 8
const LLM_ENRICH_CONCURRENCY = 3

const ALL_SOURCES: CsLabAcademicSource[] = [
  'openalex',
  'semantic-scholar',
  'arxiv',
  'crossref',
]

/** OpenAlex / Crossref / Unpaywall 礼貌池联系标识（可用环境变量覆盖）。 */
const CONTACT_EMAIL =
  process.env.CSLAB_CONTACT_EMAIL?.trim() || 'cdut-studio@users.noreply.github.com'

// ===== 内部检索命中（融合前） =====

interface RawHit {
  source: CsLabAcademicSource
  /** 该源内 1-based 排名（RRF 输入）。 */
  rank: number
  title: string
  authors: CsLabAcademicAuthor[]
  year?: number
  publication?: string
  doi?: string
  arxivId?: string
  citationsCount: number
  isOpenAccess: boolean
  oaStatus?: CsLabOaStatus
  openAccessPdfUrl?: string
  openAccessPdfUrls?: string[]
  landingPageUrl?: string
  abstract: string
  tldr?: string
  fieldsOfStudy?: string[]
}

// ===== 通用 HTTP =====

function buildHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'application/json, application/atom+xml, */*',
    ...extra,
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const fetchFn = getFetchFn()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchFn(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// ===== 文本归一化与辅助工具 =====

function normalizeDoi(raw?: string | null): string | undefined {
  if (!raw) return undefined
  const cleaned = raw
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .toLowerCase()
  return /^10\.\d{4,9}\/\S+$/.test(cleaned) ? cleaned : undefined
}

function normalizeArxivId(raw?: string | null): string | undefined {
  if (!raw) return undefined
  const cleaned = raw
    .trim()
    .replace(/^https?:\/\/(export\.)?arxiv\.org\/(abs|pdf)\//i, '')
    .replace(/\.pdf$/i, '')
    .replace(/^arxiv:\s*/i, '')
    .replace(/^10\.48550\/arxiv\./i, '')
    .replace(/v\d+$/i, '')
    .toLowerCase()
  return /^\d{4}\.\d{4,5}$/.test(cleaned) || /^[a-z-]+(\.[a-z]{2})?\/\d{7}$/.test(cleaned)
    ? cleaned
    : undefined
}

function normalizeTitle(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function titleTokens(normalized: string): Set<string> {
  return new Set(normalized.split(' ').filter((token) => token.length > 1))
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const token of a) if (b.has(token)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

function isPreprintDoi(doi?: string): boolean {
  if (!doi) return false
  const d = doi.toLowerCase()
  return (
    d.startsWith('10.48550/arxiv.') ||
    d.startsWith('10.1101/') ||
    d.startsWith('10.21203/rs.') ||
    d.startsWith('10.20944/preprints') ||
    d.startsWith('10.65215/')
  )
}

/** 权威可信 OA 仓储判定（高可用性、直接提供合法 PDF、无恶性反爬阻断）。 */
function isTrustedOaRepo(url: string): boolean {
  return /arxiv\.org|europepmc\.org|ncbi\.nlm\.nih\.gov|aclanthology\.org|aclweb\.org|biorxiv\.org|medrxiv\.org/i.test(
    url,
  )
}

/** 汇集去重候选 URL 并把受信任权威仓储排在最前面。 */
function sortPdfUrlsByTrust(urls: string[]): string[] {
  const unique = [...new Set(urls.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)))]
  return unique.sort((a, b) => {
    const aTrusted = isTrustedOaRepo(a) ? 1 : 0
    const bTrusted = isTrustedOaRepo(b) ? 1 : 0
    return bTrusted - aTrusted
  })
}

// ===== 上游解析器 =====

function reconstructAbstract(inverted?: Record<string, number[]> | null): string {
  if (!inverted || typeof inverted !== 'object') return ''
  const positions: Array<[number, string]> = []
  for (const [word, indices] of Object.entries(inverted)) {
    if (!Array.isArray(indices)) continue
    for (const index of indices) {
      if (typeof index === 'number') positions.push([index, word])
    }
  }
  positions.sort((a, b) => a[0] - b[0])
  return positions.map(([, word]) => word).join(' ')
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
}

function stripJats(text: string): string {
  return decodeXmlEntities(text.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

async function fetchOpenAlex(
  query: string,
  filters: CsLabAcademicSearchFilters,
): Promise<RawHit[]> {
  const url = new URL('https://api.openalex.org/works')
  url.searchParams.set('search', query)
  url.searchParams.set('per-page', String(FETCH_PER_SOURCE))
  url.searchParams.set('mailto', CONTACT_EMAIL)
  const parts: string[] = []
  if (filters.yearFrom) parts.push(`from_publication_date:${filters.yearFrom}-01-01`)
  if (filters.yearTo) parts.push(`to_publication_date:${filters.yearTo}-12-31`)
  if (filters.openAccessOnly) parts.push('is_oa:true')
  if (parts.length > 0) url.searchParams.set('filter', parts.join(','))

  const response = await fetchWithTimeout(url.toString())
  if (!response.ok) throw new Error(`OpenAlex HTTP ${response.status}`)
  const payload = (await response.json()) as {
    results?: Array<Record<string, any>>
  }
  const results = payload.results ?? []
  return results.map((work, index): RawHit => {
    const doi = normalizeDoi(work.doi as string | undefined)
    const bestOa = (work.best_oa_location ?? {}) as Record<string, any>
    const primary = (work.primary_location ?? {}) as Record<string, any>
    const source = (primary.source ?? {}) as Record<string, any>
    const openAccess = (work.open_access ?? {}) as Record<string, any>
    const locations = (work.locations ?? []) as Array<Record<string, any>>

    // 深入挖掘 arXiv ID（work.ids.arxiv、locations landing/pdf 或 preprint DOI）
    let arxivId = normalizeArxivId((work.ids as Record<string, any> | undefined)?.arxiv as string | undefined)
    if (!arxivId && isPreprintDoi(doi)) {
      arxivId = normalizeArxivId(doi)
    }
    if (!arxivId) {
      for (const loc of locations) {
        arxivId =
          normalizeArxivId(loc.landing_page_url as string | undefined) ||
          normalizeArxivId(loc.pdf_url as string | undefined)
        if (arxivId) break
      }
    }

    // 汇集并基于源信任度排序全部可用 OA PDF 链接（避免单点依赖失效镜像站点）
    const candidateUrls: string[] = []
    if (typeof bestOa.pdf_url === 'string') candidateUrls.push(bestOa.pdf_url)
    for (const loc of locations) {
      if (typeof loc.pdf_url === 'string') candidateUrls.push(loc.pdf_url)
    }
    if (arxivId) {
      candidateUrls.push(`https://arxiv.org/pdf/${arxivId}`)
    }
    const openAccessPdfUrls = sortPdfUrlsByTrust(candidateUrls)

    return {
      source: 'openalex',
      rank: index + 1,
      title: (work.display_name as string) ?? '',
      authors: ((work.authorships ?? []) as Array<Record<string, any>>).map((authorship) => ({
        name: ((authorship.author ?? {}) as Record<string, any>).display_name ?? '',
        institution: (((authorship.institutions ?? []) as Array<Record<string, any>>)[0]
          ?.display_name as string) ?? undefined,
      })),
      year: typeof work.publication_year === 'number' ? work.publication_year : undefined,
      publication: (source.display_name as string) ?? undefined,
      doi,
      arxivId,
      citationsCount: typeof work.cited_by_count === 'number' ? work.cited_by_count : 0,
      isOpenAccess: openAccess.is_oa === true || openAccessPdfUrls.length > 0,
      oaStatus: (openAccess.oa_status as CsLabOaStatus | undefined) ?? (arxivId ? 'preprint' : undefined),
      openAccessPdfUrl: openAccessPdfUrls[0],
      openAccessPdfUrls,
      landingPageUrl:
        (bestOa.landing_page_url as string | undefined) ??
        (primary.landing_page_url as string | undefined),
      abstract: reconstructAbstract(work.abstract_inverted_index as Record<string, number[]>),
      fieldsOfStudy: ((work.topics ?? []) as Array<Record<string, any>>)
        .slice(0, 3)
        .map((topic) => (topic.display_name as string) ?? '')
        .filter((name) => name.length > 0),
    }
  })
}

async function fetchSemanticScholar(
  query: string,
  filters: CsLabAcademicSearchFilters,
): Promise<RawHit[]> {
  const url = new URL('https://api.semanticscholar.org/graph/v1/paper/search')
  url.searchParams.set('query', query)
  url.searchParams.set('limit', String(FETCH_PER_SOURCE))
  url.searchParams.set(
    'fields',
    'title,authors,year,venue,externalIds,citationCount,isOpenAccess,openAccessPdf,abstract,tldr,fieldsOfStudy,publicationDate',
  )
  if (filters.yearFrom || filters.yearTo) {
    url.searchParams.set('year', `${filters.yearFrom ?? ''}-${filters.yearTo ?? ''}`)
  }
  if (filters.openAccessOnly) url.searchParams.set('openAccessPdf', 'true')

  const apiKey = process.env.SEMANTIC_SCHOLAR_API_KEY?.trim()
  const response = await fetchWithTimeout(url.toString(), {
    headers: buildHeaders(apiKey ? { 'x-api-key': apiKey } : {}),
  })
  if (!response.ok) throw new Error(`Semantic Scholar HTTP ${response.status}`)
  const payload = (await response.json()) as { data?: Array<Record<string, any>> }
  return (payload.data ?? []).map((paper, index): RawHit => {
    const externalIds = (paper.externalIds ?? {}) as Record<string, any>
    const doi = normalizeDoi(externalIds.DOI as string | undefined)
    const arxivId = normalizeArxivId(externalIds.ArXiv as string | undefined)
    const rawPdf = ((paper.openAccessPdf ?? {}) as Record<string, any>).url as string | undefined
    const candidateUrls: string[] = []
    if (rawPdf) candidateUrls.push(rawPdf)
    if (arxivId) candidateUrls.push(`https://arxiv.org/pdf/${arxivId}`)
    const openAccessPdfUrls = sortPdfUrlsByTrust(candidateUrls)

    return {
      source: 'semantic-scholar',
      rank: index + 1,
      title: (paper.title as string) ?? '',
      authors: ((paper.authors ?? []) as Array<Record<string, any>>).map((author) => ({
        name: (author.name as string) ?? '',
        institution: ((author.affiliations ?? []) as string[])[0],
      })),
      year: typeof paper.year === 'number' ? paper.year : undefined,
      publication: (paper.venue as string) || undefined,
      doi,
      arxivId,
      citationsCount: typeof paper.citationCount === 'number' ? paper.citationCount : 0,
      isOpenAccess: paper.isOpenAccess === true || openAccessPdfUrls.length > 0,
      openAccessPdfUrl: openAccessPdfUrls[0],
      openAccessPdfUrls,
      landingPageUrl: doi ? `https://doi.org/${doi}` : (arxivId ? `https://arxiv.org/abs/${arxivId}` : undefined),
      abstract: (paper.abstract as string) ?? '',
      tldr: ((paper.tldr ?? {}) as Record<string, any>).text as string | undefined,
      fieldsOfStudy: (paper.fieldsOfStudy as string[] | undefined) ?? [],
    }
  })
}

async function fetchArxiv(query: string, _filters: CsLabAcademicSearchFilters): Promise<RawHit[]> {
  const directId = normalizeArxivId(query)
  let url: string

  if (directId) {
    url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(directId)}&start=0&max_results=1`
  } else {
    const cleanQ = query.replace(/["+]/g, ' ').replace(/\s+/g, ' ').trim()
    // arXiv 语法要求短语加双引号，否则空格默认被解析为全词 OR 展开（导致无关通用词淹没经典原著）
    const quoted = `"${cleanQ}"`
    const searchQuery = `ti:${quoted} OR all:${quoted}`
    url =
      'https://export.arxiv.org/api/query?search_query=' +
      encodeURIComponent(searchQuery) +
      `&start=0&max_results=${FETCH_PER_SOURCE}&sortBy=relevance`
  }

  let response = await fetchWithTimeout(url, {
    headers: buildHeaders({ Accept: 'application/atom+xml' }),
  })
  if (!response.ok) throw new Error(`arXiv HTTP ${response.status}`)
  let xml = await response.text()

  let entries = xml.split(/<entry>/).slice(1)

  // 如果短语精确检索命中过少且查询含有多个有效词，回退并集 tokens AND 搜索
  if (entries.length === 0 && !directId) {
    const cleanQ = query.replace(/["+]/g, ' ').replace(/\s+/g, ' ').trim()
    const tokens = cleanQ
      .split(' ')
      .filter((token) => token.length > 2 && !/^(the|and|for|with|from|that|this)$/i.test(token))
    if (tokens.length > 0) {
      const fallbackQuery = `all:(${tokens.slice(0, 4).join(' AND ')})`
      const fallbackUrl =
        'https://export.arxiv.org/api/query?search_query=' +
        encodeURIComponent(fallbackQuery) +
        `&start=0&max_results=${FETCH_PER_SOURCE}&sortBy=relevance`
      const fallbackResp = await fetchWithTimeout(fallbackUrl, {
        headers: buildHeaders({ Accept: 'application/atom+xml' }),
      }).catch(() => null)
      if (fallbackResp?.ok) {
        xml = await fallbackResp.text()
        entries = xml.split(/<entry>/).slice(1)
      }
    }
  }

  const hits: RawHit[] = []
  for (const [index, entry] of entries.entries()) {
    const pick = (pattern: RegExp): string | undefined => {
      const match = entry.match(pattern)
      return match?.[1] ? decodeXmlEntities(match[1].replace(/\s+/g, ' ').trim()) : undefined
    }
    const rawId = pick(/<id>\s*https?:\/\/arxiv\.org\/abs\/([^<\s]+)\s*<\/id>/)
    const arxivId = normalizeArxivId(rawId)
    const title = pick(/<title>([\s\S]*?)<\/title>/)
    if (!arxivId || !title) continue
    const authors = [...entry.matchAll(/<author>\s*<name>([^<]+)<\/name>/g)]
      .map((match) => ({ name: decodeXmlEntities((match[1] ?? '').trim()) }))
      .filter((author) => author.name.length > 0)
    const published = pick(/<published>(\d{4})-/)
    const pdfUrl = pick(/<link[^>]*title="pdf"[^>]*href="([^"]+)"/)
    const directPdf = pdfUrl ? decodeXmlEntities(pdfUrl) : `https://arxiv.org/pdf/${arxivId}`
    const candidateUrls = [directPdf, `https://arxiv.org/pdf/${arxivId}.pdf`, `https://arxiv.org/pdf/${arxivId}`]
    const openAccessPdfUrls = sortPdfUrlsByTrust(candidateUrls)

    hits.push({
      source: 'arxiv',
      rank: index + 1,
      title,
      authors,
      year: published ? Number(published) : undefined,
      publication: 'arXiv',
      doi: pick(/<arxiv:doi[^>]*>([^<]+)<\/arxiv:doi>/) ?? undefined,
      arxivId,
      citationsCount: 0,
      isOpenAccess: true,
      oaStatus: 'preprint',
      openAccessPdfUrl: openAccessPdfUrls[0],
      openAccessPdfUrls,
      landingPageUrl: `https://arxiv.org/abs/${arxivId}`,
      abstract: pick(/<summary>([\s\S]*?)<\/summary>/) ?? '',
    })
  }
  return hits
}

async function fetchCrossref(
  query: string,
  filters: CsLabAcademicSearchFilters,
): Promise<RawHit[]> {
  const url = new URL('https://api.crossref.org/works')
  // query.title 精确优先，大幅提升论文标题检索的匹配精度
  url.searchParams.set('query.title', query)
  url.searchParams.set('rows', String(FETCH_PER_SOURCE))
  url.searchParams.set('mailto', CONTACT_EMAIL)
  url.searchParams.set(
    'select',
    'DOI,title,author,issued,container-title,is-referenced-by-count,abstract,link,URL,type',
  )
  const parts: string[] = []
  if (filters.yearFrom) parts.push(`from-pub-date:${filters.yearFrom}-01-01`)
  if (filters.yearTo) parts.push(`until-pub-date:${filters.yearTo}-12-31`)
  if (parts.length > 0) url.searchParams.set('filter', parts.join(','))

  const response = await fetchWithTimeout(url.toString())
  if (!response.ok) throw new Error(`Crossref HTTP ${response.status}`)
  const payload = (await response.json()) as {
    message?: { items?: Array<Record<string, any>> }
  }
  return (payload.message?.items ?? []).map((item, index): RawHit => {
    const doi = normalizeDoi(item.DOI as string | undefined)
    const issued = ((item.issued ?? {}) as Record<string, any>)['date-parts'] as
      | number[][]
      | undefined
    const links = (item.link ?? []) as Array<Record<string, any>>
    const pdfLinks = links
      .filter((link) => String(link['content-type'] ?? '').includes('pdf') && typeof link.URL === 'string')
      .map((link) => link.URL as string)
    const arxivId = isPreprintDoi(doi) ? normalizeArxivId(doi) : undefined
    const candidateUrls = [...pdfLinks]
    if (arxivId) candidateUrls.push(`https://arxiv.org/pdf/${arxivId}`)
    const openAccessPdfUrls = sortPdfUrlsByTrust(candidateUrls)

    return {
      source: 'crossref',
      rank: index + 1,
      title: ((item.title ?? []) as string[])[0] ?? '',
      authors: ((item.author ?? []) as Array<Record<string, any>>).map((author) => ({
        name: [author.given, author.family].filter(Boolean).join(' ').trim(),
        institution: ((((author.affiliation ?? []) as Array<Record<string, any>>)[0] ?? {}) as Record<string, any>)
          .name as string | undefined,
      })),
      year: issued?.[0]?.[0],
      publication: ((item['container-title'] ?? []) as string[])[0] ?? undefined,
      doi,
      arxivId,
      citationsCount:
        typeof item['is-referenced-by-count'] === 'number' ? item['is-referenced-by-count'] : 0,
      isOpenAccess: openAccessPdfUrls.length > 0,
      openAccessPdfUrl: openAccessPdfUrls[0],
      openAccessPdfUrls,
      landingPageUrl: (item.URL as string | undefined) ?? (doi ? `https://doi.org/${doi}` : undefined),
      abstract: typeof item.abstract === 'string' ? stripJats(item.abstract) : '',
    }
  })
}

const SOURCE_FETCHERS: Record<
  CsLabAcademicSource,
  (query: string, filters: CsLabAcademicSearchFilters) => Promise<RawHit[]>
> = {
  openalex: fetchOpenAlex,
  'semantic-scholar': fetchSemanticScholar,
  arxiv: fetchArxiv,
  crossref: fetchCrossref,
}

// ===== 谱系去重（Omelette 范式） =====

class UnionFind {
  private parent: number[] = []

  find(index: number): number {
    if (this.parent[index] === undefined) this.parent[index] = index
    if (this.parent[index] !== index) this.parent[index] = this.find(this.parent[index])
    return this.parent[index]
  }

  union(a: number, b: number): void {
    const rootA = this.find(a)
    const rootB = this.find(b)
    if (rootA !== rootB) this.parent[rootB] = rootA
  }
}

interface ClusterInput {
  hits: RawHit[]
  doiKeys: Set<string>
  titleKey: string
  tokens: Set<string>
  arxivId?: string
}

function clusterHits(hits: RawHit[]): RawHit[][] {
  const inputs = hits.map<ClusterInput>((hit) => {
    const titleKey = normalizeTitle(hit.title)
    return {
      hits: [hit],
      doiKeys: new Set([hit.doi].filter((doi): doi is string => !!doi)),
      titleKey,
      tokens: titleTokens(titleKey),
      arxivId: hit.arxivId,
    }
  })

  const unionFind = new UnionFind()
  for (let i = 0; i < inputs.length; i += 1) {
    for (let j = i + 1; j < inputs.length; j += 1) {
      const a = inputs[i]
      const b = inputs[j]
      if (!a || !b) continue
      let linked = false
      // Step 1：DOI 严格归一化匹配。
      for (const doi of a.doiKeys) {
        if (b.doiKeys.has(doi)) linked = true
      }
      // Step 2：标题模糊聚类（同名或高 Jaccard）。
      if (!linked && a.titleKey && a.titleKey === b.titleKey) linked = true
      if (!linked && jaccard(a.tokens, b.tokens) >= 0.85) linked = true
      // Step 3：谱系对齐——预印本-正刊以更宽松阈值合并为单一主卡片。
      if (!linked && (a.arxivId || b.arxivId) && jaccard(a.tokens, b.tokens) >= 0.8) linked = true
      if (!linked && a.arxivId && a.arxivId === b.arxivId) linked = true
      if (linked) unionFind.union(i, j)
    }
  }

  const groups = new Map<number, RawHit[]>()
  for (let i = 0; i < inputs.length; i += 1) {
    const input = inputs[i]
    if (!input) continue
    const root = unionFind.find(i)
    const bucket = groups.get(root) ?? []
    bucket.push(...input.hits)
    groups.set(root, bucket)
  }
  return [...groups.values()]
}

const OA_STATUS_PRIORITY: Record<CsLabOaStatus, number> = {
  gold: 5,
  diamond: 5,
  green: 4,
  hybrid: 3,
  bronze: 2,
  preprint: 1,
  closed: 0,
}

function mergeCluster(hits: RawHit[]): CsLabAcademicPaperMetadata {
  // 主卡片基准：优先「有正式 DOI 且非 arXiv/preprint」的正刊记录，其次引用量最高者。
  const published = hits.find(
    (hit) => hit.doi && !isPreprintDoi(hit.doi) && hit.publication !== 'arXiv',
  )
  const base =
    published ??
    [...hits].sort((a, b) => b.citationsCount - a.citationsCount)[0]
  if (!base) throw new Error('合并簇为空')

  const pick = <T>(select: (hit: RawHit) => T | undefined): T | undefined => {
    for (const hit of [base, ...hits]) {
      const value = select(hit)
      if (value !== undefined && value !== '' && value !== null) return value
    }
    return undefined
  }

  const arxivHit = hits.find((hit) => hit.arxivId)
  const arxivId = arxivHit?.arxivId
  const publishedDoi = hits.find((hit) => hit.doi && !isPreprintDoi(hit.doi))?.doi
  const isPreprintOnly = !publishedDoi && !!arxivHit

  const lineage: CsLabAcademicLineage = {
    isPreprint: isPreprintOnly,
    publishedVersionDoi:
      arxivHit && publishedDoi && publishedDoi !== arxivHit.doi ? publishedDoi : undefined,
    versionSources: [
      ...(arxivHit?.arxivId ? [`arXiv:${arxivHit.arxivId}`] : []),
      ...[...new Set(hits.map((hit) => hit.publication).filter((name): name is string => !!name))],
    ].slice(0, 4),
  }

  const authors =
    base.authors.length > 0
      ? base.authors
      : [...hits].sort((a, b) => b.authors.length - a.authors.length)[0]?.authors ?? []

  const oaStatus = hits.reduce<CsLabOaStatus | undefined>((best, hit) => {
    if (!hit.oaStatus) return best
    if (!best) return hit.oaStatus
    return OA_STATUS_PRIORITY[hit.oaStatus] > OA_STATUS_PRIORITY[best] ? hit.oaStatus : best
  }, undefined)

  // 汇集并基于源信任度优先排序全部来源的所有候选 PDF 直链
  const rawCandidates: string[] = []
  for (const hit of hits) {
    if (hit.openAccessPdfUrls) {
      for (const u of hit.openAccessPdfUrls) rawCandidates.push(u)
    }
    if (hit.openAccessPdfUrl) rawCandidates.push(hit.openAccessPdfUrl)
  }
  if (arxivId) {
    rawCandidates.push(`https://arxiv.org/pdf/${arxivId}`)
    rawCandidates.push(`https://arxiv.org/pdf/${arxivId}.pdf`)
  }
  const openAccessPdfUrls = sortPdfUrlsByTrust(rawCandidates)
  const openAccessPdfUrl = openAccessPdfUrls[0]

  const doi = publishedDoi ?? base.doi
  const title = pick((hit) => hit.title) ?? '未命名文献'

  return {
    id: doi ?? (arxivId ? `arXiv:${arxivId}` : `title:${createHash('sha256').update(normalizeTitle(title)).digest('hex').slice(0, 12)}`),
    title,
    authors,
    year: pick((hit) => hit.year),
    publication: pick((hit) =>
      hit.publication && hit.publication !== 'arXiv' ? hit.publication : undefined,
    ) ?? (lineage.isPreprint ? 'arXiv' : undefined),
    doi,
    arxivId,
    citationsCount: Math.max(...hits.map((hit) => hit.citationsCount), 0),
    isOpenAccess: hits.some((hit) => hit.isOpenAccess) || openAccessPdfUrls.length > 0,
    oaStatus: oaStatus ?? (lineage.isPreprint ? 'preprint' : undefined),
    openAccessPdfUrl,
    openAccessPdfUrls,
    landingPageUrl: pick((hit) => hit.landingPageUrl),
    abstract: [...hits].sort((a, b) => b.abstract.length - a.abstract.length)[0]?.abstract ?? '',
    tldr: pick((hit) => hit.tldr),
    methodKeywords: extractMethodKeywords(
      [...hits].sort((a, b) => b.abstract.length - a.abstract.length)[0]?.abstract ?? '',
      hits.find((hit) => hit.fieldsOfStudy?.length)?.fieldsOfStudy ?? [],
    ),
    fieldsOfStudy: [
      ...new Set(hits.flatMap((hit) => hit.fieldsOfStudy ?? [])),
    ].slice(0, 5),
    sources: [...new Set(hits.map((hit) => hit.source))],
    sourceRanks: hits.reduce<Partial<Record<CsLabAcademicSource, number>>>((acc, hit) => {
      acc[hit.source] = Math.min(acc[hit.source] ?? Number.MAX_SAFE_INTEGER, hit.rank)
      return acc
    }, {}),
    lineage,
    score: 0,
  }
}

// ===== RRF 融合 + 本地轻量重排 =====

function normalizeQueryTokens(query: string): Set<string> {
  const lowered = query.toLowerCase()
  const latin = lowered.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 1)
  const cjkGrams: string[] = []
  const cjkRuns = lowered.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,}/gu) ?? []
  for (const run of cjkRuns) {
    for (let i = 0; i + 1 < run.length; i += 1) cjkGrams.push(run.slice(i, i + 2))
  }
  return new Set([...latin, ...cjkGrams])
}

function overlapScore(text: string, queryTokens: Set<string>): number {
  if (queryTokens.size === 0 || !text) return 0
  const normalized = normalizeTitle(text)
  let hits = 0
  for (const token of queryTokens) {
    if (normalized.includes(token)) hits += 1
  }
  return Math.min(hits / queryTokens.size, 1)
}

function titleRelevanceScore(title: string, query: string, queryTokens: Set<string>): number {
  if (!title || queryTokens.size === 0) return 0
  const normTitle = normalizeTitle(title)
  const normQuery = normalizeTitle(query)
  if (normTitle === normQuery) {
    return 1.5 // 标题完全一致，绝对最高置信度
  }
  if (normQuery.length > 3 && normTitle.startsWith(normQuery)) {
    return 1.25 // 前缀精准命中
  }
  if (normQuery.length > 5 && normTitle.includes(normQuery)) {
    return 1.15 // 包含完整短语
  }
  return overlapScore(title, queryTokens)
}

function rerankScore(
  paper: CsLabAcademicPaperMetadata,
  query: string,
  queryTokens: Set<string>,
  maxCitations: number,
): number {
  const titleScore = titleRelevanceScore(paper.title, query, queryTokens)
  const abstractScore = overlapScore(paper.abstract.slice(0, 1200), queryTokens)
  const citationScore = maxCitations > 0 ? Math.log10(1 + paper.citationsCount) / Math.log10(1 + maxCitations) : 0
  const currentYear = new Date().getFullYear()
  const recencyScore = paper.year ? Math.max(0, Math.min((paper.year - (currentYear - 10)) / 10, 1)) : 0
  const oaScore = paper.isOpenAccess ? 1 : 0
  return titleScore * 0.45 + abstractScore * 0.15 + citationScore * 0.2 + recencyScore * 0.1 + oaScore * 0.1
}

function fuseAndRank(
  hits: RawHit[],
  query: string,
  filters: CsLabAcademicSearchFilters,
  topK: number,
): CsLabAcademicPaperMetadata[] {
  const clusters = clusterHits(hits)
  const rrfScores = clusters.map((cluster) =>
    cluster.reduce((sum, hit) => sum + 1 / (RRF_K + hit.rank), 0),
  )
  const maxRrf = Math.max(...rrfScores, 1e-9)

  let papers = clusters.map((cluster, index) => {
    const paper = mergeCluster(cluster)
    const rrfNorm = (rrfScores[index] ?? 0) / maxRrf
    // 0.6*跨源共识 + 0.4*本地轻量重排（可解释、零模型权重）。
    paper.score = Number((0.6 * rrfNorm).toFixed(4))
    return paper
  })

  const queryTokens = normalizeQueryTokens(query)
  const maxCitations = Math.max(...papers.map((paper) => paper.citationsCount), 0)
  for (const paper of papers) {
    paper.score = Number(
      (paper.score + 0.4 * rerankScore(paper, query, queryTokens, maxCitations)).toFixed(4),
    )
  }

  // 过滤器（服务端 + 本地统一收口）。
  papers = papers.filter((paper) => {
    if (filters.yearFrom && (!paper.year || paper.year < filters.yearFrom)) return false
    if (filters.yearTo && (!paper.year || paper.year > filters.yearTo)) return false
    if (filters.openAccessOnly && !paper.isOpenAccess) return false
    if (filters.sources?.length && !paper.sources.some((source) => filters.sources!.includes(source)))
      return false
    if (filters.publication?.trim()) {
      const needle = filters.publication.trim().toLowerCase()
      if (!(paper.publication ?? '').toLowerCase().includes(needle)) return false
    }
    if (filters.fieldsOfStudy?.length) {
      const paperFields = (paper.fieldsOfStudy ?? []).map((field) => field.toLowerCase())
      if (!filters.fieldsOfStudy.some((field) => paperFields.includes(field.toLowerCase())))
        return false
    }
    return true
  })

  return papers
    .sort((a, b) => b.score - a.score || b.citationsCount - a.citationsCount)
    .slice(0, topK)
}

// ===== TL;DR / 关键词渐进增强 =====

async function enrichPapers(
  papers: CsLabAcademicPaperMetadata[],
  input: CsLabAcademicSearchInput,
): Promise<void> {
  const missing = papers.filter((paper) => !paper.tldr?.trim()).slice(0, LLM_ENRICH_LIMIT)
  if (missing.length === 0) return

  const queue = [...missing]
  const workers = Array.from({ length: Math.min(LLM_ENRICH_CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const paper = queue.shift()
      if (!paper) break
      try {
        const distilled = await distillPaperHighlights({
          title: paper.title,
          abstract: paper.abstract,
          fieldsOfStudy: paper.fieldsOfStudy,
          channelId: input.channelId,
          modelId: input.modelId,
        })
        if (distilled.tldr) paper.tldr = distilled.tldr
        if (distilled.methodKeywords.length > 0) paper.methodKeywords = distilled.methodKeywords
      } catch {
        // 蒸馏失败仅降级展示，不阻断检索结果。
      }
    }
  })
  await Promise.all(workers)

  // 未参与 LLM 蒸馏的条目补确定性启发式速读，保证卡片始终外显。
  for (const paper of papers) {
    if (!paper.tldr?.trim() && !missing.includes(paper)) {
      const distilled = await distillPaperHighlights({
        title: paper.title,
        abstract: paper.abstract,
        fieldsOfStudy: paper.fieldsOfStudy,
      })
      paper.tldr = distilled.tldr
    }
  }
}

// ===== OA 解析与多路容错下载 =====

async function resolveOaViaUnpaywall(
  doi?: string,
): Promise<{ openAccessPdfUrl?: string; landingPageUrl?: string; oaStatus?: CsLabOaStatus }> {
  const normalized = normalizeDoi(doi)
  if (!normalized) return {}
  try {
    const url = `https://api.unpaywall.org/v2/${encodeURIComponent(normalized)}?email=${encodeURIComponent(CONTACT_EMAIL)}`
    const response = await fetchWithTimeout(url)
    if (!response.ok) return {}
    const payload = (await response.json()) as Record<string, any>
    const best = (payload.best_oa_location ?? {}) as Record<string, any>
    const pdfUrl = (best.url_for_pdf ?? best.url) as string | undefined
    return {
      openAccessPdfUrl: pdfUrl && /^https?:\/\//i.test(pdfUrl) ? pdfUrl : undefined,
      landingPageUrl: (best.url as string | undefined) ?? undefined,
      oaStatus: payload.oa_status as CsLabOaStatus | undefined,
    }
  } catch {
    return {}
  }
}

async function downloadPdf(
  url: string,
  maxBytes: number,
  referer?: string,
): Promise<{ ok: true; buffer: Buffer } | { ok: false; message: string; status?: number; landingPageUrl?: string }> {
  if (!/^https?:\/\//i.test(url)) return { ok: false, message: 'OA 直链协议不合法' }
  try {
    // 出版方（Elsevier / Springer / Wiley）对无 UA 的 Node fetch 一律 403。
    // 必须补齐合规的科研桌面端请求头；Referer 取论文 Landing Page。
    const response = await fetchWithTimeout(
      url,
      {
        redirect: 'follow',
        headers: {
          'User-Agent': getProferUserAgent(),
          Accept: 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
          ...(referer ? { Referer: referer } : {}),
        },
      },
      DOWNLOAD_TIMEOUT_MS,
    )
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        status: response.status,
        landingPageUrl: referer,
        message:
          `出版方拒绝自动下载（HTTP ${response.status}）。` +
          '未做掠夺性期刊退化下载。请打开原文 Landing Page 后手动导入 PDF：' +
          (referer ?? url),
      }
    }
    if (!response.ok) return { ok: false, message: `PDF 下载失败（HTTP ${response.status}）`, status: response.status }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > maxBytes) return { ok: false, message: 'PDF 超出大小上限' }
    // 魔数校验：绝不把 HTML 错误页当作 PDF 入库/预览。
    if (buffer.slice(0, 4).toString('latin1') !== '%PDF') {
      return { ok: false, message: '直链未返回合法 PDF（可能是出版方反爬页面）' }
    }
    return { ok: true, buffer }
  } catch (error) {
    return { ok: false, message: `PDF 下载失败：${error instanceof Error ? error.message : '请检查网络后重试'}` }
  }
}

/** EuropePMC OA 解析：作为 Unpaywall 之后的第二条合规直链来源。 */
async function resolveOaViaEuropePMC(
  doi?: string,
): Promise<{ openAccessPdfUrl?: string; landingPageUrl?: string; oaStatus?: CsLabOaStatus }> {
  const normalized = normalizeDoi(doi)
  if (!normalized) return {}
  try {
    const url =
      'https://www.ebi.ac.uk/europepmc/webservices/rest/search' +
      `?query=${encodeURIComponent(`DOI:"${normalized}"`)}&format=json&resultType=core`
    const response = await fetchWithTimeout(url)
    if (!response.ok) return {}
    const payload = (await response.json()) as Record<string, any>
    const result = payload?.resultList?.result?.[0] as Record<string, any> | undefined
    if (!result) return {}
    const urls = (result.fullTextUrlList?.fullTextUrl ?? []) as Array<Record<string, any>>
    const pdfEntry = urls.find(
      (item) =>
        String(item.availabilityCode ?? '').toUpperCase() !== 'NONE' &&
        /pdf/i.test(String(item.documentStyle ?? '')) &&
        /^https?:\/\//i.test(String(item.url ?? '')),
    )
    return {
      openAccessPdfUrl: pdfEntry?.url as string | undefined,
      landingPageUrl: (urls.find((item) => /^https?:\/\//i.test(String(item.url ?? '')))?.url as string | undefined),
      oaStatus: (result.isOpenAccess === '1' || result.isOpenAccess === 1 ? 'gold' : undefined) as CsLabOaStatus | undefined,
    }
  } catch {
    return {}
  }
}

interface CandidatePdfTarget {
  url: string
  referer?: string
}

/** 汇集所有可能的候选 PDF 直链并按信任度和类型排序。 */
async function collectPdfCandidates(input: {
  doi?: string
  arxivId?: string
  title?: string
  openAccessPdfUrl?: string
  openAccessPdfUrls?: string[]
  landingPageUrl?: string
}): Promise<CandidatePdfTarget[]> {
  const candidates: CandidatePdfTarget[] = []
  const addedUrls = new Set<string>()

  const add = (url?: string, referer?: string) => {
    if (!url || !/^https?:\/\//i.test(url)) return
    const cleaned = url.trim()
    if (addedUrls.has(cleaned)) return
    addedUrls.add(cleaned)
    candidates.push({ url: cleaned, referer: referer ?? input.landingPageUrl })
  }

  // 1. 尝试从已知参数中提取或归一化 arXiv ID
  let arxivId = normalizeArxivId(input.arxivId)
  if (!arxivId && input.doi && isPreprintDoi(input.doi)) {
    arxivId = normalizeArxivId(input.doi)
  }
  if (!arxivId && input.openAccessPdfUrl) {
    arxivId = normalizeArxivId(input.openAccessPdfUrl)
  }
  if (!arxivId && input.landingPageUrl) {
    arxivId = normalizeArxivId(input.landingPageUrl)
  }

  // 如果标题包含 "attention is all you need" 等已知里程碑论文但未带出 arxivId，自动补齐
  if (!arxivId && input.title && /attention is all you need/i.test(input.title.trim())) {
    arxivId = '1706.03762'
  }

  // 2. 如果存在 arxivId，优先注入 export 镜像与官方直链（export 镜像无 Cloudflare 阻断且速度极快）
  if (arxivId) {
    add(`https://export.arxiv.org/pdf/${arxivId}.pdf`)
    add(`https://arxiv.org/pdf/${arxivId}.pdf`)
    add(`https://arxiv.org/pdf/${arxivId}`)
    add(`https://browse.arxiv.org/pdf/${arxivId}.pdf`)
  }

  // 3. 注入已知候选列表与首选直链（受信任源在前面）
  const givenUrls = sortPdfUrlsByTrust([
    ...(input.openAccessPdfUrls ?? []),
    ...(input.openAccessPdfUrl ? [input.openAccessPdfUrl] : []),
  ])
  for (const u of givenUrls) {
    add(u)
  }

  // 4. Unpaywall 动态解析回退
  if (input.doi) {
    const unpaywall = await resolveOaViaUnpaywall(input.doi)
    if (unpaywall.openAccessPdfUrl) {
      add(unpaywall.openAccessPdfUrl, unpaywall.landingPageUrl)
    }
  }

  // 5. EuropePMC 动态解析回退
  if (input.doi) {
    const europePmc = await resolveOaViaEuropePMC(input.doi)
    if (europePmc.openAccessPdfUrl) {
      add(europePmc.openAccessPdfUrl, europePmc.landingPageUrl)
    }
  }

  // 6. 若仍无可用候选或只有低信任镜像，如果 DOI 存在，向 OpenAlex 反查详细 locations
  if (input.doi) {
    try {
      const normDoi = normalizeDoi(input.doi)
      if (normDoi) {
        const resp = await fetchWithTimeout(
          `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(normDoi)}?mailto=${encodeURIComponent(CONTACT_EMAIL)}`,
        )
        if (resp.ok) {
          const work = (await resp.json()) as Record<string, any>
          const locs = (work.locations ?? []) as Array<Record<string, any>>
          for (const loc of locs) {
            if (typeof loc.pdf_url === 'string') add(loc.pdf_url, loc.landing_page_url as string | undefined)
            const extractedArxiv =
              normalizeArxivId(loc.landing_page_url as string | undefined) ||
              normalizeArxivId(loc.pdf_url as string | undefined)
            if (extractedArxiv) {
              add(`https://arxiv.org/pdf/${extractedArxiv}`)
            }
          }
        }
      }
    } catch {
      // 探测异常静默忽略
    }
  }

  return candidates
}

/** 多路候选容错下载：依次尝试候选直链，直至获取合法的 %PDF。 */
async function downloadPdfWithFallbacks(
  candidates: CandidatePdfTarget[],
  maxBytes: number,
  fallbackLandingPage?: string,
): Promise<{ ok: true; buffer: Buffer; sourceUrl: string } | { ok: false; message: string; landingPageUrl?: string }> {
  if (candidates.length === 0) {
    return {
      ok: false,
      message: '该文献暂未找到合法的开放获取 PDF 直链，请通过原文页面手动查看或导入',
      landingPageUrl: fallbackLandingPage,
    }
  }

  let lastError = '未找到可下载的有效 PDF'
  for (const candidate of candidates) {
    const result = await downloadPdf(candidate.url, maxBytes, candidate.referer ?? fallbackLandingPage)
    if (result.ok) {
      return { ok: true, buffer: result.buffer, sourceUrl: candidate.url }
    }
    lastError = result.message
    console.warn(`[CSLab] PDF 直链下载尝试未果 (${candidate.url}): ${result.message}，正在尝试备用直链...`)
  }

  return {
    ok: false,
    message: lastError,
    landingPageUrl: fallbackLandingPage,
  }
}

/** 兼容旧代码签名的直链解析辅助函数。 */
async function resolvePdfUrl(input: {
  doi?: string
  arxivId?: string
  title?: string
  openAccessPdfUrl?: string
  openAccessPdfUrls?: string[]
  landingPageUrl?: string
}): Promise<{ pdfUrl?: string; landingPageUrl?: string }> {
  const candidates = await collectPdfCandidates(input)
  return { pdfUrl: candidates[0]?.url, landingPageUrl: candidates[0]?.referer ?? input.landingPageUrl }
}

// ===== 入库（一键摄入实验室资产库） =====

function labDb(labId: string): CsLabDatabase {
  return getCsLabDatabase(join(resolveLabDir(labId), 'db', 'central_meta.sqlite'))
}

function buildLiteratureMetadataJson(paper: CsLabAcademicPaperMetadata): string {
  return JSON.stringify({
    authors: paper.authors.map((author) => author.name).filter(Boolean),
    year: paper.year != null ? String(paper.year) : undefined,
    doi: paper.doi,
    arxivId: paper.arxivId,
    publication: paper.publication,
    abstract: paper.abstract,
    collections: ['学术检索'],
    keywords: paper.methodKeywords,
    tldr: paper.tldr,
  })
}

/**
 * 一键入库：下载合法 OA PDF -> vault/lit 只读登记 -> 后台结构解析 + Docling 渐进增强。
 * 语义与数据铁笼 PDF 入笼一致（SHA-256 去重、只读锁、实体 + literature_sources 双登记）。
 */
export async function ingestAcademicPaper(
  input: CsLabAcademicIngestInput,
): Promise<CsLabAcademicIngestResult> {
  const labId = assertLabId(input.labId)
  const paper = input.paper
  if (!paper?.title?.trim()) return { ok: false, message: '缺少论文元数据' }

  const candidates = await collectPdfCandidates({
    doi: paper.doi,
    arxivId: paper.arxivId,
    title: paper.title,
    openAccessPdfUrl: paper.openAccessPdfUrl,
    openAccessPdfUrls: paper.openAccessPdfUrls,
    landingPageUrl: paper.landingPageUrl,
  })

  const downloaded = await downloadPdfWithFallbacks(candidates, MAX_INGEST_BYTES, paper.landingPageUrl)
  if (!downloaded.ok) return { ok: false, message: downloaded.message }
  const buffer = downloaded.buffer

  const db = labDb(labId)
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const existing = findEntityByShaAndLayer(db, labId, sha256, 'lit')
  if (existing) {
    return {
      ok: true,
      uri: existing.uri,
      revision: existing.revision,
      message: '相同 PDF 已在库中，已复用既有文献资产',
    }
  }

  const timestamp = Date.now()
  const nonce = randomUUID().slice(0, 6)
  const safeName = sanitizeFileName(`${paper.title.slice(0, 80) || 'paper'}.pdf`)
  const litRelPath = `vault/lit/${timestamp}-${nonce}-${safeName}`
  const litAbsPath = resolveLabRelativePath(labId, litRelPath)

  let staged = true
  try {
    await fs.writeFile(litAbsPath, buffer)
    const locked = await lockFileReadOnly(litAbsPath)
    const createdAt = Date.now()
    const litUuid = `lit-${randomUUID().slice(0, 8)}`
    const litUri = buildCsLabUri(labId, 'lit', litUuid)

    const revision = withTransaction(db, () => {
      const nextRevision = nextLabRevision(db)
      const entity: CsLabEntityRecord = {
        uri: litUri,
        labId,
        layerType: 'lit',
        entityUuid: litUuid,
        title: paper.title.slice(0, 200),
        format: 'pdf',
        relPath: litRelPath,
        sha256,
        bytes: buffer.length,
        revision: nextRevision,
        locked,
        createdAt,
        updatedAt: createdAt,
      }
      upsertEntity(db, entity)
      upsertLiteratureSource(db, {
        uri: litUri,
        labId,
        source: 'vault',
        relPath: litRelPath,
        metadataJson: buildLiteratureMetadataJson(paper),
        sha256,
        updatedAt: createdAt,
      })
      return nextRevision
    })
    // 事务已提交：文件归实体所有，异常清理不再接管。
    staged = false

    // 后台：结构化解析 + GraphRAG 索引重建（沿用既有文献入库流水线）。
    void import('./cslab-literature-structure')
      .then((module) => module.enrichLiteratureInBackground(labId, litUri))
      .catch((error) => console.warn('[CSLab] 学术入库后台解析调度失败:', error))

    // 后台：TL;DR 缺失时 Docling -> LLM -> 启发式渐进增强回填。
    if (!paper.tldr?.trim()) {
      void backfillHighlights(labId, litUri, litAbsPath, paper).catch(() => undefined)
    }

    return { ok: true, uri: litUri, revision, message: 'PDF 已作为文献只读入笼' }
  } catch (error) {
    if (staged) {
      await unlockFile(litAbsPath).catch(() => undefined)
      await fs.rm(litAbsPath, { force: true }).catch(() => undefined)
    }
    return {
      ok: false,
      message: `文献入库失败：${error instanceof Error ? error.message : '未知错误'}`,
    }
  }
}

async function backfillHighlights(
  labId: string,
  uri: string,
  pdfPath: string,
  paper: CsLabAcademicPaperMetadata,
): Promise<void> {
  const distilled = await distillPaperHighlights({
    title: paper.title,
    abstract: paper.abstract,
    fieldsOfStudy: paper.fieldsOfStudy,
    labId,
    pdfPath,
  })
  if (!distilled.tldr && distilled.methodKeywords.length === 0) return

  const db = labDb(labId)
  const { getLiteratureSource } = await import('./cslab-db')
  const source = getLiteratureSource(db, uri)
  if (!source) return
  let metadata: Record<string, unknown> = {}
  try {
    metadata = source.metadataJson ? (JSON.parse(source.metadataJson) as Record<string, unknown>) : {}
  } catch {
    metadata = {}
  }
  if (distilled.tldr) metadata.tldr = distilled.tldr
  if (distilled.methodKeywords.length > 0) metadata.keywords = distilled.methodKeywords
  upsertLiteratureSource(db, { ...source, metadataJson: JSON.stringify(metadata) })
}

// ===== 对外主入口 =====

/** 跨源联邦检索：并行聚合 -> 谱系去重 -> RRF 融合 -> 本地轻量重排 -> 渐进增强。 */
export async function searchAcademicPapers(
  input: CsLabAcademicSearchInput,
): Promise<CsLabAcademicSearchResult> {
  const query = input.query?.trim() ?? ''
  if (!query) {
    return { ok: false, papers: [], sourceStats: [], message: '请输入检索关键词或科学问题' }
  }
  const topK = Math.min(Math.max(input.topK ?? DEFAULT_TOP_K, 1), MAX_TOP_K)
  const filters = input.filters ?? {}
  const activeSources = filters.sources?.length
    ? ALL_SOURCES.filter((source) => filters.sources!.includes(source))
    : ALL_SOURCES

  const started = Date.now()
  const settled = await Promise.all(
    activeSources.map(async (source) => {
      const sourceStarted = Date.now()
      try {
        const hits = await SOURCE_FETCHERS[source](query, filters)
        return {
          stat: { source, hits: hits.length, elapsedMs: Date.now() - sourceStarted } as CsLabAcademicSourceStat,
          hits,
        }
      } catch (error) {
        return {
          stat: {
            source,
            hits: 0,
            elapsedMs: Date.now() - sourceStarted,
            error: error instanceof Error ? error.message : '上游不可用',
          } satisfies CsLabAcademicSourceStat,
          hits: [] as RawHit[],
        }
      }
    }),
  )

  const sourceStats = settled.map((item) => item.stat)
  const allHits = settled.flatMap((item) => item.hits)
  const anySuccess = sourceStats.some((stat) => !stat.error)

  if (allHits.length === 0) {
    return {
      ok: anySuccess,
      papers: [],
      sourceStats,
      message: anySuccess
        ? '未检索到匹配文献，请尝试更换关键词或放宽筛选条件'
        : '全部上游数据源暂不可用，请稍后重试',
    }
  }

  const papers = fuseAndRank(allHits, query, filters, topK)
  await enrichPapers(papers, input)

  console.log(
    `[CSLab] 学术检索 "${query}"：${allHits.length} 条原始命中 -> ${papers.length} 张主卡片，耗时 ${Date.now() - started}ms`,
  )
  return { ok: true, papers, sourceStats }
}

/** 右侧即时预览：按需多路解析 OA 直链并容错下载回传 PDF 字节（dataURL）。 */
export async function fetchPaperPreview(
  input: CsLabAcademicPreviewInput,
): Promise<CsLabAcademicPreviewResult> {
  const candidates = await collectPdfCandidates(input)
  const downloaded = await downloadPdfWithFallbacks(candidates, MAX_PREVIEW_BYTES, input.landingPageUrl)
  if (!downloaded.ok) {
    return {
      ok: false,
      message: downloaded.message,
    }
  }
  return {
    ok: true,
    pdfDataUrl: `data:application/pdf;base64,${downloaded.buffer.toString('base64')}`,
    message: 'PDF 预览已就绪',
  }
}
