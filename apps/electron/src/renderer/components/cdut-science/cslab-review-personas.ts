/**
 * CSLab 审稿角色与提示词（纯逻辑，无 TipTap / Canvas 运行时依赖）
 *
 * 角色元数据既驱动 Ribbon 配色，也驱动 Canvas 批注内容前缀；
 * prompt / JSON 解析供“复制指令 / 粘贴建议”兜底路径使用。
 */

import type { CsLabSuggestionPersona } from '@profer/shared'

export interface CsLabPersonaMeta {
  title: string
  color: string
  background: string
  border: string
}

export const CSLAB_PERSONA_META: Record<CsLabSuggestionPersona, CsLabPersonaMeta> = {
  human: {
    title: '人工审阅',
    color: 'hsl(var(--cslab-text))',
    background: 'hsl(var(--cslab-text) / 0.05)',
    border: 'hsl(var(--cslab-text) / 0.18)',
  },
  Methodology_Reviewer: {
    title: '方法论审稿人',
    color: 'hsl(var(--cslab-accent))',
    background: 'hsl(var(--cslab-accent) / 0.08)',
    border: 'hsl(var(--cslab-accent) / 0.42)',
  },
  Data_Analyst: {
    title: '数据可靠性',
    color: '#4F7A66',
    background: 'rgba(79,122,102,0.08)',
    border: 'rgba(79,122,102,0.40)',
  },
  Literature_Expert: {
    title: '文献专家',
    color: '#4C6180',
    background: 'rgba(76,97,128,0.08)',
    border: 'rgba(76,97,128,0.40)',
  },
  Grammar_Check: {
    title: '学术润色',
    color: '#8A7A5C',
    background: 'rgba(138,122,92,0.09)',
    border: 'rgba(138,122,92,0.42)',
  },
}

export const CSLAB_REVIEWER_PERSONAS: Array<Exclude<CsLabSuggestionPersona, 'human'>> = [
  'Methodology_Reviewer',
  'Data_Analyst',
  'Literature_Expert',
  'Grammar_Check',
]

export interface CsLabReviewSuggestionInput {
  kind: 'replace' | 'delete' | 'comment'
  quote: string
  replacement?: string
  comment?: string
  persona: Exclude<CsLabSuggestionPersona, 'human'>
}

export function personaTitle(persona: CsLabSuggestionPersona): string {
  return CSLAB_PERSONA_META[persona]?.title ?? '人工审阅'
}

/** 「复制审稿指令」兜底路径（无模型渠道时交给外部对话窗口执行）。 */
export function buildReviewerPromptText(
  persona: Exclude<CsLabSuggestionPersona, 'human'>,
): string {
  const meta = CSLAB_PERSONA_META[persona]
  return [
    `你是${meta.title}。请审阅我随后粘贴的论文正文，只输出严格 JSON：`,
    '{"suggestions":[{"kind":"replace","quote":"原文逐字片段","replacement":"改写后的文本","comment":"修改理由"}]}',
    '规则：kind 只能是 replace/delete/comment；quote 必须逐字出现在原文且单条不超过 500 字；',
    'replace 必须给 replacement；最多 30 条；没有问题时返回 {"suggestions":[]}；禁止编造文献与数值。',
  ].join('\n')
}

/**
 * 解析外部粘贴的审稿 JSON（与主进程同构的宽松解析，但不调用模型）。
 * 非法条目直接丢弃，返回可施加的建议。
 */
export function parseReviewerJson(
  raw: string,
  persona: Exclude<CsLabSuggestionPersona, 'human'>,
): CsLabReviewSuggestionInput[] {
  let text = raw.trim()
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '')
  }
  let parsed: unknown = null
  try {
    parsed = JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(text.slice(start, end + 1))
      } catch {
        parsed = null
      }
    }
  }
  const list =
    parsed &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { suggestions?: unknown }).suggestions)
      ? (parsed as { suggestions: unknown[] }).suggestions
      : []

  const result: CsLabReviewSuggestionInput[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const kind = record.kind
    const quote = typeof record.quote === 'string' ? record.quote.trim() : ''
    if ((kind !== 'replace' && kind !== 'delete' && kind !== 'comment') || !quote) continue
    const replacement = typeof record.replacement === 'string' ? record.replacement : undefined
    if (kind === 'replace' && !replacement?.trim()) continue
    result.push({
      kind,
      quote,
      replacement,
      comment: typeof record.comment === 'string' ? record.comment : undefined,
      persona,
    })
    if (result.length >= 40) break
  }
  return result
}
