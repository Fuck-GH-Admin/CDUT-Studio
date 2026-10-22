/**
 * CsLabDagCanvas — Prove2Me 假说推演画布
 *
 * 交互：拖拽平移 / 滚轮缩放 / 节点拖动 / 双击编辑 / 右侧圆点连线。
 * 状态：verified / dead_end / pending 为人工事实，pruned 为拓扑派生。
 * 性能：节点拖拽使用 requestAnimationFrame 合并更新，避免每帧整树抖动。
 */

import * as React from 'react'
import {
  Check,
  Link2,
  Loader2,
  Maximize,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react'
import type {
  CsLabCanvasDocument,
  CsLabCanvasNode,
  CsLabCanvasWriteResult,
  CsLabDagNodeKind,
  CsLabDagValidationState,
} from '@profer/shared'
import {
  canvasToDagGraph,
  evaluateDag,
  findCanvasCycleIds,
  wouldCreateCycle,
} from '@profer/shared'
import { cn } from '@/lib/utils'

interface CsLabDagCanvasProps {
  labId: string
  relPath: string
  initialDocument: CsLabCanvasDocument
  initialMtimeMs: number
  onSaved?: (document: CsLabCanvasDocument, result: CsLabCanvasWriteResult) => void
  onToast?: (kind: 'info' | 'success' | 'error', text: string) => void
}

interface ViewTransform {
  x: number
  y: number
  scale: number
}

interface ConnectState {
  fromNode: string
  startX: number
  startY: number
  pointerX: number
  pointerY: number
}

const MIN_SCALE = 0.3
const MAX_SCALE = 2.4
const SAVE_DEBOUNCE_MS = 600

const KIND_LABEL: Record<CsLabDagNodeKind, string> = {
  premise: '前提',
  hypothesis: '假说',
  inference: '推演',
  experiment: '实验',
  note: '笔记',
}

const STATE_DOT: Record<CsLabDagValidationState, string> = {
  pending: 'bg-cslab-muted/50',
  verified: 'bg-[#6E8B6A]',
  dead_end: 'bg-[#B4553F]',
  pruned: 'bg-cslab-border',
}

function nodeKind(node: CsLabCanvasNode): CsLabDagNodeKind {
  const kind = node.cdut_science?.node_kind
  return kind && kind in KIND_LABEL ? kind : 'hypothesis'
}

function nodeState(node: CsLabCanvasNode): CsLabDagValidationState {
  const state = node.cdut_science?.verification_status
  return state === 'verified' || state === 'dead_end' || state === 'pruned' ? state : 'pending'
}

function nodeOperator(node: CsLabCanvasNode): 'AND' | 'OR' {
  return node.cdut_science?.logical_operator === 'OR' ? 'OR' : 'AND'
}

function edgePath(from: CsLabCanvasNode, to: CsLabCanvasNode): string {
  const start = { x: from.x + from.width, y: from.y + from.height / 2 }
  const end = { x: to.x, y: to.y + to.height / 2 }
  const dx = Math.max(60, Math.abs(end.x - start.x) * 0.5)
  return `M ${start.x} ${start.y} C ${start.x + dx} ${start.y}, ${end.x - dx} ${end.y}, ${end.x} ${end.y}`
}

function createId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

export function CsLabDagCanvas({
  labId,
  relPath,
  initialDocument,
  initialMtimeMs,
  onSaved,
  onToast,
}: CsLabDagCanvasProps): React.ReactElement {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const docRef = React.useRef<CsLabCanvasDocument>(initialDocument)
  const mtimeRef = React.useRef<number>(initialMtimeMs)
  const lastSavedJsonRef = React.useRef<string>(JSON.stringify(initialDocument))
  const skipSaveRef = React.useRef(false)
  const saveTimerRef = React.useRef<number | null>(null)

  const [document, setDocument] = React.useState<CsLabCanvasDocument>(initialDocument)
  const [mtimeMs, setMtimeMs] = React.useState(initialMtimeMs)
  const [view, setView] = React.useState<ViewTransform>({ x: 0, y: 0, scale: 1 })
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [connect, setConnect] = React.useState<ConnectState | null>(null)
  const [saveState, setSaveState] = React.useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveMessage, setSaveMessage] = React.useState<string | null>(null)
  const [conflictRelPath, setConflictRelPath] = React.useState<string | null>(null)
  const [dragDisplay, setDragDisplay] = React.useState<{ nodeId: string; dx: number; dy: number } | null>(
    null,
  )

  const dragRef = React.useRef<{
    pointerId: number
    nodeId: string
    startX: number
    startY: number
    frame: number | null
    delta: { dx: number; dy: number }
  } | null>(null)
  const panRef = React.useRef<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
  } | null>(null)

  React.useEffect(() => {
    setDocument(initialDocument)
    docRef.current = initialDocument
    mtimeRef.current = initialMtimeMs
    setMtimeMs(initialMtimeMs)
    lastSavedJsonRef.current = JSON.stringify(initialDocument)
    setView({ x: 0, y: 0, scale: 1 })
    setSelectedId(null)
    // 仅在打开另一张画布时重置；保存后父级回传新对象不应重置视口。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relPath])

  React.useEffect(() => {
    docRef.current = document
  }, [document])

  const graph = React.useMemo(() => canvasToDagGraph(document), [document])
  const evaluation = React.useMemo(
    () => evaluateDag(graph.nodes, graph.edges),
    [graph],
  )
  const cycleIds = React.useMemo(
    () => findCanvasCycleIds(graph.nodes, graph.edges),
    [graph],
  )

  const saveNow = React.useCallback(async (): Promise<void> => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const payload = docRef.current
    if (JSON.stringify(payload) === lastSavedJsonRef.current) return

    setSaveState('saving')
    try {
      const result = await window.electronAPI.cslab.writeCanvas({
        labId,
        relPath,
        document: payload,
        expectedMtimeMs: mtimeRef.current,
      })
      mtimeRef.current = result.mtimeMs
      setMtimeMs(result.mtimeMs)
      lastSavedJsonRef.current = JSON.stringify(result.document)
      skipSaveRef.current = true
      docRef.current = result.document
      setDocument(result.document)
      setSaveState('saved')
      setConflictRelPath(result.conflictRelPath ?? null)
      let savedDocument = result.document
      if (result.durability === 'in-place') {
        setSaveMessage('文件被 Obsidian 占用，已原地写入')
      } else if (result.durability === 'conflict-only') {
        setSaveMessage('已生成冲突副本，原画布未被覆盖')
        onToast?.('info', '画布被 Obsidian 占用，已写入冲突副本')
        // 重新载入磁盘版本，避免后续每次保存都继续分叉；用户编辑已保存在冲突副本。
        try {
          const reloaded = await window.electronAPI.cslab.readCanvas({ labId, relPath })
          mtimeRef.current = reloaded.mtimeMs
          setMtimeMs(reloaded.mtimeMs)
          lastSavedJsonRef.current = JSON.stringify(reloaded.document)
          skipSaveRef.current = true
          docRef.current = reloaded.document
          savedDocument = reloaded.document
          setDocument(reloaded.document)
        } catch {
          // 磁盘版本不可读时保留当前编辑，等待用户手动处理冲突副本。
        }
      } else if (result.conflictRelPath) {
        setSaveMessage('检测到外部结构变更，已生成冲突副本')
      } else {
        setSaveMessage(null)
      }
      if (result.cancelledJobIds.length > 0) {
        onToast?.('info', `已标记 ${result.cancelledJobIds.length} 个远程任务待取消`)
      }
      onSaved?.(savedDocument, result)
    } catch (error) {
      setSaveState('error')
      setSaveMessage(error instanceof Error ? error.message : '保存失败')
      onToast?.('error', error instanceof Error ? error.message : '画布保存失败')
    }
  }, [labId, relPath, onSaved, onToast])

  // 文档变化后防抖保存。
  React.useEffect(() => {
    if (skipSaveRef.current) {
      skipSaveRef.current = false
      return
    }
    if (JSON.stringify(document) === lastSavedJsonRef.current) return
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      void saveNow()
    }, SAVE_DEBOUNCE_MS)
    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
    }
  }, [document, saveNow])

  const saveRef = React.useRef(saveNow)
  saveRef.current = saveNow

  // 关闭窗格 / 切换实验室前尽量落盘，避免防抖窗口内丢编辑。
  React.useEffect(() => {
    return () => {
      if (JSON.stringify(docRef.current) !== lastSavedJsonRef.current) {
        void saveRef.current()
      }
    }
  }, [])

  React.useEffect(() => {
    if (!connect) return
    const clear = (): void => setConnect(null)
    window.addEventListener('pointerup', clear)
    window.addEventListener('pointercancel', clear)
    return () => {
      window.removeEventListener('pointerup', clear)
      window.removeEventListener('pointercancel', clear)
    }
  }, [connect])

  // 外部 Obsidian 修改：文档干净时自动重载。
  React.useEffect(() => {
    const off = window.electronAPI.cslab.onVaultChanged((event) => {
      if (event.labId !== labId) return
      if (!event.relPaths.some((path) => path === relPath || path.startsWith(relPath))) return
      if (saveState === 'saving' || saveTimerRef.current) return
      void window.electronAPI.cslab
        .readCanvas({ labId, relPath })
        .then((result) => {
          skipSaveRef.current = true
          docRef.current = result.document
          lastSavedJsonRef.current = JSON.stringify(result.document)
          mtimeRef.current = result.mtimeMs
          setMtimeMs(result.mtimeMs)
          setDocument(result.document)
        })
        .catch(() => undefined)
    })
    return off
  }, [labId, relPath, saveState])

  const updateNode = React.useCallback(
    (nodeId: string, updater: (node: CsLabCanvasNode) => CsLabCanvasNode): void => {
      setDocument((previous) => ({
        ...previous,
        nodes: previous.nodes.map((node) => (node.id === nodeId ? updater(node) : node)),
      }))
    },
    [],
  )

  const setNodeMeta = React.useCallback(
    (nodeId: string, patch: Record<string, unknown>): void => {
      updateNode(nodeId, (node) => ({
        ...node,
        cdut_science: { ...(node.cdut_science ?? {}), ...patch },
      }))
    },
    [updateNode],
  )

  const addNode = React.useCallback(
    (kind: CsLabDagNodeKind): void => {
      const rect = containerRef.current?.getBoundingClientRect()
      const centerX = rect ? (rect.width / 2 - view.x) / view.scale : 120
      const centerY = rect ? (rect.height / 2 - view.y) / view.scale : 120
      const node: CsLabCanvasNode = {
        id: createId('node'),
        type: 'text',
        x: Math.round(centerX - 130 + Math.random() * 40),
        y: Math.round(centerY - 70 + Math.random() * 40),
        width: 260,
        height: 150,
        text: kind === 'hypothesis' ? '# 新假说' : kind === 'inference' ? '推演结论' : '实验记录',
        cdut_science: {
          cdut_uri: `cdut://${labId}/node/${createId('n')}`,
          node_kind: kind,
          verification_status: 'pending',
          logical_operator: 'AND',
        },
      }
      setDocument((previous) => ({ ...previous, nodes: [...previous.nodes, node] }))
      setSelectedId(node.id)
    },
    [labId, view.scale, view.x, view.y],
  )

  const deleteNode = React.useCallback((nodeId: string): void => {
    setDocument((previous) => ({
      ...previous,
      nodes: previous.nodes.filter((node) => node.id !== nodeId),
      edges: previous.edges.filter(
        (edge) => edge.fromNode !== nodeId && edge.toNode !== nodeId,
      ),
    }))
    setSelectedId((current) => (current === nodeId ? null : current))
  }, [])

  const fitView = React.useCallback((): void => {
    if (document.nodes.length === 0) {
      setView({ x: 0, y: 0, scale: 1 })
      return
    }
    const minX = Math.min(...document.nodes.map((node) => node.x))
    const minY = Math.min(...document.nodes.map((node) => node.y))
    const maxX = Math.max(...document.nodes.map((node) => node.x + node.width))
    const maxY = Math.max(...document.nodes.map((node) => node.y + node.height))
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const scale = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, Math.min((rect.width - 120) / (maxX - minX || 1), (rect.height - 120) / (maxY - minY || 1))),
    )
    setView({
      scale,
      x: (rect.width - (maxX - minX) * scale) / 2 - minX * scale,
      y: (rect.height - (maxY - minY) * scale) / 2 - minY * scale,
    })
  }, [document.nodes])

  const fittedRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    if (fittedRef.current === relPath) return
    fittedRef.current = relPath
    const timer = window.setTimeout(() => fitView(), 0)
    return () => window.clearTimeout(timer)
  }, [relPath, fitView])

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const scaleDelta = Math.exp(-event.deltaY * 0.0015)
    const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * scaleDelta))
    const pointerX = event.clientX - rect.left
    const pointerY = event.clientY - rect.top
    setView((previous) => {
      const worldX = (pointerX - previous.x) / previous.scale
      const worldY = (pointerY - previous.y) / previous.scale
      return {
        scale: nextScale,
        x: pointerX - worldX * nextScale,
        y: pointerY - worldY * nextScale,
      }
    })
  }

  const handleBackgroundPointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
  ): void => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('[data-canvas-node]')) return
    // 工具栏/输入控件不触发画布平移。
    if (target.closest('button, input, textarea, select')) return
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: view.x,
      originY: view.y,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (panRef.current && panRef.current.pointerId === event.pointerId) {
      const pan = panRef.current
      setView((previous) => ({
        ...previous,
        x: pan.originX + (event.clientX - pan.startX),
        y: pan.originY + (event.clientY - pan.startY),
      }))
      return
    }

    if (connect) {
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      const worldX = (event.clientX - rect.left - view.x) / view.scale
      const worldY = (event.clientY - rect.top - view.y) / view.scale
      setConnect((previous) => (previous ? { ...previous, pointerX: worldX, pointerY: worldY } : previous))
      return
    }

    const drag = dragRef.current
    if (drag && drag.pointerId === event.pointerId) {
      drag.delta = {
        dx: (event.clientX - drag.startX) / view.scale,
        dy: (event.clientY - drag.startY) / view.scale,
      }
      if (drag.frame == null) {
        drag.frame = window.requestAnimationFrame(() => {
          const active = dragRef.current
          if (!active) return
          active.frame = null
          setDragDisplay({
            nodeId: active.nodeId,
            dx: active.delta.dx,
            dy: active.delta.dy,
          })
        })
      }
    }
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (panRef.current?.pointerId === event.pointerId) {
      panRef.current = null
    }
    const drag = dragRef.current
    if (drag && drag.pointerId === event.pointerId) {
      dragRef.current = null
      if (drag.frame != null) window.cancelAnimationFrame(drag.frame)
      setDragDisplay(null)
      if (drag.delta.dx !== 0 || drag.delta.dy !== 0) {
        updateNode(drag.nodeId, (node) => ({
          ...node,
          x: Math.round(node.x + drag.delta.dx),
          y: Math.round(node.y + drag.delta.dy),
        }))
      }
    }

    if (connect) {
      const targetNode = (event.target as HTMLElement).closest('[data-canvas-node]') as
        | HTMLElement
        | null
      const targetId = targetNode?.dataset.nodeId
      if (targetId && targetId !== connect.fromNode) {
        const exists = document.edges.some(
          (edge) => edge.fromNode === connect.fromNode && edge.toNode === targetId,
        )
        if (!exists && wouldCreateCycle(document.edges, connect.fromNode, targetId)) {
          onToast?.('error', '该连线会形成循环引用，已阻止')
        } else if (!exists) {
          setDocument((previous) => ({
            ...previous,
            edges: [
              ...previous.edges,
              {
                id: createId('edge'),
                fromNode: connect.fromNode,
                toNode: targetId,
                label: 'implies',
                cdut_science: { dependency_type: 'strict_conjunctive' },
              },
            ],
          }))
        }
      }
      setConnect(null)
    }
  }

  const handleNodePointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
    node: CsLabCanvasNode,
  ): void => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('[data-node-action]') || target.closest('textarea')) return
    setSelectedId(node.id)
    dragRef.current = {
      pointerId: event.pointerId,
      nodeId: node.id,
      startX: event.clientX,
      startY: event.clientY,
      frame: null,
      delta: { dx: 0, dy: 0 },
    }
    event.stopPropagation()
    // 捕获指针到节点自身：拖出画布仍能收到 pointerup，同时保留双击编辑。
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const nodeById = React.useMemo(
    () => new Map(document.nodes.map((node) => [node.id, node])),
    [document.nodes],
  )

  const selectedNode = selectedId ? nodeById.get(selectedId) ?? null : null
  const cycleWarning = cycleIds.size > 0

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full select-none overflow-hidden bg-cslab-bg"
      style={{
        backgroundImage:
          'radial-gradient(circle at 1px 1px, rgba(36,34,32,0.075) 1px, transparent 0)',
        backgroundSize: '22px 22px',
      }}
      onWheel={handleWheel}
      onPointerDown={handleBackgroundPointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center p-3">
        {cycleWarning && (
          <div className="pointer-events-auto rounded-full border border-cslab-accent/40 bg-cslab-elevated/95 px-3 py-1 text-[11px] text-cslab-accent shadow-subtle">
            存在推演循环引用（{cycleIds.size} 个节点），剪枝已暂停
          </div>
        )}
      </div>

      <div className="absolute left-3 top-3 z-20 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => addNode('hypothesis')}
          className="inline-flex items-center gap-1 rounded-lg border border-cslab-border bg-cslab-elevated px-2 py-1 text-[11px] text-cslab-text transition-colors hover:border-cslab-accent/40 hover:text-cslab-accent"
        >
          <Plus size={11} /> 假说
        </button>
        <button
          type="button"
          onClick={() => addNode('inference')}
          className="inline-flex items-center gap-1 rounded-lg border border-cslab-border bg-cslab-elevated px-2 py-1 text-[11px] text-cslab-text transition-colors hover:border-cslab-accent/40 hover:text-cslab-accent"
        >
          <Plus size={11} /> 推演
        </button>
        <button
          type="button"
          onClick={() => addNode('experiment')}
          className="inline-flex items-center gap-1 rounded-lg border border-cslab-border bg-cslab-elevated px-2 py-1 text-[11px] text-cslab-text transition-colors hover:border-cslab-accent/40 hover:text-cslab-accent"
        >
          <Plus size={11} /> 实验
        </button>
        <button
          type="button"
          onClick={fitView}
          className="inline-flex items-center gap-1 rounded-lg border border-cslab-border bg-cslab-elevated px-2 py-1 text-[11px] text-cslab-muted transition-colors hover:text-cslab-text"
        >
          <Maximize size={11} /> 适应
        </button>
      </div>

      <div className="absolute right-3 top-3 z-20 flex items-center gap-2 rounded-full border border-cslab-border bg-cslab-elevated/95 px-2.5 py-1 text-[10px] text-cslab-muted shadow-subtle">
        {saveState === 'saving' ? (
          <>
            <Loader2 size={10} className="animate-spin" /> 保存中
          </>
        ) : saveState === 'error' ? (
          <span className="text-[#B4553F]">{saveMessage ?? '保存失败'}</span>
        ) : (
          <span>{saveMessage ?? (saveState === 'saved' ? '已保存' : '自动保存')}</span>
        )}
        {conflictRelPath && (
          <span className="truncate text-cslab-accent" title={conflictRelPath}>
            冲突副本
          </span>
        )}
      </div>

      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
        }}
      >
        <svg
          className="pointer-events-none absolute left-0 top-0 overflow-visible"
          width={1}
          height={1}
          aria-hidden="true"
        >
          {document.edges.map((edge) => {
            const rawFrom = nodeById.get(edge.fromNode)
            const rawTo = nodeById.get(edge.toNode)
            if (!rawFrom || !rawTo) return null
            const from =
              dragDisplay?.nodeId === rawFrom.id
                ? { ...rawFrom, x: rawFrom.x + dragDisplay.dx, y: rawFrom.y + dragDisplay.dy }
                : rawFrom
            const to =
              dragDisplay?.nodeId === rawTo.id
                ? { ...rawTo, x: rawTo.x + dragDisplay.dx, y: rawTo.y + dragDisplay.dy }
                : rawTo
            const targetOperator = nodeOperator(to)
            return (
              <path
                key={edge.id}
                d={edgePath(from, to)}
                fill="none"
                stroke={targetOperator === 'OR' ? '#B9A38F' : '#C9C3BA'}
                strokeWidth={1.5}
                strokeDasharray={targetOperator === 'OR' ? '5 5' : undefined}
              />
            )
          })}
          {connect && (
            <path
              d={`M ${connect.startX} ${connect.startY} L ${connect.pointerX} ${connect.pointerY}`}
              fill="none"
              className="stroke-cslab-accent"
              strokeWidth={1.5}
              strokeDasharray="4 4"
            />
          )}
        </svg>

        {document.nodes.map((node) => {
          const state = evaluation.states[node.id] ?? nodeState(node)
          const kind = nodeKind(node)
          const cyclic = cycleIds.has(node.id)
          const isSelected = selectedId === node.id
          return (
            <div
              key={node.id}
              data-canvas-node
              data-node-id={node.id}
              onPointerDown={(event) => handleNodePointerDown(event, node)}
              onDoubleClick={(event) => {
                event.stopPropagation()
                setEditingId(node.id)
              }}
              className={cn(
                'absolute rounded-xl border bg-cslab-elevated text-cslab-text shadow-subtle transition-[opacity,border-color] duration-200',
                state === 'pruned'
                  ? 'border-dashed opacity-45'
                  : isSelected
                    ? 'border-cslab-accent/60'
                    : 'border-cslab-border',
                cyclic && 'animate-pulse border-[#B4553F]',
              )}
              style={{
                left: node.x,
                top: node.y,
                width: node.width,
                height: node.height,
                transform:
                  dragDisplay?.nodeId === node.id
                    ? `translate(${dragDisplay.dx}px, ${dragDisplay.dy}px)`
                    : undefined,
                ...(cyclic ? { borderWidth: 1.5, borderStyle: 'dashed' } : {}),
              }}
            >
              <div className="flex items-center gap-1.5 border-b border-cslab-border/60 px-2.5 py-1.5">
                <span
                  className={cn(
                    'inline-flex size-1.5 rounded-full',
                    STATE_DOT[state] ?? 'bg-cslab-muted/50',
                  )}
                />
                <span className="text-[10px] uppercase tracking-[0.12em] text-cslab-muted">
                  {KIND_LABEL[kind]}
                </span>
                {cyclic && (
                  <span className="rounded-full border border-[#B4553F]/40 px-1.5 text-[9px] text-[#B4553F]">
                    循环
                  </span>
                )}
                <span className="ml-auto flex items-center gap-1" data-node-action>
                  <button
                    type="button"
                    title="标记已验证"
                    onClick={() =>
                      setNodeMeta(node.id, {
                        verification_status: 'verified',
                        manual_status: 'verified',
                      })
                    }
                    className="rounded p-0.5 text-cslab-muted hover:bg-cslab-surface hover:text-[#5C7358]"
                  >
                    <Check size={10} />
                  </button>
                  <button
                    type="button"
                    title="标记死路"
                    onClick={() =>
                      setNodeMeta(node.id, {
                        verification_status: 'dead_end',
                        manual_status: 'dead_end',
                      })
                    }
                    className="rounded p-0.5 text-cslab-muted hover:bg-cslab-surface hover:text-[#B4553F]"
                  >
                    <X size={10} />
                  </button>
                  <button
                    type="button"
                    title="重置为待定"
                    onClick={() =>
                      setNodeMeta(node.id, {
                        verification_status: 'pending',
                        manual_status: 'pending',
                      })
                    }
                    className="rounded p-0.5 text-cslab-muted hover:bg-cslab-surface hover:text-cslab-text"
                  >
                    <RotateCcw size={10} />
                  </button>
                  <button
                    type="button"
                    title="删除节点"
                    onClick={() => deleteNode(node.id)}
                    className="rounded p-0.5 text-cslab-muted hover:bg-cslab-surface hover:text-[#B4553F]"
                  >
                    <Trash2 size={10} />
                  </button>
                </span>
              </div>

              <div className="flex h-[calc(100%-30px)] flex-col px-2.5 py-2">
                {editingId === node.id ? (
                  <textarea
                    autoFocus
                    defaultValue={node.text ?? ''}
                    onBlur={(event) => {
                      const text = event.currentTarget.value
                      updateNode(node.id, (current) => ({ ...current, text }))
                      setEditingId(null)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') setEditingId(null)
                      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                        event.currentTarget.blur()
                      }
                    }}
                    className="h-full w-full resize-none select-text rounded-md border border-cslab-border bg-cslab-bg p-1.5 text-[12px] leading-relaxed text-cslab-text outline-none focus:border-cslab-accent/50"
                  />
                ) : (
                  <p className="line-clamp-4 whitespace-pre-wrap text-[12px] leading-relaxed text-cslab-text">
                    {(node.text ?? node.file ?? node.url ?? '').replace(/^#+\s*/, '') || '双击编辑内容'}
                  </p>
                )}

                <div className="mt-auto flex items-center justify-between pt-1">
                  <button
                    type="button"
                    data-node-action
                    onClick={() =>
                      setNodeMeta(node.id, {
                        logical_operator: nodeOperator(node) === 'AND' ? 'OR' : 'AND',
                      })
                    }
                    className={cn(
                      'rounded-full border px-1.5 py-0.5 text-[9px] tracking-wide transition-colors',
                      nodeOperator(node) === 'OR'
                        ? 'border-cslab-accent/40 text-cslab-accent'
                        : 'border-cslab-border text-cslab-muted',
                    )}
                    title="切换逻辑门限"
                  >
                    {nodeOperator(node)}
                  </button>
                  {state === 'pruned' && (
                    <span className="text-[9px] uppercase tracking-wide text-cslab-muted">
                      {node.cdut_science?.job_cancel_requested ? '待取消任务' : '已折叠'}
                    </span>
                  )}
                </div>
              </div>

              <button
                type="button"
                data-node-action
                title="拖拽连线"
                onPointerDown={(event) => {
                  event.stopPropagation()
                  setConnect({
                    fromNode: node.id,
                    startX: node.x + node.width,
                    startY: node.y + node.height / 2,
                    pointerX: node.x + node.width,
                    pointerY: node.y + node.height / 2,
                  })
                }}
                className="absolute -right-2 top-1/2 flex size-4 -translate-y-1/2 items-center justify-center rounded-full border border-cslab-border bg-cslab-elevated text-cslab-muted shadow-subtle hover:border-cslab-accent hover:text-cslab-accent"
              >
                <Link2 size={8} />
              </button>
            </div>
          )
        })}
      </div>

      {document.nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="pointer-events-auto max-w-sm rounded-2xl border border-dashed border-cslab-border bg-cslab-elevated/80 px-6 py-5 text-center">
            <p className="font-serif text-base text-cslab-text">建立第一个假说节点</p>
            <p className="mt-1 text-[11px] leading-relaxed text-cslab-muted">
              节点之间可拖拽连线；把根假说标记为死路，下游 AND 分支会自动折叠。
            </p>
            <button
              type="button"
              onClick={() => addNode('hypothesis')}
              className="mt-3 inline-flex items-center gap-1 rounded-lg bg-cslab-accent px-3 py-1.5 text-[11px] font-medium text-white hover:bg-cslab-accentHover"
            >
              <Plus size={12} /> 添加假说
            </button>
          </div>
        </div>
      )}

      {selectedNode && (
        <div className="absolute bottom-3 left-3 z-20 flex items-center gap-2 rounded-lg border border-cslab-border bg-cslab-elevated/95 px-2.5 py-1.5 text-[10px] text-cslab-muted shadow-subtle">
          <span className="text-cslab-text">{selectedNode.text?.slice(0, 24) || selectedNode.id}</span>
          <span className="text-cslab-border">·</span>
          <span>{nodeOperator(selectedNode)}</span>
          <span className="text-cslab-border">·</span>
          <span>{(evaluation.states[selectedNode.id] ?? nodeState(selectedNode)) === 'pruned' ? '已折叠' : '就绪'}</span>
          <span className="ml-1 tabular-nums">{Math.round(view.scale * 100)}%</span>
          <span className="text-cslab-border">·</span>
          <span className="tabular-nums">{document.nodes.length} 节点</span>
          <span className="text-cslab-border">·</span>
          <input
            value={
              typeof selectedNode.cdut_science?.gpu_task_id === 'string'
                ? selectedNode.cdut_science.gpu_task_id
                : ''
            }
            onChange={(event) =>
              setNodeMeta(selectedNode.id, {
                gpu_task_id: event.target.value.trim() || null,
                job_cancel_requested: false,
              })
            }
            placeholder="GPU 任务 ID"
            title="绑定远程任务；死路剪枝后会标记待取消"
            className="w-28 select-text rounded border border-cslab-border bg-cslab-bg px-1.5 py-0.5 font-mono text-[9px] text-cslab-text outline-none focus:border-cslab-accent/50"
          />
        </div>
      )}
    </div>
  )
}
