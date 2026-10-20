/**
 * CsLabZoteroPanel — Zotero 只读同步控制台
 *
 * 只负责触发发现/同步/监听与展示状态；所有写库行为均被主进程禁止。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { FolderSearch, Loader2, RefreshCw, Radio, Square } from 'lucide-react'
import type { CsLabZoteroStatus } from '@profer/shared'
import { cn } from '@/lib/utils'
import { cslabZoteroStatusAtom } from '@/atoms/cslab-atoms'

interface CsLabZoteroPanelProps {
  labId: string
  onChanged: () => void
}

const AVAILABILITY_LABEL: Record<CsLabZoteroStatus['availability'], string> = {
  ready: '可用',
  'not-found': '未找到数据库',
  'no-permission': '无法读取',
  'schema-unsupported': '库结构不支持',
}

export function CsLabZoteroPanel({ labId, onChanged }: CsLabZoteroPanelProps): React.ReactElement {
  const [status, setStatus] = useAtom(cslabZoteroStatusAtom)
  const [busy, setBusy] = React.useState<'discover' | 'sync' | 'watch' | null>(null)
  const [message, setMessage] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const refresh = React.useCallback(async (): Promise<void> => {
    try {
      const next = await window.electronAPI.cslab.getZoteroStatus(labId)
      setStatus(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : '状态读取失败')
    }
  }, [labId, setStatus])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const discover = async (): Promise<void> => {
    setBusy('discover')
    setError(null)
    setMessage(null)
    try {
      const discovery = await window.electronAPI.cslab.discoverZotero({ labId })
      setStatus(discovery.status)
      setMessage(discovery.status.message)
    } catch (err) {
      setError(err instanceof Error ? err.message : '发现失败')
    } finally {
      setBusy(null)
    }
  }

  const pickDataDir = async (): Promise<void> => {
    try {
      const result = await window.electronAPI.openFolderDialog()
      const path = result?.path
      if (!path) return
      setBusy('discover')
      const discovery = await window.electronAPI.cslab.setZoteroDataDir({ labId, dataDir: path })
      setStatus(discovery.status)
      setMessage(discovery.status.message)
    } catch (err) {
      setError(err instanceof Error ? err.message : '数据目录设置失败')
    } finally {
      setBusy(null)
    }
  }

  const sync = async (forceFull = false): Promise<void> => {
    setBusy('sync')
    setError(null)
    setMessage(null)
    try {
      const result = await window.electronAPI.cslab.syncZotero({ labId, forceFull })
      setMessage(result.message)
      await refresh()
      if (result.ok) onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : '同步失败')
    } finally {
      setBusy(null)
    }
  }

  const toggleWatch = async (): Promise<void> => {
    setBusy('watch')
    setError(null)
    try {
      if (status?.watching) {
        await window.electronAPI.cslab.stopZoteroWatch(labId)
        setMessage('已停止 WAL 监听')
      } else {
        const handle = await window.electronAPI.cslab.startZoteroWatch(labId)
        setMessage(handle.message)
      }
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '监听操作失败')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-cslab-border bg-cslab-surface p-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-[0.14em] text-cslab-muted">连接状态</span>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[10px]',
              status?.availability === 'ready'
                ? 'bg-cslab-accent/12 text-cslab-accent'
                : 'bg-cslab-border/60 text-cslab-muted',
            )}
          >
            {status ? AVAILABILITY_LABEL[status.availability] : '未探测'}
          </span>
        </div>
        <p className="mt-2 break-all font-mono text-[10px] leading-relaxed text-cslab-text">
          {status?.dataDir ?? '尚未找到 zotero.sqlite'}
        </p>
        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          {[
            { label: '已同步', value: status?.itemCount ?? 0 },
            { label: '批注', value: status?.annotationCount ?? 0 },
            { label: '监听', value: status?.watching ? '开' : '关' },
          ].map((item) => (
            <div key={item.label} className="rounded-lg border border-cslab-border bg-cslab-bg px-2 py-1.5">
              <p className="text-[9px] uppercase tracking-[0.1em] text-cslab-muted">{item.label}</p>
              <p className="mt-0.5 font-serif text-base tabular-nums text-cslab-text">{item.value}</p>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-cslab-muted">
          {status?.lastSyncedAt
            ? `上次同步：${new Date(status.lastSyncedAt).toLocaleString('zh-CN', { hour12: false })}`
            : '尚未同步'}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void discover()}
          className="inline-flex items-center justify-center gap-1 rounded-lg border border-cslab-border px-2 py-2 text-[11px] text-cslab-text transition-colors hover:bg-cslab-surface disabled:opacity-50"
        >
          {busy === 'discover' ? <Loader2 size={11} className="animate-spin" /> : <FolderSearch size={11} />}
          重新发现
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void pickDataDir()}
          className="inline-flex items-center justify-center gap-1 rounded-lg border border-cslab-border px-2 py-2 text-[11px] text-cslab-text transition-colors hover:bg-cslab-surface disabled:opacity-50"
        >
          选择数据目录
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void sync(false)}
          className="inline-flex items-center justify-center gap-1 rounded-lg bg-cslab-accent px-2 py-2 text-[11px] font-medium text-white transition-colors hover:bg-cslab-accentHover disabled:opacity-50"
        >
          {busy === 'sync' ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
          立即同步
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void toggleWatch()}
          className="inline-flex items-center justify-center gap-1 rounded-lg border border-cslab-border px-2 py-2 text-[11px] text-cslab-text transition-colors hover:bg-cslab-surface disabled:opacity-50"
        >
          {status?.watching ? <Square size={11} /> : <Radio size={11} />}
          {status?.watching ? '停止监听' : '开启监听'}
        </button>
      </div>

      <button
        type="button"
        disabled={busy !== null}
        onClick={() => void sync(true)}
        className="w-full rounded-lg border border-dashed border-cslab-border px-2 py-1.5 text-[10px] text-cslab-muted transition-colors hover:bg-cslab-surface hover:text-cslab-text disabled:opacity-50"
      >
        强制全量重建索引游标
      </button>

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

      <div className="rounded-xl border border-cslab-border p-3">
        <p className="text-[10px] uppercase tracking-[0.14em] text-cslab-muted">写回桥接（预留）</p>
        <p className="mt-1 text-[10px] leading-relaxed text-cslab-muted">
          {status?.bridge.message ?? '本阶段仅只读同步，绝不写入 zotero.sqlite'}
        </p>
      </div>

      <p className="text-[10px] leading-relaxed text-cslab-muted">
        Zotero 运行时 WAL 可能被占用；系统会自动重试，仍失败时仅基于主库快照同步，不会中断。
      </p>
    </div>
  )
}
