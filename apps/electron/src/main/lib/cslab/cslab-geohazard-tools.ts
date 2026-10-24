/**
 * CSLab 地质灾害科研工具集（SKLGP 泥石流方向）
 *
 * 提供 DEM 分析、I-D 临界降雨、Voellmy/Bingham 推演与危险性图版生成。
 */

import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type {
  CsLabAssetSummary,
  CsLabDebrisFlowSimulationInput,
  CsLabGeoRaster,
  CsLabHazardMapInput,
  CsLabPlotDocument,
  CsLabPlotSeries,
  CsLabRainfallThresholdInput,
} from '@profer/shared'
import { createPlotDocument } from '@profer/shared'
import { getAgentSessionMeta } from '../agent-session-manager'
import {
  getCsLabDatabase,
  nextLabRevision,
  upsertEntity,
  withTransaction,
} from './cslab-db'
import {
  assertLabId,
  resolveLabDir,
  resolveLabRelativePath,
  sanitizeFileName,
} from './cslab-paths'
import { buildCsLabUri } from './cslab-uri'
import { getLayerTypeOf, listAssets, resolveAssetPath } from './cslab-iron-cage'
import { lockFileReadOnly } from './cslab-hash'
import { savePlot } from './cslab-science'
import { broadcastCsLabEvent } from './cslab-events'
import { CSLAB_IPC_CHANNELS } from './cslab-types'
import {
  analyzeDem,
  buildRainfallThresholdResult,
  parseGeoRasterBuffer,
  renderHazardMapPng,
  simulateDebrisFlowDetailed,
  writeEsriAsciiGrid,
} from './cslab-geohazard'
import { exportFigure } from './cslab-science'

type PiSdkLike = typeof import('@earendil-works/pi-coding-agent')

export interface PiCsLabGeohazardToolsContext {
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

async function requireGeoRaster(labId: string, uri: string): Promise<CsLabGeoRaster & { path: string }> {
  if (getLayerTypeOf(uri) !== 'geo') throw new Error('该资产不是地理栅格（geo 层）')
  const path = resolveAssetPath(labId, uri)
  if (!path) throw new Error('地理栅格文件不存在')
  const buffer = await fs.readFile(path)
  const raster = await parseGeoRasterBuffer(buffer, path)
  return { ...raster, path }
}

export async function registerEntityFile(options: {
  labId: string
  layerType: 'geo' | 'fig'
  title: string
  format: string
  relDir: 'geo' | 'figures'
  content: Buffer | string
  metaJson?: string
}): Promise<CsLabAssetSummary> {
  const labId = assertLabId(options.labId)
  const entityUuid = `${options.layerType}-${randomUUID().slice(0, 8)}`
  const fileName = `${entityUuid}-${sanitizeFileName(options.title)}`
  const relPath = `vault/${options.relDir}/${fileName}`
  const absPath = resolveLabRelativePath(labId, relPath)
  await fs.mkdir(join(absPath, '..'), { recursive: true })
  await fs.writeFile(absPath, options.content)
  const locked = await lockFileReadOnly(absPath)
  const db = getCsLabDatabase(join(resolveLabDir(labId), 'db', 'central_meta.sqlite'))
  const uri = buildCsLabUri(labId, options.layerType, entityUuid)
  const now = Date.now()
  withTransaction(db, () => {
    const revision = nextLabRevision(db)
    upsertEntity(db, {
      uri,
      labId,
      layerType: options.layerType,
      entityUuid,
      title: options.title,
      format: options.format,
      relPath,
      metaJson: options.metaJson,
      revision,
      locked,
      createdAt: now,
      updatedAt: now,
    })
    return revision
  })
  const asset = listAssets(labId).find((item) => item.uri === uri)
  if (!asset) throw new Error('地理/图版资产登记失败')
  broadcastCsLabEvent(CSLAB_IPC_CHANNELS.ON_ASSET_CHANGED, {
    labId,
    uri,
    kind: 'created',
    revision: asset.revision,
  })
  return asset
}

function basePlot(labId: string, id: string, title: string): CsLabPlotDocument {
  return createPlotDocument({ id, labId, title, presetId: 'nature' })
}

function withSeries(
  document: CsLabPlotDocument,
  series: CsLabPlotSeries[],
  xTitle: string,
  xUnit: string,
  yTitle: string,
  yUnit: string,
): CsLabPlotDocument {
  const layer = document.layers[0]!
  return {
    ...document,
    layers: [{
      ...layer,
      series,
      xAxis: { ...layer.xAxis, title: xTitle, unit: xUnit },
      yAxes: [
        { ...layer.yAxes[0]!, title: yTitle, unit: yUnit },
        layer.yAxes[1]!,
      ],
    }],
    updatedAt: Date.now(),
  }
}

async function saveAndBroadcastPlot(labId: string, plot: CsLabPlotDocument): Promise<string> {
  const summary = await savePlot({ labId, plot })
  const saved = { ...plot, updatedAt: summary.updatedAt }
  broadcastCsLabEvent(CSLAB_IPC_CHANNELS.ON_PLOT_UPDATED, {
    labId,
    plot: saved,
    source: 'agent',
  })
  return summary.id
}

export function buildCsLabGeohazardTools(
  sdk: PiSdkLike,
  ctx: PiCsLabGeohazardToolsContext,
): ToolDefinition[] {
  const meta = getAgentSessionMeta(ctx.sessionId)
  if (!meta?.cslabLabId) return []
  let labId: string
  try {
    labId = assertLabId(meta.cslabLabId)
  } catch {
    return []
  }

  const tools: ToolDefinition[] = []

  tools.push(
    sdk.defineTool({
      name: 'cslab_geohazard_analyze_dem',
      label: 'CSLab 分析 DEM 地形',
      description:
        '解析实验室内的 ESRI ASCII Grid (.asc) 或 GeoTIFF 高程栅格，输出高程范围、坡度/坡向统计、D8 流向、汇流累积、沟道数量与建议源区网格。',
      promptSnippet: 'cslab_geohazard_analyze_dem: DEM 坡度/坡向/汇流分析',
      parameters: Type.Object({
        demUri: Type.String({ minLength: 1, description: 'geo 层 DEM 资产 URI' }),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const input = params as { demUri: string }
        try {
          const raster = await requireGeoRaster(labId, input.demUri)
          const analysis = analyzeDem(raster)
          let flowAccumulationMax = 0
          for (const value of analysis.flowAccumulation) {
            if (value > flowAccumulationMax) flowAccumulationMax = value
          }
          return jsonToolResult({
            ok: true,
            uri: input.demUri,
            width: raster.meta.width,
            height: raster.meta.height,
            cellsizeM: raster.meta.cellsize,
            minElevationM: raster.meta.min,
            maxElevationM: raster.meta.max,
            meanSlopeDeg: Math.round(analysis.meanSlopeDeg * 100) / 100,
            maxSlopeDeg: Math.round(analysis.maxSlopeDeg * 100) / 100,
            dominantAspect: analysis.dominantAspect,
            flowDirectionCounts: analysis.flowDirectionCounts,
            flowAccumulationMax,
            channelThreshold: analysis.channelThreshold,
            channelCount: analysis.channelCount,
            suggestedSource: analysis.suggestedSource,
            warnings: raster.meta.warnings ?? [],
            modelNote: '坡度/坡向采用 Horn 3×3 有限差分；流向为 D8 最陡下降；NaN/NODATA 已屏蔽。',
          })
        } catch (error) {
          return jsonToolError(error instanceof Error ? error.message : 'DEM 分析失败')
        }
      },
    }) as ToolDefinition,
  )

  tools.push(
    sdk.defineTool({
      name: 'cslab_geohazard_rainfall_threshold',
      label: 'CSLab 临界降雨 I-D 曲线',
      description:
        '按 I = alpha * D^(-beta) 拟合泥石流临界降雨阈值。可传入历史临界点做对数域最小二乘；缺省使用区域示例参数并明确标注。默认保存出版绘图并推送到画板。',
      promptSnippet: 'cslab_geohazard_rainfall_threshold: 计算 I-D 临界降雨曲线',
      parameters: Type.Object({
        points: Type.Optional(Type.Array(Type.Object({
          durationMin: Type.Number({ minimum: 1 }),
          intensityMmPerHour: Type.Number({ minimum: 0.01 }),
        }))),
        alpha: Type.Optional(Type.Number({ minimum: 0.01 })),
        beta: Type.Optional(Type.Number({ minimum: 0 })),
        durationsMin: Type.Optional(Type.Array(Type.Number({ minimum: 1 }))),
        savePlot: Type.Optional(Type.Boolean()),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const input = params as CsLabRainfallThresholdInput & { savePlot?: boolean }
        try {
          const result = buildRainfallThresholdResult(input)
          let plotId: string | undefined
          if (input.savePlot !== false) {
            const plot = basePlot(labId, `hazard-id-curve-${Date.now()}`, '泥石流临界降雨 I-D 曲线')
            const series: CsLabPlotSeries = {
              id: 'id-curve',
              name: `I = ${result.alpha.toFixed(2)}·D^-${result.beta.toFixed(2)}`,
              x: result.curve.map((point) => point.durationMin),
              y: result.curve.map((point) => point.intensityMmPerHour),
              color: '#b52f3b',
              lineWidth: 0.7,
              lineStyle: 'solid',
              marker: 'circle',
              yAxis: 0,
              visible: true,
              alpha: 1,
            }
            const plotDocument = withSeries(plot, [series], 'Duration', 'min', 'Intensity', 'mm/h')
            plotDocument.layers[0]!.xAxis.scale = 'log10'
            plotDocument.layers[0]!.yAxes[0]!.scale = 'log10'
            plotId = await saveAndBroadcastPlot(labId, plotDocument)
          }
          return jsonToolResult({
            ...result,
            plotId,
            curve: result.curve.map((point) => ({
              durationMin: point.durationMin,
              intensityMmPerHour: Math.round(point.intensityMmPerHour * 100) / 100,
            })),
          })
        } catch (error) {
          return jsonToolError(error instanceof Error ? error.message : 'I-D 曲线计算失败')
        }
      },
    }) as ToolDefinition,
  )

  tools.push(
    sdk.defineTool({
      name: 'cslab_geohazard_debris_flow_simulation',
      label: 'CSLab 泥石流动力学推演',
      description:
        '在 DEM 上运行二维深度积分浅水波（Voellmy 或 Bingham 流变），输出最大水深/流速/到达时间栅格、出口时程、峰值流量、冲出距离与危险性面积。结果为简化工程模型，需实测校核。',
      promptSnippet: 'cslab_geohazard_debris_flow_simulation: 泥石流 Voellmy/Bingham 推演',
      parameters: Type.Object({
        demUri: Type.String({ minLength: 1 }),
        source: Type.Optional(Type.Object({
          row: Type.Integer({ minimum: 0 }),
          col: Type.Integer({ minimum: 0 }),
        })),
        rheology: Type.Union([
          Type.Object({
            model: Type.Literal('voellmy'),
            mu: Type.Number({ minimum: 0, maximum: 1 }),
            xi: Type.Number({ minimum: 1 }),
          }),
          Type.Object({
            model: Type.Literal('bingham'),
            yieldStressPa: Type.Number({ minimum: 0 }),
            viscosityPaS: Type.Number({ minimum: 0 }),
          }),
        ]),
        volumeM3: Type.Optional(Type.Number({ minimum: 0.01 })),
        rainfall: Type.Optional(Type.Object({
          intensityMmPerHour: Type.Number({ minimum: 0 }),
          durationMin: Type.Number({ minimum: 1 }),
          runoffCoefficient: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
          catchmentAreaM2: Type.Optional(Type.Number({ minimum: 1 })),
        })),
        durationS: Type.Optional(Type.Number({ minimum: 30, maximum: 7200 })),
        engine: Type.Optional(Type.Union([
          Type.Literal('auto'),
          Type.Literal('typescript'),
          Type.Literal('python'),
        ])),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const input = params as CsLabDebrisFlowSimulationInput
        try {
          const raster = await requireGeoRaster(labId, input.demUri)
          let result: ReturnType<typeof simulateDebrisFlowDetailed>['result']
          let analysis: ReturnType<typeof simulateDebrisFlowDetailed>['analysis']
          let maxH: Float32Array
          let maxSpeed: Float32Array
          let arrivalValues: Float32Array
          if (input.engine === 'python') {
            try {
              const { runPythonDebrisFlow } = await import('./cslab-geohazard-python')
              const py = await runPythonDebrisFlow(labId, raster.path, input)
              result = py.result
              analysis = analyzeDem(raster)
              maxH = py.depth.values
              maxSpeed = py.speed.values
              arrivalValues = py.arrival.values
            } catch (error) {
              const fallback = simulateDebrisFlowDetailed(raster, input)
              fallback.result.warnings.push(
                `Python 通道不可用，已回退 TypeScript：${error instanceof Error ? error.message : '未知错误'}`,
              )
              result = fallback.result
              analysis = fallback.analysis
              maxH = fallback.grid.maxH
              maxSpeed = fallback.grid.maxSpeed
              arrivalValues = fallback.grid.arrival
            }
          } else {
            const detailed = simulateDebrisFlowDetailed(raster, input)
            result = detailed.result
            analysis = detailed.analysis
            maxH = detailed.grid.maxH
            maxSpeed = detailed.grid.maxSpeed
            arrivalValues = detailed.grid.arrival
          }
          if (!result.ok) return jsonToolError(result.message ?? '推演失败')

          const stamp = Date.now()
          const metaJson = JSON.stringify({
            kind: 'debris-flow',
            width: raster.meta.width,
            height: raster.meta.height,
            cellsize: raster.meta.cellsize,
            xllcorner: raster.meta.xllcorner,
            yllcorner: raster.meta.yllcorner,
            model: result.model,
          })
          const depthAsset = await registerEntityFile({
            labId,
            layerType: 'geo',
            title: `最大水深 · ${result.model} · ${stamp}`,
            format: 'esri-ascii-grid',
            relDir: 'geo',
            content: writeEsriAsciiGrid(raster.meta, maxH),
            metaJson,
          })
          const speedAsset = await registerEntityFile({
            labId,
            layerType: 'geo',
            title: `最大流速 · ${result.model} · ${stamp}`,
            format: 'esri-ascii-grid',
            relDir: 'geo',
            content: writeEsriAsciiGrid(raster.meta, maxSpeed),
            metaJson,
          })
          const arrivalAsset = await registerEntityFile({
            labId,
            layerType: 'geo',
            title: `到达时间 · ${result.model} · ${stamp}`,
            format: 'esri-ascii-grid',
            relDir: 'geo',
            content: writeEsriAsciiGrid(raster.meta, arrivalValues),
            metaJson,
          })

          const png = renderHazardMapPng(
            raster,
            { meta: raster.meta, values: maxH },
            { meta: raster.meta, values: maxSpeed },
            result.source,
          )
          const hazardAsset = await registerEntityFile({
            labId,
            layerType: 'fig',
            title: `泥石流危险性图 · ${result.model} · ${stamp}`,
            format: 'png',
            relDir: 'figures',
            content: png,
            metaJson: JSON.stringify({ kind: 'hazard-map', source: result.source }),
          })

          let plotId: string | undefined
          if (result.timeseries.length >= 2) {
            const plot = basePlot(labId, `hazard-timeseries-${stamp}`, '泥石流出口流量与水深时程')
            const series: CsLabPlotSeries[] = [
              {
                id: 'discharge',
                name: '流量',
                x: result.timeseries.map((point) => point.timeS),
                y: result.timeseries.map((point) => point.dischargeM3s),
                color: '#2f6fed',
                lineWidth: 0.7,
                lineStyle: 'solid',
                marker: 'none',
                yAxis: 0,
                visible: true,
                alpha: 1,
              },
              {
                id: 'depth',
                name: '水深',
                x: result.timeseries.map((point) => point.timeS),
                y: result.timeseries.map((point) => point.depthM),
                color: '#b52f3b',
                lineWidth: 0.6,
                lineStyle: 'dash',
                marker: 'none',
                yAxis: 0,
                visible: true,
                alpha: 1,
              },
            ]
            plotId = await saveAndBroadcastPlot(
              labId,
              withSeries(plot, series, 'Time', 's', 'Discharge / Depth', 'm³/s · m'),
            )
          }

          return jsonToolResult({
            ...result,
            analysis: {
              suggestedSource: analysis.suggestedSource,
              channelCount: analysis.channelCount,
            },
            outputs: {
              maxDepthUri: depthAsset.uri,
              maxSpeedUri: speedAsset.uri,
              arrivalTimeUri: arrivalAsset.uri,
              hazardPngUri: hazardAsset.uri,
              plotId,
            },
          })
        } catch (error) {
          return jsonToolError(error instanceof Error ? error.message : '泥石流推演失败')
        }
      },
    }) as ToolDefinition,
  )

  tools.push(
    sdk.defineTool({
      name: 'cslab_geohazard_render_hazard_map',
      label: 'CSLab 生成危险性图版',
      description:
        '基于 DEM 与最大水深栅格生成危险性分级 PNG（高/中/低），可注册为实验室图版；可选导出 SVG/PDF 出版图。',
      promptSnippet: 'cslab_geohazard_render_hazard_map: 危险性分区与出版图版',
      parameters: Type.Object({
        demUri: Type.String({ minLength: 1 }),
        maxDepthUri: Type.String({ minLength: 1 }),
        maxSpeedUri: Type.Optional(Type.String()),
        highDepthM: Type.Optional(Type.Number({ minimum: 0.05 })),
        mediumDepthM: Type.Optional(Type.Number({ minimum: 0.01 })),
        lowDepthM: Type.Optional(Type.Number({ minimum: 0.001 })),
        exportFormat: Type.Optional(Type.Union([
          Type.Literal('png'),
          Type.Literal('svg'),
          Type.Literal('pdf'),
        ])),
        plotId: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const input = params as CsLabHazardMapInput & { maxSpeedUri?: string; plotId?: string }
        try {
          const dem = await requireGeoRaster(labId, input.demUri)
          const depth = await requireGeoRaster(labId, input.maxDepthUri!)
          if (depth.meta.width !== dem.meta.width || depth.meta.height !== dem.meta.height) {
            throw new Error('最大水深栅格与 DEM 尺寸不一致')
          }
          const speed = input.maxSpeedUri
            ? await requireGeoRaster(labId, input.maxSpeedUri)
            : { meta: dem.meta, values: new Float32Array(dem.values.length) }
          const source = { row: Math.floor(dem.meta.height * 0.1), col: Math.floor(dem.meta.width * 0.5) }
          const png = renderHazardMapPng(dem, depth, speed, source, {
            highDepthM: input.highDepthM,
            mediumDepthM: input.mediumDepthM,
            lowDepthM: input.lowDepthM,
          })
          const asset = await registerEntityFile({
            labId,
            layerType: 'fig',
            title: `危险性分区图 · ${Date.now()}`,
            format: 'png',
            relDir: 'figures',
            content: png,
            metaJson: JSON.stringify({ kind: 'hazard-map', source }),
          })

          let exportedPath: string | undefined
          if (input.exportFormat && input.exportFormat !== 'png') {
            if (input.plotId) {
              const { loadPlot } = await import('./cslab-science')
              const plot = await loadPlot({ labId, plotId: input.plotId })
              if (plot) {
                const exported = await exportFigure({
                  labId,
                  plot,
                  options: {
                    format: input.exportFormat,
                    dpi: 600,
                    transparentBackground: false,
                  },
                })
                exportedPath = exported.path
              }
            }
          }

          return jsonToolResult({
            ok: true,
            hazardPngUri: asset.uri,
            hazardPngPath: asset.relPath,
            exportedPath,
            message: '危险性等级：高=红（水深≥1.0m 或 h·v≥1.5）、中=橙（≥0.3m）、低=黄（≥0.05m）。',
          })
        } catch (error) {
          return jsonToolError(error instanceof Error ? error.message : '危险性图生成失败')
        }
      },
    }) as ToolDefinition,
  )

  return tools
}
