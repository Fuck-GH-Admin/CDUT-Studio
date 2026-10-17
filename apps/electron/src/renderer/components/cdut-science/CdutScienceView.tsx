/**
 * CdutScienceView — CDUT Science 极简纯白高定未来科幻画布
 *
 * 模块代号：CSLab
 * 视觉哲学：纯净浅色系（Pristine Titanium / Ethereal Light Canvas）
 * 灵感源自高定未来声学实验室与纯净光学天体物理场，以水蓝光芒、微棱镜折射与高精轨道环作画
 * 纯粹克制：绝无任何冗余文字干扰，仅保留标题、安全认证组件与指定双语告示
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import {
  KeyRound,
  ShieldCheck,
  Eye,
  EyeOff,
  CheckCircle2,
  AlertTriangle,
  Lock,
} from 'lucide-react'
import { detectIsWindows } from '@profer/ui'
import { cn } from '@/lib/utils'
import { WindowControlsHost } from '@/components/WindowControlsTemplate'
import { resolveWindowControlsRightInset } from '@/lib/window-controls-layout'
import {
  cslabAuthAtom,
  hashKeyClient,
  CSLAB_TARGET_HASH,
} from '@/atoms/cslab-atoms'

interface Particle {
  x: number
  y: number
  size: number
  speedX: number
  speedY: number
  alpha: number
  maxAlpha: number
  pulseSpeed: number
  color: string
}

export function CdutScienceView(): React.ReactElement {
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  const [auth, setAuth] = useAtom(cslabAuthAtom)

  // 认证输入
  const [inputKey, setInputKey] = React.useState('')
  const [showKey, setShowKey] = React.useState(false)
  const [verifying, setVerifying] = React.useState(false)
  const [errorStatus, setErrorStatus] = React.useState<string | null>(null)
  const [successNotice, setSuccessNotice] = React.useState(false)

  // Canvas 引用与动效状态
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const mouseRef = React.useRef({ x: 0, y: 0, targetX: 0, targetY: 0 })

  // 纯净浅色动态光学量子画布引擎
  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let animationFrameId: number
    let width = (canvas.width = canvas.parentElement?.clientWidth || window.innerWidth)
    let height = (canvas.height = canvas.parentElement?.clientHeight || window.innerHeight)

    const handleResize = () => {
      if (!canvas.parentElement) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      width = canvas.parentElement.clientWidth
      height = canvas.parentElement.clientHeight
      canvas.width = width * dpr
      canvas.height = height * dpr
      ctx.scale(dpr, dpr)
    }

    handleResize()
    window.addEventListener('resize', handleResize)

    // 晶莹微尘粒子
    const colors = [
      'rgba(6, 182, 212, 0.45)', // 水天青
      'rgba(99, 102, 241, 0.35)', // 浅靛蓝
      'rgba(56, 189, 248, 0.4)', // 冰蓝
    ]
    const particleCount = 70
    const particles: Particle[] = []
    for (let i = 0; i < particleCount; i++) {
      particles.push({
        x: Math.random() * width,
        y: Math.random() * height,
        size: Math.random() * 1.6 + 0.6,
        speedX: (Math.random() - 0.5) * 0.2,
        speedY: (Math.random() - 0.5) * 0.2,
        alpha: Math.random() * 0.5 + 0.15,
        maxAlpha: Math.random() * 0.5 + 0.35,
        pulseSpeed: Math.random() * 0.015 + 0.005,
        color: colors[i % colors.length] ?? 'rgba(6, 182, 212, 0.45)',
      })
    }

    let angle = 0

    const render = () => {
      // 鼠标平滑缓动
      mouseRef.current.x += (mouseRef.current.targetX - mouseRef.current.x) * 0.04
      mouseRef.current.y += (mouseRef.current.targetY - mouseRef.current.y) * 0.04

      // 清屏为纯净的高级极光白与珍珠灰（#f8fafc）
      ctx.fillStyle = '#f8fafc'
      ctx.fillRect(0, 0, width, height)

      const centerX = width / 2 + mouseRef.current.x * 18
      const centerY = height * 0.42 + mouseRef.current.y * 18

      angle += 0.006
      const pulse = Math.sin(angle * 2)

      // 1. 核心棱镜折射柔光 (Prismatic Caustic Aura)
      const auraRadius = Math.max(width, height) * 0.42
      const aura = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, auraRadius)
      aura.addColorStop(0, 'rgba(224, 242, 254, 0.85)') // 冰天水白
      aura.addColorStop(0.3, 'rgba(238, 242, 255, 0.5)') // 柔紫光
      aura.addColorStop(0.65, 'rgba(248, 250, 252, 0.2)')
      aura.addColorStop(1, 'transparent')

      ctx.fillStyle = aura
      ctx.beginPath()
      ctx.arc(centerX, centerY, auraRadius, 0, Math.PI * 2)
      ctx.fill()

      // 2. 悬浮晶莹粒子 (Crystalline Floating Dust)
      for (const p of particles) {
        p.x += p.speedX
        p.y += p.speedY
        p.alpha += p.pulseSpeed
        if (p.alpha > p.maxAlpha || p.alpha < 0.1) {
          p.pulseSpeed = -p.pulseSpeed
        }

        if (p.x < 0) p.x = width
        if (p.x > width) p.x = 0
        if (p.y < 0) p.y = height
        if (p.y > height) p.y = 0

        ctx.globalAlpha = Math.max(0, Math.min(1, p.alpha))
        ctx.fillStyle = p.color
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1.0

      // 3. 高精度天体光学细线环 (Precision Titanium Optical Rings)
      const baseR = 175 + pulse * 4

      // 外同心微刻度环
      ctx.save()
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.07)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(centerX, centerY, baseR * 1.55, 0, Math.PI * 2)
      ctx.stroke()

      // 外虚线细环
      ctx.strokeStyle = 'rgba(6, 182, 212, 0.22)'
      ctx.setLineDash([4, 14])
      ctx.beginPath()
      ctx.arc(centerX, centerY, baseR * 1.35, 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()

      // 动态旋转天体弧段（青蓝激光）
      ctx.save()
      ctx.strokeStyle = 'rgba(6, 182, 212, 0.65)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(centerX, centerY, baseR * 1.15, angle, angle + Math.PI * 0.7)
      ctx.stroke()

      // 逆向浅靛蓝对称弧
      ctx.strokeStyle = 'rgba(99, 102, 241, 0.45)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(centerX, centerY, baseR * 1.15, -angle * 1.2 + Math.PI, -angle * 1.2 + Math.PI * 1.5)
      ctx.stroke()
      ctx.restore()

      // 内层微米光学标尺环
      ctx.save()
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.09)'
      ctx.setLineDash([2, 6])
      ctx.beginPath()
      ctx.arc(centerX, centerY, baseR * 0.88, 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()

      // 4. 极简光学十字对焦丝 (Minimal Optical Reticle)
      ctx.strokeStyle = 'rgba(6, 182, 212, 0.3)'
      ctx.lineWidth = 1
      const reticleGap = baseR * 0.8
      const reticleLen = 30

      // 水平丝
      ctx.beginPath()
      ctx.moveTo(centerX - reticleGap - reticleLen, centerY)
      ctx.lineTo(centerX - reticleGap, centerY)
      ctx.moveTo(centerX + reticleGap, centerY)
      ctx.lineTo(centerX + reticleGap + reticleLen, centerY)
      ctx.stroke()

      // 垂直丝
      ctx.beginPath()
      ctx.moveTo(centerX, centerY - reticleGap - reticleLen)
      ctx.lineTo(centerX, centerY - reticleGap)
      ctx.moveTo(centerX, centerY + reticleGap)
      ctx.lineTo(centerX, centerY + reticleGap + reticleLen)
      ctx.stroke()

      // 中心晶态微圆点
      ctx.fillStyle = 'rgba(6, 182, 212, 0.7)'
      ctx.beginPath()
      ctx.arc(centerX, centerY, 2, 0, Math.PI * 2)
      ctx.fill()

      animationFrameId = requestAnimationFrame(render)
    }

    render()

    const onMouseMove = (ev: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      mouseRef.current.targetX = ((ev.clientX - rect.left) / width - 0.5) * 2
      mouseRef.current.targetY = ((ev.clientY - rect.top) / height - 0.5) * 2
    }

    window.addEventListener('mousemove', onMouseMove)

    return () => {
      cancelAnimationFrame(animationFrameId)
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('mousemove', onMouseMove)
    }
  }, [])

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
        setTimeout(() => setSuccessNotice(false), 2500)
      } else {
        setErrorStatus('ACCESS DENIED // 密钥校验未通过')
      }
    } catch {
      setErrorStatus('CRYPT_FAULT // 散列异常')
    } finally {
      setVerifying(false)
    }
  }

  const handleRevokeAuth = () => {
    setAuth({ isVerified: false })
    setInputKey('')
    setErrorStatus(null)
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[#f8fafc] select-none text-slate-800 font-sans">
      {/* ================= 顶栏冲突隔离 (Top Bar Conflict Isolation) ================= */}
      <div
        className="absolute inset-x-0 top-0 z-10 h-10 titlebar-drag-region"
        style={{ right: resolveWindowControlsRightInset(isWindows) }}
        aria-hidden="true"
      />
      <WindowControlsHost id="cdut-science-main" priority={20} className="absolute right-2 top-[3px] z-30" />

      {/* 纯浅色系动态天体光学画布 */}
      <canvas ref={canvasRef} className="absolute inset-0 z-0 pointer-events-none" />

      {/* ================= 极简悬浮内容区 ================= */}
      <div className="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-12">
        <div className="w-full max-w-xl flex flex-col items-center text-center">

          {/* ===== Hero Title & Typography ===== */}
          <div className="relative mb-10 select-none">
            {/* 柔和浅色环境光晕 */}
            <div className="absolute inset-0 -top-2 flex items-center justify-center opacity-40 blur-3xl pointer-events-none">
              <span className="font-mono text-6xl sm:text-7xl md:text-8xl font-black text-cyan-200">
                CDUT Science
              </span>
            </div>

            {/* 中心巨幅纯净高定标题 */}
            <h1 className="relative font-mono text-4xl sm:text-6xl md:text-7xl font-extralight uppercase tracking-[0.24em] text-transparent bg-clip-text bg-gradient-to-b from-slate-950 via-slate-800 to-slate-600 drop-shadow-[0_2px_20px_rgba(6,182,212,0.16)]">
              CDUT Science
            </h1>
          </div>

          {/* ===== Access Authentication Component (授权认证组件) ===== */}
          <div className="w-full max-w-md mb-8">
            <div className="relative rounded-2xl border border-black/[0.06] bg-white/70 p-4 backdrop-blur-2xl shadow-[0_20px_50px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.03)] transition-all hover:border-cyan-500/30">
              {auth.isVerified ? (
                /* 已授权状态展示 */
                <div className="flex items-center justify-between px-3 py-2">
                  <div className="flex items-center gap-2.5">
                    <span className="size-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
                    <span className="font-mono text-xs tracking-wider text-slate-800 font-medium">
                      ACCESS GRANTED // LEVEL-OMEGA
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={handleRevokeAuth}
                    className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 font-mono text-[11px] text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition-colors"
                  >
                    <Lock size={11} />
                    <span>RELOCK</span>
                  </button>
                </div>
              ) : (
                /* 未授权：浅色高定输入框 */
                <form onSubmit={handleVerify} className="space-y-3">
                  <div className="relative flex items-center rounded-xl border border-slate-200/80 bg-white/80 px-3.5 py-2.5 transition-all focus-within:border-cyan-500 focus-within:bg-white focus-within:ring-2 focus-within:ring-cyan-500/20">
                    <KeyRound size={14} className="text-cyan-600 mr-2.5 shrink-0" />
                    <input
                      type={showKey ? 'text' : 'password'}
                      value={inputKey}
                      onChange={(e) => setInputKey(e.target.value)}
                      placeholder="Access Key..."
                      disabled={verifying}
                      className="w-full bg-transparent font-mono text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey(!showKey)}
                      className="ml-2 text-slate-400 hover:text-slate-700 transition-colors"
                    >
                      {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>

                  {errorStatus && (
                    <div className="flex items-center justify-center gap-1.5 font-mono text-xs text-rose-500 py-1">
                      <AlertTriangle size={13} />
                      <span>{errorStatus}</span>
                    </div>
                  )}

                  {successNotice && (
                    <div className="flex items-center justify-center gap-1.5 font-mono text-xs text-emerald-600 py-1">
                      <CheckCircle2 size={13} />
                      <span>AUTHENTICATED</span>
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={verifying || !inputKey.trim()}
                    className={cn(
                      'w-full flex items-center justify-center gap-2 rounded-xl py-2.5 font-mono text-xs font-medium tracking-widest transition-all duration-200',
                      inputKey.trim() && !verifying
                        ? 'bg-slate-900 text-white hover:bg-slate-800 shadow-[0_4px_14px_rgba(0,0,0,0.12)] cursor-pointer'
                        : 'bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200/60',
                    )}
                  >
                    <ShieldCheck size={13} />
                    <span>{verifying ? 'VERIFYING' : 'AUTHENTICATE'}</span>
                  </button>
                </form>
              )}
            </div>
          </div>

          {/* ===== Bilingual Teaser & Status Notice (双语告示与遥测卡片) ===== */}
          <div className="w-full max-w-lg">
            <div className="relative rounded-2xl border border-black/[0.06] bg-white/70 p-5 backdrop-blur-2xl shadow-[0_16px_36px_rgba(0,0,0,0.04),0_1px_2px_rgba(0,0,0,0.02)]">
              {/* 中文在顶 */}
              <div className="text-sm sm:text-base font-normal tracking-wide text-slate-800 leading-relaxed">
                雫窝中央实验室已接管 CDUT Science 开发，敬请期待！
              </div>

              {/* 英文在底：严格遵循 Google 紧凑系统遥测风格，is not available 保持完整绝不缩写 */}
              <div className="mt-3 pt-3 border-t border-slate-200/70 font-mono text-xs text-slate-500 leading-relaxed tracking-normal">
                CDUT Science is not available right now. Nya-Home Central Laboratory has taken over development. Stay tuned!
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  )
}
