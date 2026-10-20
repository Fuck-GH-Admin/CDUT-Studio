/**
 * CSLab AI 审稿服务（一次性 LLM 调用）
 *
 * 复用 retrospective-service 已验证的 one-shot JSON 链路（渠道/代理/商用计费），
 * 只负责：构造 persona 提示词 -> 调用 -> 严格解析结构化建议。
 *
 * 红线：
 * - 未配置模型渠道时明确失败，不生成占位建议；
 * - 模型返回的 quote 必须逐字存在后才由渲染层落 Mark；
 * - 解析失败/超限时如实返回错误，不做静默修补。
 */

import type {
  CsLabReviewRequest,
  CsLabReviewResult,
  CsLabReviewSuggestion,
  CsLabSuggestionPersona,
} from '@profer/shared'
import { oneShotJsonCall } from '../retrospective-service'

const MAX_SUGGESTIONS = 40
const MAX_QUOTE_LENGTH = 500
const MAX_REPLACEMENT_LENGTH = 2000
const MAX_COMMENT_LENGTH = 1200
const MAX_INPUT_CHARS = 20_000

interface PersonaSpec {
  title: string
  system: string
  guidance: string
}

const PERSONAS: Record<Exclude<CsLabSuggestionPersona, 'human'>, PersonaSpec> = {
  Methodology_Reviewer: {
    title: '方法论审稿人',
    system:
      '你是严谨的材料科学/化学方法学审稿人。只基于给定正文提出可执行的修改建议，不编造实验或文献。',
    guidance:
      '重点检查：实验设计是否可复现、对照与变量控制、表征手段是否支撑结论、误差与重复性是否报告、因果表述是否过度。',
  },
  Data_Analyst: {
    title: '数据可靠性审稿人',
    system:
      '你是科研数据可靠性审稿人。只基于给定正文提出可执行的修改建议，不虚构数值。',
    guidance:
      '重点检查：样本量与重复次数、单位与量纲一致性、统计显著性与误差棒、图表与正文数值是否自洽、异常值处理是否说明。',
  },
  Literature_Expert: {
    title: '文献专家',
    system:
      '你是学术文献与领域背景审稿人。只基于给定正文提出建议，禁止编造参考文献或 DOI。',
    guidance:
      '重点检查：关键论断是否有引用支撑、是否遗漏重要对照工作、与已有工作的差异是否说清、术语是否符合领域惯例。',
  },
  Grammar_Check: {
    title: '学术润色编辑',
    system: '你是中文学术论文润色编辑。只做语言与表达层面的修改，不改变科学结论。',
    guidance:
      '重点检查：语法、标点、术语一致性、长句拆分、口语化表达、被动/主动语态混用、英文缩写首次出现是否定义。',
  },
}

export function isReviewerPersona(value: unknown): value is Exclude<CsLabSuggestionPersona, 'human'> {
  return (
    value === 'Methodology_Reviewer' ||
    value === 'Data_Analyst' ||
    value === 'Literature_Expert' ||
    value === 'Grammar_Check'
  )
}

export function personaTitle(persona: CsLabSuggestionPersona): string {
  if (persona === 'human') return '人工审阅'
  return PERSONAS[persona].title
}

/** 构造审稿提示词（导出便于测试与「复制审稿指令」兜底路径复用）。 */
export function buildReviewPrompt(
  persona: Exclude<CsLabSuggestionPersona, 'human'>,
  text: string,
): { system: string; user: string } {
  const spec = PERSONAS[persona]
  const system = [
    spec.system,
    `你的审稿身份：${spec.title}。`,
    spec.guidance,
    '输出必须是严格 JSON（不要 Markdown 围栏、不要解释文字），结构如下：',
    '{"suggestions":[{"kind":"replace","quote":"原文逐字片段","replacement":"改写后的文本","comment":"修改理由"}]}',
    '规则：',
    '1. kind 只能是 replace / delete / comment；',
    '2. quote 必须逐字出现在原文中（含标点），单条不超过 500 字，禁止跨段引用；',
    '3. replace 必须给 replacement；delete/comment 可省略 replacement；',
    '4. comment 用一句中文说明理由，不超过 120 字；',
    '5. 最多 30 条，按重要性排序；没有问题时返回 {"suggestions":[]}；',
    '6. 禁止编造文献、DOI、实验数值。',
  ].join('\n')

  return {
    system,
    user: `请审阅以下论文正文：\n\n${text}`,
  }
}

function stripFences(raw: string): string {
  let text = raw.trim()
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '')
  }
  return text.trim()
}

function lenientJson(raw: string): unknown {
  const text = stripFences(raw)
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1))
      } catch {
        return null
      }
    }
    return null
  }
}

/** 严格解析模型返回；非法条目逐条丢弃并计数，不做模糊替换。 */
export function parseReviewSuggestions(
  raw: string,
  persona: CsLabSuggestionPersona,
): { suggestions: CsLabReviewSuggestion[]; dropped: number } {
  const parsed = lenientJson(raw)
  const list =
    parsed && typeof parsed === 'object' && Array.isArray((parsed as { suggestions?: unknown }).suggestions)
      ? ((parsed as { suggestions: unknown[] }).suggestions)
      : []

  const suggestions: CsLabReviewSuggestion[] = []
  let dropped = 0
  for (const item of list) {
    if (suggestions.length >= MAX_SUGGESTIONS) {
      dropped += 1
      continue
    }
    if (!item || typeof item !== 'object') {
      dropped += 1
      continue
    }
    const record = item as Record<string, unknown>
    const kind = record.kind
    const quote = typeof record.quote === 'string' ? record.quote.trim() : ''
    if (kind !== 'replace' && kind !== 'delete' && kind !== 'comment') {
      dropped += 1
      continue
    }
    if (!quote || quote.length > MAX_QUOTE_LENGTH) {
      dropped += 1
      continue
    }
    const replacement =
      typeof record.replacement === 'string' ? record.replacement.slice(0, MAX_REPLACEMENT_LENGTH) : undefined
    if (kind === 'replace' && !replacement?.trim()) {
      dropped += 1
      continue
    }
    const comment =
      typeof record.comment === 'string' ? record.comment.trim().slice(0, MAX_COMMENT_LENGTH) : undefined

    suggestions.push({
      id: `sug-${suggestions.length + 1}`,
      kind,
      persona,
      quote,
      replacement: kind === 'replace' ? replacement : undefined,
      comment,
    })
  }

  return { suggestions, dropped }
}

export async function reviewManuscript(input: CsLabReviewRequest): Promise<CsLabReviewResult> {
  const startedAt = Date.now()
  const persona = input.persona
  if (!isReviewerPersona(persona)) {
    return {
      ok: false,
      persona,
      suggestions: [],
      message: '请选择 AI 审稿专家人设',
    }
  }
  const text = (input.text ?? '').trim()
  if (!text) {
    return { ok: false, persona, suggestions: [], message: '正文为空，无法审阅' }
  }
  const truncated = text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text

  const { system, user } = buildReviewPrompt(persona, truncated)
  let raw: string | null
  try {
    raw = await oneShotJsonCall(system, user)
  } catch (error) {
    return {
      ok: false,
      persona,
      suggestions: [],
      message: error instanceof Error ? error.message : '模型调用失败',
      elapsedMs: Date.now() - startedAt,
    }
  }

  if (!raw) {
    return {
      ok: false,
      persona,
      suggestions: [],
      message: '未配置可用的模型渠道，请先在「设置 → 渠道」中配置 Agent 模型',
      elapsedMs: Date.now() - startedAt,
    }
  }

  const { suggestions, dropped } = parseReviewSuggestions(raw, persona)
  if (suggestions.length === 0 && dropped === 0) {
    return {
      ok: true,
      persona,
      suggestions: [],
      message: '本次审阅未发现需要修改的问题',
      elapsedMs: Date.now() - startedAt,
    }
  }

  return {
    ok: true,
    persona,
    suggestions,
    message:
      dropped > 0
        ? `生成 ${suggestions.length} 条建议，丢弃 ${dropped} 条不规范结果`
        : `生成 ${suggestions.length} 条建议`,
    elapsedMs: Date.now() - startedAt,
  }
}
