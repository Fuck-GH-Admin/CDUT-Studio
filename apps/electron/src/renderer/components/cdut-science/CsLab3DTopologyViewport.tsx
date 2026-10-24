/**
 * CsLab3DTopologyViewport — 分层 3D 空间拓扑视口（three.js）
 *
 * 设计要点：
 * - 世界坐标 Z 轴向上：宏观（zLevel 高）在上、中观居中、微观（zLevel 低）在下，
 *   与 Hierarchical3DGraphNode.zLevel 语义一致；数据自带 x/y/z 坐标时原样使用；
 * - 节点 SphereGeometry + MeshBasicMaterial（按 layer 着色，沿用面板社群色 hsl(62% 58%) 配方），
 *   边 LineSegments（顶点色取两端节点层色，层间边天然渐变）；
 * - 交互：OrbitControls 轨道漫游 + 滚轮缩放，Raycaster 点选（高亮脉冲 + HTML 浮层显示 details），
 *   hover 小标签走 HTML 浮层方案（零额外依赖，未引入 CSS2DRenderer/sprite）；
 * - 图层切片：Macro/Meso/Micro toggle 隐藏该层节点组与相关边（visible 属性）；
 * - 层间边粒子流效果实现成本较高，本版省略（仅保留渐变连线 + 选中脉冲）；
 * - 资源清理对齐 CsLabMolstarViewer 范式：cancelAnimationFrame、ResizeObserver 断开、
 *   controls.dispose、geometry/material 全量 dispose、renderer.dispose + forceContextLoss、移除 canvas。
 */

import * as React from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { Hierarchical3DGraphData, Hierarchical3DGraphNode } from '@profer/shared'
import { Layers } from 'lucide-react'
import { cn } from '@/lib/utils'

interface CsLab3DTopologyViewportProps {
  data: Hierarchical3DGraphData
  onSelectNode?: (node: Hierarchical3DGraphNode | null) => void
  /** 视口高度（px），默认对齐 2D 图谱的 h-56。 */
  height?: number
}

type TopologyLayer = Hierarchical3DGraphNode['layer']

const LAYER_ORDER: TopologyLayer[] = ['macro', 'meso', 'micro']

/** 层色相：沿用面板社群色 hsl(62% 58%) 配方，仅按层换色相。 */
const LAYER_HUES: Record<TopologyLayer, number> = {
  macro: 212,
  meso: 268,
  micro: 160,
}

const LAYER_LEVEL: Record<TopologyLayer, number> = {
  macro: 2,
  meso: 1,
  micro: 0,
}

const LAYER_LABELS: Record<TopologyLayer, string> = {
  macro: '宏观',
  meso: '中观',
  micro: '微观',
}

const LAYER_TITLES: Record<TopologyLayer, string> = {
  macro: '宏观层：论文 / 作者 / 期刊 / 领域（Z 高）',
  meso: '中观层：概念 / 方法 / 协议',
  micro: '微观层：指标 / 表格 / 图件（Z 低）',
}

const TYPE_LABELS: Record<Hierarchical3DGraphNode['type'], string> = {
  paper: '论文',
  author: '作者',
  venue: '期刊',
  concept: '概念',
  method: '方法',
  protocol: '协议',
  metric: '指标',
  table: '表格',
  figure: '图件',
}

/** 节点基准半径（再叠加连接度增益）。 */
const TYPE_RADIUS: Record<Hierarchical3DGraphNode['type'], number> = {
  paper: 1.7,
  author: 1.1,
  venue: 1.2,
  concept: 1.3,
  method: 1.2,
  protocol: 1.1,
  metric: 0.9,
  table: 1.0,
  figure: 1.0,
}

/** 缺省坐标时的层内环形布局半径。 */
const LAYER_RING_RADIUS: Record<TopologyLayer, number> = {
  macro: 26,
  meso: 18,
  micro: 11,
}

const LAYER_GAP = 20

interface TopologyEntry {
  node: Hierarchical3DGraphNode
  position: [number, number, number]
  radius: number
}

interface TopologyModel {
  entries: TopologyEntry[]
  edges: Array<{ source: string; target: string }>
  degree: Map<string, number>
  center: [number, number, number]
  /** 相机取景半径（含层高的包围半径）。 */
  extent: number
}

/** 确定性哈希 → [0,1)，保证布局跨渲染稳定。 */
function hashUnit(input: string): number {
  let hash = 7
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) % 100003
  }
  return hash / 100003
}

/**
 * 轻量确定性布局：有坐标用坐标，无坐标按层内黄金角环形铺开；
 * 不做力导向迭代，几百节点零卡顿。
 */
function buildTopologyModel(data: Hierarchical3DGraphData): TopologyModel {
  const nodes = Array.isArray(data.nodes) ? data.nodes : []
  const rawEdges = Array.isArray(data.edges) ? data.edges : []

  const degree = new Map<string, number>()
  for (const edge of rawEdges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
  }

  const entries: TopologyEntry[] = []
  const entryById = new Map<string, TopologyEntry>()
  const layerCursor: Record<TopologyLayer, number> = { macro: 0, meso: 0, micro: 0 }
  for (const node of nodes) {
    if (!node || entryById.has(node.id)) continue
    const hasCoords =
      Number.isFinite(node.x) && Number.isFinite(node.y) && Number.isFinite(node.z)
    let position: [number, number, number]
    if (hasCoords) {
      position = [node.x ?? 0, node.y ?? 0, node.z ?? 0]
    } else {
      // 黄金角增量保证同层均匀铺开；哈希抖动避免纯同心圆呆板。
      const cursor = layerCursor[node.layer] ?? 0
      layerCursor[node.layer] = cursor + 1
      const angle = cursor * 2.399963 + hashUnit(node.id) * Math.PI * 2
      const ring = LAYER_RING_RADIUS[node.layer] * (0.82 + hashUnit(`${node.id}:r`) * 0.36)
      const level = Number.isFinite(node.zLevel) ? node.zLevel : LAYER_LEVEL[node.layer]
      position = [ring * Math.cos(angle), ring * Math.sin(angle), (level - 1) * LAYER_GAP]
    }
    const baseRadius = TYPE_RADIUS[node.type] ?? 1
    const radius = baseRadius + Math.min(1.2, (degree.get(node.id) ?? 0) * 0.08)
    const entry: TopologyEntry = { node, position, radius }
    entries.push(entry)
    entryById.set(node.id, entry)
  }

  const edges: Array<{ source: string; target: string }> = []
  for (const edge of rawEdges) {
    if (!entryById.has(edge.source) || !entryById.has(edge.target)) continue
    edges.push({ source: edge.source, target: edge.target })
  }

  let min = [Infinity, Infinity, Infinity]
  let max = [-Infinity, -Infinity, -Infinity]
  for (const entry of entries) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = entry.position[axis] ?? 0
      min[axis] = Math.min(min[axis] ?? value, value)
      max[axis] = Math.max(max[axis] ?? value, value)
    }
  }
  if (entries.length === 0) {
    min = [0, 0, 0]
    max = [0, 0, 0]
  }
  const center: [number, number, number] = [
    ((min[0] ?? 0) + (max[0] ?? 0)) / 2,
    ((min[1] ?? 0) + (max[1] ?? 0)) / 2,
    ((min[2] ?? 0) + (max[2] ?? 0)) / 2,
  ]
  const halfDiagonal =
    Math.hypot(
      (max[0] ?? 0) - (min[0] ?? 0),
      (max[1] ?? 0) - (min[1] ?? 0),
      (max[2] ?? 0) - (min[2] ?? 0),
    ) / 2
  return {
    entries,
    edges,
    degree,
    center,
    extent: Math.max(12, halfDiagonal + 6),
  }
}

/** details 值的紧凑展示（指标值/页码/relPath 等）。 */
function formatDetailValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, 4)
      .map((item) =>
        typeof item === 'string' || typeof item === 'number' ? String(item) : '…',
      )
    return items.join('、')
  }
  try {
    return JSON.stringify(value).slice(0, 60)
  } catch {
    return '—'
  }
}

interface SceneHandles {
  layerGroups: Record<TopologyLayer, THREE.Group>
  edgeGroups: Array<{ layers: [TopologyLayer, TopologyLayer]; object: THREE.LineSegments }>
  meshById: Map<string, THREE.Mesh>
}

export function CsLab3DTopologyViewport({
  data,
  onSelectNode,
  height = 224,
}: CsLab3DTopologyViewportProps): React.ReactElement {
  const mountRef = React.useRef<HTMLDivElement | null>(null)
  const tooltipRef = React.useRef<HTMLDivElement | null>(null)
  const sceneRef = React.useRef<SceneHandles | null>(null)
  const onSelectNodeRef = React.useRef(onSelectNode)
  const selectedIdRef = React.useRef<string | null>(null)
  const hoverIdRef = React.useRef<string | null>(null)

  const [layerEnabled, setLayerEnabled] = React.useState<Record<TopologyLayer, boolean>>({
    macro: true,
    meso: true,
    micro: true,
  })
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [hoverId, setHoverId] = React.useState<string | null>(null)

  React.useEffect(() => {
    onSelectNodeRef.current = onSelectNode
  }, [onSelectNode])

  const model = React.useMemo(() => buildTopologyModel(data), [data])
  const nodeById = React.useMemo(
    () => new Map(model.entries.map((entry) => [entry.node.id, entry.node])),
    [model],
  )

  // ===== three.js 初始化 / 销毁 =====
  React.useEffect(() => {
    selectedIdRef.current = null
    hoverIdRef.current = null
    setSelectedId(null)
    setHoverId(null)

    const container = mountRef.current
    if (!container || model.entries.length === 0) return

    const width = Math.max(1, container.clientWidth)
    const heightPx = Math.max(1, container.clientHeight)

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    } catch (cause) {
      console.error('[CSLab 3D 拓扑] WebGL 初始化失败:', cause)
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setSize(width, heightPx)
    container.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(50, width / heightPx, 0.1, model.extent * 14)
    // Z 轴向上，宏观层位于 Z 高处。
    camera.up.set(0, 0, 1)
    const viewDistance = Math.max(24, model.extent * 2.2)
    camera.position.set(
      model.center[0] + viewDistance * 0.9,
      model.center[1] - viewDistance * 1.1,
      model.center[2] + viewDistance * 0.75,
    )

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.minDistance = Math.max(8, model.extent * 0.35)
    controls.maxDistance = model.extent * 6
    controls.target.set(model.center[0], model.center[1], model.center[2])

    const disposables: Array<{ dispose: () => void }> = []
    const sphereGeometry = new THREE.SphereGeometry(1, 20, 14)
    disposables.push(sphereGeometry)

    const layerMaterials = {} as Record<TopologyLayer, THREE.MeshBasicMaterial>
    const layerRgb = {} as Record<TopologyLayer, [number, number, number]>
    for (const layer of LAYER_ORDER) {
      const color = new THREE.Color().setHSL(LAYER_HUES[layer] / 360, 0.62, 0.58)
      layerRgb[layer] = [color.r, color.g, color.b]
      layerMaterials[layer] = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.9,
      })
      disposables.push(layerMaterials[layer])
    }
    // 琥珀高亮，深浅主题下均可见。
    const highlightMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setHSL(0.11, 0.85, 0.62),
      transparent: true,
      opacity: 0.96,
    })
    disposables.push(highlightMaterial)

    const layerGroups: Record<TopologyLayer, THREE.Group> = {
      macro: new THREE.Group(),
      meso: new THREE.Group(),
      micro: new THREE.Group(),
    }
    for (const layer of LAYER_ORDER) {
      layerGroups[layer].visible = layerEnabled[layer]
      scene.add(layerGroups[layer])
    }

    const meshById = new Map<string, THREE.Mesh>()
    for (const entry of model.entries) {
      const mesh = new THREE.Mesh(sphereGeometry, layerMaterials[entry.node.layer])
      mesh.position.set(entry.position[0], entry.position[1], entry.position[2])
      mesh.scale.setScalar(entry.radius)
      mesh.userData.nodeId = entry.node.id
      mesh.userData.baseScale = entry.radius
      mesh.userData.baseMaterial = layerMaterials[entry.node.layer]
      layerGroups[entry.node.layer].add(mesh)
      meshById.set(entry.node.id, mesh)
    }

    // 边按层对分桶：关层时整桶隐藏（visible 属性），顶点色取两端层色形成渐变。
    const edgeBuckets = new Map<
      string,
      { layers: [TopologyLayer, TopologyLayer]; positions: number[]; colors: number[] }
    >()
    for (const edge of model.edges) {
      const sourceEntry = meshById.get(edge.source)
      const targetEntry = meshById.get(edge.target)
      const sourceNode = nodeById.get(edge.source)
      const targetNode = nodeById.get(edge.target)
      if (!sourceEntry || !targetEntry || !sourceNode || !targetNode) continue
      const bucketKey = [sourceNode.layer, targetNode.layer].sort().join('|')
      let bucket = edgeBuckets.get(bucketKey)
      if (!bucket) {
        bucket = {
          layers: [sourceNode.layer, targetNode.layer],
          positions: [],
          colors: [],
        }
        edgeBuckets.set(bucketKey, bucket)
      }
      bucket.positions.push(
        sourceEntry.position.x,
        sourceEntry.position.y,
        sourceEntry.position.z,
        targetEntry.position.x,
        targetEntry.position.y,
        targetEntry.position.z,
      )
      const sourceRgb = layerRgb[sourceNode.layer]
      const targetRgb = layerRgb[targetNode.layer]
      bucket.colors.push(
        sourceRgb[0],
        sourceRgb[1],
        sourceRgb[2],
        targetRgb[0],
        targetRgb[1],
        targetRgb[2],
      )
    }

    const edgeGroups: SceneHandles['edgeGroups'] = []
    for (const bucket of edgeBuckets.values()) {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(bucket.positions, 3))
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(bucket.colors, 3))
      const material = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
      })
      const lines = new THREE.LineSegments(geometry, material)
      lines.visible = layerEnabled[bucket.layers[0]] && layerEnabled[bucket.layers[1]]
      scene.add(lines)
      edgeGroups.push({ layers: bucket.layers, object: lines })
      disposables.push(geometry, material)
    }

    sceneRef.current = { layerGroups, edgeGroups, meshById }

    // ===== 点选 / hover =====
    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    let downAt: { x: number; y: number } | null = null

    const pick = (event: { clientX: number; clientY: number }): THREE.Mesh | null => {
      const rect = renderer.domElement.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return null
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -(((event.clientY - rect.top) / rect.height) * 2 - 1),
      )
      raycaster.setFromCamera(pointer, camera)
      const candidates: THREE.Mesh[] = []
      for (const mesh of meshById.values()) {
        if (mesh.parent?.visible !== false) candidates.push(mesh)
      }
      const hits = raycaster.intersectObjects(candidates, false)
      return hits.length > 0 ? (hits[0]!.object as THREE.Mesh) : null
    }

    const moveTooltip = (event: { clientX: number; clientY: number }): void => {
      const tooltip = tooltipRef.current
      if (!tooltip) return
      const rect = container.getBoundingClientRect()
      const x = Math.min(Math.max(8, event.clientX - rect.left + 12), Math.max(8, rect.width - 132))
      const y = Math.min(Math.max(8, event.clientY - rect.top + 12), Math.max(8, rect.height - 28))
      tooltip.style.left = `${x}px`
      tooltip.style.top = `${y}px`
    }

    const onPointerMove = (event: PointerEvent): void => {
      const mesh = pick(event)
      const nextId = mesh ? String(mesh.userData.nodeId ?? '') : null
      if (nextId !== hoverIdRef.current) {
        hoverIdRef.current = nextId
        setHoverId(nextId)
      }
      if (mesh) moveTooltip(event)
    }

    const onPointerLeave = (): void => {
      hoverIdRef.current = null
      setHoverId(null)
    }

    const onPointerDown = (event: PointerEvent): void => {
      downAt = { x: event.clientX, y: event.clientY }
    }

    const onClick = (event: MouseEvent): void => {
      // 拖拽轨道结束的 click 不做选中。
      if (downAt && Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > 4) return
      const mesh = pick(event)
      const nodeId = mesh ? String(mesh.userData.nodeId ?? '') : null
      const node = nodeId ? (nodeById.get(nodeId) ?? null) : null
      selectedIdRef.current = node ? node.id : null
      setSelectedId(selectedIdRef.current)
      onSelectNodeRef.current?.(node)
    }

    renderer.domElement.addEventListener('pointermove', onPointerMove)
    renderer.domElement.addEventListener('pointerleave', onPointerLeave)
    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    renderer.domElement.addEventListener('click', onClick)

    const resizeObserver = new ResizeObserver(() => {
      const nextWidth = Math.max(1, container.clientWidth)
      const nextHeight = Math.max(1, container.clientHeight)
      renderer.setSize(nextWidth, nextHeight)
      camera.aspect = nextWidth / nextHeight
      camera.updateProjectionMatrix()
    })
    resizeObserver.observe(container)

    const clock = new THREE.Clock()
    let frame = 0
    const render = (): void => {
      frame = requestAnimationFrame(render)
      controls.update()
      const pulse = 1 + 0.12 * Math.sin(clock.getElapsedTime() * 4)
      for (const [nodeId, mesh] of meshById) {
        const base = typeof mesh.userData.baseScale === 'number' ? mesh.userData.baseScale : 1
        const isSelected = nodeId === selectedIdRef.current
        const target = isSelected
          ? base * pulse
          : nodeId === hoverIdRef.current
            ? base * 1.18
            : base
        mesh.scale.setScalar(THREE.MathUtils.lerp(mesh.scale.x, target, 0.3))
        const wanted = isSelected
          ? highlightMaterial
          : (mesh.userData.baseMaterial as THREE.Material)
        if (mesh.material !== wanted) mesh.material = wanted
      }
      renderer.render(scene, camera)
    }
    frame = requestAnimationFrame(render)

    return () => {
      cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      renderer.domElement.removeEventListener('pointermove', onPointerMove)
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave)
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('click', onClick)
      controls.dispose()
      for (const item of disposables) {
        try {
          item.dispose()
        } catch {
          // 可能已释放。
        }
      }
      renderer.dispose()
      renderer.forceContextLoss()
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement)
      }
      sceneRef.current = null
    }
    // 仅数据变化重建场景；图层切片通过 visible 属性就地切换（见 toggleLayer）。
  }, [model])

  // ===== 图层切片（visible 属性） =====
  const toggleLayer = (layer: TopologyLayer): void => {
    const next = { ...layerEnabled, [layer]: !layerEnabled[layer] }
    setLayerEnabled(next)
    const handles = sceneRef.current
    if (handles) {
      for (const item of LAYER_ORDER) {
        handles.layerGroups[item].visible = next[item]
      }
      for (const bucket of handles.edgeGroups) {
        bucket.object.visible = next[bucket.layers[0]] && next[bucket.layers[1]]
      }
    }
    // 被关闭层上的选中 / hover 同步取消。
    const selectedNode = selectedIdRef.current ? nodeById.get(selectedIdRef.current) : undefined
    if (selectedNode && !next[selectedNode.layer]) {
      selectedIdRef.current = null
      setSelectedId(null)
      onSelectNodeRef.current?.(null)
    }
    const hoverNode = hoverIdRef.current ? nodeById.get(hoverIdRef.current) : undefined
    if (hoverNode && !next[hoverNode.layer]) {
      hoverIdRef.current = null
      setHoverId(null)
    }
  }

  // hover 浮层显示 / 隐藏（位置随光标在 pointermove 中更新）。
  React.useEffect(() => {
    if (tooltipRef.current) tooltipRef.current.style.display = hoverId ? 'block' : 'none'
  }, [hoverId])

  const selectedNode = selectedId ? (nodeById.get(selectedId) ?? null) : null
  const hoverNode = hoverId ? (nodeById.get(hoverId) ?? null) : null
  const detailRows = selectedNode
    ? Object.entries(selectedNode.details ?? {}).slice(0, 8)
    : []

  return (
    <div className="overflow-hidden rounded-xl border border-cslab-border bg-cslab-bg">
      <div className="flex items-center gap-1.5 border-b border-cslab-border px-2.5 py-1.5">
        <Layers size={10} className="shrink-0 text-cslab-muted" />
        <span className="text-[10px] text-cslab-muted">图层切片</span>
        <div className="ml-auto flex items-center gap-1">
          {LAYER_ORDER.map((layer) => (
            <button
              key={layer}
              type="button"
              title={LAYER_TITLES[layer]}
              onClick={() => toggleLayer(layer)}
              className={cn(
                'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] transition-colors',
                layerEnabled[layer]
                  ? 'border-cslab-accent/40 bg-cslab-accent/10 text-cslab-accent'
                  : 'border-cslab-border text-cslab-muted opacity-60 hover:bg-cslab-surface hover:text-cslab-text',
              )}
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: `hsl(${LAYER_HUES[layer]} 62% 58%)` }}
              />
              {layer.charAt(0).toUpperCase() + layer.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="relative w-full" style={{ height }}>
        <div ref={mountRef} className="absolute inset-0" />
        {model.entries.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-[10px] text-cslab-muted">暂无拓扑数据</p>
          </div>
        )}
        {/* hover 小标签：零依赖 HTML 浮层 */}
        <div
          ref={tooltipRef}
          style={{ display: 'none' }}
          className="pointer-events-none absolute z-10 max-w-[60%] truncate rounded-md border border-cslab-border bg-cslab-elevated/95 px-1.5 py-0.5 text-[9px] text-cslab-text shadow-subtle"
        >
          {hoverNode ? hoverNode.label : ''}
        </div>
        {selectedNode && (
          <div className="pointer-events-none absolute bottom-2 left-2 right-2 rounded-md border border-cslab-border bg-cslab-elevated/95 px-2 py-1.5 text-[10px] text-cslab-muted shadow-subtle">
            <p className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 flex-1 truncate text-[11px] text-cslab-text">
                {selectedNode.label}
              </span>
              <span className="shrink-0 text-[9px]">
                {LAYER_LABELS[selectedNode.layer]} · {TYPE_LABELS[selectedNode.type]}
              </span>
            </p>
            {detailRows.length > 0 && (
              <div className="mt-1 space-y-0.5">
                {detailRows.map(([key, value]) => (
                  <p key={key} className="flex items-baseline justify-between gap-2">
                    <span className="shrink-0 text-cslab-muted/80">{key}</span>
                    <span className="min-w-0 truncate text-cslab-text">
                      {formatDetailValue(value)}
                    </span>
                  </p>
                ))}
              </div>
            )}
            <p className="mt-1 text-[9px] text-cslab-muted/80">
              关联 {model.degree.get(selectedNode.id) ?? 0} 条 · {selectedNode.id}
            </p>
          </div>
        )}
      </div>

      <p className="border-t border-cslab-border px-2.5 py-1.5 text-[9px] leading-relaxed text-cslab-muted">
        分层空间拓扑：宏观（论文/作者/期刊/领域）在上、微观（指标/图表）在下；拖拽旋转、滚轮缩放，点击节点查看详情，点空白处取消选中。
      </p>
    </div>
  )
}
