/**
 * CsLabSpectrumStrip — 1D 谱图（XRD / 拉曼 / 红外）
 *
 * 只负责画线与命中：不做任何峰识别或拟合；
 * 点击返回的是真实 X 轴数值，由上层决定如何解释（晶面匹配或谱带高亮）。
 */

import * as React from 'react'
import type { CsLabTableSeries } from '@profer/shared'
import { cn } from '@/lib/utils'
import type { CsLabVibrationalBand } from './cslab-vibrational'

interface CsLabSpectrumStripProps {
  series: CsLabTableSeries | null
  highlights?: CsLabVibrationalBand[]
  selectedX?: number
  loading?: boolean
  onPick?: (x: number) => void
}

const VIEW_WIDTH = 1000
const VIEW_HEIGHT = 150
const PADDING = { left: 44, right: 14, top: 12, bottom: 22 }

function formatTick(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 10000) return value.toExponential(1)
  if (abs >= 100) return value.toFixed(0)
  if (abs >= 10) return value.toFixed(1)
  return value.toFixed(2)
}

export function CsLabSpectrumStrip({
  series,
  highlights = [],
  selectedX,
  loading = false,
  onPick,
}: CsLabSpectrumStripProps): React.ReactElement {
  const containerRef = React.useRef<HTMLDivElement | null>(null)

  const model = React.useMemo(() => {
    if (!series || series.x.length < 2) return null
    const yKey = series.columns.find((column) => column.key !== 'x')?.key
    if (!yKey) return null
    const y = series.series[yKey] ?? []
    if (y.length !== series.x.length) return null

    let minX = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (let index = 0; index < series.x.length; index += 1) {
      const x = series.x[index] ?? Number.NaN
      const value = y[index] ?? Number.NaN
      if (!Number.isFinite(x) || !Number.isFinite(value)) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (value < minY) minY = value
      if (value > maxY) maxY = value
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX) || maxX <= minX) return null
    if (!Number.isFinite(minY) || !Number.isFinite(maxY)) return null
    if (maxY === minY) maxY = minY + 1

    const plotWidth = VIEW_WIDTH - PADDING.left - PADDING.right
    const plotHeight = VIEW_HEIGHT - PADDING.top - PADDING.bottom
    const toX = (x: number): number =>
      PADDING.left + ((x - minX) / (maxX - minX)) * plotWidth
    const toY = (value: number): number =>
      PADDING.top + plotHeight - ((value - minY) / (maxY - minY)) * plotHeight

    let path = ''
    let penDown = false
    for (let index = 0; index < series.x.length; index += 1) {
      const x = series.x[index] ?? Number.NaN
      const value = y[index] ?? Number.NaN
      if (!Number.isFinite(x) || !Number.isFinite(value)) {
        penDown = false
        continue
      }
      path += `${penDown ? 'L' : 'M'} ${toX(x).toFixed(2)} ${toY(value).toFixed(2)} `
      penDown = true
    }

    const xColumn = series.columns.find((column) => column.key === 'x')
    return {
      yKey,
      minX,
      maxX,
      minY,
      maxY,
      toX,
      toY,
      path,
      xLabel: `${xColumn?.label ?? 'X'}${xColumn?.unit ? ` / ${xColumn.unit}` : ''}`,
      yLabel: series.columns.find((column) => column.key === yKey)?.label ?? 'Y',
    }
  }, [series])

  const handleClick = (event: React.MouseEvent<SVGSVGElement>): void => {
    if (!model || !onPick || !containerRef.current) return
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientX - rect.left) / Math.max(1, rect.width)
    const viewX = ratio * VIEW_WIDTH
    const plotWidth = VIEW_WIDTH - PADDING.left - PADDING.right
    const clamped = Math.min(1, Math.max(0, (viewX - PADDING.left) / plotWidth))
    onPick(model.minX + clamped * (model.maxX - model.minX))
  }

  return (
    <div
      ref={containerRef}
      className="rounded-lg border border-cslab-border bg-cslab-bg px-2 py-1.5"
    >
      <div className="mb-1 flex items-center justify-between text-[9px] text-cslab-muted">
        <span>
          {model ? `${model.yLabel} · ${model.xLabel}` : '尚未关联谱图'}
          {series?.downsampled && model && (
            <span className="ml-1 text-cslab-muted/70">
              （{series.totalRows.toLocaleString()} 点已降采样）
            </span>
          )}
        </span>
        {loading && <span className="text-cslab-accent">载入谱图…</span>}
      </div>

      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        preserveAspectRatio="none"
        onClick={handleClick}
        className={cn('h-[150px] w-full', onPick && model ? 'cursor-crosshair' : 'cursor-default')}
        role="img"
        aria-label="一维谱图"
      >
        <rect
          x={PADDING.left}
          y={PADDING.top}
          width={VIEW_WIDTH - PADDING.left - PADDING.right}
          height={VIEW_HEIGHT - PADDING.top - PADDING.bottom}
          fill="#FAF9F5"
          stroke="#E8E5DF"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />

        {model &&
          highlights.map((band) => {
            const from = Math.max(model.minX, Math.min(band.from, band.to))
            const to = Math.min(model.maxX, Math.max(band.from, band.to))
            if (to <= model.minX || from >= model.maxX) return null
            const x1 = model.toX(Math.max(from, model.minX))
            const x2 = model.toX(Math.min(to, model.maxX))
            return (
              <rect
                key={`${band.label}-${band.from}-${band.to}`}
                x={x1}
                y={PADDING.top}
                width={Math.max(1, x2 - x1)}
                height={VIEW_HEIGHT - PADDING.top - PADDING.bottom}
                fill="#D97757"
                opacity={0.16}
              />
            )
          })}

        {model && (
          <path
            d={model.path}
            fill="none"
            stroke="#242220"
            strokeWidth={1.1}
            vectorEffect="non-scaling-stroke"
          />
        )}

        {model && Number.isFinite(selectedX) && (
          <>
            <line
              x1={model.toX(selectedX!)}
              x2={model.toX(selectedX!)}
              y1={PADDING.top}
              y2={VIEW_HEIGHT - PADDING.bottom}
              stroke="#D97757"
              strokeWidth={1}
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={model.toX(selectedX!)}
              cy={PADDING.top + 4}
              r={2.5}
              fill="#D97757"
            />
          </>
        )}

        {model && (
          <>
            <text
              x={PADDING.left}
              y={VIEW_HEIGHT - 6}
              fontSize={9}
              fill="#7A7672"
              textAnchor="start"
            >
              {formatTick(model.minX)}
            </text>
            <text
              x={VIEW_WIDTH - PADDING.right}
              y={VIEW_HEIGHT - 6}
              fontSize={9}
              fill="#7A7672"
              textAnchor="end"
            >
              {formatTick(model.maxX)}
            </text>
            <text x={4} y={PADDING.top + 8} fontSize={9} fill="#7A7672">
              {formatTick(model.maxY)}
            </text>
            <text
              x={4}
              y={VIEW_HEIGHT - PADDING.bottom}
              fontSize={9}
              fill="#7A7672"
            >
              {formatTick(model.minY)}
            </text>
          </>
        )}

        {!model && !loading && (
          <text
            x={VIEW_WIDTH / 2}
            y={VIEW_HEIGHT / 2}
            fontSize={11}
            fill="#7A7672"
            textAnchor="middle"
          >
            选择一张数据表以显示谱图
          </text>
        )}
      </svg>

      {highlights.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[9px] text-cslab-muted">
          {highlights.map((band) => (
            <span key={`${band.label}-${band.from}`} className="inline-flex items-center gap-1">
              <span className="inline-block h-1.5 w-3 rounded-sm bg-cslab-accent/30" />
              {band.label} {band.from}–{band.to} cm⁻¹
            </span>
          ))}
          <span className="text-cslab-muted/70">（内置参考区间，非本样品实测）</span>
        </div>
      )}
    </div>
  )
}
