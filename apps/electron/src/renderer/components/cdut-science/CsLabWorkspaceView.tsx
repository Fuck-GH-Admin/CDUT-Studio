/**
 * CsLabWorkspaceView — CDUT Science 核心业务工作台
 *
 * 模块代号：CSLab
 * 架构设计重点：
 * 1. 业务主界面独立于权限门禁（CsLabAuthGate），未来移除或跳过门禁时直接作为核心视图挂载。
 * 2. 字体生态：完全采用客户端原生态字体（font-sans），自然优雅、层次清晰。
 * 3. 极简大气：留白充分，支持直接在此接入后续实验室业务子模块与工具矩阵。
 */

import * as React from 'react'
import { useSetAtom } from 'jotai'
import { Lock, Sparkles, CheckCircle2, FlaskConical, Atom } from 'lucide-react'
import { cslabAuthAtom } from '@/atoms/cslab-atoms'

export function CsLabWorkspaceView(): React.ReactElement {
  const setAuth = useSetAtom(cslabAuthAtom)

  const handleRelock = () => {
    setAuth({ isVerified: false })
  }

  return (
    <div className="w-full max-w-2xl flex flex-col items-center text-center font-sans">
      {/* 业务状态徽章 */}
      <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-cyan-500/25 bg-cyan-50/80 px-3.5 py-1 text-xs font-medium text-cyan-800 shadow-sm backdrop-blur-md">
        <Sparkles size={13} className="text-cyan-600" />
        <span>中央实验室权限已接入</span>
        <span className="text-cyan-300">|</span>
        <span className="text-cyan-600">CSLab-NX 业务工作台</span>
      </div>

      {/* 业务界面主卡片 */}
      <div className="w-full rounded-2xl border border-black/[0.06] bg-white/75 p-8 backdrop-blur-2xl shadow-[0_20px_50px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.03)]">
        <div className="flex flex-col items-center space-y-4">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-gradient-to-tr from-cyan-500/15 to-sky-500/20 text-cyan-700 shadow-inner">
            <Atom size={28} className="animate-spin-slow" />
          </div>

          <div className="space-y-1.5">
            <h2 className="text-xl sm:text-2xl font-semibold tracking-tight text-slate-900">
              CDUT Science 业务系统已就绪
            </h2>
            <p className="text-sm text-slate-500 max-w-md mx-auto leading-relaxed">
              实验室模块架构与通信管道已完全接入。后续科研业务组件、交互面板与计算能力可直接插拔部署。
            </p>
          </div>

          <div className="pt-4 flex items-center gap-3">
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-50 text-xs font-medium text-emerald-700 border border-emerald-200/60">
              <CheckCircle2 size={13} />
              <span>权限通行正常</span>
            </div>

            <button
              type="button"
              onClick={handleRelock}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-50 hover:bg-slate-100 text-xs font-medium text-slate-600 hover:text-slate-900 border border-slate-200/80 transition-colors"
            >
              <Lock size={12} />
              <span>重新锁定</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
