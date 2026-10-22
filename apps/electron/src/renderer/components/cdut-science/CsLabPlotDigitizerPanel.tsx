/**
 * CsLabPlotDigitizerPanel — 图表逆向数字化抽屉
 *
 * 流程：三点标定 → 颜色取样 → 自动提取 → 拖动控制点磁性吸附 → 保存为 fig + table。
 * 评审加固：吸附使用 shared 纯几何函数；Python 缺失时展示缺失包并支持一键安装。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Crosshair, Download, Loader2, Pipette, Sparkles } from 'lucide-react'
import {
  mapPixelToValue,
  snapPointToPolyline,
  type CsLabAxisTick,
  type CsLabDigitizedSeries,
  type CsLabPlotCalibration,
  type CsLabPlotDigitizeResult,
  type CsLabPlotMode,
  type CsLabToolProfile,
} from '@profer/shared'
import { cn } from '@/lib/utils'
import {
  cslabToolDepsProgressAtom,
  cslabToolRuntimeAtom,
  type CsLabPdfSelection,
} from '@/atoms/cslab-atoms'

interface CsLabPlotDigitizerPanelProps {
  labId: string
  selection?: CsLabPdfSelection
  onSaved: () => void
}

type PolygonMode = 'x' | 'y' | null

const MAX_TICKS = 3

/** 演示光谱图的预置标定点（坐标已按 640×480 原图边框像素扫描校准） */
const DEMO_DIGITIZER_TICKS = {
  x: [
    { px: 80.5, py: 419.5, value: 0 },
    { px: 599.5, py: 419.5, value: 1000 },
  ] as CsLabAxisTick[],
  y: [
    { px: 80.5, py: 419.5, value: 0 },
    { px: 80.5, py: 40.5, value: 100 },
  ] as CsLabAxisTick[],
}

export function CsLabPlotDigitizerPanel({
  labId,
  selection,
  onSaved,
}: CsLabPlotDigitizerPanelProps): React.ReactElement {
  const runtime = useAtomValue(cslabToolRuntimeAtom)
  const setRuntime = useSetAtom(cslabToolRuntimeAtom)
  const progress = useAtomValue(cslabToolDepsProgressAtom)

  const imageRef = React.useRef<HTMLImageElement | null>(null)
  const svgRef = React.useRef<SVGSVGElement | null>(null)
  const [naturalSize, setNaturalSize] = React.useState<{ width: number; height: number } | null>(null)
  const [mode, setMode] = React.useState<CsLabPlotMode>('line')
  const [tickAxis, setTickAxis] = React.useState<PolygonMode>('x')
  const [xTicks, setXTicks] = React.useState<CsLabAxisTick[]>([])
  const [yTicks, setYTicks] = React.useState<CsLabAxisTick[]>([])
  const [color, setColor] = React.useState('')
  const [tolerance, setTolerance] = React.useState(28)
  const [title, setTitle] = React.useState('')
  const [result, setResult] = React.useState<CsLabPlotDigitizeResult | null>(null)
  const [series, setSeries] = React.useState<CsLabDigitizedSeries[]>([])
  const [busy, setBusy] = React.useState<'digitize' | 'save' | 'install' | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [message, setMessage] = React.useState<string | null>(null)
  const dragRef = React.useRef<{ seriesIndex: number; pointIndex: number } | null>(null)
  const suppressClickRef = React.useRef(false)

  React.useEffect(() => {
    setTitle(`数字化图表 · 第 ${(selection?.pageIndex ?? 0) + 1} 页`)
  }, [selection?.pageIndex])

  React.useEffect(() => {
    let cancelled = false
    void window.electronAPI.cslab
      .getToolRuntime(labId)
      .then((status) => {
        if (!cancelled) setRuntime(status)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [labId, setRuntime])

  const plotReady = runtime?.profiles.plot.installed ?? false

  const toNaturalPoint = (event: React.PointerEvent<SVGSVGElement>): { x: number; y: number } | null => {
    const svg = svgRef.current
    if (!svg || !naturalSize) return null
    const rect = svg.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    return {
      x: ((event.clientX - rect.left) / rect.width) * naturalSize.width,
      y: ((event.clientY - rect.top) / rect.height) * naturalSize.height,
    }
  }

  const addTick = (event: React.MouseEvent<SVGSVGElement>): void => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    if (!tickAxis || !naturalSize) return
    const rect = event.currentTarget.getBoundingClientRect()
    const point = {
      x: ((event.clientX - rect.left) / rect.width) * naturalSize.width,
      y: ((event.clientY - rect.top) / rect.height) * naturalSize.height,
    }
    const tick: CsLabAxisTick = { px: point.x, py: point.y, value: 0 }
    if (tickAxis === 'x' && xTicks.length < MAX_TICKS) setXTicks([...xTicks, tick])
    if (tickAxis === 'y' && yTicks.length < MAX_TICKS) setYTicks([...yTicks, tick])
  }

  const updateTickValue = (axis: 'x' | 'y', index: number, value: number): void => {
    const update = (ticks: CsLabAxisTick[]): CsLabAxisTick[] =>
      ticks.map((tick, current) => (current === index ? { ...tick, value } : tick))
    if (axis === 'x') setXTicks(update(xTicks))
    else setYTicks(update(yTicks))
  }

  const calibration: CsLabPlotCalibration = React.useMemo(
    () => ({
      x: { ticks: xTicks, scale: 'auto' },
      y: { ticks: yTicks, scale: 'auto' },
    }),
    [xTicks, yTicks],
  )

  const digitize = React.useCallback(async (override?: {
    xTicks: CsLabAxisTick[]
    yTicks: CsLabAxisTick[]
    mode?: CsLabPlotMode
    color?: string
    tolerance?: number
  }): Promise<void> => {
    if (!selection) return
    const effectiveX = override?.xTicks ?? xTicks
    const effectiveY = override?.yTicks ?? yTicks
    const effectiveMode = override?.mode ?? mode
    const effectiveColor = override?.color ?? color
    const effectiveTolerance = override?.tolerance ?? tolerance
    if (effectiveX.length < 2 || effectiveY.length < 2) {
      setError('X/Y 轴各至少需要 2 个刻度点')
      return
    }
    setBusy('digitize')
    setError(null)
    setMessage(null)
    try {
      const calibrationInput: CsLabPlotCalibration = {
        x: { ticks: effectiveX, scale: 'auto' },
        y: { ticks: effectiveY, scale: 'auto' },
      }
      const payload = await window.electronAPI.cslab.digitizePlot({
        labId,
        imageDataUrl: selection.cropDataUrl,
        mode: effectiveMode,
        calibration: calibrationInput,
        color: effectiveColor || undefined,
        tolerance: effectiveTolerance,
      })
      setResult(payload)
      setSeries(payload.series)
      if (!payload.ok) {
        setError(payload.message ?? '未能提取曲线')
        if (payload.message?.includes('依赖')) {
          void window.electronAPI.cslab.getToolRuntime(labId).then(setRuntime).catch(() => undefined)
        }
      } else {
        const fit = payload.axisFit
        setMessage(
          `已提取 ${payload.series.length} 条曲线；X ${fit?.x.scale ?? 'linear'} R²=${(fit?.x.r2 ?? 0).toFixed(4)}，Y ${fit?.y.scale ?? 'linear'} R²=${(fit?.y.r2 ?? 0).toFixed(4)}`,
        )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '图表数字化失败')
    } finally {
      setBusy(null)
    }
  }, [selection, xTicks, yTicks, labId, mode, color, tolerance, setRuntime])

  /** 仅演示光谱图（640×480）提供的一键标定：写入预置刻度并立即提取 */
  const isDemoSpectrum = naturalSize?.width === 640 && naturalSize?.height === 480
  const applyDemoCalibration = React.useCallback(async (): Promise<void> => {
    if (!isDemoSpectrum) return
    setXTicks(DEMO_DIGITIZER_TICKS.x)
    setYTicks(DEMO_DIGITIZER_TICKS.y)
    setMode('line')
    setColor('')
    setTolerance(28)
    await digitize({
      xTicks: DEMO_DIGITIZER_TICKS.x,
      yTicks: DEMO_DIGITIZER_TICKS.y,
      mode: 'line',
      color: '',
      tolerance: 28,
    })
  }, [digitize, isDemoSpectrum])

  // 引导气泡通过自定义事件触发同一套一键标定逻辑
  React.useEffect(() => {
    const handler = (): void => {
      void applyDemoCalibration()
    }
    window.addEventListener('cslab:demo-digitize', handler)
    return () => window.removeEventListener('cslab:demo-digitize', handler)
  }, [applyDemoCalibration])

  const startDrag = (
    event: React.PointerEvent<SVGCircleElement>,
    seriesIndex: number,
    pointIndex: number,
  ): void => {
    event.stopPropagation()
    suppressClickRef.current = true
    dragRef.current = { seriesIndex, pointIndex }
    svgRef.current?.setPointerCapture(event.pointerId)
  }

  const moveDrag = (event: React.PointerEvent<SVGSVGElement>): void => {
    const drag = dragRef.current
    if (!drag || !result || !naturalSize) return
    const point = toNaturalPoint(event)
    if (!point) return

    const polylines = series.map((item) => item.pixels)
    const threshold = (8 / Math.max(1, svgRef.current?.getBoundingClientRect().width ?? 1)) * naturalSize.width
    const snapped = snapPointToPolyline(point, polylines, threshold)
    const nextPixel: [number, number] = [snapped.point.x, snapped.point.y]

    const valueX = mapPixelToValue(snapped.point.x, xTicks, result.axisFit?.x.scale ?? 'auto', 'px')
    const valueY = mapPixelToValue(snapped.point.y, yTicks, result.axisFit?.y.scale ?? 'auto', 'py')
    if (valueX == null || valueY == null) return

    setSeries((previous) =>
      previous.map((item, seriesIndex) => {
        if (seriesIndex !== drag.seriesIndex) return item
        const pixels = item.pixels.map((pixel, index) =>
          index === drag.pointIndex ? nextPixel : pixel,
        )
        const points = item.points.map((value, index) =>
          index === drag.pointIndex ? ([valueX, valueY] as [number, number]) : value,
        )
        return { ...item, pixels, points }
      }),
    )
  }

  const endDrag = (): void => {
    dragRef.current = null
  }

  const installDeps = async (profile: CsLabToolProfile): Promise<void> => {
    setBusy('install')
    setError(null)
    try {
      const status = await window.electronAPI.cslab.installToolDeps({ labId, profile })
      setRuntime(status)
      setMessage('依赖安装完成')
    } catch (err) {
      setError(err instanceof Error ? err.message : '依赖安装失败')
    } finally {
      setBusy(null)
    }
  }

  const save = async (): Promise<void> => {
    if (!selection) return
    if (series.length === 0) {
      setError('没有可保存的曲线')
      return
    }
    setBusy('save')
    setError(null)
    try {
      const saved = await window.electronAPI.cslab.saveDigitizedFigure({
        labId,
        title: title.trim() || '数字化图表',
        sourceUri: selection.literatureUri,
        imageDataUrl: selection.cropDataUrl,
        calibration,
        series: series.map((item) => ({ label: item.label, points: item.points })),
      })
      setMessage(saved.message)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setBusy(null)
    }
  }

  if (!selection) {
    return (
      <p className="text-[11px] leading-relaxed text-cslab-muted">
        请先在 PDF 中框选图表区域。
      </p>
    )
  }

  return (
    <div
      data-tour="cslab-digitizer"
      data-series-count={series.length}
      className="space-y-4"
    >
      <div className="relative overflow-hidden rounded-xl border border-cslab-border bg-cslab-elevated">
        <img
          ref={imageRef}
          src={selection.cropDataUrl}
          alt="图表框选"
          className="block h-auto w-full select-none"
          draggable={false}
          onLoad={(event) =>
            setNaturalSize({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
        />
        <svg
          ref={svgRef}
          viewBox={naturalSize ? `0 0 ${naturalSize.width} ${naturalSize.height}` : undefined}
          className={cn(
            'absolute inset-0 h-full w-full',
            tickAxis ? 'cursor-crosshair' : 'cursor-default',
          )}
          onClick={addTick}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={() => {
            endDrag()
            suppressClickRef.current = false
          }}
        >
          {series.map((item, seriesIndex) => (
            <g key={item.label}>
              <polyline
                points={item.pixels.map((pixel) => `${pixel[0]},${pixel[1]}`).join(' ')}
                fill="none"
                stroke="#3399FF"
                strokeOpacity={0.7}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
              {item.pixels.map((pixel, pointIndex) => (
                <circle
                  key={`${seriesIndex}-${pointIndex}`}
                  cx={pixel[0]}
                  cy={pixel[1]}
                  r={Math.max(3, (naturalSize?.width ?? 400) * 0.004)}
                  className="fill-cslab-accent stroke-cslab-bg"
                  fillOpacity={0.75}
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                  style={{ cursor: 'grab' }}
                  onPointerDown={(event) => startDrag(event, seriesIndex, pointIndex)}
                  onClick={(event) => event.stopPropagation()}
                />
              ))}
            </g>
          ))}
          {[...xTicks.map((tick) => ({ ...tick, axis: 'x' as const })), ...yTicks.map((tick) => ({ ...tick, axis: 'y' as const }))].map(
            (tick, index) => (
              <g key={`tick-${tick.axis}-${index}`}>
                <line
                  x1={tick.px - 6}
                  y1={tick.py}
                  x2={tick.px + 6}
                  y2={tick.py}
                  className="stroke-cslab-accent"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
                <line
                  x1={tick.px}
                  y1={tick.py - 6}
                  x2={tick.px}
                  y2={tick.py + 6}
                  className="stroke-cslab-accent"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            ),
          )}
        </svg>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {(['x', 'y', null] as const).map((axis) => (
          <button
            key={axis ?? 'off'}
            type="button"
            data-tour={
              axis === 'x'
                ? 'cslab-digitizer-calibrate-x'
                : axis === 'y'
                  ? 'cslab-digitizer-calibrate-y'
                  : 'cslab-digitizer-calibrate-off'
            }
            onClick={() => setTickAxis(axis)}
            className={cn(
              'rounded-lg border px-2 py-1 text-[10px] transition-colors',
              tickAxis === axis
                ? 'border-cslab-accent/50 bg-cslab-accent/10 text-cslab-accent'
                : 'border-cslab-border text-cslab-muted hover:bg-cslab-surface hover:text-cslab-text',
            )}
          >
            {axis === 'x' ? '标定 X 轴' : axis === 'y' ? '标定 Y 轴' : '结束标定'}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-cslab-muted">
          X {xTicks.length}/3 · Y {yTicks.length}/3
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {(
          [
            ['x', xTicks],
            ['y', yTicks],
          ] as const
        ).map(([axis, ticks]) => (
          <div key={axis} className="space-y-1">
            <p className="text-[9px] uppercase tracking-[0.14em] text-cslab-muted">
              {axis.toUpperCase()} 轴刻度值
            </p>
            {ticks.length === 0 && <p className="text-[10px] text-cslab-muted/70">点击图像添加</p>}
            {ticks.map((tick, index) => (
              <input
                key={`${axis}-${index}`}
                type="number"
                value={Number.isFinite(tick.value) ? tick.value : 0}
                onChange={(event) =>
                  updateTickValue(axis, index, Number(event.target.value) || 0)
                }
                className="w-full rounded-md border border-cslab-border bg-cslab-elevated px-2 py-1 text-[11px] text-cslab-text outline-none focus:border-cslab-accent/50"
                aria-label={`${axis} 轴第 ${index + 1} 个刻度值`}
              />
            ))}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <div className="flex overflow-hidden rounded-lg border border-cslab-border">
          {(['line', 'scatter'] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setMode(item)}
              className={cn(
                'px-2.5 py-1 text-[10px] transition-colors',
                mode === item
                  ? 'bg-cslab-surface text-cslab-text'
                  : 'text-cslab-muted hover:text-cslab-text',
              )}
            >
              {item === 'line' ? '曲线' : '散点'}
            </button>
          ))}
        </div>
        <label className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-cslab-border bg-cslab-elevated px-2 py-1">
          <Pipette size={11} className="shrink-0 text-cslab-muted" />
          <input
            value={color}
            onChange={(event) => setColor(event.target.value)}
            placeholder="#3399ff（留空自动）"
            className="w-full bg-transparent text-[10px] text-cslab-text outline-none placeholder:text-cslab-muted/60"
          />
        </label>
        <input
          type="number"
          min={8}
          max={60}
          value={tolerance}
          onChange={(event) => setTolerance(Math.max(8, Math.min(60, Number(event.target.value) || 28)))}
          className="w-14 rounded-lg border border-cslab-border bg-cslab-elevated px-2 py-1 text-[10px] text-cslab-text outline-none"
          aria-label="颜色容差"
        />
      </div>

      {!plotReady && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[10px] leading-relaxed text-amber-700">
          缺少 plot 依赖：
          {runtime?.profiles.plot.missing.join(', ') || 'numpy / opencv / scikit-image / scipy'}
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void installDeps('plot')}
            className="mt-2 flex items-center gap-1 rounded-md bg-amber-600 px-2 py-1 text-[10px] text-white disabled:opacity-50"
          >
            {busy === 'install' ? <Loader2 size={10} className="animate-spin" /> : <Download size={10} />}
            一键安装到实验室 .venv
          </button>
          {progress && (
            <p className="mt-1 text-[9px] text-amber-700/80">
              {progress.stage} · {progress.message}
            </p>
          )}
        </div>
      )}

      {isDemoSpectrum && (
        <button
          type="button"
          data-tour="cslab-digitizer-demo"
          disabled={busy !== null}
          onClick={() => void applyDemoCalibration()}
          className="flex w-full items-center justify-center gap-1 rounded-lg border border-cslab-accent/40 bg-cslab-accent/10 px-3 py-2 text-[11px] font-medium text-cslab-accent transition-colors hover:bg-cslab-accent/15 disabled:opacity-50"
        >
          {busy === 'digitize' ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
          注入演示标定点并提取
        </button>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          data-tour="cslab-digitizer-extract"
          disabled={busy !== null}
          onClick={() => void digitize()}
          className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-cslab-accent px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-cslab-accentHover disabled:opacity-50"
        >
          {busy === 'digitize' ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
          自动提取
        </button>
        <button
          type="button"
          data-tour="cslab-digitizer-save"
          disabled={busy !== null || series.length === 0}
          onClick={() => void save()}
          className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg border border-cslab-border px-3 py-2 text-xs text-cslab-text transition-colors hover:bg-cslab-surface disabled:opacity-50"
        >
          {busy === 'save' ? <Loader2 size={12} className="animate-spin" /> : <Crosshair size={12} />}
          保存为图表与数据表
        </button>
      </div>

      <input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="图表标题"
        className="w-full rounded-lg border border-cslab-border bg-cslab-elevated px-2.5 py-1.5 text-[11px] text-cslab-text outline-none focus:border-cslab-accent/50"
      />

      {message && (
        <p className="rounded-lg border border-cslab-border bg-cslab-surface px-3 py-2 text-[10px] leading-relaxed text-cslab-text">
          {message}
        </p>
      )}
      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[10px] leading-relaxed text-red-600">
          {error}
        </p>
      )}

      <p className="text-[10px] leading-relaxed text-cslab-muted">
        拖动赤陶控制点可微调；靠近提取曲线 8px 内会自动吸附到线条中心。
      </p>
    </div>
  )
}
