/**
 * MindMapBlock — 对话流 ```mindmap 代码块专用渲染器
 *
 * 依据方案 §7.2「常规对话流模式（Chat Stream Mode）」契约：
 *   - **未展开前（对话气泡内）**：只读静态预览，**禁止拖拽、禁止点击交互**（整层 pointer-events:none）；
 *   - **点击「展开大图」按钮**：弹出全屏视窗，支持滚轮 / 按钮平移缩放、**鸟瞰小地图（Bird's-Eye View Minimap）**，
 *     展开视窗中**允许自由拖拽气泡调整布局，但禁止点击触发 Prompt 复制**（不传 onNodeClick）；
 *   - **状态留存与退出重置**：拖拽坐标暂存于内存级 Map（按代码块指纹键控），客户端退出后自动清空释放。
 *
 * 渲染与视口能力复用共享引擎（mindmap-canvas：径向弧线贝塞尔 + 双曲布局 + 全屏模态）。
 */

import * as React from 'react'
import { Maximize2 } from 'lucide-react'
import { parseMindMapText } from '@profer/shared'
import { MindMapCanvas, MindMapFullscreenModal, buildMindMapScene, type MindMapPt } from './mindmap-canvas'

const BUBBLE_VIEWPORT_HEIGHT = 260

/** 内存级坐标留存：按代码块指纹键控，客户端退出后随进程自动清空 */
const memoryPositions = new Map<string, Record<string, MindMapPt>>()

/** 轻量指纹：与页面 DOM 无关，仅用于标识同一段代码块 */
function codeFingerprint(code: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < code.length; i++) {
    hash ^= code.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

export function MindMapBlock({ code }: { code: string }): React.ReactElement | null {
  const root = React.useMemo(() => parseMindMapText(code), [code])
  const fingerprint = React.useMemo(() => codeFingerprint(code), [code])
  const [overrides, setOverrides] = React.useState<Record<string, MindMapPt>>(() => memoryPositions.get(codeFingerprint(code)) ?? {})
  const [open, setOpen] = React.useState(false)

  const scene = React.useMemo(() => (root ? buildMindMapScene(root, overrides) : null), [root, overrides])

  // 气泡只读预览：按容器宽度自适应缩放
  const previewRef = React.useRef<HTMLDivElement>(null)
  const [previewWidth, setPreviewWidth] = React.useState(0)
  React.useEffect(() => {
    const el = previewRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setPreviewWidth(el.clientWidth))
    observer.observe(el)
    setPreviewWidth(el.clientWidth)
    return () => observer.disconnect()
  }, [])
  const previewScale = scene && previewWidth > 0 ? Math.min(previewWidth / scene.width, BUBBLE_VIEWPORT_HEIGHT / scene.height) : 0

  const persist = React.useCallback(
    (next: Record<string, MindMapPt>) => {
      memoryPositions.set(fingerprint, next)
    },
    [fingerprint],
  )

  if (!root || !scene) return null

  return (
    <div className="my-2 overflow-hidden rounded-xl border border-border/60 bg-muted/20">
      {/* 头部：标题 + 展开按钮（气泡内只读，展开方进入可拖拽大图） */}
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-1.5">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-foreground">
          🗺️ 思维导图
          <span className="text-[10px] font-normal text-muted-foreground">（对话流只读预览）</span>
        </span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          <Maximize2 size={12} />
          展开大图
        </button>
      </div>

      {/* 只读静态预览：整层 pointer-events:none，禁止拖拽与点击交互 */}
      <div ref={previewRef} className="relative w-full overflow-hidden bg-content-area/60" style={{ height: BUBBLE_VIEWPORT_HEIGHT }}>
        <div
          className="pointer-events-none absolute left-1/2 top-1/2 origin-center"
          style={{ width: scene.width, height: scene.height, transform: `translate(-50%, -50%) scale(${previewScale || 0.2})` }}
        >
          <MindMapCanvas root={root} scene={scene} interactive={false} />
        </div>
      </div>

      {open && (
        <MindMapFullscreenModal
          root={root}
          scene={scene}
          sceneWidth={scene.width}
          sceneHeight={scene.height}
          overrides={overrides}
          onOverridesChange={setOverrides}
          onPersist={persist}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}
