/**
 * CSLab 语义增强器（论文自动入库流水线 · 阶段一）
 *
 * 职责：
 * - 用一次性 LLM 结构化调用抽取论文的层级分类学（taxonomy）/ 概念图谱 / 方法 / 实验协议 / 引用；
 * - 未配置 LLM 渠道或调用/解析失败时，严格回退确定性解析（基于 buildStructureFromAst 类产物）；
 * - 输出供入库流水线写入 CsLabLiteratureItem.taxonomy / conceptGraph / protocols / references。
 *
 * 红线：
 * - 未配置模型渠道 / oneShotJsonCall 返回 null → 明确回退确定性解析（enrichmentSource: 'deterministic'），
 *   绝不假装拿到 LLM 产物；
 * - 绝不生成占位概念 / 编造引用与 DOI：LLM 只能转写正文已有信息，确定性回退解析不出 title 的引用直接丢弃，
 *   概念 definition 无正文依据时留空；
 * - LLM 返回 JSON 解析失败或顶层字段类型不符 → 整体如实降级 deterministicEnrichment，不做静默修补；
 *   仅单条条目非法（如 reference 缺 title）时丢弃该条目，不牵连整体；
 * - 任何失败只 console.warn + 回退，绝不向上抛出；
 * - 数量硬上限：references ≤ 50 / concepts ≤ 60 / methods ≤ 30 / protocols ≤ 20 / taxonomy ≤ 5 级。
 */

import type {
  ExperimentalProtocol,
  PaperConcept,
  PaperConceptGraph,
  PaperMethod,
  PaperReference,
} from '@profer/shared'
import type { oneShotJsonCall } from '../retrospective-service'

// ===== 常量 =====

/** userPrompt 总量截断上限（防止章节/表格超长撑爆上下文） */
const MAX_PROMPT_CHARS = 20_000
/** 数量硬上限（LLM 与确定性回退共用） */
const MAX_REFERENCES = 50
const MAX_CONCEPTS = 60
const MAX_METHODS = 30
const MAX_PROTOCOLS = 20
/** taxonomy 层级 ≤ 5 级，单级 ≤ 80 字符，总词数受限 */
const MAX_TAXONOMY_DEPTH = 5
const MAX_TAXONOMY_TERM_CHARS = 80
const MAX_TAXONOMY_TOTAL_CHARS = 400
const MAX_NAME_CHARS = 200
const MAX_DEFINITION_CHARS = 600
const MAX_STEP_CHARS = 300
const MAX_REFERENCES_TEXT_CHARS = 40_000

const PROTOCOL_CATEGORIES = new Set(['synthesis', 'characterization', 'computation', 'measurement', 'general'])
const METHOD_ROLES = new Set(['proposed', 'baseline', 'general'])

/** DOI 正则（与 cslab-literature-structure 保持一致） */
const DOI_RE = /10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/
const YEAR_RE = /\b(?:19|20)\d{2}\b/
/** 参考文献条目起始编号：[1] / (1) / 1. / 1) */
const REF_ENTRY_START_RE = /^\s*(?:\[\d{1,3}\]|\(\d{1,3}\)|\d{1,3}[.)])\s+/
/** 标准 IMRaD 结构标题（确定性 taxonomy 不从这些标题编造学科名） */
const STANDARD_SECTION_RE =
  /^(?:\d+(?:\.\d+)*\s+)?(?:abstract|摘要|keywords?|关键词|introduction|引言|绪论|background|related work|文献综述|methods?|materials? and methods?|methodology|方法|实验|experimental|experiments?|results?|结果|discussion|讨论|conclusions?|结论|summary|总结|acknowledg(?:e)?ments?|致谢|references|参考文献|appendix|附录|limitations?|future work|outlook)\b/i

// ===== 对外类型 =====

export interface EnrichPaperInput {
  title: string
  abstract?: string
  keywords?: string[]
  sections?: Array<{ title: string; level: number; page: number; text: string }>
  /** 参考文献区原始文本 */
  referencesText?: string
  /** 表格 markdown（供协议/参数线索） */
  tablesMarkdown?: string
}

export interface PaperSemanticEnrichment {
  taxonomy: string[]
  conceptGraph: PaperConceptGraph
  protocols: ExperimentalProtocol[]
  references: PaperReference[]
  enrichmentSource: 'llm' | 'deterministic'
}

// ===== Prompt =====

const ENRICH_SYSTEM_PROMPT = `你是一个严谨的学术论文语义结构化抽取器，为科研文献入库流水线产出「层级分类学 / 概念图谱 / 方法 / 实验协议 / 参考文献」五类结构化数据。

[唯一事实来源 — 硬约束]
所有内容只能来自用户提供的论文内容（标题/摘要/关键词/章节/表格/参考文献区）。禁止编造正文没有出现的概念定义、实验步骤、参数数值、参考文献、DOI、期刊名。宁缺毋滥：抽取不出就返回空数组。

[输出格式 — 硬约束]
只输出严格 JSON（无 Markdown 围栏、无解释文字），结构如下：
{
  "taxonomy": ["Earth Sciences", "Geophysics", "Seismic Imaging"],
  "concepts": [{ "id": "c1", "name": "Full Waveform Inversion", "definition": "正文中的定义性描述（正文无定义则省略该字段）", "relatedConceptIds": ["c2"] }],
  "methods": [{ "id": "m1", "name": "Viscoacoustic FWI", "role": "proposed", "description": "正文对方法的一句概括", "dependsOn": ["c1", "m2"] }],
  "protocols": [{ "id": "p1", "name": "样品退火", "category": "synthesis", "steps": ["第一步", "第二步"], "parameters": { "temperature": "800 °C", "scanRate": 5 }, "instruments": ["XRD"] }],
  "references": [{ "title": "……", "authors": ["……"], "year": "2021", "doi": "10.xxxx/xxxxx", "venue": "……" }]
}

[字段规则]
1. taxonomy：从根到叶的层级学科分类字符串数组（最多 5 级），如 ["Earth Sciences", "Geophysics", "Seismic Imaging"]；必须是论文所属领域的真实层级，不得凭空细分出正文未体现的学科名。
2. concepts：核心概念/术语。id 短且唯一（如 c1/c2）；definition 只能转写正文中的定义性表述，正文没有定义就省略 definition 字段；relatedConceptIds 填相关概念的 id。
3. methods：论文涉及的方法。role 只能是 "proposed"（本文提出）| "baseline"（对比基线）| "general"（通用方法）三选一；dependsOn 填依赖的概念或方法 id。
4. protocols：实验/表征/计算协议。category 只能是 "synthesis" | "characterization" | "computation" | "measurement" | "general" 五选一；steps 按正文顺序给出可复现步骤；parameters 只填正文出现的参数名与数值（字符串或数字）；instruments 填正文出现的仪器/设备/软件名。
5. references：只抽取正文参考文献区真实存在的条目。title 必填；authors/year/doi/venue 缺失就省略对应字段，禁止猜测或补全 DOI。

[数量上限]
references ≤ 50 条，concepts ≤ 60 条，methods ≤ 30 条，protocols ≤ 20 条，taxonomy ≤ 5 级；超出时保留最重要的。`

function renderSectionsForPrompt(
  sections: EnrichPaperInput['sections'],
  cap: number,
): string {
  if (!sections || sections.length === 0) return ''
  const parts: string[] = []
  let size = 0
  for (const section of sections) {
    const piece = `## ${String(section.title).slice(0, 200)} (p${section.page})\n${String(section.text).slice(0, 2_000)}`.trim()
    if (size + piece.length + 2 > cap) break
    parts.push(piece)
    size += piece.length + 2
  }
  return parts.join('\n\n')
}

/** 拼接 userPrompt：标题/摘要/关键词/章节/参考文献区/表格，总量截断 ≤ MAX_PROMPT_CHARS。 */
export function buildEnrichUserPrompt(input: EnrichPaperInput): string {
  const blocks: Array<{ label: string; content: string; cap: number }> = [
    { label: '标题', content: input.title ?? '', cap: 600 },
    { label: '摘要', content: input.abstract ?? '', cap: 3_000 },
    { label: '关键词', content: (input.keywords ?? []).join('; '), cap: 800 },
    { label: '章节', content: renderSectionsForPrompt(input.sections, 10_000), cap: 10_000 },
    {
      label: '参考文献区原始文本',
      content: (input.referencesText ?? '').slice(0, MAX_REFERENCES_TEXT_CHARS),
      cap: 3_600,
    },
    { label: '表格 markdown（协议/参数线索）', content: input.tablesMarkdown ?? '', cap: 2_000 },
  ]
  let out = '请基于以下论文内容抽取结构化语义数据（严格遵循系统指令的 JSON schema 与硬约束）。\n\n'
  for (const block of blocks) {
    const content = block.content.trim()
    if (!content) continue
    // 预留标签与截断标记的余量，保证总量不超过 MAX_PROMPT_CHARS
    const remaining = MAX_PROMPT_CHARS - out.length - 64
    if (remaining <= 0) break
    const limit = Math.min(block.cap, remaining)
    const text = content.length > limit ? `${content.slice(0, limit)} …[truncated]` : content
    out += `【${block.label}】\n${text}\n\n`
  }
  return out.length > MAX_PROMPT_CHARS ? out.slice(0, MAX_PROMPT_CHARS) : out
}

// ===== LLM 返回的严格解析 =====

function stripFences(raw: string): string {
  let text = raw.trim()
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '')
  }
  return text.trim()
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asTrimmedString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text) return undefined
  return text.length > maxChars ? text.slice(0, maxChars) : text
}

function asStringList(value: unknown, maxChars: number, maxCount: number): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (out.length >= maxCount) break
    const text = asTrimmedString(item, maxChars)
    if (text) out.push(text)
  }
  return [...new Set(out)]
}

function parseLlmTaxonomy(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const terms: string[] = []
  let total = 0
  for (const item of value) {
    if (terms.length >= MAX_TAXONOMY_DEPTH) break
    const term = asTrimmedString(item, MAX_TAXONOMY_TERM_CHARS)
    if (!term) continue
    if (total + term.length > MAX_TAXONOMY_TOTAL_CHARS) break
    terms.push(term)
    total += term.length
  }
  return terms
}

function parseLlmConcepts(value: unknown): PaperConcept[] {
  if (!Array.isArray(value)) return []
  const concepts: PaperConcept[] = []
  const seenIds = new Set<string>()
  for (const item of value) {
    if (concepts.length >= MAX_CONCEPTS) break
    if (!isPlainObject(item)) continue
    const name = asTrimmedString(item.name, MAX_NAME_CHARS)
    if (!name) continue
    let id = asTrimmedString(item.id, 60) ?? `concept-${concepts.length + 1}`
    while (seenIds.has(id)) id = `${id}-${concepts.length + 1}`
    seenIds.add(id)
    const concept: PaperConcept = { id, name }
    const definition = asTrimmedString(item.definition, MAX_DEFINITION_CHARS)
    if (definition) concept.definition = definition
    const related = asStringList(item.relatedConceptIds, 60, 20)
    if (related.length > 0) concept.relatedConceptIds = related
    concepts.push(concept)
  }
  return concepts
}

function parseLlmMethods(value: unknown): PaperMethod[] {
  if (!Array.isArray(value)) return []
  const methods: PaperMethod[] = []
  const seenIds = new Set<string>()
  for (const item of value) {
    if (methods.length >= MAX_METHODS) break
    if (!isPlainObject(item)) continue
    const name = asTrimmedString(item.name, MAX_NAME_CHARS)
    if (!name) continue
    // role 严格三选一，不符视为该条目非法 → 丢弃（不猜、不改写）
    const role = asTrimmedString(item.role, 20)
    if (!role || !METHOD_ROLES.has(role)) continue
    let id = asTrimmedString(item.id, 60) ?? `method-${methods.length + 1}`
    while (seenIds.has(id)) id = `${id}-${methods.length + 1}`
    seenIds.add(id)
    const method: PaperMethod = { id, name, role: role as PaperMethod['role'] }
    const description = asTrimmedString(item.description, MAX_DEFINITION_CHARS)
    if (description) method.description = description
    const dependsOn = asStringList(item.dependsOn, 60, 20)
    if (dependsOn.length > 0) method.dependsOn = dependsOn
    methods.push(method)
  }
  return methods
}

function parseLlmProtocols(value: unknown): ExperimentalProtocol[] {
  if (!Array.isArray(value)) return []
  const protocols: ExperimentalProtocol[] = []
  const seenIds = new Set<string>()
  for (const item of value) {
    if (protocols.length >= MAX_PROTOCOLS) break
    if (!isPlainObject(item)) continue
    const name = asTrimmedString(item.name, MAX_NAME_CHARS)
    if (!name) continue
    const category = asTrimmedString(item.category, 30)
    if (!category || !PROTOCOL_CATEGORIES.has(category)) continue
    const steps = asStringList(item.steps, MAX_STEP_CHARS, 50)
    // 无可复现步骤的协议条目视为非法 → 丢弃（不伪造步骤）
    if (steps.length === 0) continue
    let id = asTrimmedString(item.id, 60) ?? `protocol-${protocols.length + 1}`
    while (seenIds.has(id)) id = `${id}-${protocols.length + 1}`
    seenIds.add(id)
    const parameters: Record<string, string | number> = {}
    // parameters 容器类型不符 → 整条丢弃；仅单个键值非法 → 跳过该键值（不编造）
    if (item.parameters !== undefined && item.parameters !== null) {
      if (!isPlainObject(item.parameters)) continue
      for (const [rawKey, rawValue] of Object.entries(item.parameters)) {
        const key = rawKey.trim().slice(0, 60)
        if (!key) continue
        if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
          parameters[key] = rawValue
        } else if (typeof rawValue === 'string' && rawValue.trim()) {
          parameters[key] = rawValue.trim().slice(0, 200)
        }
      }
    }
    const protocol: ExperimentalProtocol = {
      id,
      name,
      category: category as ExperimentalProtocol['category'],
      steps,
      parameters,
    }
    const instruments = asStringList(item.instruments, 100, 20)
    if (instruments.length > 0) protocol.instruments = instruments
    protocols.push(protocol)
  }
  return protocols
}

function parseLlmReferences(value: unknown): PaperReference[] {
  if (!Array.isArray(value)) return []
  const references: PaperReference[] = []
  for (const item of value) {
    if (references.length >= MAX_REFERENCES) break
    if (!isPlainObject(item)) continue
    // title 必填：缺失视为该条目非法 → 丢弃，绝不编造
    const title = asTrimmedString(item.title, 400)
    if (!title) continue
    const reference: PaperReference = { title }
    const authors = asStringList(item.authors, 120, 20)
    if (authors.length > 0) reference.authors = authors
    const yearValue = typeof item.year === 'number' ? String(item.year) : item.year
    const year = asTrimmedString(yearValue, 16)
    if (year) reference.year = year
    const doi = asTrimmedString(item.doi, 200)
    if (doi) reference.doi = doi
    const venue = asTrimmedString(item.venue, 200)
    if (venue) reference.venue = venue
    references.push(reference)
  }
  return references
}

/**
 * 严格解析 LLM 返回：
 * - JSON.parse 失败 / 顶层非对象 / 顶层字段类型不符（非数组）→ 返回 null（整体回退）；
 * - 单条条目非法 → 丢弃该条目（不牵连整体）。
 */
export function parseLlmEnrichment(raw: string): PaperSemanticEnrichment | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFences(raw))
  } catch {
    return null
  }
  if (!isPlainObject(parsed)) return null
  for (const key of ['taxonomy', 'concepts', 'methods', 'protocols', 'references']) {
    const value = parsed[key]
    if (value !== undefined && value !== null && !Array.isArray(value)) return null
  }
  return {
    taxonomy: parseLlmTaxonomy(parsed.taxonomy),
    conceptGraph: {
      concepts: parseLlmConcepts(parsed.concepts),
      methods: parseLlmMethods(parsed.methods),
    },
    protocols: parseLlmProtocols(parsed.protocols),
    references: parseLlmReferences(parsed.references),
    enrichmentSource: 'llm',
  }
}

// ===== 确定性回退（纯函数） =====

/** 参考文献切条：有编号按编号起始边界切（续行并入），无编号则一行一条。 */
export function splitReferenceEntries(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const hasNumbering = lines.some((line) => REF_ENTRY_START_RE.test(line))
  if (!hasNumbering) return lines
  const entries: string[] = []
  let current: string[] = []
  for (const line of lines) {
    if (REF_ENTRY_START_RE.test(line)) {
      if (current.length > 0) entries.push(current.join(' '))
      current = [line]
    } else if (current.length > 0) {
      // 软换行续行：并入当前条目
      current.push(line)
    } else {
      current = [line]
    }
  }
  if (current.length > 0) entries.push(current.join(' '))
  return entries
}

/** 标题/出处常用词（出现在片段里说明它更像标题而非作者行） */
const TITLE_WORD_RE = /\b(?:the|of|for|with|from|study|based|using|analysis|model|method|approach|effect|data|imaging|inversion|survey|system|systems)\b/i

/** 作者行启发：含人名缩写、或逗号/and 分段后大部分像人名，且无标题常用词。 */
function looksLikeAuthorList(segment: string): boolean {
  if (/\bet al\b/i.test(segment)) return true
  if (/\b[A-Z]\./.test(segment) && !TITLE_WORD_RE.test(segment)) return true
  const parts = segment
    .split(/[,，;；]|\band\b/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  if (parts.length < 2) return false
  const nameLike = parts.filter(
    (part) => part.length <= 40 && /^\p{Lu}[\p{L}'.-]*(?:\s+\p{Lu}[\p{L}'.-]*)*$/u.test(part),
  )
  if (nameLike.length < Math.ceil(parts.length * 0.7)) return false
  return !TITLE_WORD_RE.test(segment)
}

/** 切句：人名缩写（"A." / "U.S."）后的点不是句边界（其前是大写字母）；分号/句号才是。 */
function splitTitleSegments(text: string): string[] {
  return text
    .split(/[;；。]\s*|(?<![A-Z])\.\s+/)
    .map((segment) => segment.replace(/^[\s()[\]{}.,;:，。；、"'“”‘’-]+/u, '').replace(/[.,;:，；、()\s]+$/u, '').trim())
    .filter((segment) => segment.length > 0)
}

/** 从条目剩余文本启发 title：取首个既不像作者列表也不像出处信息的片段；解析不出返回 null（丢弃该条目）。 */
function deriveReferenceTitle(text: string): string | null {
  for (const segment of splitTitleSegments(text)) {
    if (segment.length < 4 || segment.length > 300) continue
    if (looksLikeAuthorList(segment)) continue
    if (/^(?:in |proc|proceedings|vol|volume|pp|no|n|issn|isbn|fig|eq|chapter|ch|available at|https?:|doi)\b/i.test(segment)) continue
    // 像样的标题至少约两个实词：英文按 ≥3 字母的单词数，中文按字数折算；
    // 残留的 "(2019)" 空括号 / "Geophysics" 单个出处词不是标题
    const asciiWords = (segment.match(/[A-Za-z]{3,}/g) ?? []).length
    const hanChars = (segment.match(/\p{Script=Han}/gu) ?? []).length
    if (asciiWords + Math.floor(hanChars / 2) < 2) continue
    return segment
  }
  return null
}

/** 解析单条参考文献文本 → PaperReference；解析不出 title 返回 null（不编造）。 */
export function parseReferenceEntry(entry: string): PaperReference | null {
  let text = entry.replace(REF_ENTRY_START_RE, '').trim()
  if (!text) return null
  let doi: string | undefined
  const doiMatch = DOI_RE.exec(text)
  if (doiMatch) {
    doi = doiMatch[0]
    const start = doiMatch.index ?? 0
    // 只清理紧邻 DOI 前的 "doi:" 标注，不误伤正文里的 "DOI" 词
    const before = text.slice(0, start).replace(/\bdoi\s*[:：]?\s*$/i, ' ')
    text = `${before} ${text.slice(start + doi.length)}`
  }
  let year: string | undefined
  const yearMatch = YEAR_RE.exec(text)
  if (yearMatch) {
    year = yearMatch[0]
    text = text.replace(yearMatch[0], ' ')
  }
  const title = deriveReferenceTitle(text.replace(/\s+/g, ' ').trim())
  if (!title) return null
  const reference: PaperReference = { title }
  if (year) reference.year = year
  if (doi) reference.doi = doi
  return reference
}

/** 确定性 taxonomy：keywords 优先（前 2-3 个词串成层级链）；无关键词时只用非标准结构的一级章节标题保守兜底，不编造学科名。 */
function deterministicTaxonomy(input: EnrichPaperInput): string[] {
  const keywords = (input.keywords ?? [])
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword.length > 0)
  if (keywords.length > 0) {
    return keywords
      .slice(0, 3)
      .map((keyword) => keyword.slice(0, MAX_TAXONOMY_TERM_CHARS))
      .slice(0, MAX_TAXONOMY_DEPTH)
  }
  const headingLike = (input.sections ?? [])
    .filter((section) => section.level <= 1)
    .map((section) => section.title.trim())
    .filter((title) => title.length > 0 && !STANDARD_SECTION_RE.test(title))
  return [...new Set(headingLike)]
    .slice(0, 3)
    .map((title) => title.slice(0, MAX_TAXONOMY_TERM_CHARS))
    .slice(0, MAX_TAXONOMY_DEPTH)
}

/** 确定性概念：keywords → PaperConcept（definition 留空，不编造）。 */
function deterministicConcepts(input: EnrichPaperInput): PaperConcept[] {
  return (input.keywords ?? [])
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword.length > 0)
    .slice(0, MAX_CONCEPTS)
    .map((keyword, index) => ({
      id: `concept-${index + 1}`,
      name: keyword.slice(0, MAX_NAME_CHARS),
    }))
}

/** 确定性回退解析（纯函数）：只从输入已有文本提炼，解析不出的一律留空/丢弃。 */
export function deterministicEnrichment(input: EnrichPaperInput): PaperSemanticEnrichment {
  const references: PaperReference[] = []
  const referencesText = (input.referencesText ?? '').slice(0, MAX_REFERENCES_TEXT_CHARS)
  if (referencesText.trim()) {
    for (const entry of splitReferenceEntries(referencesText)) {
      if (references.length >= MAX_REFERENCES) break
      const reference = parseReferenceEntry(entry)
      if (reference) references.push(reference)
    }
  }
  return {
    taxonomy: deterministicTaxonomy(input),
    conceptGraph: {
      concepts: deterministicConcepts(input),
      // 确定性回退不推断方法角色/依赖关系：诚实为空，不伪造
      methods: [],
    },
    // 确定性回退不伪造实验协议：诚实为空
    protocols: [],
    references,
    enrichmentSource: 'deterministic',
  }
}

// ===== 主入口 =====

/**
 * 语义增强主入口：优先一次性 LLM 结构化抽取；未配置渠道 / 调用失败 / 解析失败时
 * 整体回退 deterministicEnrichment。任何失败只 console.warn + 回退，不抛出。
 *
 * `options.llmCall` 仅供测试注入（默认走真实 oneShotJsonCall 的渠道/代理/计费链路）。
 */
export async function enrichPaperSemantics(
  input: EnrichPaperInput,
  options: { llmCall?: typeof oneShotJsonCall } = {},
): Promise<PaperSemanticEnrichment> {
  try {
    const call = options.llmCall ?? (await import('../retrospective-service')).oneShotJsonCall
    const raw = await call(ENRICH_SYSTEM_PROMPT, buildEnrichUserPrompt(input))
    if (!raw) {
      console.warn('[CSLab] 语义增强：LLM 未配置或调用失败，回退确定性解析')
      return deterministicEnrichment(input)
    }
    const parsed = parseLlmEnrichment(raw)
    if (!parsed) {
      console.warn('[CSLab] 语义增强：LLM 返回解析失败，回退确定性解析')
      return deterministicEnrichment(input)
    }
    return parsed
  } catch (error) {
    console.warn('[CSLab] 语义增强异常，回退确定性解析:', error)
    return deterministicEnrichment(input)
  }
}
