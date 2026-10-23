/**
 * BeijingAnalogClock — 空会话欢迎区的立体拟物表盘
 *
 * 表盘时刻恒为 Asia/Shanghai，与宿主系统时区无关。
 * 旋转角度由「挂载锚点 + 真实时间差」纯推导，严禁改回浮点取模累加：
 * 分/时针每秒仅移动 0.1°/0.0083°，浮点误差会让增量出现极小负值，
 * 取模后得到约 359.999°，指针被判为向前追一整圈，叠加过渡即整圈跳闪（历史 Bug）。
 * 休眠唤醒或系统时间回拨必须重取锚点并瞬时归位，避免超长角度过渡与表盘假死。
 * 颜色全部使用主题 token，深浅主题与各皮肤自动适配。
 */

import * as React from 'react'
import {
  createBeijingClockAnchor,
  getBeijingClockAngles,
  resolveBeijingClockRotations,
  shouldRebaseClockAnchor,
} from '@/lib/beijing-greeting'

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

/** 休眠唤醒/时间回拨的重锚阈值：超过该间隔直接归位，不做超长角度过渡 */
const REBASE_GAP_MS = 1500

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
  const { clockText } = getBeijingClockAngles(now)
  const [anchor, setAnchor] = React.useState(() => createBeijingClockAnchor(now))
  const lastNowMsRef = React.useRef(now.getTime())

  // 休眠唤醒（跨度超阈值）或系统时间回拨：本帧先用临时新锚点计算角度，
  // 锚点状态写入收敛到提交后的 effect，严禁在渲染期间派发 setState。
  const needsRebase = shouldRebaseClockAnchor(lastNowMsRef.current, now, REBASE_GAP_MS)
  const effectiveAnchor = needsRebase ? createBeijingClockAnchor(now) : anchor
  const { hourRotation, minuteRotation, secondRotation } = resolveBeijingClockRotations(effectiveAnchor, now)

  React.useEffect(() => {
    lastNowMsRef.current = now.getTime()
    // 复用渲染期已构建的 effectiveAnchor 引用，避免 effect 内再次取时产生微秒偏差
    if (needsRebase) setAnchor(effectiveAnchor)
  }, [now, needsRebase, effectiveAnchor])

  // 秒针：150ms 机械跳动（无过冲，避免回弹被判成跳闪）；分/时针：300ms 顺滑跟随。
  // 重锚帧禁用过渡，直接以新锚点瞬时归位；下一帧角度数值未变，不会二次动画。
  const secondTransition = needsRebase
    ? undefined
    : 'transform 150ms cubic-bezier(0.25, 0.1, 0.25, 1)'
  const slowTransition = needsRebase
    ? undefined
    : 'transform 300ms cubic-bezier(0.22, 1, 0.36, 1)'

  // 多实例同屏时隔离渐变 ID
  const uid = React.useId().replace(/:/g, '')

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
