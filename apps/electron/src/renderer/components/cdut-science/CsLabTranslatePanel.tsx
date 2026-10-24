/**
 * CsLabTranslatePanel — 选区学术翻译抽屉
 *
 * 链路：Pix2Text 纯文本 OCR → runLightweightCompletion 隔离单轮补全（防提示词注入）。
 * 容错：Pix2Text 未安装时不报废，渲染「一键安装学术 OCR 引擎」引导卡。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import {
  Check,
  Copy,
  Download,
  Languages,
  Loader2,
  ShieldCheck,
} from 'lucide-react'
import { agentChannelIdAtom, agentModelIdAtom } from '@/atoms/agent-atoms'
import { cn } from '@/lib/utils'
import { cslabToolDepsProgressAtom, type CsLabPdfSelection } from '@/atoms/cslab-atoms'

interface CsLabTranslatePanelProps {
  labId: string
  selection?: CsLabPdfSelection
}

export function CsLabTranslatePanel({
  labId,
  selection,
}: CsLabTranslatePanelProps): React.ReactElement {
  const channelId = useAtomValue(agentChannelIdAtom)
  const modelId = useAtomValue(agentModelIdAtom)
  const progress = useAtomValue(cslabToolDepsProgressAtom)

  const [busy, setBusy] = React.useState<'install' | 'translate' | null>(null)
  const [ocrText, setOcrText] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<string | null>(null)
  const [missingDependency, setMissingDependency] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState<'ocr' | 'text' | null>(null)
  const [showOcr, setShowOcr] = React.useState(true)

  const channelReady = Boolean(channelId && modelId)

  const copy = async (text: string, kind: 'ocr' | 'text'): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(kind)
      window.setTimeout(() => setCopied(null), 1600)
    } catch {
      setError('剪贴板不可用')
    }
  }

  const installOcrEngine = async (): Promise<void> => {
    setBusy('install')
    setError(null)
    try {
      await window.electronAPI.cslab.installToolDeps({ labId, profile: 'formula-ocr' })
      setMissingDependency(false)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'OCR 引擎安装失败')
    } finally {
      setBusy(null)
    }
  }

  const translate = async (): Promise<void> => {
    if (!selection) {
      setError('请先在 PDF 中按住 Ctrl 框选要翻译的区域')
      return
    }
    if (!channelReady) {
      setError('未配置可用模型渠道，请先在设置中选择模型')
      return
    }
    setBusy('translate')
    setError(null)
    setResult(null)
    setMissingDependency(false)
    try {
      const payload = await window.electronAPI.cslab.translateSelection({
        labId,
        imageDataUrl: selection.cropDataUrl,
        channelId: channelId!,
        modelId: modelId!,
      })
      setOcrText(payload.ocrText ?? null)
      if (payload.missingDependency) setMissingDependency(true)
      if (payload.ok && payload.text) {
        setResult(payload.text)
      } else {
        setError(payload.message ?? '翻译失败')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '翻译失败')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      {selection && (
        <div className="overflow-hidden rounded-xl border border-cslab-border bg-cslab-elevated p-2 shadow-subtle">
          <img
            src={selection.cropDataUrl}
            alt="框选区域"
            className="max-h-48 w-full object-contain"
          />
          <p className="mt-1 text-center text-[9px] text-cslab-muted">
            第 {selection.pageIndex + 1} 页框选区域
          </p>
        </div>
      )}

      <div className="flex items-center gap-1.5 rounded-lg border border-cslab-border bg-cslab-surface px-2.5 py-1.5 text-[9px] leading-relaxed text-cslab-muted">
        <ShieldCheck size={11} className="shrink-0 text-cslab-accent" />
        翻译经一次性隔离通道完成，源文本被随机边界标签包裹，内容中的任何指令性语句都不会被执行。
      </div>

      {missingDependency && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[10px] leading-relaxed text-amber-700">
          学术 OCR 引擎（Pix2Text）尚未安装到本实验室，无法提取框选文字。
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void installOcrEngine()}
            className="mt-2 flex items-center gap-1 rounded-md bg-amber-600 px-2 py-1 text-[10px] text-white disabled:opacity-50"
          >
            {busy === 'install' ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <Download size={10} />
            )}
            一键安装学术 OCR 引擎（Pix2Text）
          </button>
          {progress && (
            <p className="mt-1 text-[9px] text-amber-700/80">
              {progress.stage} · {progress.message}
            </p>
          )}
        </div>
      )}

      {ocrText && (
        <div className="rounded-xl border border-cslab-border bg-cslab-surface px-3 py-2">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setShowOcr((value) => !value)}
              className="text-[10px] font-medium text-cslab-text hover:text-cslab-accent"
            >
              OCR 原文 {showOcr ? '▾' : '▸'}
            </button>
            <button
              type="button"
              onClick={() => void copy(ocrText, 'ocr')}
              className="inline-flex items-center gap-1 rounded p-1 text-[9px] text-cslab-muted hover:bg-cslab-elevated hover:text-cslab-text"
            >
              {copied === 'ocr' ? <Check size={10} /> : <Copy size={10} />}
              {copied === 'ocr' ? '已复制' : '复制'}
            </button>
          </div>
          {showOcr && (
            <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words font-sans text-[10px] leading-relaxed text-cslab-muted">
              {ocrText}
            </pre>
          )}
        </div>
      )}

      <button
        type="button"
        disabled={busy !== null || !selection || !channelReady}
        onClick={() => void translate()}
        className={cn(
          'w-full rounded-lg px-3 py-2 text-xs font-medium text-white transition-colors disabled:opacity-50',
          missingDependency ? 'bg-cslab-muted/60' : 'bg-cslab-accent hover:bg-cslab-accentHover',
        )}
      >
        {busy === 'translate' ? (
          <Loader2 size={12} className="mx-auto animate-spin" />
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <Languages size={12} />
            {missingDependency ? '请先安装 OCR 引擎' : '翻译为简体中文'}
          </span>
        )}
      </button>

      {result && (
        <div className="rounded-xl border border-cslab-accent/30 bg-cslab-accent/5 px-3 py-2.5">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-medium text-cslab-accent">简体中文译文</p>
            <button
              type="button"
              onClick={() => void copy(result, 'text')}
              className="inline-flex items-center gap-1 rounded p-1 text-[9px] text-cslab-muted hover:bg-cslab-elevated hover:text-cslab-text"
            >
              {copied === 'text' ? <Check size={10} /> : <Copy size={10} />}
              {copied === 'text' ? '已复制' : '一键复制'}
            </button>
          </div>
          <p className="mt-1.5 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-cslab-text">
            {result}
          </p>
        </div>
      )}

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[10px] leading-relaxed text-red-600">
          {error}
        </p>
      )}
    </div>
  )
}
