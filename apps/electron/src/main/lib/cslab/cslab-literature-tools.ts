/**
 * CSLab 文献智脑工具集
 *
 * 仅会话绑定实验室时注入，提供跨文献检索、章节精读与结构化导读。
 */

import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { resolveCsLabSeminarLabId } from './cslab-session-gate'
import { searchLabLiterature } from './cslab-graphrag-router'
import { buildLiteratureGuide, readPaperSection } from './cslab-literature-structure'

type PiSdkLike = typeof import('@earendil-works/pi-coding-agent')

export interface PiCsLabLiteratureToolsContext {
  sessionId: string
}

function jsonToolResult<T>(value: T): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  } as AgentToolResult<unknown>
}

function jsonToolError(message: string): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text' as const, text: `执行失败：${message}` }],
    details: { error: message },
    isError: true,
  } as AgentToolResult<unknown>
}

export function buildCsLabLiteratureTools(
  sdk: PiSdkLike,
  ctx: PiCsLabLiteratureToolsContext,
): ToolDefinition[] {
  const labId = resolveCsLabSeminarLabId(ctx.sessionId)
  if (!labId) return []

  const tools: ToolDefinition[] = []

  tools.push(
    sdk.defineTool({
      name: 'cslab_search_literature',
      label: 'CSLab 跨文献检索',
      description:
        '在实验室已入笼文献中执行 Leiden 分层 GraphRAG 检索，返回跨论文切块、页码、证据摘录与 PDF 内 bbox。适合回答“哪篇论文提到…/证据在哪一页”。',
      promptSnippet: 'cslab_search_literature: 跨文献检索并返回页码/证据',
      parameters: Type.Object({
        query: Type.String({ minLength: 1, description: '检索关键词或科学问题' }),
        topK: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
        literatureUri: Type.Optional(Type.String({ description: '限定单篇文献 URI' })),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const input = params as { query: string; topK?: number; literatureUri?: string }
        try {
          const result = await searchLabLiterature({
            labId,
            query: input.query,
            topK: input.topK,
            literatureUri: input.literatureUri,
          })
          return jsonToolResult(result)
        } catch (error) {
          return jsonToolError(error instanceof Error ? error.message : '文献检索失败')
        }
      },
    }) as ToolDefinition,
  )

  tools.push(
    sdk.defineTool({
      name: 'cslab_read_paper_section',
      label: 'CSLab 精读论文章节',
      description:
        '按章节标题模糊匹配，或按页码/页码范围读取已解析 PDF 的纯净文本、公式与表格。用于核对方法、实验条件、公式变量定义。',
      promptSnippet: 'cslab_read_paper_section: 读取指定章节或页码的原文',
      parameters: Type.Object({
        literatureUri: Type.String({ minLength: 1 }),
        section: Type.Optional(Type.String({ description: '章节标题关键词，例如 Methods / 结果' })),
        page: Type.Optional(Type.Integer({ minimum: 1 })),
        pageEnd: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const input = params as {
          literatureUri: string
          section?: string
          page?: number
          pageEnd?: number
        }
        try {
          const result = await readPaperSection(labId, input.literatureUri, {
            section: input.section,
            page: input.page,
            pageEnd: input.pageEnd,
          })
          return jsonToolResult(result)
        } catch (error) {
          return jsonToolError(error instanceof Error ? error.message : '章节读取失败')
        }
      },
    }) as ToolDefinition,
  )

  tools.push(
    sdk.defineTool({
      name: 'cslab_paper_guided_reading',
      label: 'CSLab 论文智能导读',
      description:
        '生成指定文献的结构化导读：摘要、章节脉络、公式/表格清单、作者标注的局限/结论原文摘录与阅读路径。返回的是证据而非主观结论，请基于证据综合回答。',
      promptSnippet: 'cslab_paper_guided_reading: 生成结构化论文导读',
      parameters: Type.Object({
        literatureUri: Type.String({ minLength: 1 }),
        focus: Type.Optional(Type.Union([
          Type.Literal('methods'),
          Type.Literal('results'),
          Type.Literal('limitations'),
        ])),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const input = params as {
          literatureUri: string
          focus?: 'methods' | 'results' | 'limitations'
        }
        try {
          const guide = await buildLiteratureGuide(labId, input.literatureUri)
          if (!guide.ok) return jsonToolError(guide.message ?? '导读生成失败')
          return jsonToolResult({
            ...guide,
            focus: input.focus,
            synthesisInstruction:
              '请仅基于上述证据，用用户语言综合出背景动机、核心方法、主要结果、局限与可复用点；不得编造未返回的结论、数据或页码。',
          })
        } catch (error) {
          return jsonToolError(error instanceof Error ? error.message : '导读生成失败')
        }
      },
    }) as ToolDefinition,
  )

  return tools
}
