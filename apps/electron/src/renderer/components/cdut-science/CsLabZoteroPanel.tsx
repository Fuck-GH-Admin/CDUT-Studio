/**
 * CsLabZoteroPanel — Zotero 只读同步控制台
 *
 * 只负责触发发现/同步/监听与展示状态；所有写库行为均被主进程禁止。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { toast } from 'sonner'
import {
  FolderOpen,
  FolderSearch,
  Loader2,
  PlugZap,
  RefreshCw,
  Radio,
  Settings2,
  Square,
} from 'lucide-react'
import type { CsLabZoteroBridgeStatus, CsLabZoteroStatus } from '@profer/shared'
import { cn } from '@/lib/utils'
import { cslabZoteroStatusAtom } from '@/atoms/cslab-atoms'

interface CsLabZoteroPanelProps {
  labId: string
  onChanged: () => void
}



/** 心跳轮询间隔；document.hidden 时暂停。 */
const BRIDGE_POLL_MS = 30_000
const BRIDGE_ENDPOINT_FALLBACK = 'http://127.0.0.1:23119'
const BRIDGE_FAILURE_GUIDE =
  '未检测到 Zotero 本地 REST 插件（端口 23119）。请在 Zotero 中安装并启用 Better BibTeX / Zotero API 插件后重试'

const AVAILABILITY_LABEL: Record<CsLabZoteroStatus['availability'], string> = {
  ready: '可用',
  'not-found': '未找到数据库',
  'no-permission': '无法读取',
  'schema-unsupported': '库结构不支持',
}

export function CsLabZoteroPanel({ labId, onChanged }: CsLabZoteroPanelProps): React.ReactElement {
  const [status, setStatus] = useAtom(cslabZoteroStatusAtom)
  const [busy, setBusy] = React.useState<'discover' | 'sync' | 'watch' | 'probe' | 'init' | null>(null)
  const [message, setMessage] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  /** 写回桥接心跳：绿=已连通 / 黄=探测中 / 红=未连通。 */
  const [bridge, setBridge] = React.useState<CsLabZoteroBridgeStatus | null>(null)
  const [probing, setProbing] = React.useState(false)
  /** 「生成默认配置」成功后展示的 zotero-bridge.json 绝对路径。 */
  const [configPath, setConfigPath] = React.useState<string | null>(null)

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

  /** 探测写回桥接；notify=true 时（手动「测试连通」）toast 端点与实际命中的探测路径。 */
  const probeBridge = React.useCallback(
    async (options?: { notify?: boolean }): Promise<void> => {
      setProbing(true)
      try {
        const next = await window.electronAPI.cslab.getZoteroBridgeStatus()
        setBridge(next)
        if (options?.notify) {
          const endpoint = next.endpoint ?? BRIDGE_ENDPOINT_FALLBACK
          const hit = next.probePath ? ` · 探测路径 ${next.probePath}` : ''
          if (next.reachable) {
            toast.success(`写回桥接已连通：${endpoint}${hit}`)
          } else {
            toast.error(`写回桥接未连通：${endpoint}${hit}。${BRIDGE_FAILURE_GUIDE}`)
          }
        }
      } catch (err) {
        setBridge(null)
        if (options?.notify) {
          toast.error(err instanceof Error ? err.message : '写回桥接探测失败')
        }
      } finally {
        setProbing(false)
      }
    },
    [],
  )

  // 实时心跳：默认 30s 轮询；document.hidden 时暂停，恢复可见立即探测一次。
  React.useEffect(() => {
    const tick = (): void => {
      if (document.hidden) return
      void probeBridge()
    }
    tick()
    const timer = window.setInterval(tick, BRIDGE_POLL_MS)
    const onVisibility = (): void => {
      if (!document.hidden) tick()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [probeBridge])

  /** 生成默认写回桥接配置模板（zotero-bridge.json），成功后展示绝对路径。 */
  const generateConfig = async (): Promise<void> => {
    setBusy('init')
    setError(null)
    try {
      const result = await window.electronAPI.cslab.initZoteroBridgeConfig()
      if (!result.ok) {
        setError(result.message)
        toast.error(result.message)
        return
      }
      setConfigPath(result.configPath)
      setMessage(`${result.message}：${result.configPath}`)
      toast.success(result.message)
      void probeBridge()
    } catch (err) {
      const text = err instanceof Error ? err.message : '默认配置生成失败'
      setError(text)
      toast.error(text)
    } finally {
      setBusy(null)
    }
  }

  const openConfigFolder = async (): Promise<void> => {
    if (!configPath) return
    const opened = await window.electronAPI.showItemInFolder(configPath).catch(() => false)
    if (!opened) toast.error('无法打开配置文件所在文件夹')
  }

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
      setMessage(
        result.lastVersion > 0
          ? `${result.message} · 当前游标 version=${result.lastVersion}`
          : result.message,
      )
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
      <div className="flex items-center gap-2 rounded-xl border border-cslab-border bg-cslab-surface px-3 py-2">
        <span
          aria-hidden
          className={cn(
            'h-2 w-2 shrink-0 rounded-full',
            probing || !bridge
              ? 'animate-pulse bg-amber-400'
              : bridge.reachable
                ? 'bg-emerald-500'
                : 'bg-red-500',
          )}
        />
        <span className="text-[10px] uppercase tracking-[0.14em] text-cslab-muted">写回桥接心跳</span>
        <span className="text-[11px] text-cslab-text">
          {probing || !bridge ? '探测中' : bridge.reachable ? '已连通' : '未连通'}
        </span>
        <span className="ml-auto truncate text-[9px] tabular-nums text-cslab-muted">
          {bridge?.endpoint ?? BRIDGE_ENDPOINT_FALLBACK}
          {bridge?.probePath ? ` · ${bridge.probePath}` : ''}
        </span>
      </div>
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
        title="游标归零全量重放：用于回收被物理删除/清空的 Zotero 条目（增量游标无法感知库级重建）"
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
        <div className="flex items-center justify-between">
          <p className="text-[10px] uppercase tracking-[0.14em] text-cslab-muted">写回桥接</p>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={busy !== null || probing}
              onClick={() => void probeBridge({ notify: true })}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] text-cslab-muted hover:bg-cslab-surface hover:text-cslab-text disabled:opacity-50"
            >
              {probing ? <Loader2 size={9} className="animate-spin" /> : <PlugZap size={9} />}
              测试连通
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void generateConfig()}
              className="inline-flex items-center gap-1 rounded border border-cslab-border px-1.5 py-0.5 text-[9px] text-cslab-muted hover:border-cslab-accent/40 hover:text-cslab-accent disabled:opacity-50"
            >
              {busy === 'init' ? <Loader2 size={9} className="animate-spin" /> : <Settings2 size={9} />}
              生成默认配置
            </button>
          </div>
        </div>
        <p className="mt-1 text-[10px] leading-relaxed text-cslab-text">
          {bridge?.message ?? '正在探测写回桥接…'}
        </p>
        <p className="mt-0.5 break-all font-mono text-[9px] text-cslab-muted">
          {bridge?.endpoint ?? BRIDGE_ENDPOINT_FALLBACK}
          {bridge?.probePath ? `（探测路径 ${bridge.probePath}）` : ''}
        </p>
        {configPath && (
          <div className="mt-2 rounded-lg border border-cslab-border bg-cslab-bg px-2 py-1.5">
            <p className="text-[9px] uppercase tracking-[0.1em] text-cslab-muted">配置文件</p>
            <p className="mt-0.5 break-all font-mono text-[9px] text-cslab-text">{configPath}</p>
            <button
              type="button"
              onClick={() => void openConfigFolder()}
              className="mt-1 inline-flex items-center gap-1 rounded border border-cslab-border px-1.5 py-0.5 text-[9px] text-cslab-muted hover:border-cslab-accent/40 hover:text-cslab-accent"
            >
              <FolderOpen size={9} /> 打开所在文件夹
            </button>
          </div>
        )}
        {bridge && !bridge.reachable && (
          <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5 text-[9px] leading-relaxed text-amber-700">
            {BRIDGE_FAILURE_GUIDE}
          </p>
        )}
        <p className="mt-1.5 text-[9px] leading-relaxed text-cslab-muted">
          工作模式：默认只读同步，绝不写入 zotero.sqlite。写回批注/标签/收藏夹需在 Zotero
          安装「本地 REST」插件（默认端口 23119），并在配置文件
          zotero-bridge.json 中启用 {`{ "enabled": true, "port": 23119, "token?": "..." }`}；
          所有写回经 HTTP 通道携带版本头完成，杜绝直写数据库。
        </p>
      </div>

      <p className="text-[10px] leading-relaxed text-cslab-muted">
        Zotero 运行时 WAL 可能被占用；系统会自动重试，仍失败时仅基于主库快照同步，不会中断。
      </p>
    </div>
  )
}
