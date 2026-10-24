/**
 * CsLabLiteraturePreviewPane — 社论式左右分栏的右侧即时预览窗格
 *
 * Tab 1 速览：外显出版信息 / 作者机构 / TL;DR / 摘要 / 方法关键词；
 * Tab 2 PDF：按需拉取合法 OA 直链并用 pdfjs 轻量分页渲染（未入库即可预览）；
 * Tab 3 结构：图表/公式/章节清单引导（入库后由文献智脑结构化解析生成）。
 *
 * Editorial Minimalism：羊皮纸底 + 细线切分 + 赤陶橙动作键，无厚阴影。
 */

import * as React from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { ChevronLeft, ChevronRight, ExternalLink, Loader2, Sparkles } from 'lucide-react'
import type { CsLabAcademicPaperMetadata } from '@profer/shared'
import { cn } from '@/lib/utils'
import { formatPaperAuthors, formatPaperCitation, type CsLabIngestState } from './CsLabLiteratureSearchCard'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc

type PreviewTab = 'overview' | 'pdf' | 'structure'

const TABS: Array<{ key: PreviewTab; label: string }> = [
  { key: 'overview', label: '速览' },
  { key: 'pdf', label: 'PDF' },
  { key: 'structure', label: '结构' },
]

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

interface PdfCanvasPreviewProps {
  dataUrl: string
}

function PdfCanvasPreview({ dataUrl }: PdfCanvasPreviewProps): React.ReactElement {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const [pageCount, setPageCount] = React.useState(0)
  const [pageIndex, setPageIndex] = React.useState(0)
  const [rendering, setRendering] = React.useState(false)

  const documentProxy = React.useRef<pdfjsLib.PDFDocumentProxy | null>(null)

  React.useEffect(() => {
    let cancelled = false
    setRendering(true)
    void (async () => {
      try {
        const doc = await pdfjsLib.getDocument({ data: dataUrlToBytes(dataUrl) }).promise
        if (cancelled) {
          void doc.destroy()
          return
        }
        documentProxy.current = doc
        setPageCount(doc.numPages)
        setPageIndex(0)
      } catch (error) {
        console.warn('[CSLab] PDF 预览渲染失败:', error)
      } finally {
        if (!cancelled) setRendering(false)
      }
    })()
    return () => {
      cancelled = true
      const doc = documentProxy.current
      documentProxy.current = null
      if (doc) void doc.destroy()
    }
  }, [dataUrl])

  React.useEffect(() => {
    const doc = documentProxy.current
    const canvas = canvasRef.current
    if (!doc || !canvas) return
    let cancelled = false
    setRendering(true)
    void (async () => {
      try {
        const page = await doc.getPage(pageIndex + 1)
        if (cancelled) return
        const viewport = page.getViewport({ scale: 1.35 })
        const context = canvas.getContext('2d')
        if (!context) return
        canvas.width = viewport.width
        canvas.height = viewport.height
        await page.render({ canvasContext: context, viewport }).promise
        page.cleanup()
      } catch (error) {
        console.warn('[CSLab] PDF 页面渲染失败:', error)
      } finally {
        if (!cancelled) setRendering(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [dataUrl, pageIndex, pageCount])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-cslab-border/70 px-3 py-1.5">
        <button
          type="button"
          disabled={pageIndex <= 0}
          onClick={() => setPageIndex((previous) => Math.max(0, previous - 1))}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] text-cslab-muted transition-colors hover:bg-cslab-elevated hover:text-cslab-text disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronLeft size={11} />
          上一页
        </button>
        <span className="text-[10px] text-cslab-muted">
          {pageCount > 0 ? `${pageIndex + 1} / ${pageCount}` : '…'}
        </span>
        <button
          type="button"
          disabled={pageIndex >= pageCount - 1}
          onClick={() => setPageIndex((previous) => Math.min(pageCount - 1, previous + 1))}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] text-cslab-muted transition-colors hover:bg-cslab-elevated hover:text-cslab-text disabled:cursor-not-allowed disabled:opacity-40"
        >
          下一页
          <ChevronRight size={11} />
        </button>
      </div>
      <div className="relative flex-1 overflow-auto bg-cslab-surface/60 p-3">
        {rendering && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 size={16} className="animate-spin text-cslab-muted" />
          </div>
        )}
        <canvas ref={canvasRef} className="mx-auto block h-auto max-w-full rounded-lg border border-cslab-border/60" />
      </div>
    </div>
  )
}

export interface CsLabLiteraturePreviewPaneProps {
  paper: CsLabAcademicPaperMetadata
  ingestState: CsLabIngestState
  ingestMessage?: string
  onIngest: () => void
  onCopyCitation: () => void
  /** 把格式化引用插入当前文稿光标处（未打开文稿时传 undefined）。 */
  onInsertCitation?: () => void
  /** 激活窗格是否已打开文稿。 */
  canInsertCitation?: boolean
  /** 已入库后投射至当前分屏画布（携带文献 URI）。 */
  onCastToPane?: (uri: string) => void
  ingestedUri?: string
}

export function CsLabLiteraturePreviewPane({
  paper,
  ingestState,
  ingestMessage,
  onIngest,
  onCopyCitation,
  onInsertCitation,
  canInsertCitation,
  onCastToPane,
  ingestedUri,
}: CsLabLiteraturePreviewPaneProps): React.ReactElement {
  const [tab, setTab] = React.useState<PreviewTab>('overview')
  const [pdfDataUrl, setPdfDataUrl] = React.useState<string | null>(null)
  const [pdfLoading, setPdfLoading] = React.useState(false)
  const [pdfError, setPdfError] = React.useState<string | null>(null)

  const fetchPdf = React.useCallback(async (): Promise<void> => {
    setPdfLoading(true)
    setPdfError(null)
    try {
      const result = await window.electronAPI.cslab.academicFetchPreview({
        doi: paper.doi,
        openAccessPdfUrl: paper.openAccessPdfUrl,
      })
      if (result.ok && result.pdfDataUrl) {
        setPdfDataUrl(result.pdfDataUrl)
      } else {
        setPdfError(result.message ?? 'PDF 预览不可用')
      }
    } catch (error) {
      setPdfError(error instanceof Error ? error.message : 'PDF 预览失败')
    } finally {
      setPdfLoading(false)
    }
  }, [paper.doi, paper.openAccessPdfUrl])

  React.useEffect(() => {
    setTab('overview')
    setPdfDataUrl(null)
    setPdfError(null)
  }, [paper.id])

  React.useEffect(() => {
    if (tab === 'pdf' && !pdfDataUrl && !pdfLoading && !pdfError) {
      void fetchPdf()
    }
  }, [tab, pdfDataUrl, pdfLoading, pdfError, fetchPdf])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 操作栏 */}
      <div className="flex items-center gap-2 border-b border-cslab-border/70 px-4 py-2">
        <button
          type="button"
          onClick={onIngest}
          disabled={
            ingestState === 'ingesting' ||
            ingestState === 'ingested' ||
            !(paper.isOpenAccess && (paper.openAccessPdfUrl || paper.doi))
          }
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] transition-colors',
            ingestState === 'ingested'
              ? 'text-cslab-accent'
              : paper.isOpenAccess && (paper.openAccessPdfUrl || paper.doi)
                ? 'bg-cslab-accent text-cslab-bg hover:bg-cslab-accentHover'
                : 'cursor-not-allowed border border-cslab-border text-cslab-muted',
          )}
        >
          {ingestState === 'ingesting' ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Sparkles size={12} />
          )}
          {ingestState === 'ingested' ? '已入库' : ingestState === 'ingesting' ? '入库中…' : '一键导入本实验室资产库'}
        </button>
        <button
          type="button"
          onClick={onCopyCitation}
          className="inline-flex items-center gap-1 rounded-lg border border-cslab-border px-2.5 py-1 text-[11px] text-cslab-muted transition-colors hover:bg-cslab-elevated hover:text-cslab-text"
        >
          复制引用
        </button>
        <button
          type="button"
          onClick={onInsertCitation}
          disabled={!canInsertCitation || !onInsertCitation}
          title={canInsertCitation ? '把格式化引用插入当前文稿光标处' : '请先在激活窗格中打开文稿'}
          className={cn(
            'inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] transition-colors',
            canInsertCitation && onInsertCitation
              ? 'border-cslab-accent/50 text-cslab-accent hover:bg-cslab-accent hover:text-cslab-bg'
              : 'cursor-not-allowed border-cslab-border text-cslab-muted',
          )}
        >
          插入当前文稿引用
        </button>
        {ingestedUri && onCastToPane && (
          <button
            type="button"
            onClick={() => onCastToPane(ingestedUri)}
            className="inline-flex items-center gap-1 rounded-lg border border-cslab-border px-2.5 py-1 text-[11px] text-cslab-muted transition-colors hover:bg-cslab-elevated hover:text-cslab-text"
          >
            投射至当前分屏画布
          </button>
        )}
        {paper.doi && (
          <a
            href={`https://doi.org/${paper.doi}`}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-[10px] text-cslab-accent/90 transition-colors hover:text-cslab-accentHover hover:underline"
          >
            DOI 跳转
            <ExternalLink size={10} />
          </a>
        )}
      </div>

      {ingestMessage && (
        <p className="border-b border-cslab-border/70 bg-cslab-surface/60 px-4 py-1 text-[10px] text-cslab-muted">
          {ingestMessage}
        </p>
      )}

      {/* Tab 栏 */}
      <div className="flex items-center gap-1 border-b border-cslab-border/70 px-4">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            className={cn(
              'border-b-2 px-2.5 py-1.5 text-[11px] transition-colors',
              tab === item.key
                ? 'border-cslab-accent text-cslab-accent'
                : 'border-transparent text-cslab-muted hover:text-cslab-text',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'overview' && (
          <div className="h-full space-y-3 overflow-y-auto px-4 py-3">
            <h2 className="font-serif text-base font-medium leading-relaxed text-cslab-text">
              {paper.title}
            </h2>
            <p className="text-xs leading-relaxed text-cslab-muted">{formatPaperAuthors(paper, 8)}</p>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl border border-cslab-border/70 bg-cslab-surface px-3 py-2.5">
              <div>
                <dt className="text-[9px] uppercase tracking-[0.14em] text-cslab-muted">年份</dt>
                <dd className="mt-0.5 text-xs text-cslab-text">{paper.year ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-[9px] uppercase tracking-[0.14em] text-cslab-muted">出版物</dt>
                <dd className="mt-0.5 text-xs text-cslab-text">{paper.publication ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-[9px] uppercase tracking-[0.14em] text-cslab-muted">DOI</dt>
                <dd className="mt-0.5 truncate text-xs text-cslab-text">{paper.doi ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-[9px] uppercase tracking-[0.14em] text-cslab-muted">被引</dt>
                <dd className="mt-0.5 text-xs text-cslab-text">{paper.citationsCount}</dd>
              </div>
            </dl>

            {paper.tldr && (
              <div className="rounded-xl border border-cslab-accent/40 bg-cslab-accent/5 px-3 py-2">
                <p className="text-[9px] uppercase tracking-[0.14em] text-cslab-accent">TL;DR · 核心贡献</p>
                <p className="mt-1 text-xs leading-relaxed text-cslab-text">{paper.tldr}</p>
              </div>
            )}

            {paper.abstract && (
              <div>
                <p className="text-[9px] uppercase tracking-[0.14em] text-cslab-muted">摘要</p>
                <p className="mt-1 text-xs leading-relaxed text-cslab-text/90">{paper.abstract}</p>
              </div>
            )}

            {paper.methodKeywords.length > 0 && (
              <div>
                <p className="text-[9px] uppercase tracking-[0.14em] text-cslab-muted">方法关键词</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {paper.methodKeywords.map((keyword) => (
                    <span
                      key={keyword}
                      className="rounded-md border border-cslab-border/70 bg-cslab-surface px-1.5 py-0.5 text-[10px] text-cslab-muted"
                    >
                      {keyword}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {paper.lineage.versionSources.length > 0 && (
              <div>
                <p className="text-[9px] uppercase tracking-[0.14em] text-cslab-muted">版本谱系</p>
                <p className="mt-1 text-xs leading-relaxed text-cslab-muted">
                  {paper.lineage.versionSources.join(' · ')}
                  {paper.lineage.publishedVersionDoi
                    ? ` · 正式发表版本 ${paper.lineage.publishedVersionDoi}`
                    : ''}
                </p>
              </div>
            )}
          </div>
        )}

        {tab === 'pdf' && (
          <div className="h-full">
            {pdfLoading && (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-cslab-muted">
                <Loader2 size={16} className="animate-spin" />
                <p className="text-xs">正在拉取合法 OA PDF…</p>
              </div>
            )}
            {!pdfLoading && pdfError && (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
                <p className="text-xs leading-relaxed text-cslab-muted">{pdfError}</p>
                {paper.doi && (
                  <a
                    href={`https://doi.org/${paper.doi}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] text-cslab-accent hover:underline"
                  >
                    前往出版方页面查看
                  </a>
                )}
              </div>
            )}
            {!pdfLoading && !pdfError && pdfDataUrl && <PdfCanvasPreview dataUrl={pdfDataUrl} />}
          </div>
        )}

        {tab === 'structure' && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
            <p className="text-xs leading-relaxed text-cslab-muted">
              {ingestedUri
                ? '已入库。章节脉络、关键图表与公式清单将由文献智脑在后台结构化解析后呈现于「文献智脑」面板。'
                : '一键入库后，系统将自动解析章节脉络、关键图表与公式清单，并接入文献智脑 GraphRAG。'}
            </p>
          </div>
        )}
      </div>

      <div className="border-t border-cslab-border/70 px-4 py-1.5">
        <p className="truncate text-[9px] text-cslab-muted">{formatPaperCitation(paper)}</p>
      </div>
    </div>
  )
}
