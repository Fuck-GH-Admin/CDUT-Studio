/**
 * CsLabToolsPanel — 实验室 Python 工具与运行时
 *
 * 仅展示真实扫描结果与执行结果；无工具、无 Python 或执行失败都如实标注。
 * 会话绑定是唯一注入路径，禁止全局 activeLabId。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import {
  Boxes,
  Check,
  FlaskConical,
  Gauge,
  Loader2,
  PackagePlus,
  Play,
  RefreshCw,
  Unlink,
  Wrench,
  X,
} from 'lucide-react'
import type {
  AgentSessionMeta,
  CsLabCustomTool,
  CsLabToolPreset,
  CsLabToolProfile,
  PdfParseAccuracy,
} from '@profer/shared'
import {
  PDF_PARSE_ACCURACY_DEFAULT,
  PDF_PARSE_ACCURACY_HINT,
  PDF_PARSE_ACCURACY_OPTIONS,
} from '@profer/shared'
import { cn } from '@/lib/utils'
import {
  cslabCustomToolsAtom,
  cslabToolDepsProgressAtom,
  cslabToolRuntimeAtom,
} from '@/atoms/cslab-atoms'

interface CsLabToolsPanelProps {
  labId: string
  onToast: (kind: 'info' | 'success' | 'error', text: string) => void
  /** 从数据集动作栏进入时携带的数据表绝对路径。 */
  initialPath?: string | null
}

const ENGINE_LABEL: Record<string, string> = {
  ast: 'AST 静态分析',
  heuristic: '启发式解析',
  none: '未检测到工具',
}

const PROFILE_OPTIONS: Array<{ value: CsLabToolProfile; label: string }> = [
  { value: 'plot', label: '图表数字化（numpy/OpenCV/SciPy）' },
  { value: 'formula', label: '公式验算（SymPy）' },
  { value: 'instrument', label: '仪器增强（h5py/yadg）' },
]

function signature(tool: CsLabCustomTool): string {
  const params = tool.params
    .map((param) => `${param.name}${param.required ? '' : '?'}: ${param.annotation ?? param.jsonType}`)
    .join(', ')
  return `${tool.name}(${params})${tool.returns ? ` -> ${tool.returns}` : ''}`
}

/** 生成参数 JSON：先套用函数默认值，再把数据表路径注入最匹配的字符串参数。 */
function buildArgsText(tool: CsLabCustomTool, path?: string | null): string {
  const args: Record<string, unknown> = {}
  for (const param of tool.params) {
    if (param.defaultValue === undefined) continue
    const raw = param.defaultValue.trim()
    if (param.jsonType === 'number' || param.jsonType === 'integer') {
      const value = Number(raw)
      if (Number.isFinite(value)) args[param.name] = value
    } else if (param.jsonType === 'boolean') {
      args[param.name] = raw === 'True' || raw === 'true'
    } else if (raw.startsWith("'") || raw.startsWith('"')) {
      args[param.name] = raw.slice(1, -1)
    }
  }

  if (path) {
    const target = tool.params.find(
      (param) =>
        param.jsonType === 'string' && /path|file|data|input/i.test(param.name),
    )
    args[target?.name ?? 'path'] = path
  }
  return JSON.stringify(args, null, 2)
}

export function CsLabToolsPanel({
  labId,
  onToast,
  initialPath,
}: CsLabToolsPanelProps): React.ReactElement {
  const [scan, setScan] = useAtom(cslabCustomToolsAtom)
  const [runtime, setRuntime] = useAtom(cslabToolRuntimeAtom)
  const [progress] = useAtom(cslabToolDepsProgressAtom)

  const [busy, setBusy] = React.useState<'scan' | 'uv' | 'install' | 'run' | 'bind' | null>(null)
  const [profile, setProfile] = React.useState<CsLabToolProfile>('plot')
  const [selectedTool, setSelectedTool] = React.useState<string>('')
  const [argsText, setArgsText] = React.useState('{}')
  const [runResult, setRunResult] = React.useState<string | null>(null)
  const [sessions, setSessions] = React.useState<AgentSessionMeta[]>([])
  const [sessionId, setSessionId] = React.useState('')
  const [message, setMessage] = React.useState<string | null>(null)
  const [presets, setPresets] = React.useState<CsLabToolPreset[]>([])
  const [installingPreset, setInstallingPreset] = React.useState<string | null>(null)
  const [sourceView, setSourceView] = React.useState<{ filename: string; source: string } | null>(null)
  const [showPresets, setShowPresets] = React.useState(false)
  const [accuracy, setAccuracy] = React.useState<PdfParseAccuracy>(PDF_PARSE_ACCURACY_DEFAULT)
  const seedAppliedRef = React.useRef('')

  // 初始化论文解析准度：缺失或非法值一律回落默认档（与主进程解析侧同一套判定）
  React.useEffect(() => {
    let cancelled = false
    void window.electronAPI
      .getSettings()
      .then((settings) => {
        if (cancelled) return
        const value = settings.pdfParseAccuracy
        setAccuracy(
          PDF_PARSE_ACCURACY_OPTIONS.some((option) => option.value === value)
            ? (value as PdfParseAccuracy)
            : PDF_PARSE_ACCURACY_DEFAULT,
        )
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  React.useEffect(() => {
    if (!initialPath) {
      seedAppliedRef.current = ''
      return
    }
    const tool = scan?.tools.find((item) => item.name === selectedTool)
    if (!tool) return
    const key = `${initialPath}|${tool.name}`
    if (seedAppliedRef.current === key) return
    seedAppliedRef.current = key
    setArgsText(buildArgsText(tool, initialPath))
  }, [initialPath, scan, selectedTool])

  const refreshRuntime = React.useCallback(async (): Promise<void> => {
    try {
      setRuntime(await window.electronAPI.cslab.getToolRuntime(labId))
    } catch {
      setRuntime(null)
    }
  }, [labId, setRuntime])

  const refreshTools = React.useCallback(
    async (forceRefresh = false): Promise<void> => {
      setBusy('scan')
      try {
        const next = forceRefresh
          ? await window.electronAPI.cslab.refreshCustomTools(labId)
          : await window.electronAPI.cslab.listCustomTools(labId)
        setScan(next)
        setMessage(next.message)
        if (next.tools.length > 0) {
          setSelectedTool((current) => current || next.tools[0]!.name)
        }
        if (forceRefresh) onToast('success', next.message)
      } catch (error) {
        onToast('error', error instanceof Error ? error.message : '工具扫描失败')
      } finally {
        setBusy(null)
      }
    },
    [labId, onToast, setScan],
  )

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      await refreshTools(false)
      await refreshRuntime()
      try {
        const list = await window.electronAPI.listAgentSessions()
        if (!cancelled) {
          const recent = list.filter((session) => !session.archived).slice(0, 20)
          setSessions(recent)
          const bound = recent.find((session) => session.cslabLabId === labId)
          setSessionId(bound?.id ?? recent[0]?.id ?? '')
        }
      } catch {
        if (!cancelled) setSessions([])
      }
      try {
        const presetList = await window.electronAPI.cslab.listToolPresets(labId)
        if (!cancelled) setPresets(presetList)
      } catch {
        if (!cancelled) setPresets([])
      }
    })()

    const off = window.electronAPI.cslab.onToolsChanged((event) => {
      if (event.labId !== labId) return
      setScan(event.scan)
    })

    return () => {
      cancelled = true
      off()
    }
    // 仅随实验室切换重置。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labId])

  const installPreset = async (filename?: string): Promise<void> => {
    setInstallingPreset(filename ?? 'all')
    try {
      const result = await window.electronAPI.cslab.installToolPresets({
        labId,
        filenames: filename ? [filename] : undefined,
      })
      onToast(result.ok ? 'success' : 'error', result.message)
      const presetList = await window.electronAPI.cslab.listToolPresets(labId)
      setPresets(presetList)
      if (result.installed.length > 0) await refreshTools(true)
    } catch (error) {
      onToast('error', error instanceof Error ? error.message : '预置算子安装失败')
    } finally {
      setInstallingPreset(null)
    }
  }

  const viewPresetSource = async (filename: string): Promise<void> => {
    try {
      const result = await window.electronAPI.cslab.readToolPresetSource(filename)
      if (result.ok && result.source) {
        setSourceView({ filename: result.filename ?? filename, source: result.source })
      } else {
        onToast('error', result.message ?? '源码读取失败')
      }
    } catch (error) {
      onToast('error', error instanceof Error ? error.message : '源码读取失败')
    }
  }

  const ensureUv = async (): Promise<void> => {
    setBusy('uv')
    try {
      const result = await window.electronAPI.cslab.ensureUv(labId)
      onToast(result.ok ? 'success' : 'info', result.message)
      await refreshRuntime()
    } catch (error) {
      onToast('error', error instanceof Error ? error.message : 'uv 探测失败')
    } finally {
      setBusy(null)
    }
  }

  const installDeps = async (): Promise<void> => {
    setBusy('install')
    try {
      const status = await window.electronAPI.cslab.installToolDeps({ labId, profile })
      setRuntime(status)
      onToast('success', `依赖已安装：${PROFILE_OPTIONS.find((item) => item.value === profile)?.label ?? profile}`)
    } catch (error) {
      onToast('error', error instanceof Error ? error.message : '依赖安装失败')
    } finally {
      setBusy(null)
    }
  }

  const runTool = async (): Promise<void> => {
    if (!selectedTool) return
    let args: Record<string, unknown>
    try {
      const parsed = JSON.parse(argsText || '{}') as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('参数必须是 JSON 对象')
      }
      args = parsed as Record<string, unknown>
    } catch (error) {
      onToast('error', error instanceof Error ? error.message : '参数 JSON 无效')
      return
    }
    setBusy('run')
    setRunResult(null)
    try {
      const result = await window.electronAPI.cslab.runCustomTool({
        labId,
        name: selectedTool,
        args,
      })
      setRunResult(
        result.ok
          ? JSON.stringify(result.result, null, 2)
          : `${result.error ?? '执行失败'}\n（${result.elapsedMs} ms）`,
      )
      onToast(result.ok ? 'success' : 'error', result.ok ? '工具执行完成' : '工具执行失败')
    } catch (error) {
      setRunResult(error instanceof Error ? error.message : '工具执行失败')
    } finally {
      setBusy(null)
    }
  }

  const bindSession = async (bind: boolean): Promise<void> => {
    if (!sessionId) {
      onToast('info', '请选择一个会话')
      return
    }
    setBusy('bind')
    try {
      const result = bind
        ? await window.electronAPI.cslab.bindSessionLab({ sessionId, labId })
        : await window.electronAPI.cslab.unbindSessionLab({ sessionId })
      setSessions((previous) =>
        previous.map((session) =>
          session.id === sessionId
            ? { ...session, cslabLabId: result.labId ?? undefined }
            : session,
        ),
      )
      onToast('success', result.message)
    } catch (error) {
      onToast('error', error instanceof Error ? error.message : '会话绑定失败')
    } finally {
      setBusy(null)
    }
  }

  /** 切换论文解析准度并经 settings 更新通道落盘 */
  const changeAccuracy = async (value: PdfParseAccuracy): Promise<void> => {
    if (value === accuracy) return
    setAccuracy(value)
    try {
      await window.electronAPI.updateSettings({ pdfParseAccuracy: value })
      const option = PDF_PARSE_ACCURACY_OPTIONS.find((item) => item.value === value)
      onToast('success', `论文解析准度已改为「${option?.label ?? value}」`)
    } catch (error) {
      onToast('error', error instanceof Error ? error.message : '论文解析准度保存失败')
    }
  }

  const currentSession = sessions.find((session) => session.id === sessionId)
  const selectedToolMeta = scan?.tools.find((tool) => tool.name === selectedTool)

  return (
    <div className="space-y-4">
      {initialPath && (
        <section className="rounded-xl border border-cslab-accent/30 bg-cslab-accent/5 px-3 py-2">
          <p className="text-[10px] font-medium text-cslab-accent">已注入当前数据表路径</p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-cslab-muted" title={initialPath}>
            {initialPath}
          </p>
        </section>
      )}
      <section className="rounded-xl border border-cslab-border bg-cslab-elevated/70 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full border border-cslab-border px-2 py-0.5 text-[10px] text-cslab-muted">
            <Boxes size={10} /> {ENGINE_LABEL[scan?.engine ?? 'none'] ?? scan?.engine}
          </span>
          <span className="text-[10px] text-cslab-muted">{scan?.tools.length ?? 0} 个函数</span>
          <button
            type="button"
            disabled={busy === 'scan'}
            onClick={() => void refreshTools(true)}
            className="ml-auto inline-flex items-center gap-1 rounded-lg border border-cslab-border px-2 py-1 text-[10px] text-cslab-muted hover:text-cslab-text disabled:opacity-50"
          >
            <RefreshCw size={10} className={busy === 'scan' ? 'animate-spin' : undefined} /> 重新扫描
          </button>
        </div>
        {message && <p className="mt-2 text-[10px] leading-relaxed text-cslab-muted">{message}</p>}
        <p className="mt-1 text-[10px] leading-relaxed text-cslab-muted/80">
          放置路径：runtime/tools/*.py · 顶层函数（非 _ 开头）会被装配为 Agent 工具
        </p>
      </section>

      <section className="rounded-xl border border-cslab-border bg-cslab-elevated/70 p-3">
        <div className="flex items-center gap-2">
          <Wrench size={11} className="text-cslab-muted" />
          <span className="text-[10px] uppercase tracking-[0.14em] text-cslab-muted">运行时</span>
          <span className="ml-auto text-[10px] text-cslab-muted">
            {runtime?.venvPath ? '实验室 .venv' : runtime?.pythonPath ? '系统 Python' : '未检测到 Python'}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <select
            value={profile}
            onChange={(event) => setProfile(event.target.value as CsLabToolProfile)}
            className="min-w-0 flex-1 rounded-lg border border-cslab-border bg-cslab-bg px-2 py-1 text-[10px] text-cslab-text outline-none"
          >
            {PROFILE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy === 'install'}
            onClick={() => void installDeps()}
            className="rounded-lg bg-cslab-accent px-2 py-1 text-[10px] font-medium text-white hover:bg-cslab-accentHover disabled:opacity-50"
          >
            {busy === 'install' ? '安装中…' : '安装依赖'}
          </button>
          <button
            type="button"
            disabled={busy === 'uv'}
            onClick={() => void ensureUv()}
            className="rounded-lg border border-cslab-border px-2 py-1 text-[10px] text-cslab-muted hover:text-cslab-text disabled:opacity-50"
          >
            {busy === 'uv' ? '探测中…' : '确保 uv'}
          </button>
        </div>
        {progress && progress.labId === labId && (
          <p className="mt-1.5 truncate text-[10px] text-cslab-muted">
            {progress.stage} · {progress.message}
          </p>
        )}
        {runtime?.note && <p className="mt-1 text-[10px] leading-relaxed text-cslab-muted">{runtime.note}</p>}
      </section>

      <section className="rounded-xl border border-cslab-border bg-cslab-elevated/70 p-3">
        <div className="flex items-center gap-2">
          <Gauge size={11} className="text-cslab-muted" />
          <span className="text-[10px] uppercase tracking-[0.14em] text-cslab-muted">论文解析准度</span>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-1.5">
          {PDF_PARSE_ACCURACY_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => void changeAccuracy(option.value)}
              className={cn(
                'rounded-lg border px-2 py-1.5 text-left transition-colors',
                accuracy === option.value
                  ? 'border-cslab-accent/40 bg-cslab-surface'
                  : 'border-cslab-border hover:bg-cslab-surface/70',
              )}
            >
              <span className="block text-[10px] font-medium text-cslab-text">{option.label}</span>
              <span className="mt-0.5 block text-[9px] leading-relaxed text-cslab-muted">
                {option.description}
              </span>
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[10px] leading-relaxed text-cslab-muted">{PDF_PARSE_ACCURACY_HINT}</p>
      </section>

      <section className="space-y-1">
        {(scan?.tools ?? []).length === 0 ? (
          <div className="rounded-xl border border-dashed border-cslab-border px-4 py-5 text-center">
            <FlaskConical size={16} className="mx-auto text-cslab-muted/60" />
            <p className="mt-1.5 font-serif text-sm text-cslab-text">自定义科研算子 (Python Workspace)</p>
            <p className="mt-1 text-[10px] leading-relaxed text-cslab-muted">
              在实验室目录 runtime/tools 放入 .py 文件（函数需带类型注解与 docstring），
              或直接安装下方的地质灾害预置算子。
            </p>
          </div>
        ) : (
          scan?.tools.map((tool) => (
            <button
              key={`${tool.moduleRelPath}:${tool.name}`}
              type="button"
              onClick={() => {
                setSelectedTool(tool.name)
                setArgsText(buildArgsText(tool, initialPath))
                setRunResult(null)
              }}
              className={cn(
                'w-full rounded-lg border px-2.5 py-2 text-left transition-colors',
                selectedTool === tool.name
                  ? 'border-cslab-accent/40 bg-cslab-surface'
                  : 'border-transparent hover:bg-cslab-surface/70',
              )}
            >
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[11px] text-cslab-text">{tool.name}</span>
                <span className="rounded-full border border-cslab-border px-1.5 text-[9px] uppercase text-cslab-muted">
                  {tool.source}
                </span>
                {tool.unsupportedReason && (
                  <span className="ml-auto text-[9px] text-[#B4553F]">{tool.unsupportedReason}</span>
                )}
              </div>
              <p className="mt-0.5 truncate font-mono text-[10px] text-cslab-muted">{signature(tool)}</p>
              <p className="mt-0.5 line-clamp-2 text-[10px] leading-relaxed text-cslab-muted">
                {tool.description}
              </p>
            </button>
          ))
        )}
      </section>

      <section className="rounded-xl border border-cslab-border bg-cslab-elevated/70 p-3">
        <div className="flex items-center gap-2">
          <PackagePlus size={11} className="text-cslab-muted" />
          <span className="text-[10px] uppercase tracking-[0.14em] text-cslab-muted">
            预置算子库 · 地质灾害 / 泥石流
          </span>
          <button
            type="button"
            onClick={() => setShowPresets((value) => !value)}
            className="ml-auto text-[9px] text-cslab-muted hover:text-cslab-text"
          >
            {showPresets || (scan?.tools ?? []).length === 0 ? '收起' : '展开'}
          </button>
        </div>
        {(showPresets || (scan?.tools ?? []).length === 0) && (
          <div className="mt-2 space-y-1.5">
            {presets.length === 0 && (
              <p className="text-[10px] text-cslab-muted">预置算子库不可用（资源包缺失）</p>
            )}
            {presets.map((preset) => (
              <div
                key={preset.filename}
                className="rounded-lg border border-cslab-border bg-cslab-bg px-2.5 py-2"
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-medium text-cslab-text">{preset.title}</span>
                  {preset.installed && (
                    <span className="rounded-full border border-[#6E8B6A]/40 px-1.5 text-[8px] text-[#5C7358]">
                      已安装
                    </span>
                  )}
                  <span className="ml-auto rounded-full border border-cslab-border px-1.5 text-[8px] text-cslab-muted">
                    {preset.dependency}
                  </span>
                </div>
                <p className="mt-0.5 text-[10px] leading-relaxed text-cslab-muted">
                  {preset.description}
                </p>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={preset.installed || installingPreset !== null}
                    onClick={() => void installPreset(preset.filename)}
                    className="inline-flex items-center gap-1 rounded-md bg-cslab-accent px-2 py-0.5 text-[9px] font-medium text-white hover:bg-cslab-accentHover disabled:opacity-40"
                  >
                    {installingPreset === preset.filename ? (
                      <Loader2 size={9} className="animate-spin" />
                    ) : (
                      <PackagePlus size={9} />
                    )}
                    {preset.installed ? '已安装' : '安装到本实验室'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void viewPresetSource(preset.filename)}
                    className="rounded-md border border-cslab-border px-2 py-0.5 text-[9px] text-cslab-muted hover:text-cslab-text"
                  >
                    查看源码
                  </button>
                </div>
              </div>
            ))}
            {presets.length > 0 && presets.some((preset) => !preset.installed) && (
              <button
                type="button"
                disabled={installingPreset !== null}
                onClick={() => void installPreset()}
                className="w-full rounded-lg border border-dashed border-cslab-border px-2 py-1.5 text-[10px] text-cslab-muted hover:border-cslab-accent/40 hover:text-cslab-accent disabled:opacity-40"
              >
                {installingPreset === 'all' ? '安装中…' : '一键安装全部预置算子'}
              </button>
            )}
          </div>
        )}
      </section>

      {sourceView && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
          <div className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-cslab-border bg-cslab-elevated shadow-subtle">
            <div className="flex items-center gap-2 border-b border-cslab-border px-4 py-2.5">
              <span className="font-mono text-[11px] text-cslab-text">{sourceView.filename}</span>
              <span className="text-[9px] text-cslab-muted">预置算子源码</span>
              <button
                type="button"
                onClick={() => setSourceView(null)}
                className="ml-auto rounded p-1 text-cslab-muted hover:bg-cslab-surface hover:text-cslab-text"
              >
                <X size={12} />
              </button>
            </div>
            <pre className="flex-1 overflow-auto bg-cslab-bg p-4 font-mono text-[10px] leading-relaxed text-cslab-text">
              {sourceView.source}
            </pre>
          </div>
        </div>
      )}

      {selectedToolMeta && !selectedToolMeta.unsupportedReason && (
        <section className="rounded-xl border border-cslab-border bg-cslab-elevated/70 p-3">
          <div className="flex items-center gap-2">
            <Play size={11} className="text-cslab-muted" />
            <span className="text-[10px] uppercase tracking-[0.14em] text-cslab-muted">试运行</span>
            <span className="ml-auto font-mono text-[10px] text-cslab-muted">{selectedToolMeta.name}</span>
          </div>
          <textarea
            value={argsText}
            onChange={(event) => setArgsText(event.target.value)}
            rows={4}
            spellCheck={false}
            className="mt-2 w-full resize-none rounded-lg border border-cslab-border bg-cslab-bg px-2 py-1.5 font-mono text-[10px] leading-relaxed text-cslab-text outline-none focus:border-cslab-accent/50"
          />
          <div className="mt-1.5 flex justify-end">
            <button
              type="button"
              disabled={busy === 'run'}
              onClick={() => void runTool()}
              className="inline-flex items-center gap-1 rounded-lg bg-cslab-accent px-2.5 py-1 text-[10px] font-medium text-white hover:bg-cslab-accentHover disabled:opacity-50"
            >
              {busy === 'run' ? <Loader2 size={10} className="animate-spin" /> : <Play size={10} />}
              运行
            </button>
          </div>
          {runResult !== null && (
            <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-cslab-bg p-2 font-mono text-[10px] leading-relaxed text-cslab-text">
              {runResult}
            </pre>
          )}
        </section>
      )}

      <section className="rounded-xl border border-cslab-border bg-cslab-elevated/70 p-3">
        <div className="flex items-center gap-2">
          <Check size={11} className="text-cslab-muted" />
          <span className="text-[10px] uppercase tracking-[0.14em] text-cslab-muted">绑定到会话</span>
          <span className="ml-auto text-[9px] text-cslab-muted">重新发送消息后生效</span>
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <select
            value={sessionId}
            onChange={(event) => setSessionId(event.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-cslab-border bg-cslab-bg px-2 py-1 text-[10px] text-cslab-text outline-none"
          >
            {sessions.length === 0 && <option value="">暂无可用会话</option>}
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.title}
                {session.cslabLabId === labId ? '（已绑定）' : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy === 'bind' || !sessionId}
            onClick={() => void bindSession(true)}
            className="rounded-lg bg-cslab-accent px-2 py-1 text-[10px] font-medium text-white hover:bg-cslab-accentHover disabled:opacity-50"
          >
            绑定
          </button>
          <button
            type="button"
            disabled={busy === 'bind' || !sessionId || !currentSession?.cslabLabId}
            onClick={() => void bindSession(false)}
            className="inline-flex items-center gap-1 rounded-lg border border-cslab-border px-2 py-1 text-[10px] text-cslab-muted hover:text-cslab-text disabled:opacity-40"
          >
            <Unlink size={10} /> 解绑
          </button>
        </div>
        <p className="mt-1.5 text-[10px] leading-relaxed text-cslab-muted">
          仅绑定的会话会注入 cslab_* 工具；其他会话保持通用编程能力，互不串扰。
        </p>
      </section>
    </div>
  )
}
