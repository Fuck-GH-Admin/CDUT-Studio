/**
 * CdutScienceView — CDUT Science 专区全屏独立视图
 *
 * 模块代号：CSLab
 * 架构解耦：
 * 1. 权限门禁高度模块化（通过 <CsLabAuthGate> 包装），未来可一键剥离或设置 bypassAuth，直接进入内部业务界面。
 * 2. 字体生态：全量采用客户端原生态字体（font-sans），自然平滑、无机械突兀感。
 * 3. 视觉画布：纯净浅色动态光学粒子场，自声明窗口按钮宿主隔离顶栏。
 */

import * as React from 'react'
import { detectIsWindows } from '@profer/ui'
import { WindowControlsHost } from '@/components/WindowControlsTemplate'
import { resolveWindowControlsRightInset } from '@/lib/window-controls-layout'
import { CsLabAuthGate } from './CsLabAuthGate'
import { CsLabWorkspaceView } from './CsLabWorkspaceView'

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

      // 纯净极光浅白底色（#f8fafc）
      ctx.fillStyle = '#f8fafc'
      ctx.fillRect(0, 0, width, height)

      const centerX = width / 2 + mouseRef.current.x * 18
      const centerY = height * 0.38 + mouseRef.current.y * 18

      angle += 0.006
      const pulse = Math.sin(angle * 2)

      // 1. 核心棱镜折射柔光
      const auraRadius = Math.max(width, height) * 0.42
      const aura = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, auraRadius)
      aura.addColorStop(0, 'rgba(224, 242, 254, 0.85)')
      aura.addColorStop(0.3, 'rgba(238, 242, 255, 0.5)')
      aura.addColorStop(0.65, 'rgba(248, 250, 252, 0.2)')
      aura.addColorStop(1, 'transparent')

      ctx.fillStyle = aura
      ctx.beginPath()
      ctx.arc(centerX, centerY, auraRadius, 0, Math.PI * 2)
      ctx.fill()

      // 2. 悬浮晶莹粒子
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

      // 3. 高精度光学细线环
      const baseR = 175 + pulse * 4

      ctx.save()
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.07)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(centerX, centerY, baseR * 1.55, 0, Math.PI * 2)
      ctx.stroke()

      ctx.strokeStyle = 'rgba(6, 182, 212, 0.22)'
      ctx.setLineDash([4, 14])
      ctx.beginPath()
      ctx.arc(centerX, centerY, baseR * 1.35, 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()

      ctx.save()
      ctx.strokeStyle = 'rgba(6, 182, 212, 0.65)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(centerX, centerY, baseR * 1.15, angle, angle + Math.PI * 0.7)
      ctx.stroke()

      ctx.strokeStyle = 'rgba(99, 102, 241, 0.45)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(centerX, centerY, baseR * 1.15, -angle * 1.2 + Math.PI, -angle * 1.2 + Math.PI * 1.5)
      ctx.stroke()
      ctx.restore()

      ctx.save()
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.09)'
      ctx.setLineDash([2, 6])
      ctx.beginPath()
      ctx.arc(centerX, centerY, baseR * 0.88, 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()

      // 4. 极简光学十字对焦丝
      ctx.strokeStyle = 'rgba(6, 182, 212, 0.3)'
      ctx.lineWidth = 1
      const reticleGap = baseR * 0.8
      const reticleLen = 30

      ctx.beginPath()
      ctx.moveTo(centerX - reticleGap - reticleLen, centerY)
      ctx.lineTo(centerX - reticleGap, centerY)
      ctx.moveTo(centerX + reticleGap, centerY)
      ctx.lineTo(centerX + reticleGap + reticleLen, centerY)
      ctx.stroke()

      ctx.beginPath()
      ctx.moveTo(centerX, centerY - reticleGap - reticleLen)
      ctx.lineTo(centerX, centerY - reticleGap)
      ctx.moveTo(centerX, centerY + reticleGap)
      ctx.lineTo(centerX, centerY + reticleGap + reticleLen)
      ctx.stroke()

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

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[#f8fafc] select-none text-slate-800 font-sans">
      {/* ================= 顶栏冲突隔离 (Top Bar Conflict Isolation) ================= */}
      <div
        className="absolute inset-x-0 top-0 z-10 h-10 titlebar-drag-region"
        style={{ right: resolveWindowControlsRightInset(isWindows) }}
        aria-hidden="true"
      />
      <WindowControlsHost id="cdut-science-main" priority={20} className="absolute right-2 top-[3px] z-30" />

      {/* 浅色系动态天体光学画布 */}
      <canvas ref={canvasRef} className="absolute inset-0 z-0 pointer-events-none" />

      {/* ================= 核心悬浮内容区 ================= */}
      <div className="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-12 font-sans">
        {/* ===== Hero Title (采用客户端原生态字体) ===== */}
        <div className="relative mb-8 select-none text-center">
          <div className="absolute inset-0 -top-2 flex items-center justify-center opacity-40 blur-3xl pointer-events-none">
            <span className="font-sans text-5xl sm:text-7xl font-bold text-cyan-200">
              CDUT Science
            </span>
          </div>

          <h1 className="relative font-sans text-4xl sm:text-6xl font-semibold tracking-tight text-slate-900 drop-shadow-sm">
            CDUT Science
          </h1>
        </div>

        {/* ===== 模块化权限门禁与业务工作台 =====
            未来若直接开放业务界面，可直接剥离 <CsLabAuthGate> 或传入 bypassAuth，
            内部的 <CsLabWorkspaceView /> 业务界面不受任何影响 */}
        <CsLabAuthGate>
          <CsLabWorkspaceView />
        </CsLabAuthGate>
      </div>
    </div>
  )
}
