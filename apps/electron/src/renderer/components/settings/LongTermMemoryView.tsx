/**
 * 长期记忆星图（Long-Term Memory Constellation）
 *
 * 全屏沉浸式工作台：
 *   - 中区纯 SVG 星图：类别锚点 + hash 极坐标散布，节点按共享标签连线；
 *   - 左区：搜索 / 类别筛选 / 检索测试；
 *   - 右区：节点详情与手动编辑。
 *
 * 视觉红线：整个面板强制深色 Token 隔离（`dark` + 局部覆盖 CSS 变量），
 * 避免浅色主题下 `text-foreground` 在深空底色上变成黑底黑字。
 *
 * 挂载位置：由 SettingsDialog 渲染在 Dialog 内容层（与 SettingsPanel 同级），
 * 使用 `absolute inset-0` 铺满设置面板；不能 portal 到 body——Radix Dialog 的
 * 模态焦点陷阱与 pointer-events 会阻断交互，且点击外部会误关闭设置面板。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Plus, RefreshCw, Save, Search, Sparkles, Trash2, X } from 'lucide-react'
import { Z_LAYER } from '@profer/ui'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@profer/ui/primitives/alert-dialog'
import { Button } from '@profer/ui/primitives/button'
import {
  LONGTERM_MEMORY_CATEGORIES,
  LONGTERM_MEMORY_CATEGORY_META,
  type LongTermMemoryCategory,
  type LongTermMemoryNode,
} from '@profer/shared'
import { useGlobalOverlay } from '@/atoms/overlay-atoms'
import {
  deleteLongTermMemoryNodeAtom,
  draftFromNode,
  longTermMemoryDraftAtom,
  longTermMemoryFilterAtom,
  longTermMemoryGraphAtom,
  longTermMemoryHitsAtom,
  longTermMemoryLoadingAtom,
  longTermMemoryQueryAtom,
  longTermMemoryQueryingAtom,
  longTermMemorySelectedIdAtom,
  longTermMemoryViewOpenAtom,
  refreshLongTermMemoryAtom,
  runLongTermMemoryQueryTestAtom,
  saveLongTermMemoryDraftAtom,
  type LongTermMemoryDraft,
} from '@/atoms/longterm-memory-atoms'

// ===== 视觉常量 =====

/** 深空主题变量（局部作用域，不污染全局主题） */
const DREAMY_THEME: React.CSSProperties & Record<`--${string}`, string> = {
  '--background': '230 32% 7%',
  '--foreground': '210 40% 96%',
  '--card': '230 28% 12%',
  '--card-foreground': '210 40% 96%',
  '--popover': '230 28% 12%',
  '--popover-foreground': '210 40% 96%',
  '--primary': '265 85% 72%',
  '--primary-foreground': '230 32% 8%',
  '--secondary': '230 20% 20%',
  '--secondary-foreground': '210 40% 96%',
  '--muted': '230 20% 18%',
  '--muted-foreground': '215 20% 65%',
  '--accent': '230 24% 22%',
  '--accent-foreground': '210 40% 96%',
  '--border': '230 20% 24%',
  '--input': '230 20% 24%',
  '--ring': '265 85% 72%',
}

interface AccentColors {
  node: string
  glow: string
  chip: string
}

const ACCENT_COLORS: Record<LongTermMemoryCategory, AccentColors> = {
  coding_preference: { node: '#34d399', glow: 'rgba(52, 211, 153, 0.55)', chip: 'bg-emerald-400/15 text-emerald-200 border-emerald-400/30' },
  workflow_habit: { node: '#a78bfa', glow: 'rgba(167, 139, 250, 0.55)', chip: 'bg-violet-400/15 text-violet-200 border-violet-400/30' },
  cdut_special_domain: { node: '#38bdf8', glow: 'rgba(56, 189, 248, 0.55)', chip: 'bg-sky-400/15 text-sky-200 border-sky-400/30' },
  tool_affinity: { node: '#fbbf24', glow: 'rgba(251, 191, 36, 0.55)', chip: 'bg-amber-400/15 text-amber-200 border-amber-400/30' },
  interaction_style: { node: '#fb7185', glow: 'rgba(251, 113, 133, 0.55)', chip: 'bg-rose-400/15 text-rose-200 border-rose-400/30' },
}

const FIELD_CLASS =
  'w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-slate-100 outline-none transition focus:border-violet-400/50 focus:bg-white/[0.07] placeholder:text-slate-500'

// ===== 星图几何 =====

interface Point {
  node: LongTermMemoryNode
  x: number
  y: number
}

interface Edge {
  from: string
  to: string
  shared: number
}

function hashString(value: string): number {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** 确定性布局：类别锚点 + hash 极坐标抖动，保证每次渲染位置稳定 */
function layoutNodes(nodes: LongTermMemoryNode[], width: number, height: number): Point[] {
  if (nodes.length === 0 || width <= 0 || height <= 0) return []
  const cx = width / 2
  const cy = height / 2
  const anchorRadius = Math.min(width, height) * 0.32
  const minRadius = Math.min(width, height) * 0.06
  const spread = Math.min(width, height) * 0.16

  const anchors = new Map<LongTermMemoryCategory, { x: number; y: number }>()
  LONGTERM_MEMORY_CATEGORIES.forEach((category, index) => {
    const angle = (Math.PI * 2 * index) / LONGTERM_MEMORY_CATEGORIES.length - Math.PI / 2
    anchors.set(category, {
      x: cx + Math.cos(angle) * anchorRadius,
      y: cy + Math.sin(angle) * anchorRadius,
    })
  })

  return nodes.map((node) => {
    const anchor = anchors.get(node.category) ?? { x: cx, y: cy }
    const hash = hashString(node.id)
    const angle = ((hash % 360) / 180) * Math.PI
    const radius = minRadius + ((hash >>> 9) % 1000) / 1000 * spread
    return {
      node,
      x: anchor.x + Math.cos(angle) * radius,
      y: anchor.y + Math.sin(angle) * radius,
    }
  })
}

/** 由共享标签推导连线；每节点最多 4 条，避免密集噪声 */
function buildEdges(nodes: LongTermMemoryNode[]): Edge[] {
  const candidates: Edge[] = []
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const left = nodes[i]!
      const right = nodes[j]!
      let shared = 0
      for (const tag of left.tags) {
        if (right.tags.includes(tag)) shared += 1
      }
      if (shared > 0) candidates.push({ from: left.id, to: right.id, shared })
    }
  }
  candidates.sort((a, b) => b.shared - a.shared)

  const degree = new Map<string, number>()
  const edges: Edge[] = []
  for (const edge of candidates) {
    const left = degree.get(edge.from) ?? 0
    const right = degree.get(edge.to) ?? 0
    if (left >= 4 || right >= 4) continue
    degree.set(edge.from, left + 1)
    degree.set(edge.to, right + 1)
    edges.push(edge)
  }
  return edges
}

// ===== 组件 =====

export function LongTermMemoryView(): React.ReactElement | null {
  const open = useAtomValue(longTermMemoryViewOpenAtom)
  const setOpen = useSetAtom(longTermMemoryViewOpenAtom)
  useGlobalOverlay(open)

  const graph = useAtomValue(longTermMemoryGraphAtom)
  const loading = useAtomValue(longTermMemoryLoadingAtom)
  const selectedId = useAtomValue(longTermMemorySelectedIdAtom)
  const setSelectedId = useSetAtom(longTermMemorySelectedIdAtom)
  const [draft, setDraft] = useAtom(longTermMemoryDraftAtom)
  const [filter, setFilter] = useAtom(longTermMemoryFilterAtom)
  const [query, setQuery] = useAtom(longTermMemoryQueryAtom)
  const hits = useAtomValue(longTermMemoryHitsAtom)
  const querying = useAtomValue(longTermMemoryQueryingAtom)
  const refresh = useSetAtom(refreshLongTermMemoryAtom)
  const saveDraft = useSetAtom(saveLongTermMemoryDraftAtom)
  const deleteNode = useSetAtom(deleteLongTermMemoryNodeAtom)
  const runQueryTest = useSetAtom(runLongTermMemoryQueryTestAtom)

  const [search, setSearch] = React.useState('')
  const [confirmDeleteId, setConfirmDeleteId] = React.useState<string | null>(null)
  const [size, setSize] = React.useState({ width: 800, height: 600 })
  const [viewport, setViewport] = React.useState({ scale: 1, x: 0, y: 0 })

  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const dragRef = React.useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null)
  /** 拖拽过程中的位移标记：click 在 pointerup 之后触发，不能依赖 dragRef 是否已清空 */
  const movedRef = React.useRef(false)

  // 加载 + 订阅跨窗口变更
  React.useEffect(() => {
    if (!open) return
    void refresh()
    const unsubscribe = window.electronAPI.longTermMemory.onChanged(() => {
      void refresh()
    })
    return unsubscribe
  }, [open, refresh])

  // ESC 关闭：capture 阶段拦截并阻止冒泡，避免同时触发 Radix Dialog 关闭整个设置面板
  React.useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (confirmDeleteId) return
      event.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, setOpen, confirmDeleteId])

  // 容器尺寸自适应
  React.useEffect(() => {
    if (!open) return
    const element = containerRef.current
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect || rect.width <= 0 || rect.height <= 0) return
      setSize({ width: Math.round(rect.width), height: Math.round(rect.height) })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [open])

  // 滚轮缩放（需要非 passive 才能 preventDefault）
  React.useEffect(() => {
    if (!open) return
    const element = containerRef.current
    if (!element) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      setViewport((current) => ({
        ...current,
        scale: Math.min(2.4, Math.max(0.6, current.scale * (event.deltaY > 0 ? 0.92 : 1.08))),
      }))
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [open])

  const nodes = React.useMemo(() => graph?.nodes ?? [], [graph])
  const visibleNodes = React.useMemo(() => {
    const keyword = search.trim().toLowerCase()
    return nodes.filter((node) => {
      if (filter !== 'all' && node.category !== filter) return false
      if (!keyword) return true
      return (
        node.title.toLowerCase().includes(keyword) ||
        node.content.toLowerCase().includes(keyword) ||
        node.tags.some((tag) => tag.toLowerCase().includes(keyword))
      )
    })
  }, [nodes, filter, search])

  const points = React.useMemo(() => layoutNodes(visibleNodes, size.width, size.height), [visibleNodes, size])
  const edges = React.useMemo(() => buildEdges(visibleNodes), [visibleNodes])
  const pointMap = React.useMemo(() => new Map(points.map((point) => [point.node.id, point])), [points])
  const hitRanks = React.useMemo(() => new Map(hits.map((hit, index) => [hit.node.id, index])), [hits])

  const selectedNode = React.useMemo(
    () => nodes.find((node) => node.id === (draft?.id ?? selectedId)) ?? null,
    [nodes, draft?.id, selectedId],
  )

  const stats = React.useMemo(() => {
    const byCategory = new Map<LongTermMemoryCategory, number>()
    for (const node of nodes) {
      byCategory.set(node.category, (byCategory.get(node.category) ?? 0) + 1)
    }
    return byCategory
  }, [nodes])

  if (!open) return null

  const startCreate = (): void => {
    setDraft({ id: null, category: 'coding_preference', title: '', content: '', tagsText: '', confidence: 0.7 })
    setSelectedId(null)
  }

  const startEdit = (node: LongTermMemoryNode): void => {
    setDraft(draftFromNode(node))
    setSelectedId(node.id)
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    movedRef.current = false
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: viewport.x,
      originY: viewport.y,
    }
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (Math.abs(dx) + Math.abs(dy) > 4) movedRef.current = true
    setViewport((current) => ({ ...current, x: drag.originX + dx, y: drag.originY + dy }))
  }

  const handlePointerUp = (): void => {
    dragRef.current = null
  }

  return (
    <div
      className={`dark absolute inset-0 ${Z_LAYER.fullscreen} flex flex-col text-slate-100`}
      style={{
        ...DREAMY_THEME,
        backgroundColor: 'hsl(230 32% 6%)',
        backgroundImage:
          'radial-gradient(circle at 18% 12%, rgba(124, 58, 237, 0.28), transparent 42%), radial-gradient(circle at 82% 78%, rgba(14, 165, 233, 0.22), transparent 46%), radial-gradient(circle at 50% 50%, rgba(15, 23, 42, 0.9), #050814 78%)',
      }}
    >
      <style>{`
        @keyframes ltm-twinkle {
          0%, 100% { opacity: 0.55; }
          50% { opacity: 1; }
        }
        @keyframes ltm-pulse {
          0% { transform: scale(0.9); opacity: 0.85; }
          70% { transform: scale(1.9); opacity: 0; }
          100% { transform: scale(1.9); opacity: 0; }
        }
        .ltm-twinkle { animation: ltm-twinkle 4.2s ease-in-out infinite; }
        .ltm-pulse { animation: ltm-pulse 1.8s ease-out infinite; }
      `}</style>

      {/* 顶栏 */}
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-white/10 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-500/20 text-violet-200 shadow-[0_0_24px_rgba(139,92,246,0.45)]">
            <Sparkles size={18} />
          </div>
          <div>
            <h2 className="text-base font-semibold tracking-wide">记忆星图</h2>
            <p className="text-[11px] text-slate-400">
              共 {nodes.length} 条长期记忆 · AI 静默沉淀，本地存储、可随时编辑
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="text-slate-300 hover:bg-white/10 hover:text-white"
            onClick={() => void refresh()}
            disabled={loading}
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            刷新
          </Button>
          <Button size="sm" variant="ghost" className="text-slate-300 hover:bg-white/10 hover:text-white" onClick={() => setOpen(false)}>
            <X size={16} />
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 左栏 */}
        <aside className="flex w-[286px] shrink-0 flex-col gap-4 border-r border-white/10 p-4">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索记忆标题、内容或标签"
              className={`${FIELD_CLASS} pl-8`}
            />
          </div>

          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setFilter('all')}
              className={`rounded-full border px-2.5 py-1 text-[11px] transition ${
                filter === 'all'
                  ? 'border-violet-400/50 bg-violet-400/20 text-violet-100'
                  : 'border-white/10 bg-white/[0.03] text-slate-400 hover:text-slate-200'
              }`}
            >
              全部 {nodes.length}
            </button>
            {LONGTERM_MEMORY_CATEGORIES.map((category) => {
              const meta = LONGTERM_MEMORY_CATEGORY_META[category]
              const count = stats.get(category) ?? 0
              const active = filter === category
              return (
                <button
                  key={category}
                  type="button"
                  onClick={() => setFilter(category)}
                  className={`rounded-full border px-2.5 py-1 text-[11px] transition ${
                    active ? ACCENT_COLORS[category].chip : 'border-white/10 bg-white/[0.03] text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {meta.label} {count}
                </button>
              )
            })}
          </div>

          <Button size="sm" className="bg-violet-500 text-white hover:bg-violet-400" onClick={startCreate}>
            <Plus size={14} />
            新建记忆
          </Button>

          <div className="mt-1 border-t border-white/10 pt-3">
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-slate-500">RAG 检索测试</p>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void runQueryTest()
              }}
              placeholder="输入一句测试文本，回车检索"
              className={FIELD_CLASS}
            />
            <p className="mt-1.5 text-[10px] text-slate-500">
              与对话前的真实召回使用同一套 BM25 + 标签桥接算法。
            </p>

            <div className="mt-3 space-y-1.5">
              {querying && <p className="text-[11px] text-slate-400">检索中…</p>}
              {!querying && hits.length === 0 && query.trim() !== '' && (
                <p className="text-[11px] text-slate-500">没有命中任何记忆。</p>
              )}
              {hits.map((hit, index) => (
                <button
                  key={hit.node.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(hit.node.id)
                    setDraft(null)
                  }}
                  className="w-full rounded-lg border border-white/10 bg-white/[0.03] p-2 text-left transition hover:border-violet-400/40 hover:bg-white/[0.06]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[11px] font-medium text-slate-200">
                      #{index + 1} {hit.node.title}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-violet-300">{hit.score.toFixed(3)}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[10px] leading-relaxed text-slate-400">{hit.excerpt}</p>
                </button>
              ))}
            </div>
          </div>
        </aside>

        {/* 中区星图 */}
        <div
          ref={containerRef}
          className="relative min-w-0 flex-1 cursor-grab touch-none overflow-hidden active:cursor-grabbing"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onPointerLeave={handlePointerUp}
        >
          <div className="pointer-events-none absolute inset-0 opacity-40 [background-image:radial-gradient(rgba(255,255,255,0.16)_1px,transparent_1px)] [background-size:52px_52px]" />

          {visibleNodes.length === 0 ? (
            <div className="relative flex h-full flex-col items-center justify-center gap-3 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-500/15 text-violet-200">
                <Sparkles size={24} />
              </div>
              <p className="text-sm text-slate-300">
                {nodes.length === 0 ? '星图还没有记忆' : '没有符合筛选条件的记忆'}
              </p>
              <p className="max-w-xs text-xs leading-relaxed text-slate-500">
                {nodes.length === 0
                  ? '正常对话后 AI 会自动沉淀偏好；也可以手动新建第一条长期记忆。'
                  : '换一个搜索词或切换到「全部」分类试试。'}
              </p>
              {nodes.length === 0 && (
                <Button size="sm" className="bg-violet-500 text-white hover:bg-violet-400" onClick={startCreate}>
                  <Plus size={14} />
                  新建记忆
                </Button>
              )}
            </div>
          ) : (
            <svg viewBox={`0 0 ${size.width} ${size.height}`} className="relative h-full w-full select-none">
              <defs>
                <filter id="ltm-glow" x="-80%" y="-80%" width="260%" height="260%">
                  <feGaussianBlur stdDeviation="4" result="blur" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              </defs>

              <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}>
                {edges.map((edge) => {
                  const from = pointMap.get(edge.from)
                  const to = pointMap.get(edge.to)
                  if (!from || !to) return null
                  return (
                    <line
                      key={`${edge.from}-${edge.to}`}
                      x1={from.x}
                      y1={from.y}
                      x2={to.x}
                      y2={to.y}
                      stroke="rgba(167, 139, 250, 0.5)"
                      strokeWidth={0.8 + edge.shared * 0.6}
                      strokeOpacity={0.16 + edge.shared * 0.12}
                      strokeLinecap="round"
                    />
                  )
                })}

                {points.map(({ node, x, y }) => {
                  const accent = ACCENT_COLORS[node.category]
                  const radius = 5 + 5 * Math.min(1, node.weight / 10)
                  const active = node.id === (draft?.id ?? selectedId)
                  const rank = hitRanks.get(node.id)
                  return (
                    <g
                      key={node.id}
                      transform={`translate(${x} ${y})`}
                      className="cursor-pointer"
                      onClick={(event) => {
                        event.stopPropagation()
                        if (movedRef.current) return
                        setSelectedId(node.id)
                        setDraft(null)
                      }}
                    >
                      {(rank !== undefined || active) && (
                        <circle
                          r={radius + 8}
                          fill="none"
                          stroke={rank !== undefined ? '#c4b5fd' : 'rgba(255,255,255,0.55)'}
                          strokeWidth={1.2}
                          className={rank !== undefined ? 'ltm-pulse' : undefined}
                          opacity={rank !== undefined ? 0.9 : 0.5}
                        />
                      )}
                      <circle
                        r={radius * 2.2}
                        fill={accent.glow}
                        opacity={rank !== undefined ? 0.35 : 0.16}
                        filter="url(#ltm-glow)"
                      />
                      <circle
                        r={radius}
                        fill={accent.node}
                        stroke={active ? '#ffffff' : 'rgba(255,255,255,0.35)'}
                        strokeWidth={active ? 1.6 : 0.6}
                        className="ltm-twinkle"
                        style={{ animationDelay: `${hashString(node.id) % 3000}ms` }}
                      />
                      {(rank !== undefined || active) && (
                        <text
                          x={radius + 10}
                          y={4}
                          fill="#e2e8f0"
                          fontSize={11}
                          style={{ pointerEvents: 'none' }}
                        >
                          {rank !== undefined ? `#${rank + 1} ${node.title}` : node.title}
                        </text>
                      )}
                    </g>
                  )
                })}
              </g>
            </svg>
          )}

          <div className="pointer-events-none absolute bottom-3 left-3 rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-[10px] text-slate-400 backdrop-blur">
            滚轮缩放 · 拖拽平移 · 点击查看
          </div>
        </div>

        {/* 右栏 */}
        <aside className="flex w-[330px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-white/10 p-4">
          {draft ? (
            <DraftEditor
              draft={draft}
              onChange={setDraft}
              onCancel={() => setDraft(null)}
              onSave={() => void saveDraft()}
            />
          ) : selectedNode ? (
            <NodeInspector
              node={selectedNode}
              onEdit={() => startEdit(selectedNode)}
              onDelete={() => setConfirmDeleteId(selectedNode.id)}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <p className="text-xs text-slate-400">选择一颗星点查看详情</p>
              <p className="max-w-[220px] text-[11px] leading-relaxed text-slate-500">
                节点的权重与置信度会随对话中的反复验证自动提升；由共享标签生成的连线代表它们属于同一类习惯。
              </p>
            </div>
          )}
        </aside>
      </div>

      <AlertDialog open={confirmDeleteId !== null} onOpenChange={(next) => { if (!next) setConfirmDeleteId(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这条长期记忆？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后 AI 将不再在对话中参考它。此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmDeleteId) void deleteNode(confirmDeleteId)
                setConfirmDeleteId(null)
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ===== 右栏：详情 =====

function NodeInspector({
  node,
  onEdit,
  onDelete,
}: {
  node: LongTermMemoryNode
  onEdit: () => void
  onDelete: () => void
}): React.ReactElement {
  const meta = LONGTERM_MEMORY_CATEGORY_META[node.category]
  const accent = ACCENT_COLORS[node.category]
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className={`rounded-full border px-2 py-0.5 text-[10px] ${accent.chip}`}>{meta.label}</span>
        <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] text-slate-400">
          {node.source === 'user_manual' ? '手动添加' : 'AI 自动提炼'}
        </span>
      </div>
      <h3 className="text-sm font-semibold leading-snug text-slate-100">{node.title}</h3>
      <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-slate-300">{node.content}</p>

      {node.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {node.tags.map((tag) => (
            <span key={tag} className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-slate-400">
              #{tag}
            </span>
          ))}
        </div>
      )}

      <div className="space-y-2 rounded-xl border border-white/10 bg-white/[0.03] p-3">
        <Metric label="权重" value={node.weight.toFixed(1)} />
        <Metric label="置信度" value={node.confidence.toFixed(2)} />
        <Metric label="更新时间" value={new Date(node.updatedAt).toLocaleString()} />
      </div>

      <div className="mt-auto flex gap-2 pt-2">
        <Button size="sm" className="flex-1 bg-violet-500 text-white hover:bg-violet-400" onClick={onEdit}>
          <Save size={14} />
          编辑
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="border border-white/10 text-rose-300 hover:bg-rose-500/15 hover:text-rose-200"
          onClick={onDelete}
        >
          <Trash2 size={14} />
        </Button>
      </div>
    </>
  )
}

function Metric({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex items-center justify-between text-[11px]">
      <span className="text-slate-500">{label}</span>
      <span className="font-mono text-slate-300">{value}</span>
    </div>
  )
}

// ===== 右栏：编辑 =====

function DraftEditor({
  draft,
  onChange,
  onCancel,
  onSave,
}: {
  draft: LongTermMemoryDraft
  onChange: (draft: LongTermMemoryDraft) => void
  onCancel: () => void
  onSave: () => void
}): React.ReactElement {
  const update = (patch: Partial<LongTermMemoryDraft>): void => onChange({ ...draft, ...patch })

  return (
    <>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-100">{draft.id ? '编辑记忆' : '新建记忆'}</h3>
        <button type="button" onClick={onCancel} className="text-slate-500 transition hover:text-slate-200">
          <X size={15} />
        </button>
      </div>

      <label className="space-y-1.5">
        <span className="text-[11px] text-slate-400">分类</span>
        <select
          value={draft.category}
          onChange={(event) => update({ category: event.target.value as LongTermMemoryCategory })}
          className={FIELD_CLASS}
        >
          {LONGTERM_MEMORY_CATEGORIES.map((category) => (
            <option key={category} value={category} className="bg-slate-900">
              {LONGTERM_MEMORY_CATEGORY_META[category].label}
            </option>
          ))}
        </select>
      </label>

      <label className="space-y-1.5">
        <span className="text-[11px] text-slate-400">标题</span>
        <input
          value={draft.title}
          onChange={(event) => update({ title: event.target.value })}
          placeholder="例如：状态管理统一使用 Jotai"
          className={FIELD_CLASS}
        />
      </label>

      <label className="space-y-1.5">
        <span className="text-[11px] text-slate-400">内容</span>
        <textarea
          value={draft.content}
          onChange={(event) => update({ content: event.target.value })}
          rows={7}
          placeholder="写 React 组件时所有状态必须使用 Jotai，严禁使用 useState。"
          className={`${FIELD_CLASS} resize-none leading-relaxed`}
        />
      </label>

      <label className="space-y-1.5">
        <span className="text-[11px] text-slate-400">标签（逗号分隔）</span>
        <input
          value={draft.tagsText}
          onChange={(event) => update({ tagsText: event.target.value })}
          placeholder="jotai, react, 状态管理"
          className={FIELD_CLASS}
        />
      </label>

      <label className="space-y-2">
        <span className="flex items-center justify-between text-[11px] text-slate-400">
          置信度
          <span className="font-mono text-slate-300">{draft.confidence.toFixed(2)}</span>
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={draft.confidence}
          onChange={(event) => update({ confidence: Number(event.target.value) })}
          className="w-full accent-violet-400"
        />
      </label>

      <div className="mt-auto flex gap-2 pt-2">
        <Button size="sm" className="flex-1 bg-violet-500 text-white hover:bg-violet-400" onClick={onSave}>
          <Save size={14} />
          保存
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="border border-white/10 text-slate-300 hover:bg-white/10 hover:text-white"
          onClick={onCancel}
        >
          取消
        </Button>
      </div>
    </>
  )
}
