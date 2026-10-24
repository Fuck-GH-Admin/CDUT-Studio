/**
 * CsLabLiteratureBrainPanel — 跨文献分层 GraphRAG 检索 + 全景知识图谱
 *
 * 未搜索时渲染基于已建索引的全景图谱（Leiden 社区着色，文献级共现网络）；
 * 检索命中点击后跳转 PDF 页码并按 bbox 高亮聚焦选框。
 * 头部支持 2D Leiden Map / 3D Spatial Topology 分段切换（3D 为分层空间拓扑视口）。
 */

import * as React from 'react'
import { Box, Loader2, Network, Search, X } from 'lucide-react'
import type {
  CsLabLiteratureGraphResult,
  CsLabLiteratureSearchResult,
  Hierarchical3DGraphData,
} from '@profer/shared'
import { cn } from '@/lib/utils'
import { CsLab3DTopologyViewport } from './CsLab3DTopologyViewport'

interface CsLabLiteratureBrainPanelProps {
  labId: string
  onOpenLiterature: (uri: string, page: number, bbox?: [number, number, number, number]) => void
}

const TEXT_LAYER_HINT = '文献缺少文本层（扫描版 PDF），请导入带 OCR/文本层的 PDF 后再建索引。'

/** 图谱视图模式：2D Leiden 社群图 / 3D 分层空间拓扑。 */
type TopologyViewMode = '2d' | '3d'

/** 3D 拓扑 IPC 由并行任务接线；方法缺失时降级提示而非崩溃。 */
interface Literature3DGraphApi {
  getLiterature3DGraph?: (labId: string, uri?: string) => Promise<Hierarchical3DGraphData | null>
}

/** 渲染规模软保护：防止数千级 SVG DOM 卡顿渲染主线程。 */
const MAX_GRAPH_NODES = 250
const MAX_GRAPH_EDGES = 400

/** 判断后端消息是否属于「扫描版 PDF 无文本层」而非真实异常。 */
function isTextLayerMessage(message?: string): boolean {
  return !!message && (message.includes('扫描版') || message.includes('未能从文献中提取文本'))
}

/** 社群 ID → 稳定色相（确定性哈希，跨渲染一致）。 */
function communityHue(communityId: string): number {
  let hash = 0
  for (let index = 0; index < communityId.length; index += 1) {
    hash = (hash * 31 + communityId.charCodeAt(index)) % 360
  }
  return hash
}

interface GraphLayoutNode {
  uri: string
  title: string
  communityId: string
  communityTitle: string
  chunkCount: number
  x: number
  y: number
  degree: number
}

/**
 * 轻量环形簇布局：按社群排序后均匀铺在圆环上，同社群节点自然相邻；
 * 不做力导向迭代，几十~几百节点零卡顿。
 */
function layoutGraph(
  graph: CsLabLiteratureGraphResult,
): { nodes: GraphLayoutNode[]; edges: Array<{ source: GraphLayoutNode; target: GraphLayoutNode; weight: number }>; truncated: boolean } {
  const degree = new Map<string, number>()
  for (const edge of graph.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
  }

  // 软保护：按连接度截断核心节点。
  const sortedNodes = [...graph.nodes].sort(
    (a, b) => (degree.get(b.uri) ?? 0) - (degree.get(a.uri) ?? 0),
  )
  const truncated = sortedNodes.length > MAX_GRAPH_NODES
  const kept = sortedNodes.slice(0, MAX_GRAPH_NODES)
  const keptUris = new Set(kept.map((node) => node.uri))

  // 同社群相邻排列：社群排序保证环形布局上的视觉聚类。
  const ordered = [...kept].sort((a, b) =>
    (a.communityId || a.uri).localeCompare(b.communityId || b.uri),
  )
  const radius = 46
  const nodes: GraphLayoutNode[] = ordered.map((node, index) => {
    const angle = (index / Math.max(1, ordered.length)) * Math.PI * 2 - Math.PI / 2
    return {
      uri: node.uri,
      title: node.title,
      communityId: node.communityId,
      communityTitle: node.communityTitle,
      chunkCount: node.chunkCount,
      degree: degree.get(node.uri) ?? 0,
      x: 50 + radius * Math.cos(angle),
      y: 50 + radius * Math.sin(angle),
    }
  })
  const byUri = new Map(nodes.map((node) => [node.uri, node]))

  const edges: Array<{ source: GraphLayoutNode; target: GraphLayoutNode; weight: number }> = []
  for (const edge of graph.edges) {
    if (edges.length >= MAX_GRAPH_EDGES) break
    const source = byUri.get(edge.source)
    const target = byUri.get(edge.target)
    if (!source || !target) continue
    edges.push({ source, target, weight: edge.weight })
  }
  return { nodes, edges, truncated }
}

export function CsLabLiteratureBrainPanel({
  labId,
  onOpenLiterature,
}: CsLabLiteratureBrainPanelProps): React.ReactElement {
  const [query, setQuery] = React.useState('')
  const [result, setResult] = React.useState<CsLabLiteratureSearchResult | null>(null)
  const [indexInfo, setIndexInfo] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<'build' | 'search' | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [hint, setHint] = React.useState<string | null>(null)
  const [graph, setGraph] = React.useState<CsLabLiteratureGraphResult | null>(null)
  const [graphLoading, setGraphLoading] = React.useState(false)
  const [viewMode, setViewMode] = React.useState<TopologyViewMode>('2d')
  const [graph3d, setGraph3d] = React.useState<Hierarchical3DGraphData | null>(null)
  const [graph3dLoading, setGraph3dLoading] = React.useState(false)
  const [graph3dLoaded, setGraph3dLoaded] = React.useState(false)
  const [graph3dError, setGraph3dError] = React.useState<string | null>(null)

  const loadGraph = React.useCallback(async (): Promise<void> => {
    setGraphLoading(true)
    try {
      const payload = await window.electronAPI.cslab.getLiteratureGraph(labId)
      setGraph(payload)
    } catch {
      setGraph(null)
    } finally {
      setGraphLoading(false)
    }
  }, [labId])

  // 未在搜索时加载全景图谱（挂载 + 搜索清除回退）。
  React.useEffect(() => {
    if (result === null && graph === null && !graphLoading) void loadGraph()
  }, [result, graph, graphLoading, loadGraph])

  /** 加载 3D 分层空间拓扑（IPC 防御：方法缺失时降级提示而非崩溃）。 */
  const loadGraph3d = React.useCallback(async (): Promise<void> => {
    const api = window.electronAPI.cslab as unknown as Literature3DGraphApi
    if (typeof api.getLiterature3DGraph !== 'function') {
      setGraph3dError('3D 拓扑接口尚未就绪（IPC getLiterature3DGraph 未接线）')
      return
    }
    setGraph3dLoading(true)
    setGraph3dError(null)
    try {
      const payload = await api.getLiterature3DGraph(labId)
      setGraph3d(payload)
    } catch (err) {
      setGraph3d(null)
      setGraph3dError(err instanceof Error ? err.message : '3D 拓扑加载失败')
    } finally {
      setGraph3dLoading(false)
      setGraph3dLoaded(true)
    }
  }, [labId])

  // 3D 模式下按需加载分层拓扑（首次切换 + 索引重建后回填）。
  React.useEffect(() => {
    if (viewMode !== '3d' || graph3dLoaded || graph3dLoading || graph3dError) return
    void loadGraph3d()
  }, [viewMode, graph3dLoaded, graph3dLoading, graph3dError, loadGraph3d])

  const build = async (force: boolean): Promise<void> => {
    setBusy('build')
    setError(null)
    setHint(null)
    try {
      const payload = await window.electronAPI.cslab.buildLiteratureIndex({ labId, force })
      setIndexInfo(payload.message ?? null)
      if (!payload.ok) {
        if (isTextLayerMessage(payload.message)) setHint(TEXT_LAYER_HINT)
        else setError(payload.message ?? '索引构建失败')
      }
      // 索引重建后刷新全景图谱数据（2D / 3D 一并回填）。
      setGraph(null)
      setGraph3d(null)
      setGraph3dLoaded(false)
      setGraph3dError(null)
      if (result === null) void loadGraph()
    } catch (err) {
      setError(err instanceof Error ? err.message : '索引构建失败')
    } finally {
      setBusy(null)
    }
  }

  const search = async (): Promise<void> => {
    if (!query.trim()) return
    setBusy('search')
    setError(null)
    setHint(null)
    try {
      const payload = await window.electronAPI.cslab.searchLiterature({
        labId,
        query: query.trim(),
        topK: 8,
      })
      setResult(payload)
      if (!payload.ok) {
        if (isTextLayerMessage(payload.message)) setHint(TEXT_LAYER_HINT)
        else setError(payload.message ?? '检索失败')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '检索失败')
    } finally {
      setBusy(null)
    }
  }

  /** 清空搜索：一键回退全景图谱视图。 */
  const clearSearch = (): void => {
    setQuery('')
    setResult(null)
    setError(null)
    setHint(null)
  }

  const layout = React.useMemo(
    () => (graph?.ok && graph.nodes.length > 0 ? layoutGraph(graph) : null),
    [graph],
  )

  const showGraph = result === null

  return (
    <div className="space-y-4">
      {/* 图谱视图分段切换：2D Leiden 社群图 / 3D 分层空间拓扑 */}
      <div className="inline-flex items-center gap-0.5 self-start rounded-lg border border-cslab-border bg-cslab-elevated p-0.5">
        <button
          type="button"
          title="Leiden 社群环形布局（2D）"
          onClick={() => setViewMode('2d')}
          className={cn(
            'rounded-md px-2 py-1 text-[10px] transition-colors',
            viewMode === '2d'
              ? 'bg-cslab-accent/10 text-cslab-accent'
              : 'text-cslab-muted hover:bg-cslab-surface hover:text-cslab-text',
          )}
        >
          2D Leiden Map
        </button>
        <button
          type="button"
          title="分层 3D 空间拓扑（宏观/中观/微观）"
          onClick={() => setViewMode('3d')}
          className={cn(
            'rounded-md px-2 py-1 text-[10px] transition-colors',
            viewMode === '3d'
              ? 'bg-cslab-accent/10 text-cslab-accent'
              : 'text-cslab-muted hover:bg-cslab-surface hover:text-cslab-text',
          )}
        >
          3D Spatial Topology
        </button>
      </div>

      <div className="flex items-center gap-2 rounded-xl border border-cslab-border bg-cslab-elevated px-2.5 py-1.5">
        <Search size={12} className="shrink-0 text-cslab-muted" />
        <input
          value={query}
          onChange={(event) => {
            const next = event.target.value
            setQuery(next)
            // 退格清空输入框时自动回退全景图谱。
            if (!next.trim() && result !== null) setResult(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void search()
            if (event.key === 'Escape') clearSearch()
          }}
          placeholder="跨文献检索，例如：界面阻抗"
          className="w-full bg-transparent text-[11px] text-cslab-text outline-none placeholder:text-cslab-muted/60"
        />
        {query && (
          <button
            type="button"
            aria-label="清空检索"
            title="清空并返回全景图谱"
            onClick={clearSearch}
            className="shrink-0 rounded-md p-0.5 text-cslab-muted transition-colors hover:bg-cslab-surface hover:text-cslab-text"
          >
            <X size={11} />
          </button>
        )}
        <button
          type="button"
          disabled={busy !== null || !query.trim()}
          onClick={() => void search()}
          className="shrink-0 rounded-md bg-cslab-accent px-2 py-1 text-[10px] text-white transition-colors hover:bg-cslab-accentHover disabled:opacity-50"
        >
          {busy === 'search' ? <Loader2 size={10} className="animate-spin" /> : '检索'}
        </button>
      </div>

      {viewMode === '2d' && showGraph && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-cslab-muted">
              <Network size={10} /> 全景知识图谱
            </p>
            {graph?.ok && (
              <span className="text-[9px] text-cslab-muted/80">
                {graph.nodes.length} 篇文献 · {graph.communityCount} 个社群
              </span>
            )}
          </div>
          {graphLoading && (
            <p className="flex items-center gap-1.5 text-[10px] text-cslab-muted">
              <Loader2 size={10} className="animate-spin" /> 图谱加载中…
            </p>
          )}
          {!graphLoading && layout && (
            <div className="overflow-hidden rounded-xl border border-cslab-border bg-cslab-bg">
              <svg viewBox="0 0 100 100" className="h-56 w-full" role="img" aria-label="文献全景关联图谱">
                {layout.edges.map((edge, index) => (
                  <line
                    key={`e-${index}`}
                    x1={edge.source.x}
                    y1={edge.source.y}
                    x2={edge.target.x}
                    y2={edge.target.y}
                    stroke="currentColor"
                    className="text-cslab-muted"
                    strokeOpacity={Math.min(0.45, 0.08 + edge.weight * 0.06)}
                    strokeWidth={Math.min(0.7, 0.15 + edge.weight * 0.05)}
                  />
                ))}
                {layout.nodes.map((node) => (
                  <g
                    key={node.uri}
                    transform={`translate(${node.x} ${node.y})`}
                    className="cursor-pointer"
                    onClick={() => onOpenLiterature(node.uri, 1)}
                  >
                    <title>{`${node.title} · ${node.communityTitle || '未聚类'} · ${node.chunkCount} 块`}</title>
                    <circle
                      r={Math.min(2.6, 0.9 + node.chunkCount * 0.06)}
                      fill={`hsl(${communityHue(node.communityId || '_')} 62% 58%)`}
                      fillOpacity={0.85}
                      stroke="transparent"
                      className="transition-[r] hover:r-3"
                    >
                      {/* 悬停放大由外层 g 的 CSS :hover 控制，circle 本身保持几何稳定 */}
                    </circle>
                  </g>
                ))}
              </svg>
              <p className="border-t border-cslab-border px-2.5 py-1.5 text-[9px] leading-relaxed text-cslab-muted">
                {layout.truncated
                  ? '已展示核心全景关联（按连接度截断前 250 篇文献）。'
                  : '节点按 Leiden 社群着色，连线为跨文献共现强度；点击节点打开文献。'}
              </p>
            </div>
          )}
          {!graphLoading && graph && !graph.ok && (
            <p className="text-[10px] leading-relaxed text-cslab-muted">{graph.message}</p>
          )}
        </div>
      )}

      {viewMode === '3d' && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-cslab-muted">
              <Box size={10} /> 分层 3D 空间拓扑
            </p>
            {graph3d && (
              <span className="text-[9px] text-cslab-muted/80">
                {graph3d.nodes.length} 节点 · {graph3d.edges.length} 关联
              </span>
            )}
          </div>
          {!graph3dError && (graph3dLoading || !graph3dLoaded) && (
            <p className="flex items-center gap-1.5 text-[10px] text-cslab-muted">
              <Loader2 size={10} className="animate-spin" /> 3D 拓扑加载中…
            </p>
          )}
          {graph3dError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[10px] leading-relaxed text-red-600">
              <p>{graph3dError}</p>
              <button
                type="button"
                onClick={() => {
                  setGraph3dError(null)
                  setGraph3dLoaded(false)
                }}
                className="mt-1.5 rounded-md border border-dashed border-red-300 px-2 py-1 text-[10px] text-red-600 transition-colors hover:bg-red-100"
              >
                重试
              </button>
            </div>
          )}
          {!graph3dError && graph3dLoaded && graph3d && (
            <CsLab3DTopologyViewport data={graph3d} height={224} />
          )}
          {!graph3dError && graph3dLoaded && graph3d === null && (
            <p className="text-[10px] leading-relaxed text-cslab-muted">暂无拓扑数据。</p>
          )}
        </div>
      )}

      {busy === 'search' && (
        <p className="text-[10px] leading-relaxed text-cslab-muted">
          检索中（首次需构建索引，请稍候）
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void build(false)}
          className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg border border-cslab-border px-2 py-1.5 text-[10px] text-cslab-text transition-colors hover:bg-cslab-surface disabled:opacity-50"
        >
          {busy === 'build' ? <Loader2 size={10} className="animate-spin" /> : <Network size={10} />}
          建立索引
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void build(true)}
          className="rounded-lg border border-dashed border-cslab-border px-2 py-1.5 text-[10px] text-cslab-muted transition-colors hover:bg-cslab-surface hover:text-cslab-text disabled:opacity-50"
        >
          重建
        </button>
      </div>

      {indexInfo && (
        <p className="rounded-lg border border-cslab-border bg-cslab-surface px-3 py-2 text-[10px] leading-relaxed text-cslab-text">
          {indexInfo}
        </p>
      )}

      {result?.ok && result.hits.length === 0 && (
        <p className="text-[11px] text-cslab-muted">没有匹配的文献切块。</p>
      )}

      {result?.hits.map((hit) => (
        <button
          key={hit.chunkId}
          type="button"
          onClick={() => onOpenLiterature(hit.literatureUri, hit.page, hit.bbox)}
          className="block w-full rounded-xl border border-cslab-border bg-cslab-bg p-3 text-left transition-colors hover:bg-cslab-surface"
        >
          <div className="flex items-baseline justify-between gap-2">
            <p className="min-w-0 flex-1 truncate font-serif text-[12px] text-cslab-text">
              {hit.title}
            </p>
            <span className="shrink-0 text-[9px] tabular-nums text-cslab-muted">p{hit.page}</span>
          </div>
          <p className="mt-1 line-clamp-4 text-[10px] leading-relaxed text-cslab-muted">
            {hit.excerpt}
          </p>
          <div className="mt-1.5 flex items-center gap-2 text-[9px] text-cslab-muted/80">
            <span className="rounded-full bg-cslab-surface px-1.5 py-0.5">{hit.communityTitle}</span>
            <span className="tabular-nums">score {hit.score.toFixed(2)}</span>
            {hit.bbox && <span className="text-cslab-accent/80">点击定位原文</span>}
          </div>
        </button>
      ))}

      {hint && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[10px] leading-relaxed text-amber-600 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
          {hint}
        </p>
      )}

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[10px] leading-relaxed text-red-600">
          {error}
        </p>
      )}

      <p className="text-[10px] leading-relaxed text-cslab-muted">
        索引基于 PDF 真实字符流切块，再用 Leiden 分层社区聚类；扫描版 PDF 若无文本层会如实返回空结果。
      </p>
    </div>
  )
}
