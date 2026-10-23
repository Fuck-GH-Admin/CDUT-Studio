/**
 * CdutScienceView — CDUT Science 专区全屏独立视图
 *
 * 模块代号：CSLab
 * 架构解耦：
 * 1. 本机访问密码门禁（<CsLabAuthGate>）首次启用设密、后续进入验密。
 * 2. 授权成功后进入 CSLab 实验室选择页（CsLabPreparationView），并由 AppShell 完全隐藏主侧边栏。
 * 3. 视觉语言：暖调编辑式极简（羊皮纸底 + 赤陶强调 + 发丝细边框 + 大面积留白）。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { detectIsWindows } from '@profer/ui'
import { WindowControlsHost } from '@/components/WindowControlsTemplate'
import { resolveWindowControlsRightInset } from '@/lib/window-controls-layout'
import { cslabActiveLabIdAtom, cslabAuthAtom } from '@/atoms/cslab-atoms'
import { CsLabAuthGate } from './CsLabAuthGate'
import { CsLabPreparationView } from './CsLabPreparationView'
import { CsLabWorkspaceView } from './CsLabWorkspaceView'

export function CdutScienceView(): React.ReactElement {
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  const auth = useAtomValue(cslabAuthAtom)
  const setAuth = useSetAtom(cslabAuthAtom)
  const activeLabId = useAtomValue(cslabActiveLabIdAtom)

  // 首屏与主进程同步真实门禁状态；失败时安全降级为「需要验密」
  React.useEffect(() => {
    let cancelled = false

    const syncAuthStatus = async (): Promise<void> => {
      try {
        const status = await window.electronAPI.cslab.getAuthStatus()
        if (!cancelled) setAuth({ ...status, hydrated: true })
      } catch {
        if (!cancelled) setAuth({ isInitialized: true, isVerified: false, hydrated: true })
      }
    }

    void syncAuthStatus()
    return () => {
      cancelled = true
    }
  }, [setAuth])

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-cslab-bg font-sans text-cslab-text">
      {/* 暖色径向渐变：颜色全部走 CSLab 语义变量，深色下自动切换为暖石墨 */}
      <div
        className="pointer-events-none absolute inset-0 z-0"
        style={{
          backgroundImage:
            'radial-gradient(120% 90% at 50% -10%, hsl(var(--cslab-highlight)) 0%, hsl(var(--cslab-bg)) 46%, hsl(var(--cslab-surface)) 100%)',
        }}
        aria-hidden="true"
      />

      {/* ================= 顶栏冲突隔离 (Top Bar Conflict Isolation) ================= */}
      <div
        className="absolute inset-x-0 top-0 z-10 h-10 titlebar-drag-region"
        style={{ right: resolveWindowControlsRightInset(isWindows) }}
        aria-hidden="true"
      />
      <WindowControlsHost id="cdut-science-main" priority={20} className="absolute right-2 top-[3px] z-30" />

      {!auth.hydrated ? (
        <div className="relative z-10 flex min-h-0 flex-1 items-center justify-center">
          <p className="text-xs tracking-[0.18em] text-cslab-muted">正在读取本机门禁状态…</p>
        </div>
      ) : auth.isVerified ? (
        <div className="relative z-10 flex min-h-0 flex-1 flex-col">
          {activeLabId ? <CsLabWorkspaceView labId={activeLabId} /> : <CsLabPreparationView />}
        </div>
      ) : (
        // ================= 本机访问密码门禁 =================
        <div className="relative z-10 flex min-h-0 flex-1 justify-center overflow-y-auto px-6 pb-16 pt-20 sm:pt-24">
          <div className="w-full max-w-3xl">
            <div className="mx-auto max-w-xl animate-in fade-in slide-in-from-bottom-1 text-center duration-500">
              <p className="text-[10px] font-medium uppercase tracking-[0.32em] text-cslab-accent">
                CSLab · Research Workspace
              </p>
              <h1 className="mt-4 font-serif text-5xl font-medium tracking-tight text-cslab-text sm:text-6xl">
                CDUT Science
              </h1>
              <p className="mt-3 font-serif text-lg text-cslab-muted sm:text-xl">
                成都理工大学 · 科研智能工作台
              </p>
            </div>

            <div className="mt-10 flex justify-center">
              <CsLabAuthGate />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
