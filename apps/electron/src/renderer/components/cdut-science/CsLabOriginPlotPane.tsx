/**
 * CSLab Origin 级出版绘图窗格
 */

import * as React from 'react'
import { Download, Loader2, Save, ScanLine, Sigma, SlidersHorizontal, Sparkles } from 'lucide-react'
import { useAtom } from 'jotai'
import type {
  CsLabAgentPlotRoi,
  CsLabFitResult,
  CsLabJournalPresetId,
  CsLabPlotDocument,
} from '@profer/shared'
import { JOURNAL_PRESETS, createPlotDocument } from '@profer/shared'
import { cn } from '@/lib/utils'
import type { CsLabPaneState } from '@/atoms/cslab-atoms'
import { cslabPanePlotsAtom } from '@/atoms/cslab-atoms'
import { CsLabPlotControls } from './CsLabPlotControls'
import { CsLabPlotExportDialog } from './origin/CsLabPlotExportDialog'
import { CsLabPeakFitDrawer, type CsLabFitData } from './origin/CsLabPeakFitDrawer'
import { buildPlotRenderModel } from './origin/cslab-plot-render-model'
import { panAxisWindow, zoomAxisWindow } from './origin/cslab-plot-interaction'
import { drawPlotToCanvas, pixelToData } from './origin/canvas-plot-renderer'

interface CsLabOriginPlotPaneProps {
  labId: string
  pane: CsLabPaneState
  onToast: (kind: 'info' | 'success' | 'error', text: string) => void
}

export function CsLabOriginPlotPane({
  labId,
  pane,
  onToast,
}: CsLabOriginPlotPaneProps): React.ReactElement {
  const [plots, setPlots] = useAtom(cslabPanePlotsAtom)
  const plot = plots[pane.id]
  const [plotState, setPlotState] = React.useState<CsLabPlotDocument | null>(plot)
  const [exportOpen, setExportOpen] = React.useState(false)
  const [fitOpen, setFitOpen] = React.useState(false)
  const [fitData, setFitData] = React.useState<CsLabFitData | null>(null)
  const [roiMode, setRoiMode] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [selection, setSelection] = React.useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  /** 最近一次框选的数据坐标区间；用于「发送至助理」时复用。 */
  const [lastRoi, setLastRoi] = React.useState<CsLabAgentPlotRoi | null>(null)
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const dragRef = React.useRef<{
    pointerId: number
    originX: number
    originY: number
    lastX: number
    lastY: number
    moved: boolean
    startPlot: CsLabPlotDocument
  } | null>(null)

  React.useEffect(() => {
    setPlotState(plot)
  }, [plot])

  const updatePlot = React.useCallback(
    (next: CsLabPlotDocument): void => {
      setPlotState(next)
      setPlots((previous) => ({ ...previous, [pane.id]: next }))
    },
    [pane.id, setPlots],
  )

  const preset = plotState ? JOURNAL_PRESETS[plotState.presetId] ?? JOURNAL_PRESETS.default : JOURNAL_PRESETS.default

  const draw = React.useCallback((): void => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container || !plotState) return
    const width = Math.max(1, container.clientWidth)
    const height = Math.max(1, container.clientHeight)
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    const context = canvas.getContext('2d')
    if (!context) return
    const model = buildPlotRenderModel(plotState, preset, width, height)
    drawPlotToCanvas(context, model, plotState, preset, dpr)
    if (selection) {
      context.save()
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      context.strokeStyle = '#2f6fed'
      context.setLineDash([4, 3])
      context.strokeRect(
        Math.min(selection.x1, selection.x2),
        Math.min(selection.y1, selection.y2),
        Math.abs(selection.x2 - selection.x1),
        Math.abs(selection.y2 - selection.y1),
      )
      context.restore()
    }
  }, [plotState, preset, selection])

  React.useEffect(() => {
    draw()
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver(() => draw())
    observer.observe(container)
    return () => observer.disconnect()
  }, [draw])

  const firstSeries = plotState?.layers[0]?.series.find((series) => series.visible !== false)

  const openFit = (data?: CsLabFitData): void => {
    if (data && data.x.length > 5) {
      setFitData(data)
      setFitOpen(true)
      return
    }
    if (!firstSeries) {
      onToast('info', '当前绘图没有可拟合的曲线')
      return
    }
    setFitData({ x: firstSeries.x, y: firstSeries.y })
    setFitOpen(true)
  }

  const handleFitApply = (result: CsLabFitResult, data: CsLabFitData): void => {
    if (!plotState) return
    const layer = plotState.layers[0]
    if (!layer) return
    const fittedSeries = {
      id: `fit-${Date.now()}`,
      name: '拟合',
      x: data.x,
      y: result.fitted,
      color: '#d04a7a',
      lineWidth: 0.8,
      lineStyle: 'dash' as const,
      marker: 'none' as const,
      yAxis: 0 as const,
      visible: true,
      alpha: 1,
    }
    updatePlot({
      ...plotState,
      layers: [{ ...layer, series: [...layer.series, fittedSeries] }, ...plotState.layers.slice(1)],
      updatedAt: Date.now(),
    })
    setFitOpen(false)
    onToast('success', '拟合曲线已加入图层')
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!plotState || event.button !== 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    dragRef.current = {
      pointerId: event.pointerId,
      originX: x,
      originY: y,
      lastX: x,
      lastY: y,
      moved: false,
      startPlot: plotState,
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // 某些环境不支持 pointer capture，退化为普通事件流。
    }
    if (roiMode) {
      setSelection({ x1: x, y1: y, x2: x, y2: y })
    }
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current
    if (!drag || !plotState || drag.pointerId !== event.pointerId) return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    if (roiMode) {
      setSelection((previous) => (previous ? { ...previous, x2: x, y2: y } : previous))
      return
    }
    if (!drag.moved) {
      const distance = Math.hypot(x - drag.originX, y - drag.originY)
      if (distance < 4) return
      drag.moved = true
    }
    const container = containerRef.current
    if (!container) return
    const scale = Math.min(container.clientWidth / plotState.sizeMm.width, container.clientHeight / plotState.sizeMm.height)
    const layer = plotState.layers[0]
    if (!layer) return
    const model = buildPlotRenderModel(plotState, preset, container.clientWidth, container.clientHeight)
    const entry = model.series[0]
    if (!entry) return
    const dx = (x - drag.lastX) / scale
    const dy = (y - drag.lastY) / scale
    const xWindow = panAxisWindow({
      scale: layer.xAxis.scale,
      min: layer.xAxis.min ?? entry.xBounds.min,
      max: layer.xAxis.max ?? entry.xBounds.max,
      dataMin: entry.xBounds.min,
      dataMax: entry.xBounds.max,
      deltaRatio: dx / Math.max(1e-6, model.plotRect.width),
    })
    const yWindow = panAxisWindow({
      scale: layer.yAxes[0]!.scale,
      min: layer.yAxes[0]!.min ?? entry.yBounds.min,
      max: layer.yAxes[0]!.max ?? entry.yBounds.max,
      dataMin: entry.yBounds.min,
      dataMax: entry.yBounds.max,
      deltaRatio: -dy / Math.max(1e-6, model.plotRect.height),
    })
    const next: CsLabPlotDocument = {
      ...plotState,
      layers: [
        {
          ...layer,
          xAxis: { ...layer.xAxis, ...xWindow },
          yAxes: [
            { ...layer.yAxes[0]!, ...yWindow },
            layer.yAxes[1]!,
          ],
        },
        ...plotState.layers.slice(1),
      ],
      updatedAt: Date.now(),
    }
    updatePlot(next)
    drag.lastX = x
    drag.lastY = y
    drag.startPlot = next
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    dragRef.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // 已释放或环境不支持。
    }
    if (!roiMode || !selection || !plotState) return
    const container = containerRef.current
    if (!container) return
    const model = buildPlotRenderModel(plotState, preset, container.clientWidth, container.clientHeight)
    const start = pixelToData(model, plotState, Math.min(selection.x1, selection.x2), Math.min(selection.y1, selection.y2))
    const end = pixelToData(model, plotState, Math.max(selection.x1, selection.x2), Math.max(selection.y1, selection.y2))
    if (start && end) {
      setLastRoi({
        xMin: Math.min(start.x, end.x),
        xMax: Math.max(start.x, end.x),
        yMin: Math.min(start.y, end.y),
        yMax: Math.max(start.y, end.y),
      })
    }
    if (start && end && firstSeries) {
      const xMin = Math.min(start.x, end.x)
      const xMax = Math.max(start.x, end.x)
      const xs: number[] = []
      const ys: number[] = []
      for (let index = 0; index < firstSeries.x.length; index += 1) {
        const value = firstSeries.x[index]!
        if (value >= xMin && value <= xMax) {
          xs.push(value)
          ys.push(firstSeries.y[index] ?? 0)
        }
      }
      if (xs.length > 5) openFit({ x: xs, y: ys })
    }
    setSelection(null)
    setRoiMode(false)
  }

  const handleWheel = (event: React.WheelEvent<HTMLCanvasElement>): void => {
    event.preventDefault()
    if (!plotState) return
    const layer = plotState.layers[0]
    const container = containerRef.current
    if (!layer || !container) return
    const model = buildPlotRenderModel(plotState, preset, container.clientWidth, container.clientHeight)
    const entry = model.series[0]
    if (!entry) return
    const rect = event.currentTarget.getBoundingClientRect()
    // 以真实绘图区（plotRect，毫米）换算到 CSS 像素，排除坐标轴与留白导致的锚点漂移
    const localX = event.clientX - rect.left
    const plotLeft = model.plotRect.x * model.scale
    const plotWidth = model.plotRect.width * model.scale
    const ratio =
      plotWidth > 0 ? Math.max(0, Math.min(1, (localX - plotLeft) / plotWidth)) : 0.5
    const factor = event.deltaY > 0 ? 1.2 : 1 / 1.2
    const window = zoomAxisWindow({
      scale: layer.xAxis.scale,
      min: layer.xAxis.min ?? entry.xBounds.min,
      max: layer.xAxis.max ?? entry.xBounds.max,
      dataMin: entry.xBounds.min,
      dataMax: entry.xBounds.max,
      anchorRatio: ratio,
      factor,
    })
    updatePlot({
      ...plotState,
      layers: [
        { ...layer, xAxis: { ...layer.xAxis, ...window } },
        ...plotState.layers.slice(1),
      ],
      updatedAt: Date.now(),
    })
  }

  const handleSave = async (): Promise<void> => {
    if (!plotState) return
    setSaving(true)
    try {
      const summary = await window.electronAPI.cslab.savePlot({ labId, plot: plotState })
      onToast('success', `已保存：${summary.title}`)
    } catch (error) {
      onToast('error', error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  /** 把当前选区（或整条可见曲线范围）作为上下文发送给科学助理。 */
  const sendSelectionToAgent = async (): Promise<void> => {
    if (!plotState) return
    let roi = lastRoi
    if (!roi) {
      const layer = plotState.layers[0]
      const series = layer?.series.find((item) => item.visible !== false)
      if (layer && series && series.x.length > 0) {
        let min = series.x[0]!
        let max = min
        for (const value of series.x) {
          if (value < min) min = value
          if (value > max) max = value
        }
        roi = {
          xMin: layer.xAxis.min ?? min,
          xMax: layer.xAxis.max ?? max,
        }
      }
    }
    const roiText = roi ? `在 x = ${roi.xMin.toFixed(2)} ~ ${roi.xMax.toFixed(2)} 区间` : ''
    try {
      const result = await window.electronAPI.cslab.sendToAgentWindow({
        labId,
        source: 'plot-roi',
        prompt: `请读取绘图《${plotState.title}》（plotId=${plotState.id}），${roiText}执行多峰解叠拟合，并用 cslab_render_plot 把拟合曲线追加到画板。`,
        plotId: plotState.id,
        plotTitle: plotState.title,
        roi: roi ?? undefined,
        createdAt: Date.now(),
      })
      onToast(
        result.delivered ? 'success' : 'info',
        result.delivered ? '已发送至科学助理' : '科学助理未就绪，请重试',
      )
    } catch (error) {
      onToast('error', error instanceof Error ? error.message : '发送至助理失败')
    }
  }

  const changePreset = (presetId: CsLabJournalPresetId): void => {
    if (!plotState) return
    const nextPreset = JOURNAL_PRESETS[presetId]
    updatePlot({
      ...plotState,
      presetId,
      sizeMm: { width: nextPreset.singleColumnMm, height: Math.round(nextPreset.singleColumnMm * 0.75 * 10) / 10 },
      updatedAt: Date.now(),
    })
  }

  if (!plotState) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-xs text-muted-foreground">
        <Sigma className="h-6 w-6" />
        <p>当前窗格没有出版图。</p>
        <button
          type="button"
          onClick={() => {
            const created = createPlotDocument({
              id: `plot-${Date.now()}`,
              labId,
              title: '新绘图',
            })
            updatePlot(created)
          }}
          className="rounded-md border px-3 py-1.5 hover:bg-muted"
        >
          新建空白绘图
        </button>
      </div>
    )
  }

  return (
    <div data-tour="cslab-origin-plot" data-plot-id={pane.plotId} className="relative flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-1.5 border-b px-2 py-1.5">
          <select
            value={plotState.presetId}
            onChange={(event) => changePreset(event.target.value as CsLabJournalPresetId)}
            className="rounded-md border bg-background px-2 py-1 text-[11px]"
          >
            {Object.values(JOURNAL_PRESETS).map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setRoiMode((value) => !value)}
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px]',
              roiMode ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
            )}
          >
            <ScanLine className="h-3 w-3" /> 框选
          </button>
          <button
            type="button"
            onClick={() => void sendSelectionToAgent()}
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-muted"
            title="把当前选区与绘图上下文发送给科学助理"
          >
            <Sparkles className="h-3 w-3" /> 发送至助理
          </button>
          <button
            type="button"
            onClick={() => openFit()}
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-muted"
          >
            <Sigma className="h-3 w-3" /> 拟合
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-muted disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />} 保存
          </button>
          <button
            type="button"
            onClick={() => setExportOpen(true)}
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-muted"
          >
            <Download className="h-3 w-3" /> 导出
          </button>
        </div>

        <div ref={containerRef} className="relative min-h-0 flex-1 bg-cslab-elevated">
          <canvas
            ref={canvasRef}
            className={cn('absolute inset-0', roiMode ? 'cursor-crosshair' : 'cursor-grab')}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onDoubleClick={() => {
              const layer = plotState.layers[0]
              if (!layer) return
              updatePlot({
                ...plotState,
                layers: [
                  {
                    ...layer,
                    xAxis: { ...layer.xAxis, min: undefined, max: undefined },
                    yAxes: [
                      { ...layer.yAxes[0]!, min: undefined, max: undefined },
                      layer.yAxes[1]!,
                    ],
                  },
                  ...plotState.layers.slice(1),
                ],
                updatedAt: Date.now(),
              })
            }}
            onWheel={handleWheel}
          />
        </div>
      </div>

      <aside className="hidden w-[220px] shrink-0 border-l lg:block">
        <div className="flex items-center gap-1 border-b px-2 py-1.5 text-[11px] text-muted-foreground">
          <SlidersHorizontal className="h-3 w-3" /> 图层与坐标轴
        </div>
        <CsLabPlotControls document={plotState} onChange={updatePlot} />
      </aside>

      <CsLabPeakFitDrawer
        open={fitOpen}
        data={fitData}
        onClose={() => setFitOpen(false)}
        onApply={handleFitApply}
        onToast={onToast}
      />

      <CsLabPlotExportDialog
        open={exportOpen}
        labId={labId}
        document={plotState}
        onClose={() => setExportOpen(false)}
        onToast={onToast}
      />
    </div>
  )
}
