/**
 * CsLabAuthGate — CDUT Science 独立权限门禁与密钥填写组件
 *
 * 架构设计重点（模块化）：
 * 1. 业务完全解耦：独立封装授权认证逻辑与双语告示卡片，未来可一键剥离或设置 bypassAuth，直接进入内部业务界面。
 * 2. 字体生态：完全采用客户端原生态系统字体（font-sans），杜绝生硬简陋的等宽字体。
 * 3. 安全规范：明文密钥绝不落盘，仅通过 Web Crypto API 计算 SHA-256 单向散列后持久化。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import {
  KeyRound,
  ShieldCheck,
  Eye,
  EyeOff,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  cslabAuthAtom,
  hashKeyClient,
  CSLAB_TARGET_HASH,
} from '@/atoms/cslab-atoms'

export interface CsLabAuthGateProps {
  /** 认证通过后（或门禁移除后）呈现的核心业务视图 */
  children: React.ReactNode
  /**
   * 旁路开关：设为 true 时直接跳过密钥校验进入业务界面。
   * 未来移除门禁时，可直接开启此开关或将本组件从上层树中摘除。
   */
  bypassAuth?: boolean
}

export function CsLabAuthGate({
  children,
  bypassAuth = false,
}: CsLabAuthGateProps): React.ReactElement {
  const [auth, setAuth] = useAtom(cslabAuthAtom)

  const [inputKey, setInputKey] = React.useState('')
  const [showKey, setShowKey] = React.useState(false)
  const [verifying, setVerifying] = React.useState(false)
  const [errorStatus, setErrorStatus] = React.useState<string | null>(null)
  const [successNotice, setSuccessNotice] = React.useState(false)

  // 处理密钥校验
  const handleVerify = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    if (!inputKey.trim() || verifying) return

    setVerifying(true)
    setErrorStatus(null)

    try {
      const computedHash = await hashKeyClient(inputKey)
      let backendValid = false

      if (window.electronAPI?.cslab) {
        const res = await window.electronAPI.cslab.verifyKey(inputKey)
        backendValid = res.success
      } else {
        backendValid = computedHash === CSLAB_TARGET_HASH
      }

      if (computedHash === CSLAB_TARGET_HASH && (backendValid || !window.electronAPI?.cslab)) {
        setAuth({
          isVerified: true,
          keyHash: computedHash,
          verifiedAt: Date.now(),
          clearanceLevel: 'LEVEL-OMEGA',
        })
        setInputKey('')
        setSuccessNotice(true)
        setTimeout(() => setSuccessNotice(false), 2000)
      } else {
        setErrorStatus('访问密钥校验未通过，请核对后重试')
      }
    } catch {
      setErrorStatus('安全散列计算出现异常')
    } finally {
      setVerifying(false)
    }
  }

  // 若已旁路授权或本地已持久化有效授权，直接呈现业务界面
  if (bypassAuth || auth.isVerified) {
    return <>{children}</>
  }

  return (
    <div className="w-full max-w-xl flex flex-col items-center text-center font-sans">
      {/* ===== 授权认证卡片组件 ===== */}
      <div className="w-full max-w-md mb-8">
        <div className="relative rounded-2xl border border-black/[0.08] bg-white/75 p-5 backdrop-blur-2xl shadow-[0_20px_50px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.03)] transition-all hover:border-cyan-500/30">
          <form onSubmit={handleVerify} className="space-y-3.5">
            <div className="relative flex items-center rounded-xl border border-slate-200/90 bg-white/90 px-3.5 py-2.5 transition-all focus-within:border-cyan-500 focus-within:bg-white focus-within:ring-2 focus-within:ring-cyan-500/20 shadow-sm">
              <KeyRound size={16} className="text-cyan-600 mr-2.5 shrink-0" />
              <input
                type={showKey ? 'text' : 'password'}
                value={inputKey}
                onChange={(e) => setInputKey(e.target.value)}
                placeholder="请输入访问密钥..."
                disabled={verifying}
                className="w-full bg-transparent text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="ml-2 text-slate-400 hover:text-slate-700 transition-colors"
                title={showKey ? '隐藏密钥' : '显示密钥'}
              >
                {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>

            {errorStatus && (
              <div className="flex items-center justify-center gap-1.5 text-xs text-rose-500 py-0.5">
                <AlertTriangle size={14} className="shrink-0" />
                <span>{errorStatus}</span>
              </div>
            )}

            {successNotice && (
              <div className="flex items-center justify-center gap-1.5 text-xs text-emerald-600 py-0.5">
                <CheckCircle2 size={14} className="shrink-0" />
                <span>验证成功，正在进入业务界面...</span>
              </div>
            )}

            <button
              type="submit"
              disabled={verifying || !inputKey.trim()}
              className={cn(
                'w-full flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium tracking-wide transition-all duration-200 shadow-sm',
                inputKey.trim() && !verifying
                  ? 'bg-slate-900 text-white hover:bg-slate-800 shadow-[0_4px_14px_rgba(0,0,0,0.12)] cursor-pointer'
                  : 'bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200/60',
              )}
            >
              <ShieldCheck size={15} />
              <span>{verifying ? '正在校验...' : '验证并进入'}</span>
            </button>
          </form>
        </div>
      </div>

      {/* ===== Bilingual Teaser & Status Notice (规范双语告示卡片) ===== */}
      <div className="w-full max-w-lg">
        <div className="relative rounded-2xl border border-black/[0.06] bg-white/70 p-5 backdrop-blur-2xl shadow-[0_16px_36px_rgba(0,0,0,0.04),0_1px_2px_rgba(0,0,0,0.02)]">
          {/* 中文在顶 */}
          <div className="text-sm sm:text-base font-normal tracking-wide text-slate-800 leading-relaxed">
            雫窝中央实验室已接管 CDUT Science 开发，敬请期待！
          </div>

          {/* 英文在底：严格遵循 Google 紧凑系统风格，is not available 保持完整绝不缩写 */}
          <div className="mt-3 pt-3 border-t border-slate-200/70 text-xs sm:text-sm text-slate-500 leading-relaxed tracking-normal">
            CDUT Science is not available right now. Nya-Home Central Laboratory has taken over development. Stay tuned!
          </div>
        </div>
      </div>
    </div>
  )
}
