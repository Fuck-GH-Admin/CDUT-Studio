/**
 * CsLabFormulaPanel — 公式识别与 SymPy 验算抽屉
 *
 * 评审加固 11.5：首屏默认双栏 LaTeX 输入 + KaTeX 预览；
 * OCR 仅为右上角可选增强，失败不影响手工验算。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import katex from 'katex'
import DOMPurify from 'dompurify'
import { CheckCircle2, Download, Loader2, ScanText, ShieldQuestion } from 'lucide-react'
import type {
  CsLabFormulaVerifyResult,
  CsLabToolProfile,
} from '@profer/shared'
import { cn } from '@/lib/utils'
import {
  cslabToolDepsProgressAtom,
  cslabToolRuntimeAtom,
  type CsLabPdfSelection,
} from '@/atoms/cslab-atoms'

interface CsLabFormulaPanelProps {
  labId: string
  selection?: CsLabPdfSelection
}

function LatexPreview({ latex }: { latex: string }): React.ReactElement {
  const html = React.useMemo(() => {
    if (!latex.trim()) return ''
    try {
      const rendered = katex.renderToString(latex, {
        throwOnError: false,
        displayMode: true,
        strict: 'ignore',
      })
      // 纵深防御：即便 KaTeX trust 默认关闭，注入 DOM 前仍统一消毒。
      return DOMPurify.sanitize(rendered, {
        USE_PROFILES: { html: true, svg: true, mathMl: true },
      })
    } catch {
      return ''
    }
  }, [latex])

  if (!html) {
    return <p className="py-2 text-center text-[10px] text-cslab-muted/70">公式预览</p>
  }
  return (
    <div
      className="overflow-x-auto py-1 text-center text-[13px] text-cslab-text"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

export function CsLabFormulaPanel({
  labId,
  selection,
}: CsLabFormulaPanelProps): React.ReactElement {
  const runtime = useAtomValue(cslabToolRuntimeAtom)
  const setRuntime = useSetAtom(cslabToolRuntimeAtom)
  const progress = useAtomValue(cslabToolDepsProgressAtom)

  const [latexLhs, setLatexLhs] = React.useState('')
  const [latexRhs, setLatexRhs] = React.useState('')
  const [symbolsText, setSymbolsText] = React.useState('')
  const [result, setResult] = React.useState<CsLabFormulaVerifyResult | null>(null)
  const [busy, setBusy] = React.useState<'ocr' | 'verify' | 'install' | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [message, setMessage] = React.useState<string | null>(null)

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

  const formulaReady = runtime?.profiles.formula.installed ?? false
  const ocrReady = runtime?.profiles['formula-ocr'].installed ?? false

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

  const ocr = async (): Promise<void> => {
    if (!selection) {
      setError('请先在 PDF 中框选公式区域')
      return
    }
    setBusy('ocr')
    setError(null)
    try {
      const payload = await window.electronAPI.cslab.ocrFormula({
        labId,
        imageDataUrl: selection.cropDataUrl,
      })
      if (!payload.ok || !payload.latex) {
        setError(payload.message ?? '公式识别失败')
        return
      }
      const parts = payload.latex.split(/=(.+)/, 2)
      const left = parts[0] ?? ''
      const right = parts[1] ?? ''
      if (right) {
        setLatexLhs(left.trim())
        setLatexRhs(right.trim())
      } else {
        setLatexLhs(payload.latex.trim())
      }
      setMessage(`已通过 ${payload.engine} 识别，请核对后验算`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '公式识别失败')
    } finally {
      setBusy(null)
    }
  }

  const verify = async (): Promise<void> => {
    if (!latexLhs.trim() || !latexRhs.trim()) {
      setError('请填写等式左右两侧的 LaTeX')
      return
    }
    let symbolDimensions: Record<string, string> | undefined
    if (symbolsText.trim()) {
      try {
        const parsed = JSON.parse(symbolsText) as Record<string, string>
        symbolDimensions = parsed
      } catch {
        setError('量纲映射必须是合法 JSON，例如 {"F":"force","m":"mass"}')
        return
      }
    }

    setBusy('verify')
    setError(null)
    setResult(null)
    try {
      const payload = await window.electronAPI.cslab.verifyFormula({
        labId,
        latexLhs: latexLhs.trim(),
        latexRhs: latexRhs.trim(),
        symbolDimensions,
      })
      setResult(payload)
      if (!payload.ok) {
        setError(payload.message ?? '验算失败')
        if (payload.message?.includes('SymPy')) {
          void window.electronAPI.cslab.getToolRuntime(labId).then(setRuntime).catch(() => undefined)
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '验算失败')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      {selection && (
        <div className="flex items-start gap-2 rounded-xl border border-cslab-border bg-cslab-surface p-2">
          <img
            src={selection.cropDataUrl}
            alt="公式框选"
            className="max-h-24 w-28 object-contain"
          />
          <div className="min-w-0 flex-1">
            <p className="text-[10px] uppercase tracking-[0.14em] text-cslab-muted">
              PAGE {(selection.pageIndex ?? 0) + 1}
            </p>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void ocr()}
              className="mt-1 inline-flex items-center gap-1 rounded-md border border-cslab-border bg-cslab-bg px-2 py-1 text-[10px] text-cslab-text transition-colors hover:bg-cslab-surface disabled:opacity-50"
            >
              {busy === 'ocr' ? <Loader2 size={10} className="animate-spin" /> : <ScanText size={10} />}
              截图识别（可选）
            </button>
            {!ocrReady && (
              <p className="mt-1 text-[9px] leading-relaxed text-cslab-muted">
                未安装 Pix2Text；可手工粘贴 LaTeX，或
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void installDeps('formula-ocr')}
                  className="ml-1 underline decoration-dotted hover:text-cslab-accent disabled:opacity-50"
                >
                  安装 formula-ocr
                </button>
              </p>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-2">
        <label className="block">
          <span className="text-[9px] uppercase tracking-[0.14em] text-cslab-muted">LHS</span>
          <textarea
            value={latexLhs}
            onChange={(event) => setLatexLhs(event.target.value)}
            rows={2}
            placeholder="例如：F"
            className="mt-1 w-full resize-none rounded-lg border border-cslab-border bg-cslab-elevated px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-cslab-text outline-none focus:border-cslab-accent/50"
          />
          <div className="mt-1 rounded-lg border border-cslab-border/70 bg-cslab-surface/60">
            <LatexPreview latex={latexLhs} />
          </div>
        </label>
        <label className="block">
          <span className="text-[9px] uppercase tracking-[0.14em] text-cslab-muted">RHS</span>
          <textarea
            value={latexRhs}
            onChange={(event) => setLatexRhs(event.target.value)}
            rows={2}
            placeholder="例如：m a"
            className="mt-1 w-full resize-none rounded-lg border border-cslab-border bg-cslab-elevated px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-cslab-text outline-none focus:border-cslab-accent/50"
          />
          <div className="mt-1 rounded-lg border border-cslab-border/70 bg-cslab-surface/60">
            <LatexPreview latex={latexRhs} />
          </div>
        </label>
      </div>

      <details className="rounded-lg border border-cslab-border px-3 py-2">
        <summary className="cursor-pointer text-[10px] text-cslab-muted">量纲映射（可选）</summary>
        <textarea
          value={symbolsText}
          onChange={(event) => setSymbolsText(event.target.value)}
          rows={3}
          placeholder='{"F":"force","m":"mass","a":"acceleration"}'
          className="mt-2 w-full resize-none rounded-md border border-cslab-border bg-cslab-elevated px-2 py-1.5 font-mono text-[10px] leading-relaxed text-cslab-text outline-none focus:border-cslab-accent/50"
        />
      </details>

      {!formulaReady && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[10px] leading-relaxed text-amber-700">
          缺少 SymPy：
          {runtime?.profiles.formula.missing.join(', ') || 'sympy'}
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void installDeps('formula')}
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

      <button
        type="button"
        disabled={busy !== null}
        onClick={() => void verify()}
        className="w-full rounded-lg bg-cslab-accent px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-cslab-accentHover disabled:opacity-50"
      >
        {busy === 'verify' ? <Loader2 size={12} className="mx-auto animate-spin" /> : '执行 SymPy 验算'}
      </button>

      {result?.ok && (
        <div className="space-y-2">
          <div
            className={cn(
              'rounded-xl border px-3 py-2',
              result.equivalent
                ? 'border-emerald-200 bg-emerald-50'
                : 'border-amber-200 bg-amber-50',
            )}
          >
            <p className="flex items-center gap-1 text-[10px] font-medium text-cslab-text">
              {result.equivalent ? (
                <CheckCircle2 size={11} className="text-emerald-600" />
              ) : (
                <ShieldQuestion size={11} className="text-amber-600" />
              )}
              代数等价性：{result.equivalent ? '通过' : '未通过'}
            </p>
            {!result.equivalent && result.residual && (
              <p className="mt-1 break-all font-mono text-[10px] leading-relaxed text-amber-700">
                残差：{result.residual}
              </p>
            )}
          </div>

          <div className="rounded-xl border border-cslab-border px-3 py-2">
            <p className="text-[10px] font-medium text-cslab-text">量纲齐次性</p>
            <p className="mt-0.5 text-[10px] leading-relaxed text-cslab-muted">
              {result.dimensions?.note ?? '未执行'}
              {typeof result.dimensions?.homogeneous === 'boolean' && (
                <span className="ml-1 text-cslab-text">
                  {result.dimensions.homogeneous ? '· LHS/RHS 量纲一致' : '· LHS/RHS 量纲不一致'}
                </span>
              )}
            </p>
          </div>

          <div className="rounded-xl border border-cslab-border px-3 py-2">
            <p className="text-[10px] font-medium text-cslab-text">边界奇点</p>
            <p className="mt-0.5 text-[10px] leading-relaxed text-cslab-muted">
              {result.singularities && result.singularities.length > 0
                ? result.singularities.join('；')
                : '未检测到边界奇点'}
            </p>
            {result.limitNotes && result.limitNotes.length > 0 && (
              <p className="mt-1 text-[9px] leading-relaxed text-cslab-muted/80">
                {result.limitNotes.join('；')}
              </p>
            )}
          </div>

          {result.preprocess?.appliedFixes && result.preprocess.appliedFixes.length > 0 && (
            <p className="text-[9px] leading-relaxed text-cslab-muted">
              预处理：{result.preprocess.appliedFixes.join('；')}
            </p>
          )}

          <p className="text-[9px] text-cslab-muted/70">
            引擎 {result.engine}
            {result.elapsedMs ? ` · ${result.elapsedMs}ms` : ''}
          </p>
        </div>
      )}

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
    </div>
  )
}
