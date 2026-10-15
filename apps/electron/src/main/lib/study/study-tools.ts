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
        'Read back the full original text of a study-material section by the sectionId given in the outline. Use it when explaining a specific knowledge point, quoting an example, or verifying details — avoids restating the whole material and blowing up the context window.',
      promptSnippet:
        'study_inspect_section: read the full original text of one study-material section by its sectionId from the outline.',
      parameters: Type.Object({
        documentId: Type.String({ minLength: 1, description: 'The document ID given at the top of the outline' }),
        sectionId: Type.String({ minLength: 1, description: 'The section ID of the form <documentId>-sN shown in the outline' }),
        queryFocus: Type.Optional(
          Type.String({ maxLength: 200, description: 'Optional focus keywords; when matched, only the context around the hit is returned to further save tokens' }),
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
        'Full-domain high-precision hybrid retrieval across all materials of the current class (textbooks, slides, exam papers, outlines). Prefer this tool when answering the student\'s concept definitions, theorem proofs, or example exam points, or when looking for cross-material connections. It can directly return each document\'s relevant golden facts and section locators.',
      promptSnippet:
        'study_search_knowledge: search across all uploaded study documents using high-precision hybrid retrieval to find relevant sections and facts.',
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 300, description: 'The retrieval query or the student\'s specific question' }),
        targetDocumentId: Type.Optional(
          Type.String({ description: 'Optional: restrict the search to one specific document; omit to search across all documents globally' }),
        ),
        topK: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 10, default: 5, description: 'Number of most relevant chunks to return' }),
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
        'Read or update the student\'s cognition memory profile (学生认知档案) in AI速课堂 (AI Quick Classroom) — a three-dimensional inventory of mastered / unlearned / fragile-confused concepts. Read it before starting to tutor; write it back promptly after a baseline diagnostic (摸底诊断) or a completed self-test.',
      promptSnippet:
        'study_cognition: read or update the student cognition profile (mastered / unlearned / fragile concepts) used by the prior-knowledge guard.',
      parameters: Type.Object({
        action: Type.Union([Type.Literal('read'), Type.Literal('update')], {
          description: '`read` reads the current profile; `update` applies an incremental update',
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
