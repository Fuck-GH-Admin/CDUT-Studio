/**
 * CsLabNetworkSharePanel — 局域网仪器共享盘
 *
 * 只做三件事：登记源、观察候选生命周期、必要时手动扫描。
 * 租约等级必须如实展示（独占读租约 / 内联租约 / 流式稳定性校验）。
 */

import * as React from 'react'
import {
  FolderSearch,
  HardDrive,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import type {
  CsLabShareCandidate,
  CsLabShareCandidateState,
  CsLabShareLeaseType,
  CsLabShareSourceSummary,
} from '@profer/shared'
import { cn } from '@/lib/utils'

interface CsLabNetworkSharePanelProps {
  labId: string
  onToast: (kind: 'info' | 'success' | 'error', text: string) => void
  onOpenAsset?: (uri: string) => void
}

const STATE_LABELS: Record<CsLabShareCandidateState, string> = {
  observed: '已发现',
  debouncing: '等待静默期',
  capturing: '正在捕获',
  published: '已入库',
  retry: '重试中',
  quarantined: '已隔离',
}

const STATE_CLASSES: Record<CsLabShareCandidateState, string> = {
  observed: 'bg-cslab-surface text-cslab-muted',
  debouncing: 'bg-amber-50 text-amber-700',
  capturing: 'bg-cslab-accent/10 text-cslab-accent',
  published: 'bg-emerald-50 text-emerald-700',
  retry: 'bg-orange-50 text-orange-700',
  quarantined: 'bg-red-50 text-red-600',
}

const LEASE_LABELS: Record<CsLabShareLeaseType, string> = {
  'protected-lease': '独占读租约',
  'inline-command-lease': '内联租约',
  'node-stream-stability': '流式稳定性校验',
  pending: '待校验',
}

const KIND_LABELS: Record<CsLabShareSourceSummary['kind'], string> = {
  unc: 'SMB / UNC',
  local: '本地目录',
  webdav: 'WebDAV',
}

function formatBytes(bytes?: number): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatTime(timestamp?: number): string {
  if (!timestamp) return '未扫描'
  const date = new Date(timestamp)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

export function CsLabNetworkSharePanel({
  labId,
  onToast,
  onOpenAsset,
}: CsLabNetworkSharePanelProps): React.ReactElement {
  const [sources, setSources] = React.useState<CsLabShareSourceSummary[]>([])
  const [candidates, setCandidates] = React.useState<CsLabShareCandidate[]>([])
  const [loading, setLoading] = React.useState(true)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [adding, setAdding] = React.useState(false)
  const [form, setForm] = React.useState({
    label: '原位测试共享盘',
    rootPath: '',
    include: '',
    quietSeconds: '45',
    pollSeconds: '30',
    username: '',
    password: '',
  })

  const refresh = React.useCallback(async (): Promise<void> => {
    try {
      const [nextSources, nextCandidates] = await Promise.all([
        window.electronAPI.cslab.listShareSources(labId),
        window.electronAPI.cslab.listShareCandidates({ labId }),
      ])
      setSources(nextSources)
      setCandidates(nextCandidates)
    } catch (error) {
      onToast('error', error instanceof Error ? error.message : '共享盘状态读取失败')
    } finally {
      setLoading(false)
    }
  }, [labId, onToast])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const runAction = async (
    sourceId: string,
    action: () => Promise<{ message?: string } | void>,
  ): Promise<void> => {
    setBusyId(sourceId)
    try {
      const result = await action()
      if (result && 'message' in result && result.message) {
        onToast('info', String(result.message))
      }
      await refresh()
    } catch (error) {
      onToast('error', error instanceof Error ? error.message : '操作失败')
    } finally {
      setBusyId(null)
    }
  }

  const handleAdd = async (): Promise<void> => {
    if (!form.rootPath.trim()) {
      onToast('error', '请填写共享路径')
      return
    }
    setBusyId('new')
    try {
      const created = await window.electronAPI.cslab.addShareSource({
        labId,
        label: form.label.trim() || '仪器共享盘',
        rootPath: form.rootPath.trim(),
        include: form.include
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
        quietSeconds: Number(form.quietSeconds) || undefined,
        pollSeconds: Number(form.pollSeconds) || undefined,
        username: form.username.trim() || undefined,
        password: form.password || undefined,
      })
      setAdding(false)
      setForm({
        label: '原位测试共享盘',
        rootPath: '',
        include: '',
        quietSeconds: '45',
        pollSeconds: '30',
        username: '',
        password: '',
      })
      onToast('success', `已登记共享盘：${created.label}`)
      await window.electronAPI.cslab.startShareWatch(labId)
      await refresh()
    } catch (error) {
      onToast('error', error instanceof Error ? error.message : '登记失败')
    } finally {
      setBusyId(null)
    }
  }

  const candidatesBySource = React.useMemo(() => {
    const map = new Map<string, CsLabShareCandidate[]>()
    for (const candidate of candidates) {
      const list = map.get(candidate.sourceId) ?? []
      list.push(candidate)
      map.set(candidate.sourceId, list)
    }
    return map
  }, [candidates])

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-cslab-border bg-cslab-surface/60 px-3 py-2.5">
        <p className="text-[11px] leading-relaxed text-cslab-muted">
          共享盘只做「发现 + 安全捕获」：静默期结束后才抓取，Windows 优先申请独占读租约，
          边流式读取边计算 SHA-256，fsync 后原子入库。半截文件不会出现在数据铁笼。
        </p>
      </div>

      <div className="flex items-center justify-between">
        <h3 className="font-serif text-sm text-cslab-text">共享源</h3>
        <button
          type="button"
          onClick={() => setAdding((value) => !value)}
          className="inline-flex items-center gap-1 rounded-lg border border-cslab-border px-2 py-1 text-[11px] text-cslab-muted transition-colors hover:bg-cslab-surface hover:text-cslab-text"
        >
          {adding ? <X size={11} /> : <Plus size={11} />}
          {adding ? '取消' : '添加共享盘'}
        </button>
      </div>

      {adding && (
        <div className="space-y-2 rounded-xl border border-cslab-border bg-cslab-elevated p-3 shadow-subtle">
          <input
            value={form.label}
            onChange={(event) => setForm({ ...form, label: event.target.value })}
            placeholder="显示名（如：XRD 机台共享盘）"
            className="w-full rounded-lg border border-cslab-border bg-cslab-bg px-2.5 py-1.5 text-xs text-cslab-text placeholder:text-cslab-muted/60 focus:border-cslab-accent/40 focus:outline-none"
          />
          <input
            value={form.rootPath}
            onChange={(event) => setForm({ ...form, rootPath: event.target.value })}
            placeholder="\\server\share\data 或 https://dav.example.edu/lab"
            className="w-full rounded-lg border border-cslab-border bg-cslab-bg px-2.5 py-1.5 font-mono text-[11px] text-cslab-text placeholder:text-cslab-muted/60 focus:border-cslab-accent/40 focus:outline-none"
          />
          <input
            value={form.include}
            onChange={(event) => setForm({ ...form, include: event.target.value })}
            placeholder="只扫描子目录（逗号分隔，可留空）"
            className="w-full rounded-lg border border-cslab-border bg-cslab-bg px-2.5 py-1.5 text-[11px] text-cslab-text placeholder:text-cslab-muted/60 focus:border-cslab-accent/40 focus:outline-none"
          />
          <div className="flex items-center gap-2">
            <label className="flex flex-1 items-center gap-1.5 text-[10px] text-cslab-muted">
              静默期(s)
              <input
                value={form.quietSeconds}
                onChange={(event) => setForm({ ...form, quietSeconds: event.target.value })}
                className="w-14 rounded border border-cslab-border bg-cslab-bg px-1.5 py-1 text-[11px] text-cslab-text focus:outline-none"
              />
            </label>
            <label className="flex flex-1 items-center gap-1.5 text-[10px] text-cslab-muted">
              轮询(s)
              <input
                value={form.pollSeconds}
                onChange={(event) => setForm({ ...form, pollSeconds: event.target.value })}
                className="w-14 rounded border border-cslab-border bg-cslab-bg px-1.5 py-1 text-[11px] text-cslab-text focus:outline-none"
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input
              value={form.username}
              onChange={(event) => setForm({ ...form, username: event.target.value })}
              placeholder="WebDAV 用户名（可选）"
              className="w-full rounded-lg border border-cslab-border bg-cslab-bg px-2.5 py-1.5 text-[11px] text-cslab-text placeholder:text-cslab-muted/60 focus:outline-none"
            />
            <input
              value={form.password}
              type="password"
              onChange={(event) => setForm({ ...form, password: event.target.value })}
              placeholder="WebDAV 密码（可选）"
              className="w-full rounded-lg border border-cslab-border bg-cslab-bg px-2.5 py-1.5 text-[11px] text-cslab-text placeholder:text-cslab-muted/60 focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={() => void handleAdd()}
            disabled={busyId === 'new'}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-cslab-accent px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-cslab-accentHover disabled:opacity-50"
          >
            {busyId === 'new' ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
            登记并开始监听
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 px-1 py-6 text-[11px] text-cslab-muted">
          <Loader2 size={12} className="animate-spin" />
          正在读取共享盘状态…
        </div>
      ) : sources.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-cslab-border px-4 py-10 text-center">
          <HardDrive size={20} className="text-cslab-muted/60" />
          <p className="mt-2 font-serif text-sm text-cslab-text">尚未登记共享盘</p>
          <p className="mt-1 text-[11px] leading-relaxed text-cslab-muted">
            支持 UNC（\\server\share）、smb://、WebDAV 与本地目录。
          </p>
        </div>
      ) : (
        sources.map((source) => {
          const list = candidatesBySource.get(source.id) ?? []
          const busy = busyId === source.id
          return (
            <section
              key={source.id}
              className="rounded-xl border border-cslab-border bg-cslab-elevated p-3 shadow-subtle"
            >
              <header className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'size-1.5 shrink-0 rounded-full',
                        source.status === 'online'
                          ? 'bg-emerald-500'
                          : source.status === 'error'
                            ? 'bg-red-500'
                            : 'bg-cslab-border',
                      )}
                    />
                    <h4 className="truncate font-serif text-sm text-cslab-text">{source.label}</h4>
                    <span className="shrink-0 rounded bg-cslab-surface px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-cslab-muted">
                      {KIND_LABELS[source.kind]}
                    </span>
                  </div>
                  <p className="mt-1 truncate font-mono text-[10px] text-cslab-muted">
                    {source.rootPath}
                  </p>
                  <p className="mt-1 text-[10px] text-cslab-muted">
                    水位 {formatTime(source.watermarkMs)} · 上次扫描 {formatTime(source.lastScanAt)} ·{' '}
                    {source.candidateCount} 个候选
                  </p>
                  {source.message && (
                    <p className="mt-1 text-[10px] leading-relaxed text-amber-600">{source.message}</p>
                  )}
                </div>
                {busy && <Loader2 size={12} className="mt-1 shrink-0 animate-spin text-cslab-accent" />}
              </header>

              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void runAction(source.id, () =>
                      window.electronAPI.cslab.testShareSource({ labId, sourceId: source.id }),
                    )
                  }
                  className="inline-flex items-center gap-1 rounded-md border border-cslab-border px-2 py-1 text-[10px] text-cslab-muted transition-colors hover:bg-cslab-surface hover:text-cslab-text disabled:opacity-50"
                >
                  <FolderSearch size={10} /> 测试
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void runAction(source.id, () =>
                      window.electronAPI.cslab.scanShareNow({ labId, sourceId: source.id }),
                    )
                  }
                  className="inline-flex items-center gap-1 rounded-md border border-cslab-border px-2 py-1 text-[10px] text-cslab-muted transition-colors hover:bg-cslab-surface hover:text-cslab-text disabled:opacity-50"
                >
                  <RefreshCw size={10} /> 立即扫描
                </button>
                {source.watching ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void runAction(source.id, () =>
                        window.electronAPI.cslab.stopShareWatch({ labId, sourceId: source.id }),
                      )
                    }
                    className="inline-flex items-center gap-1 rounded-md border border-cslab-border px-2 py-1 text-[10px] text-cslab-muted transition-colors hover:bg-cslab-surface hover:text-cslab-text disabled:opacity-50"
                  >
                    <Square size={10} /> 停止监听
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void runAction(source.id, async () => {
                        await window.electronAPI.cslab.startShareWatch(labId)
                        return { message: '共享盘监听已启动' }
                      })
                    }
                    className="inline-flex items-center gap-1 rounded-md border border-cslab-border px-2 py-1 text-[10px] text-cslab-muted transition-colors hover:bg-cslab-surface hover:text-cslab-text disabled:opacity-50"
                  >
                    <Play size={10} /> 开始监听
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void runAction(source.id, async () => {
                      await window.electronAPI.cslab.removeShareSource({ labId, sourceId: source.id })
                      return { message: '已移除共享源' }
                    })
                  }
                  className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] text-cslab-muted transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                >
                  <Trash2 size={10} /> 移除
                </button>
              </div>

              {list.length > 0 && (
                <ul className="mt-3 space-y-1.5">
                  {list.slice(0, 40).map((candidate) => (
                    <li
                      key={candidate.id}
                      className="rounded-lg border border-cslab-border/70 bg-cslab-bg px-2 py-1.5"
                    >
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={!candidate.assetUri || !onOpenAsset}
                          onClick={() => candidate.assetUri && onOpenAsset?.(candidate.assetUri)}
                          className="min-w-0 flex-1 truncate text-left font-mono text-[10px] text-cslab-text transition-colors hover:text-cslab-accent disabled:cursor-default disabled:hover:text-cslab-text"
                        >
                          {candidate.relPath}
                        </button>
                        <span
                          className={cn(
                            'shrink-0 rounded px-1.5 py-0.5 text-[9px]',
                            STATE_CLASSES[candidate.state],
                          )}
                        >
                          {STATE_LABELS[candidate.state]}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[9px] text-cslab-muted">
                        <span>{formatBytes(candidate.size)}</span>
                        <span className="text-cslab-border">·</span>
                        <span>{LEASE_LABELS[candidate.leaseType]}</span>
                        {candidate.attempts > 1 && (
                          <>
                            <span className="text-cslab-border">·</span>
                            <span className="tabular-nums">第 {candidate.attempts} 次尝试</span>
                          </>
                        )}
                        {candidate.sha256 && (
                          <>
                            <span className="text-cslab-border">·</span>
                            <span className="font-mono">SHA {candidate.sha256.slice(0, 10)}…</span>
                          </>
                        )}
                      </div>
                      {candidate.message && (
                        <p className="mt-0.5 text-[9px] leading-relaxed text-amber-600">
                          {candidate.message}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )
        })
      )}
    </div>
  )
}
