/**
 * StudySourceTrace — AI 速课堂「原文依据」学术溯源胶囊
 *
 * 将模型输出的溯源锚点（形如 `[第3页·核心定理](#f1:p3)` 的 Markdown 链接，或裸锚点 `#f1:p3`）
 * 渲染为可点击胶囊：点击后反查资料树目标文档的页码与坐标，驱动右栏高保真预览定位高亮，
 * 复用对话流「学术溯源胶囊」同一套解析链路（resolveDocumentAnchor + documentHighlightTargetAtom）。
 *
 * 未包含可解析锚点时（历史数据）降级为纯文本，保持原文可见，绝不丢失信息。
 */

import * as React from 'react'
import { useSetAtom } from 'jotai'
import { ImageIcon, MapPin, Sigma, Table2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useOpenPreview } from '@/components/diff/preview-opener'
import { documentHighlightTargetAtom } from '@/atoms/preview-atoms'

/** 与对话流一致的拓扑锚点形态：`#f1:p3-b2` / `#f1:p3` / `#p3-b2` */
const ANCHOR_IN_TEXT_RE = /#((?:[a-zA-Z]+\d+)[:\-])?p\d+(?:-(?:b\d+|tbl\d+|r\d+|c[a-zA-Z]+\d+(?::[a-zA-Z]+\d+)?))?/i

interface ParsedTrace {
  /** 锚点串（含前导 `#`） */
  anchor: string
  /** 面向用户展示的可读位置标签 */
  label: string
}

/** 从溯源文本中解析 Markdown 链接锚点或裸锚点 */
function parseTrace(raw: string): ParsedTrace | null {
  const text = raw.trim()
  if (!text) return null
  const link = /\[([^\]]*)\]\(\s*(#[^)\s]+)\s*\)/.exec(text)
  if (link) {
    const anchor = link[2]!
    const label = (link[1] ?? '').trim() || anchor
    return { anchor, label }
  }
  const bare = ANCHOR_IN_TEXT_RE.exec(text)
  if (bare) {
    const anchor = bare[0]
    const label = text.replace(anchor, '').replace(/[·，,：:、\s]+$/g, '').trim() || anchor
    return { anchor, label }
  }
  return null
}

/** 依据位置标签推断图标（公式 / 表格 / 插图 / 通用定位） */
function pickIcon(label: string): typeof MapPin {
  if (label.includes('公式')) return Sigma
  if (label.includes('表')) return Table2
  if (label.includes('图')) return ImageIcon
  return MapPin
}

interface StudySourceTraceProps {
  sessionId: string
  /** 溯源文本（可能为 Markdown 链接锚点、裸锚点或纯文本） */
  trace?: string
  className?: string
}

export function StudySourceTrace({ sessionId, trace, className }: StudySourceTraceProps): React.ReactElement | null {
  const openPreview = useOpenPreview()
  const setHighlight = useSetAtom(documentHighlightTargetAtom)
  const [busy, setBusy] = React.useState(false)

  const parsed = React.useMemo(() => (trace ? parseTrace(trace) : null), [trace])

  const handleOpen = React.useCallback(async (): Promise<void> => {
    if (!parsed || busy) return
    setBusy(true)
    try {
      const resolved = await window.electronAPI.resolveDocumentAnchor(parsed.anchor, { sessionId, label: parsed.label })
      if (!resolved) return
      setHighlight({
        requestId: Date.now() + Math.floor(Math.random() * 1000),
        sessionId,
        fileId: resolved.fileId,
        filePath: resolved.filePath,
        format: resolved.format ?? 'pdf',
        pageNumber: resolved.pageNumber,
        blockId: resolved.blockId,
        bbox: resolved.bbox,
        cellRef: resolved.cellRef,
        label: resolved.label || parsed.label,
      })
      openPreview(sessionId, { filePath: resolved.filePath, previewOnly: true, readOnly: true })
    } catch (error) {
      console.warn('[速课堂溯源胶囊] 解析文档锚点失败:', error)
    } finally {
      setBusy(false)
    }
  }, [parsed, busy, sessionId, setHighlight, openPreview])

  if (!trace || !trace.trim()) return null
  if (!parsed) return <span className={className}>{trace}</span>

  const Icon = pickIcon(parsed.label)
  return (
    <button
      type="button"
      onClick={() => void handleOpen()}
      disabled={busy}
      title={`点击在右侧定位原文：${parsed.label}（${parsed.anchor}）`}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-[1.5px] align-baseline',
        'text-[10px] font-medium text-primary transition-colors',
        'bg-primary/12 hover:bg-primary/20 disabled:opacity-60',
        className,
      )}
    >
      <Icon className="size-3 shrink-0 opacity-85" />
      <span>{parsed.label}</span>
    </button>
  )
}
