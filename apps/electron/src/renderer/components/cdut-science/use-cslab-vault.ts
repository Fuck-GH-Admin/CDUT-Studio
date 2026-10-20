/**
 * useCsLabVault — Vault 索引生命周期
 *
 * 负责启动/停止 Chokidar（显式 close 释放 Windows 目录句柄）、增量重建索引，
 * 并在外部变更事件到来时刷新笔记列表与索引状态。
 */

import { useCallback, useEffect, useRef } from 'react'
import { useAtom } from 'jotai'
import {
  cslabNotesAtom,
  cslabVaultIndexAtom,
} from '@/atoms/cslab-atoms'

export function useCsLabVault(
  labId: string,
  onAssetsChanged?: () => void,
): {
  refresh: () => Promise<void>
  rebuild: (force?: boolean) => Promise<void>
} {
  const [, setNotes] = useAtom(cslabNotesAtom)
  const [, setStatus] = useAtom(cslabVaultIndexAtom)
  const assetsChangedRef = useRef(onAssetsChanged)
  assetsChangedRef.current = onAssetsChanged

  const refresh = useCallback(async (): Promise<void> => {
    const [notes, status] = await Promise.all([
      window.electronAPI.cslab.listVaultNotes(labId),
      window.electronAPI.cslab.getVaultIndexStatus(labId),
    ])
    setNotes(notes)
    setStatus(status)
  }, [labId, setNotes, setStatus])

  const rebuild = useCallback(
    async (force = false): Promise<void> => {
      const result = await window.electronAPI.cslab.rebuildVaultIndex({ labId, force })
      setStatus(result.status)
      await refresh()
      void Promise.resolve(assetsChangedRef.current?.()).catch(() => undefined)
    },
    [labId, refresh, setStatus],
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        await window.electronAPI.cslab.startVaultWatch(labId)
        const result = await window.electronAPI.cslab.rebuildVaultIndex({ labId })
        if (cancelled) return
        setStatus(result.status)
        await refresh()
        void Promise.resolve(assetsChangedRef.current?.()).catch(() => undefined)
      } catch (error) {
        console.warn('[CSLab] Vault 初始化失败:', error)
      }
    })()

    const off = window.electronAPI.cslab.onVaultChanged((event) => {
      if (event.labId !== labId) return
      void refresh().catch(() => undefined)
      void Promise.resolve(assetsChangedRef.current?.()).catch(() => undefined)
    })

    return () => {
      cancelled = true
      off()
      void window.electronAPI.cslab.stopVaultWatch(labId).catch(() => undefined)
    }
  }, [labId, refresh, setStatus])

  return { refresh, rebuild }
}
