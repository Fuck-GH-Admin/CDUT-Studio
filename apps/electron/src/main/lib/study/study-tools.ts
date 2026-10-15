/**
 * AI 速课堂 — Pi 工具桥接层
 *
 * 注册速课堂专属内置工具：
 *   - `study_inspect_section`：按大纲中的 sectionId 反向查阅章节完整原文（防上下文爆炸）；
 *   - `study_search_knowledge`：跨全域所有资料的高精度混合检索（大纲被截断时的跨文件主动检索）；
 *   - `study_cognition`：读取 / 更新学生认知记忆档案（已掌握 / 待学未知 / 薄弱混淆三维清单）。
 *
 * 与 pi-builtin-tools 中其它 Profer 内置工具一致，均以 Pi ToolDefinition 格式暴露。
 */

import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { StudentCognitionProfile } from '@profer/shared'
import {
  readStudentCognition,
  readStudySection,
  writeStudentCognition,
} from './study-document-indexer'
import { searchStudyRouted } from './study-retrieval-router'
import { getSettings } from '../settings-service'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

function jsonToolResult(payload: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    details: payload,
  } as AgentToolResult<unknown>
}

/** 合并三维概念清单：传入的清单为「新增」，同时支持显式移除 */
function mergeConcepts(current: string[], add?: string[], remove?: string[]): string[] {
  const result = new Set(current)
  for (const item of add ?? []) {
    const trimmed = item.trim()
    if (trimmed) result.add(trimmed)
  }
  for (const item of remove ?? []) result.delete(item.trim())
  return [...result]
}

/**
 * 注册 AI 速课堂专属工具。
 * 仅在具备会话上下文的 Pi 会话中注册。
 */
export function buildPiStudyTools(
  sdk: PiSdk,
  ctx: { sessionId: string },
): ToolDefinition[] {
  return [
    sdk.defineTool({
      name: 'study_inspect_section',
      label: '查阅学习资料章节原文',
      description:
        '按大纲给出的 sectionId 反向查阅学习资料对应章节的完整原文。讲解具体知识点、引用例题或核对细节时使用，避免一次性复述整篇资料造成上下文爆炸。',
      promptSnippet:
        'study_inspect_section: read the full original text of one study-material section by its sectionId from the outline.',
      parameters: Type.Object({
        documentId: Type.String({ minLength: 1, description: '大纲顶部给出的文档标识' }),
        sectionId: Type.String({ minLength: 1, description: '大纲中形如 <documentId>-sN 的章节标识' }),
        queryFocus: Type.Optional(
          Type.String({ maxLength: 200, description: '可选的查阅焦点关键词，命中时只返回焦点周围上下文，进一步节省 Token' }),
        ),
      }),
      async execute(_toolCallId, params) {
        const args = params as { documentId: string; sectionId: string; queryFocus?: string }
        const result = readStudySection(ctx.sessionId, args.documentId, args.sectionId, args.queryFocus)
        if (!result.success) {
          return jsonToolResult({
            error: result.error,
            message: '未找到对应章节；请核对 documentId 与 sectionId 是否来自当前资料大纲。',
          })
        }
        return jsonToolResult(result)
      },
    }),
    sdk.defineTool({
      name: 'study_search_knowledge',
      label: '全域跨文档检索学习资料',
      description:
        '跨当前课堂的所有资料（教材、课件、试卷、大纲）进行全域高精度混合检索。当回答学生的概念定义、定理证明、例题考点或查找跨资料关联时优先调用此工具。支持直接返回各文档相关的黄金事实与章节定位。',
      promptSnippet:
        'study_search_knowledge: search across all uploaded study documents using high-precision hybrid retrieval to find relevant sections and facts.',
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 300, description: '检索查询词或学生的具体提问' }),
        targetDocumentId: Type.Optional(
          Type.String({ description: '可选：限定在某份特定文档中检索；不传则跨所有文档全局检索' }),
        ),
        topK: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 10, default: 5, description: '返回最相关的切块数量' }),
        ),
      }),
      async execute(_toolCallId, params) {
        const args = params as { query: string; targetDocumentId?: string; topK?: number }
        const engine = getSettings().studyRetrievalEngine ?? 'classic'
        return jsonToolResult(
          searchStudyRouted(ctx.sessionId, args.query, engine, {
            ...(args.targetDocumentId ? { targetDocumentId: args.targetDocumentId } : {}),
            topK: args.topK ?? 5,
          }),
        )
      },
    }),
    sdk.defineTool({
      name: 'study_cognition',
      label: '学生认知记忆档案',
      description:
        '读取或更新学生在 AI 速课堂的认知记忆档案（已掌握 / 待学未知 / 薄弱混淆三维清单）。开始讲解前应先读取；摸底诊断或自测通过后应及时回写。',
      promptSnippet:
        'study_cognition: read or update the student cognition profile (mastered / unlearned / fragile concepts) used by the prior-knowledge guard.',
      parameters: Type.Object({
        action: Type.Union([Type.Literal('read'), Type.Literal('update')], {
          description: 'read 读取当前档案；update 增量更新档案',
        }),
        subject: Type.Optional(Type.String({ maxLength: 120 })),
        targetGoal: Type.Optional(Type.String({ maxLength: 200 })),
        examDate: Type.Optional(Type.String({ maxLength: 60 })),
        masteredAdd: Type.Optional(Type.Array(Type.String({ maxLength: 80 }))),
        masteredRemove: Type.Optional(Type.Array(Type.String({ maxLength: 80 }))),
        unlearnedAdd: Type.Optional(Type.Array(Type.String({ maxLength: 80 }))),
        unlearnedRemove: Type.Optional(Type.Array(Type.String({ maxLength: 80 }))),
        fragileAdd: Type.Optional(Type.Array(Type.String({ maxLength: 80 }))),
        fragileRemove: Type.Optional(Type.Array(Type.String({ maxLength: 80 }))),
      }),
      async execute(_toolCallId, params) {
        const args = params as {
          action: 'read' | 'update'
          subject?: string
          targetGoal?: string
          examDate?: string
          masteredAdd?: string[]
          masteredRemove?: string[]
          unlearnedAdd?: string[]
          unlearnedRemove?: string[]
          fragileAdd?: string[]
          fragileRemove?: string[]
        }
        if (args.action === 'read') {
          return jsonToolResult({ profile: readStudentCognition(ctx.sessionId) })
        }
        const current: StudentCognitionProfile = readStudentCognition(ctx.sessionId) ?? {
          subject: '',
          masteredConcepts: [],
          unlearnedConcepts: [],
          fragileConcepts: [],
          lastUpdated: 0,
        }
        const updated: StudentCognitionProfile = {
          subject: args.subject?.trim() || current.subject,
          targetGoal: args.targetGoal?.trim() || current.targetGoal,
          examDate: args.examDate?.trim() || current.examDate,
          masteredConcepts: mergeConcepts(current.masteredConcepts, args.masteredAdd, args.masteredRemove),
          unlearnedConcepts: mergeConcepts(current.unlearnedConcepts, args.unlearnedAdd, args.unlearnedRemove),
          fragileConcepts: mergeConcepts(current.fragileConcepts, args.fragileAdd, args.fragileRemove),
          lastUpdated: Date.now(),
        }
        writeStudentCognition(ctx.sessionId, updated)
        return jsonToolResult({ updated: true, profile: updated })
      },
    }),
  ] as unknown as ToolDefinition[]
}
