/**
 * CSLab 8 类资产专职工具链
 *
 * 仅在 CSLab 研讨会话（AgentSessionMeta.cslabLabId 已绑定）注入。
 * 覆盖：统一聚焦、图版数字化、数据表创建、JSON Canvas 写入、手稿写入。
 */

import { promises as fs } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type {
  CsLabCanvasDocument,
  CsLabCapsule,
  CsLabPlotCalibration,
} from '@profer/shared'
import { resolveCsLabSeminarLabId } from './cslab-session-gate'
import { getAssetEntity, resolveAssetPath } from './cslab-iron-cage'
import { resolveLabDir, resolveLabRelativePath, sanitizeFileName } from './cslab-paths'
import { buildCsLabUri } from './cslab-uri'
import { getCsLabDatabase, nextLabRevision, upsertEntity, upsertTable, withTransaction } from './cslab-db'
import { broadcastCsLabEvent } from './cslab-events'
import { CSLAB_IPC_CHANNELS } from './cslab-types'
import { fileToImageDataUrl } from './cslab-image-data'
import { digitizePlot } from './cslab-plot-digitizer'
import { persistDigitizedFigure } from './cslab-dataset-store'
import { buildDataset } from './cslab-formats/types'
import { writeDatasetParquet, writeDatasetPreview } from './cslab-columnar'
import { createCanvas, writeCanvas } from './cslab-canvas-sync'
import { createManuscript, getManuscript, saveManuscript } from './cslab-manuscript'

type PiSdkLike = typeof import('@earendil-works/pi-coding-agent')

export interface PiCsLabAssetToolsContext {
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

function buildDoc(paragraphs: string[]): unknown {
  return {
    type: 'doc',
    content: paragraphs.map((text) => {
      if (text.startsWith('## ')) {
        return {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: text.slice(3) }],
        }
      }
      if (text.startsWith('# ')) {
        return {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: text.slice(2) }],
        }
      }
      return { type: 'paragraph', content: [{ type: 'text', text }] }
    }),
  }
}

function appendDoc(existing: unknown, paragraphs: string[]): unknown {
  const extra = buildDoc(paragraphs) as { type: string; content?: unknown[] }
  const base =
    existing && typeof existing === 'object' && (existing as { type?: string }).type === 'doc'
      ? (existing as { type: string; content?: unknown[] })
      : { type: 'doc', content: [] as unknown[] }
  return {
    ...base,
    content: [...(base.content ?? []), ...(extra.content ?? [])],
  }
}

export function buildCsLabAssetTools(
  sdk: PiSdkLike,
  ctx: PiCsLabAssetToolsContext,
): ToolDefinition[] {
  const labId = resolveCsLabSeminarLabId(ctx.sessionId)
  if (!labId) return []

  const tools: ToolDefinition[] = []

  tools.push(
    sdk.defineTool({
      name: 'cslab_focus_asset',
      label: 'CSLab 在原生窗格打开资产',
      description:
        '把实验室资产（晶体/地貌/图版/数据表/文献/画布/手稿）在激活的舞台窗格中打开。view=terrain 仅用于 geo 栅格。',
      promptSnippet: 'cslab_focus_asset: 在原生科研窗格中打开指定资产',
      parameters: Type.Object({
        uri: Type.String({ minLength: 1, description: '资产 URI' }),
        view: Type.Optional(Type.Union([Type.Literal('auto'), Type.Literal('terrain')])),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const input = params as { uri: string; view?: 'auto' | 'terrain' }
        const entity = getAssetEntity(labId, input.uri)
        if (!entity) return jsonToolError('资产不存在')
        if (input.view === 'terrain' && entity.layerType !== 'geo') {
          return jsonToolError('view=terrain 只能用于 geo 栅格资产')
        }
        broadcastCsLabEvent(CSLAB_IPC_CHANNELS.ON_ASSET_FOCUSED, {
          labId,
          uri: input.uri,
          view: input.view ?? 'auto',
        })
        return jsonToolResult({
          uri: input.uri,
          title: entity.title,
          layerType: entity.layerType,
          status: 'focused',
        })
      },
    }) as ToolDefinition,
  )

  tools.push(
    sdk.defineTool({
      name: 'cslab_digitize_figure',
      description:
        '对实验室内的图版资产执行像素曲线逆向数字化。preset=standard-calibration 时读取演示资产元数据中的预置刻度；否则必须提供 x/y 标定刻度。save=true 时同时生成图版与 Parquet 数据表。',
      label: 'CSLab 图版逆向数字化',
      promptSnippet: 'cslab_digitize_figure: 图版像素曲线数字化并保存为数据表',
      parameters: Type.Object({
        uri: Type.String({ minLength: 1 }),
        preset: Type.Optional(Type.Literal('standard-calibration')),
        calibration: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        mode: Type.Union([Type.Literal('line'), Type.Literal('scatter')]),
        color: Type.Optional(Type.String()),
        colors: Type.Optional(Type.Array(Type.String())),
        tolerance: Type.Optional(Type.Number({ minimum: 8, maximum: 60 })),
        save: Type.Optional(Type.Boolean()),
        title: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const input = params as {
          uri: string
          preset?: 'standard-calibration'
          calibration?: unknown
          mode: 'line' | 'scatter'
          color?: string
          colors?: string[]
          tolerance?: number
          save?: boolean
          title?: string
        }
        try {
          const entity = getAssetEntity(labId, input.uri)
          if (!entity || entity.layerType !== 'fig') throw new Error('该资产不是图版（fig 层）')
          const path = resolveAssetPath(labId, input.uri)
          if (!path) throw new Error('图版文件不存在')
          const image = await fileToImageDataUrl(path)
          if (image.extension === 'svg') {
            throw new Error('SVG 图版需先栅格化为 PNG/WebP')
          }
          let calibration = input.calibration as CsLabPlotCalibration | undefined
          if (input.preset === 'standard-calibration' || !calibration) {
            const meta = entity.metaJson ? JSON.parse(entity.metaJson) as {
              kind?: string
              calibration?: CsLabPlotCalibration
            } : undefined
            if (meta?.kind === 'plot-digitizer-standard' && meta.calibration) {
              calibration = meta.calibration
            }
          }
          if (!calibration?.x?.ticks?.length || !calibration?.y?.ticks?.length) {
            throw new Error('缺少坐标轴标定刻度（可对标准曲线使用 preset=standard-calibration）')
          }
          const result = await digitizePlot({
            labId,
            imageDataUrl: image.dataUrl,
            mode: input.mode,
            calibration,
            color: input.color,
            colors: input.colors,
            tolerance: input.tolerance,
          })
          if (!result.ok || result.series.length === 0) {
            return jsonToolError(result.message ?? '未能提取有效曲线')
          }
          let saved: { figUri: string; tableUri: string; rowCount: number } | null = null
          if (input.save !== false) {
            const persisted = await persistDigitizedFigure({
              labId,
              title: input.title?.trim() || entity.title,
              sourceUri: input.uri,
              imageDataUrl: image.dataUrl,
              calibration,
              series: result.series.map((item) => ({
                label: item.label,
                points: item.points,
              })),
            })
            saved = {
              figUri: persisted.figUri,
              tableUri: persisted.tableUri,
              rowCount: persisted.rowCount,
            }
          }
          return jsonToolResult({
            uri: input.uri,
            width: result.width,
            height: result.height,
            axisFit: result.axisFit,
            series: result.series,
            saved,
          })
        } catch (error) {
          return jsonToolError(error instanceof Error ? error.message : '图版数字化失败')
        }
      },
    }) as ToolDefinition,
  )

  tools.push(
    sdk.defineTool({
      name: 'cslab_create_table',
      description:
        '把数值列创建为实验室 Parquet 数据表资产。第一列作为 X 轴，其余列作为 Y 序列；所有列长度必须一致。',
      label: 'CSLab 创建数据表资产',
      promptSnippet: 'cslab_create_table: 将数值序列保存为 Parquet 数据表',
      parameters: Type.Object({
        title: Type.String({ minLength: 1 }),
        columns: Type.Array(
          Type.Object({
            key: Type.Optional(Type.String()),
            label: Type.String({ minLength: 1 }),
            unit: Type.Optional(Type.String()),
            values: Type.Array(Type.Number()),
          }),
          { minItems: 2 },
        ),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const input = params as {
          title: string
          columns: Array<{ key?: string; label: string; unit?: string; values: number[] }>
        }
        try {
          if (input.columns.length < 2) throw new Error('至少需要 X 列与一个 Y 列')
          const rowCount = input.columns[0]!.values.length
          if (rowCount < 2) throw new Error('数据表至少需要 2 行')
          for (const column of input.columns) {
            if (column.values.length !== rowCount) throw new Error(`列 ${column.label} 长度不一致`)
            if (column.values.some((value) => !Number.isFinite(value))) {
              throw new Error(`列 ${column.label} 含非有限数值`)
            }
          }
          const x = input.columns[0]!
          const rest = input.columns.slice(1)
          const dataset = buildDataset({
            format: 'agent-table',
            xLabel: x.label,
            xUnit: x.unit,
            seriesLabels: rest.map((column) => ({ label: column.label, unit: column.unit })),
            x: x.values,
            series: rest.map((column) => column.values),
            metadata: { source: 'agent', title: input.title },
          })

          const tableUuid = `table-${randomUUID().slice(0, 8)}`
          const tableUri = buildCsLabUri(labId, 'table', tableUuid)
          const relPath = `vault/tables/${tableUuid}.parquet`
          const previewRelPath = `vault/tables/${tableUuid}.preview.json`
          const absolute = resolveLabRelativePath(labId, relPath)
          await fs.mkdir(join(resolveLabDir(labId), 'vault', 'tables'), { recursive: true })
          const parquet = await writeDatasetParquet(dataset, absolute)
          await writeDatasetPreview(dataset, resolveLabRelativePath(labId, previewRelPath))
          const bytes = await fs.readFile(absolute)
          const sha256 = createHash('sha256').update(bytes).digest('hex')
          const db = getCsLabDatabase(join(resolveLabDir(labId), 'db', 'central_meta.sqlite'))
          const now = Date.now()
          withTransaction(db, () => {
            const revision = nextLabRevision(db)
            upsertEntity(db, {
              uri: tableUri,
              labId,
              layerType: 'table',
              entityUuid: tableUuid,
              title: sanitizeFileName(input.title).slice(0, 120) || 'AI 数据表',
              format: 'parquet',
              relPath,
              sha256,
              bytes: parquet.bytes,
              metaJson: JSON.stringify({ source: 'agent' }),
              revision,
              locked: true,
              createdAt: now,
              updatedAt: now,
            })
            upsertTable(db, {
              uri: tableUri,
              parquetRelPath: relPath,
              previewRelPath,
              columnsJson: JSON.stringify(dataset.columns),
              rowCount: dataset.rowCount,
              revision,
            })
            return revision
          })
          broadcastCsLabEvent(CSLAB_IPC_CHANNELS.ON_ASSET_CHANGED, {
            labId,
            uri: tableUri,
            kind: 'created',
            revision: 1,
          })
          return jsonToolResult({
            uri: tableUri,
            title: input.title,
            rowCount,
            columns: dataset.columns,
          })
        } catch (error) {
          return jsonToolError(error instanceof Error ? error.message : '创建数据表失败')
        }
      },
    }) as ToolDefinition,
  )

  tools.push(
    sdk.defineTool({
      name: 'cslab_write_canvas',
      description:
        '创建或更新符合 JSON Canvas 规范的推演画布。无 relPath 时新建；有 relPath 时按 expectedMtimeMs 做冲突检测后写入。',
      label: 'CSLab 写入推演画布',
      promptSnippet: 'cslab_write_canvas: 生成/更新 JSON Canvas 推演画布',
      parameters: Type.Object({
        title: Type.String({ minLength: 1 }),
        relPath: Type.Optional(Type.String()),
        document: Type.Record(Type.String(), Type.Unknown()),
        expectedMtimeMs: Type.Optional(Type.Number()),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const input = params as {
          title: string
          relPath?: string
          document: CsLabCanvasDocument
          expectedMtimeMs?: number
        }
        try {
          if (!Array.isArray(input.document?.nodes) || !Array.isArray(input.document?.edges)) {
            throw new Error('document 必须包含 nodes 与 edges 数组')
          }
          let relPath = input.relPath
          let expectedMtimeMs = input.expectedMtimeMs
          if (!relPath) {
            const created = await createCanvas(labId, input.title)
            relPath = created.relPath
            expectedMtimeMs = created.mtimeMs
          }
          const result = await writeCanvas({
            labId,
            relPath,
            document: input.document,
            expectedMtimeMs,
          })
          broadcastCsLabEvent(CSLAB_IPC_CHANNELS.ON_ASSET_CHANGED, {
            labId,
            uri: `canvas:${result.relPath}`,
            kind: 'updated',
            revision: 1,
          })
          return jsonToolResult({
            relPath: result.relPath,
            nodes: result.document.nodes.length,
            edges: result.document.edges.length,
            durability: result.durability,
            conflictRelPath: result.conflictRelPath,
          })
        } catch (error) {
          return jsonToolError(error instanceof Error ? error.message : '写入画布失败')
        }
      },
    }) as ToolDefinition,
  )

  tools.push(
    sdk.defineTool({
      name: 'cslab_write_manuscript',
      description:
        '新建手稿或向已有手稿追加段落。追加时以 docJson 为唯一真相源，不携带旧 canvasData，前端会从最新段落重新编译画布。',
      label: 'CSLab 写入手稿段落',
      promptSnippet: 'cslab_write_manuscript: 新建/追加手稿段落',
      parameters: Type.Object({
        title: Type.String({ minLength: 1 }),
        uri: Type.Optional(Type.String()),
        paragraphs: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
        capsules: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const input = params as {
          title: string
          uri?: string
          paragraphs: string[]
          capsules?: CsLabCapsule[]
        }
        try {
          if (input.uri) {
            const manuscript = await getManuscript(labId, input.uri)
            if (!manuscript) throw new Error('手稿不存在')
            const saved = await saveManuscript({
              labId,
              uri: manuscript.uri,
              title: input.title.trim() || manuscript.title,
              docJson: appendDoc(manuscript.docJson, input.paragraphs),
              // 关键：不传旧 canvasData，确保前端从最新 docJson 重新编译。
              canvasData: undefined,
              comments: manuscript.comments,
              capsules: input.capsules ?? manuscript.capsules,
            })
            broadcastCsLabEvent(CSLAB_IPC_CHANNELS.ON_ASSET_CHANGED, {
              labId,
              uri: saved.uri,
              kind: 'updated',
              revision: 1,
            })
            return jsonToolResult({
              uri: saved.uri,
              title: saved.title,
              paragraphs: input.paragraphs.length,
              mode: 'appended',
            })
          }
          const created = await createManuscript(labId, input.title)
          const saved = await saveManuscript({
            labId,
            uri: created.uri,
            title: created.title,
            docJson: buildDoc(input.paragraphs),
            canvasData: undefined,
            comments: undefined,
            capsules: input.capsules ?? [],
          })
          broadcastCsLabEvent(CSLAB_IPC_CHANNELS.ON_ASSET_CHANGED, {
            labId,
            uri: saved.uri,
            kind: 'created',
            revision: 1,
          })
          return jsonToolResult({
            uri: saved.uri,
            title: saved.title,
            paragraphs: input.paragraphs.length,
            mode: 'created',
          })
        } catch (error) {
          return jsonToolError(error instanceof Error ? error.message : '写入手稿失败')
        }
      },
    }) as ToolDefinition,
  )

  return tools
}
