/**
 * CsLabCanvasEditor — Canvas 物理分页编辑器宿主
 *
 * 唯一允许 import Canvas 引擎运行时的模块；其余适配代码全部是纯函数。
 */

import * as React from 'react'
import Editor, { EditorMode, ElementType, PageMode } from '@hufe921/canvas-editor'
import type {
  IEditorData,
  IElement,
  IRangeStyle,
  IRegisterContextMenu,
  ListType,
  TitleLevel,
} from '@hufe921/canvas-editor'
import commentPlugin from '@hufe921/canvas-editor-plugin-comment'
import type { IComment } from '@hufe921/canvas-editor-plugin-comment'
import type {
  CsLabCanvasData,
  CsLabCapsule,
  CsLabManuscriptComment,
} from '@profer/shared'
import { buildCapsuleAttrs, CSLAB_CELL_MIME, hasDragType, readCellRef } from '../cslab-dnd'
import {
  capsuleConceptId,
  capsuleControlPatch,
  capsuleDisplayText,
  capsuleExtensionOf,
  buildCanvasCapsuleControl,
  type CsLabCapsuleControlPatch,
  type CsLabCapsuleExtension,
} from './cslab-canvas-capsule'
import {
  canvasToTipTapDoc,
  extractCanvasCapsules,
  extractCanvasText,
} from './cslab-canvas-adapter'
import {
  applyReviewComments,
  clearAllComments,
  CSLAB_COMMENT_AUTHOR,
  CSLAB_COMMENT_HIGHLIGHT,
} from './cslab-canvas-comments'
import { CsCanvasZone } from './cslab-canvas-enums'
import type {
  CsLabCanvasHandle,
  CsLabCanvasMetrics,
  CsLabCapsuleAttrs,
  CsLabRangeStyle,
  CsLabReviewCommentInput,
} from './cslab-canvas-types'
import './cslab-canvas.css'

interface CsLabCanvasEditorProps {
  labId: string
  canvasData: CsLabCanvasData
  initialComments: CsLabManuscriptComment[]
  staleCapsuleIds: Set<string>
  zoom: number
  showRuler: boolean
  onReady: (handle: CsLabCanvasHandle | null) => void
  onDirtyChange: (dirty: boolean) => void
  onRangeStyleChange: (style: CsLabRangeStyle) => void
  onPageChange: (currentPage: number, totalPages: number) => void
  onZoomChange?: (percent: number) => void
  onCapsuleClick: (capsuleId: string) => void
  onMetricsChange: (metrics: CsLabCanvasMetrics) => void
  onToast?: (kind: 'info' | 'success' | 'error', text: string) => void
  /** 划词右键「检索关联学术文献」：携带选中文本反向打开学术检索弹窗。 */
  onSearchLiterature?: (query: string) => void
}

function createPageOptions(hostId: string) {
  return {
    width: 794,
    height: 1123,
    pageMode: PageMode.PAGING,
    pageGap: 20,
    margins: [96, 96, 96, 96] as [number, number, number, number],
    scale: 1,
    header: { top: 30, editable: true },
    footer: { bottom: 30, editable: true },
    pageNumber: { disabled: true },
    ruler: { disabled: false },
    control: { borderColor: '#3B82F6', borderWidth: 1 },
    defaultSize: 16,
    historyMaxRecordCount: 100,
    // 每个窗格独立的滚动容器，避免多实例下 document.querySelector 命中首个编辑器。
    scrollContainerSelector: `#${hostId}`,
  }
}

function normalizeRangeStyle(payload: IRangeStyle): CsLabRangeStyle {
  const level =
    payload.level === 'first' ||
    payload.level === 'second' ||
    payload.level === 'third' ||
    payload.level === 'fourth' ||
    payload.level === 'fifth' ||
    payload.level === 'sixth'
      ? payload.level
      : null
  return {
    bold: !!payload.bold,
    italic: !!payload.italic,
    underline: !!payload.underline,
    strikeout: !!payload.strikeout,
    level: level as CsLabRangeStyle['level'],
    listType: payload.listType === 'ul' || payload.listType === 'ol' ? payload.listType : null,
    undo: !!payload.undo,
    redo: !!payload.redo,
  }
}

export function CsLabCanvasEditor({
  labId,
  canvasData,
  initialComments,
  staleCapsuleIds,
  zoom,
  showRuler,
  onReady,
  onDirtyChange,
  onRangeStyleChange,
  onPageChange,
  onZoomChange,
  onCapsuleClick,
  onMetricsChange,
  onToast,
  onSearchLiterature,
}: CsLabCanvasEditorProps): React.ReactElement {
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const hostId = React.useMemo(
    () => `cslab-canvas-${Math.random().toString(36).slice(2, 10)}`,
    [],
  )
  const editorRef = React.useRef<Editor | null>(null)
  const handleRef = React.useRef<CsLabCanvasHandle | null>(null)
  const zoneRef = React.useRef<string>(CsCanvasZone.MAIN)
  const initializingRef = React.useRef(true)
  const pageRef = React.useRef({ current: 1, total: 1 })
  const metricsTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const [handTool, setHandTool] = React.useState(false)
  const handToolRef = React.useRef(false)
  const propsRef = React.useRef({
    labId,
    staleCapsuleIds,
    onDirtyChange,
    onRangeStyleChange,
    onPageChange,
    onZoomChange,
    onCapsuleClick,
    onMetricsChange,
    onToast,
    onSearchLiterature,
  })
  propsRef.current = {
    labId,
    staleCapsuleIds,
    onDirtyChange,
    onRangeStyleChange,
    onPageChange,
    onZoomChange,
    onCapsuleClick,
    onMetricsChange,
    onToast,
    onSearchLiterature,
  }

  const computeMetrics = React.useCallback((editor: Editor): void => {
    const result = editor.command.getValue()
    const main = (result.data.main ?? []) as IElement[]
    const chars = extractCanvasText({ main }).length
    const capsules = extractCanvasCapsules({ main }, propsRef.current.labId).length
    const comments = editor.command.executeGetCommentList().length
    const apply = (words: number): void => {
      propsRef.current.onMetricsChange({
        words,
        chars,
        capsules,
        comments,
      })
    }
    void editor.command
      .getWordCount()
      .then((words) => apply(Number.isFinite(words) ? words : Math.ceil(chars / 2)))
      .catch(() => apply(Math.ceil(chars / 2)))
  }, [])

  const scheduleMetrics = React.useCallback(
    (editor: Editor): void => {
      if (metricsTimer.current) clearTimeout(metricsTimer.current)
      metricsTimer.current = setTimeout(() => computeMetrics(editor), 250)
    },
    [computeMetrics],
  )

  const notifyPage = React.useCallback((): void => {
    propsRef.current.onPageChange(pageRef.current.current, pageRef.current.total)
  }, [])

  React.useEffect(() => {
    const host = hostRef.current
    if (!host) return

    host.innerHTML = ''
    zoneRef.current = CsCanvasZone.MAIN
    pageRef.current = { current: 1, total: 1 }

    const data: IEditorData = {
      main: (Array.isArray(canvasData.main) ? canvasData.main : []) as IElement[],
      ...(Array.isArray(canvasData.header) && canvasData.header.length > 0
        ? { header: canvasData.header as IElement[] }
        : {}),
      ...(Array.isArray(canvasData.footer) && canvasData.footer.length > 0
        ? { footer: canvasData.footer as IElement[] }
        : {}),
    }

    const editor = new Editor(host, data, createPageOptions(hostId))
    editorRef.current = editor

    editor.use(commentPlugin, {
      user: CSLAB_COMMENT_AUTHOR,
      railWidth: 240,
      userColor: '#1E40AF',
      lineColor: '#3B82F6',
      highlightColor: CSLAB_COMMENT_HIGHLIGHT,
      locale: 'zhCN',
    })

    const savedComments: IComment[] = initialComments.map((comment) => ({
      id: comment.id,
      content: comment.content,
      createdAt: comment.createdAt,
      user: comment.user ?? CSLAB_COMMENT_AUTHOR,
    }))

    const handle: CsLabCanvasHandle = {
      getSnapshot() {
        const result = editor.command.getValue()
        const main = (result.data.main ?? []) as IElement[]
        const nextCanvasData: CsLabCanvasData = {
          main,
          ...(Array.isArray(result.data.header) ? { header: result.data.header as IElement[] } : {}),
          ...(Array.isArray(result.data.footer) ? { footer: result.data.footer as IElement[] } : {}),
        }
        const comments = editor.command.executeGetCommentList().map((comment) => ({
          id: comment.id,
          content: comment.content,
          createdAt: comment.createdAt,
          user: comment.user,
        }))
        return {
          canvasData: nextCanvasData,
          docJson: canvasToTipTapDoc(nextCanvasData, comments),
          capsules: extractCanvasCapsules(nextCanvasData, propsRef.current.labId),
          comments,
        }
      },
      getWordCount: () => editor.command.getWordCount(),
      getCharCount: () => {
        const main = (editor.command.getValue().data.main ?? []) as IElement[]
        return extractCanvasText({ main }).length
      },
      bold: () => editor.command.executeBold(),
      italic: () => editor.command.executeItalic(),
      underline: () => editor.command.executeUnderline(),
      strikeout: () => editor.command.executeStrikeout(),
      title: (level) => editor.command.executeTitle(level as unknown as TitleLevel | null),
      list: (type) => editor.command.executeList(type as unknown as ListType),
      separator: () => editor.command.executeSeparator([]),
      pageBreak: () => editor.command.executePageBreak(),
      undo: () => editor.command.executeUndo(),
      redo: () => editor.command.executeRedo(),
      setPageScale: (scale) => editor.command.executePageScale(scale),
      toggleRuler: (show) => editor.command.executeToggleRuler(show),
      updateCapsule(capsule: CsLabCapsule) {
        const attrs: CsLabCapsuleAttrs = {
          capsuleId: capsule.id,
          label: capsule.label,
          value: capsule.value,
          unit: capsule.unit ?? '',
          tableUri: capsule.tableUri,
          column: capsule.column,
          rowIndex: capsule.rowIndex,
          revisionAtBind: capsule.revisionAtBind,
          status: 'fresh',
        }
        editor.command.executeSetControlValueList([
          {
            conceptId: capsuleConceptId(capsule.id),
            value: capsuleDisplayText(attrs),
            isOverwrite: true,
            isSubmitHistory: false,
          },
        ])
        editor.command.executeSetControlPropertiesList([capsuleControlPatch(attrs, false)])
      },
      markCapsulesStale(ids: Set<string>) {
        const controls = editor.command.getControlList()
        const patches: CsLabCapsuleControlPatch[] = []
        for (const control of controls) {
          const extension = control.extension as CsLabCapsuleExtension | undefined
          if (!extension || extension.kind !== 'cslab-capsule') continue
          if (!ids.has(extension.capsuleId)) continue
          const attrs: CsLabCapsuleAttrs = {
            capsuleId: extension.capsuleId,
            label: extension.label,
            value: extension.value,
            unit: extension.unit,
            tableUri: extension.tableUri,
            column: extension.column,
            rowIndex: extension.rowIndex,
            revisionAtBind: extension.revisionAtBind,
            status: 'stale',
          }
          patches.push(capsuleControlPatch(attrs, true))
        }
        if (patches.length > 0) editor.command.executeSetControlPropertiesList(patches)
      },
      appendCapsule(attrs: CsLabCapsuleAttrs) {
        const main = (editor.command.getValue().data.main ?? []) as IElement[]
        const endIndex = Math.max(0, main.length - 1)
        editor.command.executeSetRange(endIndex, endIndex)
        editor.command.executeInsertElementList([{ value: '\n' }], {
          isSubmitHistory: true,
        })
        editor.command.executeInsertControl(buildCanvasCapsuleControl(attrs))
        editor.command.executeInsertElementList([{ value: ' ' }])
        editor.command.executeFocus()
      },
      applyReview(items: CsLabReviewCommentInput[]) {
        return applyReviewComments(editor, items)
      },
      getCommentCount: () => editor.command.executeGetCommentList().length,
      clearComments: () => {
        clearAllComments(editor)
      },
      focus: () => editor.command.executeFocus(),
      insertText(text: string) {
        if (!text) return
        try {
          editor.command.executeInsertElementList([{ value: text }], { isSubmitHistory: true })
          editor.command.executeFocus()
        } catch {
          propsRef.current.onToast?.('error', '插入失败，请先把光标定位到正文')
        }
      },
      getSelectedText: () => {
        try {
          return editor.command.getRangeText()
        } catch {
          return ''
        }
      },
      insertImage(payload: { value: string; width: number; height: number }) {
        if (!payload.value) return
        try {
          editor.command.executeInsertElementList(
            [
              {
                type: ElementType.IMAGE,
                value: payload.value,
                width: payload.width,
                height: payload.height,
              },
            ],
            { isSubmitHistory: true },
          )
          editor.command.executeFocus()
        } catch {
          propsRef.current.onToast?.('error', '图片插入失败，请先把光标定位到正文')
        }
      },
      insertLatex(latex: string) {
        const value = latex.trim()
        if (!value) return
        try {
          // 元素规范化阶段引擎会按 value 调内置 LaTeX→SVG 渲染器，回填 laTexSVG/width/height。
          editor.command.executeInsertElementList([{ type: ElementType.LATEX, value }], {
            isSubmitHistory: true,
          })
          editor.command.executeFocus()
        } catch {
          propsRef.current.onToast?.('error', '公式插入失败，请先把光标定位到正文')
        }
      },
      setHandTool: (enabled: boolean) => setHandTool(enabled),
    }

    handleRef.current = handle
    onReady(handle)

    // 划词右键「检索关联学术文献」：携带选中文本反向打开学术检索弹窗。
    const academicSearchMenu: IRegisterContextMenu = {
      key: 'cslab-academic-search',
      name: '检索关联学术文献',
      when: (context) => context.editorHasSelection && !context.isReadonly,
      callback: (command) => {
        const text = command.getRangeText().replace(/\s+/g, ' ').trim()
        if (!text) return
        propsRef.current.onSearchLiterature?.(text.slice(0, 120))
      },
    }
    editor.register.contextMenuList([academicSearchMenu])

    // 等首屏分页计算完成后再恢复批注与陈旧态，避免控件/分组尚未初始化。
    const restoreTimer = setTimeout(() => {
      if (savedComments.length > 0) {
        editor.command.executeSetCommentList(savedComments)
      }
      handle.markCapsulesStale(propsRef.current.staleCapsuleIds)
      // 初始化期间的程序化变更不应把刚打开的文稿标记为“未保存”。
      initializingRef.current = false
    }, 60)

    const onContentChange = (): void => {
      if (!initializingRef.current) propsRef.current.onDirtyChange(true)
      scheduleMetrics(editor)
    }
    const onRangeStyle = (payload: IRangeStyle): void => {
      propsRef.current.onRangeStyleChange(normalizeRangeStyle(payload))
    }
    const onPageSize = (total: number): void => {
      pageRef.current.total = Math.max(1, Number(total) || 1)
      if (pageRef.current.current > pageRef.current.total) {
        pageRef.current.current = pageRef.current.total
      }
      notifyPage()
    }
    const onIntersectionPageNo = (pageNo: number): void => {
      const next = Math.max(1, Math.min(pageRef.current.total, Number(pageNo) + 1))
      pageRef.current.current = next
      notifyPage()
    }
    const onZoneChange = (zone: string): void => {
      zoneRef.current = zone
    }
    const onPageScale = (scale: number): void => {
      propsRef.current.onZoomChange?.(Math.round(Number(scale) * 100))
    }

    editor.eventBus.on('contentChange', onContentChange)
    editor.eventBus.on('rangeStyleChange', onRangeStyle)
    editor.eventBus.on('pageSizeChange', onPageSize)
    editor.eventBus.on('intersectionPageNoChange', onIntersectionPageNo)
    editor.eventBus.on('zoneChange', onZoneChange)
    editor.eventBus.on('pageScaleChange', onPageScale)

    const onMouseDown = (event: MouseEvent): void => {
      // 抓手平移态：命中检测交由平移手势处理，避免误触胶囊联动。
      if (handToolRef.current) return
      try {
        const context = editor.command.getPositionContextByEvent(event, {
          isMustDirectHit: false,
        })
        let extension = capsuleExtensionOf(context?.element)
        if (!extension) {
          const controlId = (context?.element as IElement | null | undefined)?.controlId
          if (controlId) {
            const main = (editor.command.getValue().data.main ?? []) as IElement[]
            extension = capsuleExtensionOf(
              main.find((element) => element.controlId === controlId),
            )
          }
        }
        if (extension) propsRef.current.onCapsuleClick(extension.capsuleId)
      } catch {
        // 命中失败不影响编辑。
      }
    }

    const onDragOver = (event: DragEvent): void => {
      if (!hasDragType(event.dataTransfer, CSLAB_CELL_MIME)) return
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }

    const onDrop = (event: DragEvent): void => {
      if (!hasDragType(event.dataTransfer, CSLAB_CELL_MIME)) return
      event.preventDefault()
      event.stopPropagation()
      const cellRef = readCellRef(event.dataTransfer)
      if (!cellRef) return
      if (zoneRef.current !== CsCanvasZone.MAIN) {
        propsRef.current.onToast?.('info', '活体数据胶囊仅支持插入正文')
        return
      }
      const target = event.target as HTMLElement | null
      if (target?.dataset?.index != null) {
        const init: MouseEventInit = {
          clientX: event.clientX,
          clientY: event.clientY,
          bubbles: true,
          cancelable: true,
          view: window,
        }
        target.dispatchEvent(new MouseEvent('mousedown', init))
        target.dispatchEvent(new MouseEvent('mouseup', init))
      }
      try {
        editor.command.executeInsertControl(
          buildCanvasCapsuleControl(buildCapsuleAttrs(cellRef)),
        )
        editor.command.executeInsertElementList([{ value: ' ' }])
      } catch {
        propsRef.current.onToast?.('error', '胶囊插入失败，请把光标放在正文后重试')
      }
    }

    host.addEventListener('mousedown', onMouseDown, true)
    host.addEventListener('dragover', onDragOver, true)
    host.addEventListener('drop', onDrop, true)

    scheduleMetrics(editor)
    notifyPage()

    return () => {
      onReady(null)
      clearTimeout(restoreTimer)
      handleRef.current = null
      editorRef.current = null
      if (metricsTimer.current) {
        clearTimeout(metricsTimer.current)
        metricsTimer.current = null
      }
      host.removeEventListener('mousedown', onMouseDown, true)
      host.removeEventListener('dragover', onDragOver, true)
      host.removeEventListener('drop', onDrop, true)
      editor.eventBus.off('contentChange', onContentChange)
      editor.eventBus.off('rangeStyleChange', onRangeStyle)
      editor.eventBus.off('pageSizeChange', onPageSize)
      editor.eventBus.off('intersectionPageNoChange', onIntersectionPageNo)
      editor.eventBus.off('zoneChange', onZoneChange)
      editor.eventBus.off('pageScaleChange', onPageScale)
      editor.destroy()
      host.innerHTML = ''
    }
    // 编辑器实例只在文稿切换时重建；其余 props 通过 effect 同步。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  React.useEffect(() => {
    handleRef.current?.markCapsulesStale(staleCapsuleIds)
  }, [staleCapsuleIds])

  React.useEffect(() => {
    const scale = Math.max(0.5, Math.min(2, zoom / 100))
    handleRef.current?.setPageScale(scale)
  }, [zoom])

  React.useEffect(() => {
    handleRef.current?.toggleRuler(showRuler)
  }, [showRuler])

  // 抓手平移：拖拽滚动画布视口（host 即 scrollContainer）；期间切只读防止误编辑/误选区。
  React.useEffect(() => {
    handToolRef.current = handTool
    const host = hostRef.current
    if (!host) return
    const applyMode = (mode: EditorMode): void => {
      try {
        editorRef.current?.command.executeMode(mode)
      } catch {
        // 编辑器已销毁时忽略。
      }
    }
    if (!handTool) {
      host.style.removeProperty('cursor')
      applyMode(EditorMode.EDIT)
      return
    }
    applyMode(EditorMode.READONLY)
    host.style.cursor = 'grab'
    let panning: { x: number; y: number; scrollLeft: number; scrollTop: number } | null = null
    const onMouseDown = (event: MouseEvent): void => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      panning = {
        x: event.clientX,
        y: event.clientY,
        scrollLeft: host.scrollLeft,
        scrollTop: host.scrollTop,
      }
      host.style.cursor = 'grabbing'
    }
    const onMouseMove = (event: MouseEvent): void => {
      if (!panning) return
      event.preventDefault()
      host.scrollLeft = panning.scrollLeft - (event.clientX - panning.x)
      host.scrollTop = panning.scrollTop - (event.clientY - panning.y)
    }
    const onMouseUp = (): void => {
      if (!panning) return
      panning = null
      host.style.cursor = 'grab'
    }
    host.addEventListener('mousedown', onMouseDown, true)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      host.removeEventListener('mousedown', onMouseDown, true)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      host.style.removeProperty('cursor')
      applyMode(EditorMode.EDIT)
      handToolRef.current = false
    }
  }, [handTool])

  return <div ref={hostRef} id={hostId} className="cslab-canvas-host relative h-full w-full" />
}
