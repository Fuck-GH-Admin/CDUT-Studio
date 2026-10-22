/**
 * BeijingAnalogClock — 空会话欢迎区的立体拟物表盘
 *
 * 表盘时刻恒为 Asia/Shanghai，与宿主系统时区无关；
 * 指针角度采用正向增量展开，防止 59→0 与休眠唤醒时倒转；
 * 颜色全部使用主题 token，深浅主题与各皮肤自动适配。
 */

import * as React from 'react'
import { getBeijingClockAngles } from '@/lib/beijing-greeting'

interface BeijingAnalogClockProps {
  /** 当前时刻（由父级 1s 定时器驱动，与文本药丸共用同一份状态） */
  now: Date
}

/** 12 个刻度索引（0 = 12 点方向，顺时针） */
const TICK_INDEXES = Array.from({ length: 12 }, (_, index) => index)

/** 分/时针投影偏移（viewBox 坐标系） */
const HAND_SHADOW_OFFSET = 'translate(0.7 0.9)'

/** 秒针朱砂红：深浅主题下均有足够对比度，不随 --primary 皮肤漂移 */
const SECOND_HAND_COLOR = 'hsl(6 78% 57%)'

/**
 * 角度单调向前展开。
 * 真实时间只会前进，因此一律取正向增量：休眠/后台挂起唤醒后秒针顺时针快进，
 * 绝不像最短路径算法那样为「追赶时间」而逆时针回扫。
 */
function useUnwrappedAngle(target: number): number {
  const ref = React.useRef(target)
  const current = ref.current
  const currentMod = ((current % 360) + 360) % 360
  const delta = ((target - currentMod) % 360 + 360) % 360
  ref.current = current + delta
  return ref.current
}

/** 指针旋转样式：以 viewBox 中心为轴心（百分比基准 = viewBox） */
function handStyle(angle: number, transition: string | undefined): React.CSSProperties {
  return {
    transform: `rotate(${angle}deg)`,
    transformBox: 'view-box',
    transformOrigin: '50% 50%',
    transition,
  }
}

export function BeijingAnalogClock({ now }: BeijingAnalogClockProps): React.ReactElement {
  const { hourAngle, minuteAngle, secondAngle, clockText } = getBeijingClockAngles(now)
  const hourRotation = useUnwrappedAngle(hourAngle)
  const minuteRotation = useUnwrappedAngle(minuteAngle)
  const secondRotation = useUnwrappedAngle(secondAngle)
  // 多实例同屏时隔离渐变 ID
  const uid = React.useId().replace(/:/g, '')

  // 首帧不挂 transition，避免指针从默认 0° 过渡到当前角度造成「飞转」
  const [transitionsOn, setTransitionsOn] = React.useState(false)
  React.useEffect(() => {
    let secondFrame = 0
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => setTransitionsOn(true))
    })
    return () => {
      window.cancelAnimationFrame(firstFrame)
      window.cancelAnimationFrame(secondFrame)
    }
  }, [])

  // 秒针：150ms 机械微弹跳；分/时针：300ms 顺滑跟随
  const secondTransition = transitionsOn
    ? 'transform 150ms cubic-bezier(0.4, 2.08, 0.55, 0.44)'
    : undefined
  const slowTransition = transitionsOn
    ? 'transform 300ms cubic-bezier(0.22, 1, 0.36, 1)'
    : undefined

  return (
    <div
      role="img"
      aria-label={`北京标准时间 ${clockText}`}
      className="size-[100px] shrink-0 drop-shadow-[0_8px_18px_rgba(0,0,0,0.10)] [@media(max-height:820px)]:size-[84px] [@media(max-height:700px)]:size-[68px] dark:drop-shadow-[0_10px_22px_rgba(0,0,0,0.45)]"
    >
      <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false" className="size-full">
        <defs>
          <linearGradient id={`${uid}-bezel`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="hsl(var(--card))" />
            <stop offset="50%" stopColor="hsl(var(--muted))" />
            <stop offset="100%" stopColor="hsl(var(--card))" />
          </linearGradient>
          <radialGradient id={`${uid}-face`} cx="35%" cy="28%" r="80%">
            <stop offset="0%" stopColor="hsl(var(--card))" />
            <stop offset="72%" stopColor="hsl(var(--muted))" />
            <stop offset="100%" stopColor="hsl(var(--muted))" />
          </radialGradient>
          <radialGradient id={`${uid}-cap`} cx="35%" cy="30%" r="80%">
            <stop offset="0%" stopColor="hsl(var(--foreground))" />
            <stop offset="100%" stopColor="hsl(var(--muted-foreground))" />
          </radialGradient>
        </defs>

        {/* 外壳与内凹盘面 */}
        <circle
          cx="50"
          cy="50"
          r="48"
          fill={`url(#${uid}-bezel)`}
          stroke="hsl(var(--border))"
          strokeWidth="0.7"
        />
        <circle
          cx="50"
          cy="50"
          r="42"
          fill={`url(#${uid}-face)`}
          stroke="hsl(var(--foreground) / 0.06)"
          strokeWidth="1"
        />

        {/* 12 个刻度：12/3/6/9 为主刻度条，其余为点 */}
        {TICK_INDEXES.map((index) => (
          <g key={index} transform={`rotate(${index * 30} 50 50)`}>
            {index % 3 === 0 ? (
              <line
                x1="50"
                y1="13.5"
                x2="50"
                y2="16.5"
                stroke="hsl(var(--foreground) / 0.75)"
                strokeWidth="2.4"
                strokeLinecap="round"
              />
            ) : (
              <circle cx="50" cy="14.8" r="1.05" fill="hsl(var(--foreground) / 0.28)" />
            )}
          </g>
        ))}

        {/* 时针（含投影） */}
        <g style={handStyle(hourRotation, slowTransition)}>
          <line
            x1="50"
            y1="50"
            x2="50"
            y2="31"
            stroke="hsl(var(--foreground) / 0.12)"
            strokeWidth="3.4"
            strokeLinecap="round"
            transform={HAND_SHADOW_OFFSET}
          />
          <line
            x1="50"
            y1="50"
            x2="50"
            y2="31"
            stroke="hsl(var(--foreground))"
            strokeWidth="3.4"
            strokeLinecap="round"
          />
        </g>

        {/* 分针（含投影） */}
        <g style={handStyle(minuteRotation, slowTransition)}>
          <line
            x1="50"
            y1="50"
            x2="50"
            y2="23"
            stroke="hsl(var(--foreground) / 0.12)"
            strokeWidth="2.2"
            strokeLinecap="round"
            transform={HAND_SHADOW_OFFSET}
          />
          <line
            x1="50"
            y1="50"
            x2="50"
            y2="23"
            stroke="hsl(var(--foreground) / 0.9)"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        </g>

        {/* 秒针（带尾柄配重） */}
        <g style={handStyle(secondRotation, secondTransition)}>
          <line
            x1="50"
            y1="57"
            x2="50"
            y2="17"
            stroke={SECOND_HAND_COLOR}
            strokeWidth="1.15"
            strokeLinecap="round"
          />
        </g>

        {/* 轴心金属盖 */}
        <circle cx="50" cy="50" r="3.6" fill={`url(#${uid}-cap)`} />
        <circle cx="50" cy="50" r="1.9" fill="hsl(var(--card))" />
        <circle cx="50" cy="50" r="0.9" fill={SECOND_HAND_COLOR} />
      </svg>
    </div>
  )
}
