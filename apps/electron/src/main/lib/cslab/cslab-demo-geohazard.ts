/**
 * 演示实验室 · 成都理工大学 SKLGP 泥石流动力学推演
 *
 * 内置合成 Wenjia-like 沟谷 DEM、小时降雨、出口时程与演示论文 PDF；
 * 首次创建时跑一次短时 Voellmy 推演，生成最大水深/流速栅格、危险性图版与两套出版图。
 */

import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  CsLabAssetSummary,
  CsLabCapsule,
  CsLabDemoLabResult,
  CsLabIngestResult,
  CsLabLab,
  CsLabPlotDocument,
  CsLabPlotSeries,
} from '@profer/shared'
import { createPlotDocument } from '@profer/shared'
import { createLab, listLabs } from './cslab-manager'
import { ingestFiles, listAssets, resolveDerivedTableUri } from './cslab-iron-cage'
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
import { registerEntityFile } from './cslab-geohazard-tools'
import { DEMO_LAB_NAMES, resolveGeohazardDemoDir } from './cslab-demo'
import { bindCapsule } from './cslab-capsule'
import {
  attachDocx,
  createManuscript,
  getLinkedDocxPath,
  getManuscript,
  listManuscripts,
  saveManuscript,
} from './cslab-manuscript'
import { exportManuscriptToDocx } from './cslab-ooxml'
import { getCsLabDatabase, getLabState, setLabState } from './cslab-db'
import { resolveLabDir, resolveLabRelativePath } from './cslab-paths'
import { getLiteratureStructure } from './cslab-literature-structure'
import { buildLabLiteratureIndex } from './cslab-literature-index'
import { createCanvas, listCanvases, writeCanvas } from './cslab-canvas-sync'
import { indexSingleNote, listVaultNotes } from './cslab-vault-index'
import {
  SKLGP_CANVAS_TITLE,
  SKLGP_HYDROGRAPH_FILE,
  SKLGP_NOTE_REL_PATH,
  SKLGP_NOTE_TITLE,
  SKLGP_THESIS_TITLE,
  buildSkLgpCanvasDocument,
  buildSkLgpDemoPapers,
  buildSkLgpResearchNote,
  buildSkLgpThesisDocJson,
  renderDemoHydrographPng,
  resolveThesisCapsuleRows,
} from './cslab-demo-geohazard-content'

const REQUIRED_FILES = [
  'wenjia_gully_dem.asc',
  'rainfall_timeseries.csv',
  'debris_flow_timeseries.csv',
] as const

const PLOT_IDS = [
  'demo-sklgp-id-curve',
  'demo-sklgp-timeseries',
  'demo-sklgp-runout-profile',
] as const

async function requireDemoFiles(demoDir: string): Promise<string[]> {
  const paths: string[] = []
  const missing: string[] = []
  for (const fileName of REQUIRED_FILES) {
    const path = join(demoDir, fileName)
    try {
      await fs.access(path)
      paths.push(path)
    } catch {
      missing.push(fileName)
    }
  }
  if (missing.length > 0) {
    throw new Error(`SKLGP 演示数据缺失：${missing.join('、')}（期望目录 ${demoDir}）`)
  }
  return paths
}

/** 把 3 篇演示 PDF 写入临时目录后入笼；ingestFiles 按 SHA 去重，重复调用不会产生副本。 */
async function ingestDemoPapers(labId: string): Promise<CsLabIngestResult[]> {
  const tempDir = await fs.mkdtemp(join(tmpdir(), 'cslab-demo-papers-'))
  try {
    const paths: string[] = []
    for (const paper of buildSkLgpDemoPapers()) {
      const path = join(tempDir, paper.fileName)
      await fs.writeFile(path, paper.buffer)
      paths.push(path)
    }
    return await ingestFiles(labId, paths)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

function basePlot(labId: string, id: string, title: string): CsLabPlotDocument {
  return createPlotDocument({ id, labId, title, presetId: 'nature' })
}

async function saveDemoPlot(labId: string, plot: CsLabPlotDocument): Promise<void> {
  const summary = await savePlot({ labId, plot })
  broadcastCsLabEvent(CSLAB_IPC_CHANNELS.ON_PLOT_UPDATED, {
    labId,
    plot: { ...plot, updatedAt: summary.updatedAt },
    source: 'agent',
  })
}

function buildIdCurvePlot(labId: string): { plot: CsLabPlotDocument; alpha: number; beta: number } {
  const threshold = buildRainfallThresholdResult({})
  const plot = basePlot(labId, PLOT_IDS[0], '临界降雨 I-D 曲线（示例参数）')
  const layer = plot.layers[0]!
  const series: CsLabPlotSeries = {
    id: 'id-curve',
    name: `I = ${threshold.alpha}·D^-${threshold.beta}`,
    x: threshold.curve.map((point) => point.durationMin),
    y: threshold.curve.map((point) => point.intensityMmPerHour),
    color: '#b52f3b',
    lineWidth: 0.7,
    lineStyle: 'solid',
    marker: 'circle',
    yAxis: 0,
    visible: true,
    alpha: 1,
  }
  return {
    alpha: threshold.alpha,
    beta: threshold.beta,
    plot: {
      ...plot,
      layers: [{
        ...layer,
        series: [series],
        xAxis: { ...layer.xAxis, title: 'Duration', unit: 'min', scale: 'log10' },
        yAxes: [
          { ...layer.yAxes[0]!, title: 'Intensity', unit: 'mm/h', scale: 'log10' },
          layer.yAxes[1]!,
        ],
      }],
      updatedAt: Date.now(),
    },
  }
}

function buildTimeseriesPlot(
  labId: string,
  timeseries: Array<{ timeS: number; dischargeM3s: number; depthM: number; velocityMs: number }>,
): CsLabPlotDocument {
  const plot = basePlot(labId, PLOT_IDS[1], '泥石流出口流量 / 水深 / 流速时程')
  const layer = plot.layers[0]!
  const x = timeseries.map((point) => point.timeS)
  const series: CsLabPlotSeries[] = [
    {
      id: 'discharge',
      name: '流量',
      x,
      y: timeseries.map((point) => point.dischargeM3s),
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
      x,
      y: timeseries.map((point) => point.depthM),
      color: '#b52f3b',
      lineWidth: 0.6,
      lineStyle: 'dash',
      marker: 'none',
      yAxis: 1,
      visible: true,
      alpha: 1,
    },
    {
      id: 'velocity',
      name: '流速',
      x,
      y: timeseries.map((point) => point.velocityMs),
      color: '#2e9e6b',
      lineWidth: 0.5,
      lineStyle: 'dot',
      marker: 'none',
      yAxis: 1,
      visible: true,
      alpha: 1,
    },
  ]
  return {
    ...plot,
    layers: [{
      ...layer,
      series,
      xAxis: { ...layer.xAxis, title: 'Time', unit: 's' },
      yAxes: [
        { ...layer.yAxes[0]!, title: 'Discharge', unit: 'm³/s' },
        { ...layer.yAxes[1]!, title: 'Depth / Velocity', unit: 'm / m·s⁻¹' },
      ],
    }],
    updatedAt: Date.now(),
  }
}

function buildRunoutProfile(
  labId: string,
  raster: Awaited<ReturnType<typeof parseGeoRasterBuffer>>,
  maxDepth: Float32Array,
  flowAccumulation: Float32Array,
  threshold: number,
  sourceRow: number,
): CsLabPlotDocument {
  const { width, height, cellsize } = raster.meta
  const distances: number[] = []
  const elevations: number[] = []
  const depths: number[] = []
  for (let row = 0; row < height; row += 1) {
    let bestCol = -1
    for (let col = 0; col < width; col += 1) {
      const index = row * width + col
      if (!Number.isFinite(raster.values[index])) continue
      if (flowAccumulation[index]! < threshold) continue
      if (bestCol < 0 || flowAccumulation[index]! > flowAccumulation[row * width + bestCol]!) {
        bestCol = col
      }
    }
    if (bestCol < 0) continue
    const index = row * width + bestCol
    distances.push(Math.abs(row - sourceRow) * cellsize)
    elevations.push(raster.values[index]!)
    depths.push(maxDepth[index]!)
  }
  const plot = basePlot(labId, PLOT_IDS[2], '主沟纵剖面 · 高程与最大水深')
  const layer = plot.layers[0]!
  const series: CsLabPlotSeries[] = [
    {
      id: 'elevation',
      name: '高程',
      x: distances,
      y: elevations,
      color: '#5c6670',
      lineWidth: 0.8,
      lineStyle: 'solid',
      marker: 'none',
      yAxis: 0,
      visible: true,
      alpha: 1,
    },
    {
      id: 'max-depth',
      name: '最大水深',
      x: distances,
      y: depths,
      color: '#b52f3b',
      lineWidth: 0.7,
      lineStyle: 'dash',
      marker: 'none',
      yAxis: 1,
      visible: true,
      alpha: 1,
    },
  ]
  return {
    ...plot,
    layers: [{
      ...layer,
      series,
      xAxis: { ...layer.xAxis, title: 'Downstream distance', unit: 'm' },
      yAxes: [
        { ...layer.yAxes[0]!, title: 'Elevation', unit: 'm' },
        { ...layer.yAxes[1]!, title: 'Max depth', unit: 'm' },
      ],
    }],
    updatedAt: Date.now(),
  }
}

export const SKLGP_DEMO_CONTENT_VERSION = '2'

function resolveDebrisTableUri(
  labId: string,
  ingestResults?: CsLabIngestResult[],
): string | undefined {
  const fromIngest = ingestResults?.find(
    (result) => result.asset.title === 'debris_flow_timeseries.csv',
  )?.tableUri
  if (fromIngest) return fromIngest
  const raw = listAssets(labId).find(
    (asset) => asset.title === 'debris_flow_timeseries.csv' && asset.layerType === 'raw',
  )
  return raw ? (resolveDerivedTableUri(labId, raw.uri) ?? undefined) : undefined
}

function resolveDemoDemUri(labId: string): string | undefined {
  return listAssets(labId).find(
    (asset) => asset.layerType === 'geo' && asset.title === 'wenjia_gully_dem.asc',
  )?.uri
}

async function seedDemoThesis(
  lab: CsLabLab,
  demoDir: string,
  tableUri: string | undefined,
  db: ReturnType<typeof getCsLabDatabase>,
): Promise<void> {
  const storedUri = getLabState(db, 'sklgp_demo_thesis_uri') ?? undefined
  const titledUri = listManuscripts(lab.id).find(
    (manuscript) => manuscript.title === SKLGP_THESIS_TITLE,
  )?.uri
  const existingUri = storedUri ?? titledUri

  if (existingUri) {
    const existing = await getManuscript(lab.id, existingUri)
    if (existing) {
      if (!getLinkedDocxPath(lab.id, existingUri)) {
        const buffer = await exportManuscriptToDocx({
          title: existing.title,
          docJson: existing.docJson,
          capsules: existing.capsules.map(({ id, label, unit, value }) => ({
            id,
            label,
            unit,
            value,
          })),
        })
        await attachDocx(lab.id, existingUri, buffer)
      }
      setLabState(db, 'sklgp_demo_thesis_uri', existingUri)
      return
    }
  }

  const csvText = await fs.readFile(join(demoDir, 'debris_flow_timeseries.csv'), 'utf-8')
  const { peakDischargeRow, maxDepthRow } = resolveThesisCapsuleRows(csvText)
  const manuscript = await createManuscript(lab.id, SKLGP_THESIS_TITLE)

  let capsules: CsLabCapsule[] = []
  if (tableUri) {
    try {
      const peak = await bindCapsule(lab.id, manuscript.uri, {
        id: 'cap-demo-peak-discharge',
        label: '峰值流量（示例时程）',
        tableUri,
        column: 'y1',
        rowIndex: peakDischargeRow,
        unit: 'm³/s',
      })
      const depth = await bindCapsule(lab.id, manuscript.uri, {
        id: 'cap-demo-max-depth',
        label: '最大水深（示例时程）',
        tableUri,
        column: 'y2',
        rowIndex: maxDepthRow,
        unit: 'm',
      })
      capsules = [peak, depth]
    } catch (error) {
      console.warn('[CSLab] 演示论文胶囊绑定失败，已降级为占位文字:', error)
    }
  }

  const docJson = buildSkLgpThesisDocJson(
    capsules.map((capsule) => ({
      id: capsule.id,
      label: capsule.label,
      value: capsule.value,
      unit: capsule.unit ?? '',
      tableUri: capsule.tableUri,
      column: capsule.column,
      rowIndex: capsule.rowIndex,
      revisionAtBind: capsule.revisionAtBind,
    })),
  )

  // 关键：不传 canvasData / comments。sidecar 会省略空 Canvas，
  // 渲染层才能通过 legacyTipTapToCanvasWithComments 正常显示正文与批注。
  await saveManuscript({
    labId: lab.id,
    uri: manuscript.uri,
    title: SKLGP_THESIS_TITLE,
    docJson,
    capsules,
  })

  const buffer = await exportManuscriptToDocx({
    title: SKLGP_THESIS_TITLE,
    docJson,
    capsules: capsules.map(({ id, label, unit, value }) => ({ id, label, unit, value })),
  })
  await attachDocx(lab.id, manuscript.uri, buffer)
  setLabState(db, 'sklgp_demo_thesis_uri', manuscript.uri)
}

async function seedDemoCanvas(
  lab: CsLabLab,
  tableUri: string | undefined,
  db: ReturnType<typeof getCsLabDatabase>,
): Promise<void> {
  const stored = getLabState(db, 'sklgp_demo_canvas_rel_path')
  if (stored) {
    try {
      await fs.access(resolveLabRelativePath(lab.id, stored))
      return
    } catch {
      // 文件被移动/删除，走重建分支。
    }
  }

  const existing = (await listCanvases(lab.id)).find(
    (canvas) => canvas.title === SKLGP_CANVAS_TITLE,
  )
  if (existing) {
    setLabState(db, 'sklgp_demo_canvas_rel_path', existing.relPath)
    return
  }

  const created = await createCanvas(lab.id, SKLGP_CANVAS_TITLE)
  await writeCanvas({
    labId: lab.id,
    relPath: created.relPath,
    document: buildSkLgpCanvasDocument({
      tableUri,
      demUri: resolveDemoDemUri(lab.id),
    }),
    expectedMtimeMs: created.mtimeMs,
  })
  setLabState(db, 'sklgp_demo_canvas_rel_path', created.relPath)
}

async function seedDemoNote(
  lab: CsLabLab,
  tableUri: string | undefined,
  db: ReturnType<typeof getCsLabDatabase>,
): Promise<void> {
  await fs.mkdir(resolveLabRelativePath(lab.id, 'vault/notes'), { recursive: true })

  const stored = getLabState(db, 'sklgp_demo_note_rel_path')
  if (stored) {
    try {
      await fs.access(resolveLabRelativePath(lab.id, stored))
      return
    } catch {
      // 文件被移动/删除，走重建分支。
    }
  }

  const existing = listVaultNotes(lab.id).find((note) => note.title === SKLGP_NOTE_TITLE)
  if (existing) {
    setLabState(db, 'sklgp_demo_note_rel_path', existing.relPath)
    return
  }

  const content = buildSkLgpResearchNote({
    demUri: resolveDemoDemUri(lab.id),
    tableUri,
    thesisTitle: SKLGP_THESIS_TITLE,
    canvasTitle: SKLGP_CANVAS_TITLE,
  })
  const absPath = resolveLabRelativePath(lab.id, SKLGP_NOTE_REL_PATH)
  await fs.writeFile(absPath, content, 'utf-8')
  await indexSingleNote(lab.id, SKLGP_NOTE_REL_PATH)
  setLabState(db, 'sklgp_demo_note_rel_path', SKLGP_NOTE_REL_PATH)
}

/**
 * 幂等补齐 SKLGP 演示实验室的「新增演示内容」。
 *
 * - 已有实验室升级与首次创建共用；
 * - 只补缺失项，绝不覆盖用户改过的文稿/画布/笔记；
 * - 版本号写入 lab_state，避免每次 LIST_LABS 都重复解析 PDF。
 */
export async function ensureSkLgpDemoContent(
  lab: CsLabLab,
  options: { demoDir?: string; ingestResults?: CsLabIngestResult[] } = {},
): Promise<void> {
  const demoDir = resolveGeohazardDemoDir(options.demoDir)
  const db = getCsLabDatabase(join(resolveLabDir(lab.id), 'db', 'central_meta.sqlite'))
  if (getLabState(db, 'sklgp_demo_content_version') === SKLGP_DEMO_CONTENT_VERSION) return

  let criticalOk = true
  const run = async (label: string, task: () => Promise<void>, critical = true): Promise<void> => {
    try {
      await task()
    } catch (error) {
      console.warn(`[CSLab] SKLGP 演示内容补齐失败（${label}）:`, error)
      if (critical) criticalOk = false
    }
  }

  // 1. 文献：3 篇 PDF 入笼 + 结构化解析 + 跨文献索引。
  await run(
    '文献',
    async () => {
      const paperResults = await ingestDemoPapers(lab.id)
      const litUris = new Set(
        paperResults
          .filter((result) => result.asset.layerType === 'lit')
          .map((result) => result.asset.uri),
      )
      for (const asset of listAssets(lab.id)) {
        if (asset.layerType === 'lit') litUris.add(asset.uri)
      }
      for (const uri of litUris) {
        try {
          await getLiteratureStructure(lab.id, uri, { ensure: true })
        } catch (error) {
          console.warn(`[CSLab] 演示文献结构解析失败: ${uri}`, error)
        }
      }
      await buildLabLiteratureIndex(lab.id, { force: true })
    },
    false,
  )

  // 2. 多曲线过程线 PNG（走 registerEntityFile，直接写 Buffer）。
  await run('过程线图', async () => {
    const existing = listAssets(lab.id).find(
      (asset) => asset.layerType === 'fig' && asset.title === SKLGP_HYDROGRAPH_FILE,
    )
    if (existing) return
    await registerEntityFile({
      labId: lab.id,
      layerType: 'fig',
      title: SKLGP_HYDROGRAPH_FILE,
      format: 'png',
      relDir: 'figures',
      content: Buffer.from(renderDemoHydrographPng()),
      metaJson: JSON.stringify({ kind: 'digitizer-demo', curves: 3 }),
    })
  })

  // 3. 写了一半的 DOCX 论文初稿。
  const tableUri = resolveDebrisTableUri(lab.id, options.ingestResults)
  await run('论文初稿', () => seedDemoThesis(lab, demoDir, tableUri, db))

  // 4. JSON Canvas 推演画布。
  await run('推演画布', () => seedDemoCanvas(lab, tableUri, db))

  // 5. 研究日志（为 Obsidian 互通提供双链入口）。
  await run('研究日志', () => seedDemoNote(lab, tableUri, db))

  if (criticalOk) {
    setLabState(db, 'sklgp_demo_content_version', SKLGP_DEMO_CONTENT_VERSION)
  }
}

export async function createSkLgpGeohazardDemoLab(demoDirInput?: string): Promise<CsLabDemoLabResult> {
  const demoDir = resolveGeohazardDemoDir(demoDirInput)
  const dataPaths = await requireDemoFiles(demoDir)

  const existing = listLabs().find((lab) => lab.demoKind === 'sklgp-geohazard')
  const lab: CsLabLab = existing ?? createLab({
    name: DEMO_LAB_NAMES['sklgp-geohazard'],
    description:
      '内置 SKLGP 方向演示沙箱：合成 Wenjia-like 沟谷 DEM、小时降雨、入口时程、I-D 临界降雨曲线、Voellmy 泥石流推演与危险性分区图版，另含 3 篇演示文献、推演画布、研究日志与一篇未完成的论文初稿（含审稿批注与活体数据胶囊）。',
    tags: [
      '演示',
      'SKLGP',
      '泥石流',
      'DEM',
      'I-D 曲线',
      'Voellmy',
      '危险性图版',
      '论文初稿',
      '文献智脑',
      '推演画布',
    ],
    demoKind: 'sklgp-geohazard',
  })

  const ingestResults = await ingestFiles(lab.id, dataPaths)
  const failed = ingestResults.filter((result) => result.status !== 'ok')
  if (failed.length > 0) {
    throw new Error(`SKLGP 演示数据摄取失败：${failed.map((result) => result.message).join('；')}`)
  }

  const plotIds: string[] = []
  let geohazardStats: CsLabDemoLabResult['geohazardStats']

  try {
    const demBuffer = await fs.readFile(join(demoDir, 'wenjia_gully_dem.asc'))
    const raster = await parseGeoRasterBuffer(demBuffer, 'wenjia_gully_dem.asc')
    const analysis = analyzeDem(raster)
    const { result, grid } = simulateDebrisFlowDetailed(raster, {
      demUri: 'demo://wenjia',
      rheology: { model: 'voellmy', mu: 0.2, xi: 400 },
      volumeM3: 200_000,
      durationS: 300,
      engine: 'typescript',
    })

    const metaJson = JSON.stringify({
      kind: 'debris-flow-demo',
      width: raster.meta.width,
      height: raster.meta.height,
      cellsize: raster.meta.cellsize,
      model: result.model,
    })
    await registerEntityFile({
      labId: lab.id,
      layerType: 'geo',
      title: '最大水深 · SKLGP 演示',
      format: 'esri-ascii-grid',
      relDir: 'geo',
      content: writeEsriAsciiGrid(raster.meta, grid.maxH),
      metaJson,
    })
    await registerEntityFile({
      labId: lab.id,
      layerType: 'geo',
      title: '最大流速 · SKLGP 演示',
      format: 'esri-ascii-grid',
      relDir: 'geo',
      content: writeEsriAsciiGrid(raster.meta, grid.maxSpeed),
      metaJson,
    })
    await registerEntityFile({
      labId: lab.id,
      layerType: 'fig',
      title: '危险性分区图 · SKLGP 演示',
      format: 'png',
      relDir: 'figures',
      content: renderHazardMapPng(
        raster,
        { meta: raster.meta, values: grid.maxH },
        { meta: raster.meta, values: grid.maxSpeed },
        result.source,
      ),
      metaJson,
    })

    const idPlot = buildIdCurvePlot(lab.id)
    await saveDemoPlot(lab.id, idPlot.plot)
    plotIds.push(idPlot.plot.id)

    const timeseriesPlot = buildTimeseriesPlot(lab.id, result.timeseries)
    await saveDemoPlot(lab.id, timeseriesPlot)
    plotIds.push(timeseriesPlot.id)

    const profile = buildRunoutProfile(
      lab.id,
      raster,
      grid.maxH,
      analysis.flowAccumulation,
      analysis.channelThreshold,
      result.source.row,
    )
    await saveDemoPlot(lab.id, profile)
    plotIds.push(profile.id)

    geohazardStats = {
      nistMaxDeviationDeg: 0,
      ramanRSquared: 0,
      ramanAreaRelativeError: 0,
      peakDischargeM3s: result.peakDischargeM3s,
      runoutDistanceM: result.runoutDistanceM,
      maxFlowDepthM: result.maxDepthM,
    }
  } catch (error) {
    console.warn('[CSLab] SKLGP 演示推演生成失败（实验室仍可用）:', error)
  }

  // 新增演示内容：多文献、过程线图、论文初稿、推演画布、研究日志。
  // 单步失败只告警，保证实验室与已有资产仍可用。
  await ensureSkLgpDemoContent(lab, { demoDir, ingestResults })

  const assets = await listAssets(lab.id)
  return {
    lab,
    assets,
    plotId: plotIds[0],
    plotIds,
    kind: 'sklgp-geohazard',
    geohazardStats,
  }
}
