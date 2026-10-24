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
import {
  ingestAcademicPaper,
  searchAcademicPapers,
} from './cslab-academic-search-service'

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
      name: 'cslab_academic_search',
      label: 'CSLab 学术文献检索',
      description:
        '跨源联邦检索全球学术文献（OpenAlex / Semantic Scholar / arXiv / Crossref），自动做 DOI/标题/预印本-正刊谱系去重与 RRF 重排，返回外显元数据（TL;DR、方法关键词、引用量、OA 直链）。可选 ingest 把最相关的开放获取 PDF 一键入库为实验室文献资产。适合「帮我调研…方向的文献」类需求。',
      promptSnippet: 'cslab_academic_search: 多源学术文献检索（可一键入库）',
      parameters: Type.Object({
        query: Type.String({ minLength: 1, description: '检索关键词或科学问题' }),
        topK: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
        yearFrom: Type.Optional(Type.Integer({ minimum: 1900, maximum: 2100 })),
        yearTo: Type.Optional(Type.Integer({ minimum: 1900, maximum: 2100 })),
        openAccessOnly: Type.Optional(Type.Boolean({ description: '仅返回开放获取文献' })),
        ingest: Type.Optional(
          Type.Boolean({ description: '把最相关的开放获取论文 PDF 一键入库为实验室文献资产' }),
        ),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const input = params as {
          query: string
          topK?: number
          yearFrom?: number
          yearTo?: number
          openAccessOnly?: boolean
          ingest?: boolean
        }
        try {
          const result = await searchAcademicPapers({
            query: input.query,
            topK: input.topK,
            filters: {
              yearFrom: input.yearFrom,
              yearTo: input.yearTo,
              openAccessOnly: input.openAccessOnly ?? (input.ingest ? true : undefined),
            },
          })
          if (!input.ingest) return jsonToolResult(result)

          const target = result.papers.find(
            (paper) => paper.isOpenAccess && (paper.openAccessPdfUrl || paper.doi),
          )
          if (!target) {
            return jsonToolResult({
              ...result,
              ingest: { ok: false, message: '检索结果中没有可入库的开放获取 PDF' },
            })
          }
          const ingest = await ingestAcademicPaper({ labId, paper: target })
          return jsonToolResult({ ...result, ingest })
        } catch (error) {
          return jsonToolError(error instanceof Error ? error.message : '学术检索失败')
        }
      },
    }) as ToolDefinition,
  )

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
