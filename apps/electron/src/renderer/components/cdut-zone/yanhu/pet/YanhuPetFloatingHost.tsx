/**
 * 砚小龙 · 浮动桌宠主容器（YanhuPetFloatingHost）
 *
 * 运行在独立透明子窗口（`?window=yanhu-pet`）内，负责：
 *   - 拉取主进程启动引导数据（配置 + 记忆 + 视口）；
 *   - 常驻伴随模式：160px 立绘 + 340px 灵动气泡 / 输入条卡片，卡片底边与立绘底部对齐；
 *   - 维护拖拽、视口碰撞检测与自适应推回，并上报紧凑包裹窗口几何；
 *   - 维护 60s 闲置计时器与四态精灵状态切变（Blinking / Breathing / Walking / Yawning）；
 *   - 透明留白区域鼠标穿透（setIgnoreMouseEvents forward），网页保持原生交互。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import type { YanhuPetMessage, YanhuPetSpriteState } from '@profer/shared'
import {
  petActiveToolsAtom,
  petConfigAtom,
  petMessagesAtom,
  petPresentedAtom,
  petReasoningTextAtom,
  petSpriteStateAtom,
  petStreamTextAtom,
  petStreamingAtom,
  petViewportSizeAtom,
} from '@/atoms/yanhu-pet-atoms'
import {
  CARD_WIDTH,
  PET_HEIGHT,
  PET_WIDTH,
  clampPetPosition,
  computeCardHeight,
  computeCenterPetPosition,
  computeInteractionUnionRect,
  computePetCardLayout,
  computePetOnlyLayout,
  computePushBackCoordinates,
  isLegacyDefaultPosition,
  isPointInsideRect,
} from './pet-geometry'
import { YanhuPetAvatar } from './YanhuPetAvatar'
import { YanhuPetDialog } from './YanhuPetDialog'

/** 闲置触发 Yawning 的阈值（60s） */
const IDLE_YAWN_MS = 60_000
/** 进入子页面初始 Blinking 时长（3s） */
const INITIAL_BLINK_MS = 3_000
/** 打字后维持 Blinking 的时长 */
const TYPING_BLINK_MS = 1_200
/** 视口未知时的兜底尺寸 */
const FALLBACK_VIEWPORT = { width: 900, height: 640 }
/**
 * 鼠标穿透判定的滞后余量（px）。
 *
 * 命中区外扩该余量后再判定是否放行鼠标：避免在命中边界上「进/出」反复横跳导致
 * 穿透开关高频切换（表现为拖拽/悬停时灵时不灵的「碰撞箱不稳定」）。
 */
const IGNORE_HYSTERESIS_PX = 10

export function YanhuPetFloatingHost(): React.ReactElement {
  const api = window.electronAPI?.yanhuExpress

  /** IPC 调用失败统一日志管道（去除静默 .catch，暴露底层异常） */
  const logIpcError = React.useCallback((action: string, err: unknown): void => {
    console.warn(`[yanhu-pet] ${action} 调用失败: ${err instanceof Error ? err.message : String(err)}`)
  }, [])

  const config = useAtomValue(petConfigAtom)
  const setConfig = useSetAtom(petConfigAtom)
  const messages = useAtomValue(petMessagesAtom)
  const setMessages = useSetAtom(petMessagesAtom)
  const setViewport = useSetAtom(petViewportSizeAtom)
  const setPresented = useSetAtom(petPresentedAtom)
  const streaming = useAtomValue(petStreamingAtom)
  const setStreaming = useSetAtom(petStreamingAtom)
  const streamText = useAtomValue(petStreamTextAtom)
  const setStreamText = useSetAtom(petStreamTextAtom)
  const reasoning = useAtomValue(petReasoningTextAtom)
  const setReasoning = useSetAtom(petReasoningTextAtom)
  const activeTools = useAtomValue(petActiveToolsAtom)
  const setActiveTools = useSetAtom(petActiveToolsAtom)
  const setSprite = useSetAtom(petSpriteStateAtom)
  const sprite = useAtomValue(petSpriteStateAtom)

  // 视口尺寸（用于几何计算；未知时兜底）
  const [viewport, setLocalViewport] = React.useState<{ width: number; height: number } | null>(null)

  // 位置 / 朝向 / 卡片可见性 / 历史展开态
  const [xp, setXp] = React.useState(config.petPosition.x)
  const [yp, setYp] = React.useState(config.petPosition.y)
  const [direction, setDirection] = React.useState<'left' | 'right'>(config.dialogPosition)
  const [cardVisible, setCardVisible] = React.useState(!config.isCollapsed)
  const [historyExpanded, setHistoryExpanded] = React.useState(false)
  const [cardHeight, setCardHeight] = React.useState<number>(() => computeCardHeight('bubble'))
  /** 首帧几何是否已上报完成（在此之前维持交互捕获，杜绝启动瞬间鼠标穿透冻结） */
  const [ready, setReady] = React.useState(false)
  /** 新手引导一次性填充请求（nonce 保证重复文本也触发） */
  const [fillRequest, setFillRequest] = React.useState<{ text: string; nonce: number } | null>(null)

  const cardRef = React.useRef<HTMLDivElement>(null)
  const mountedAtRef = React.useRef(Date.now())
  const lastInteractionRef = React.useRef(Date.now())
  const typingUntilRef = React.useRef(0)
  const streamingRef = React.useRef(false)
  streamingRef.current = streaming
  const dragRef = React.useRef<{ startX: number; startY: number; baseXp: number; baseYp: number } | null>(null)
  const lastConfigRevisionRef = React.useRef(-1)
  /** 启动引导是否已到达（用于首帧自动居中的时序判定） */
  const bootedRef = React.useRef(false)
  /** 首帧自动居中是否已执行（每会话仅一次，避免拖拽过程被反复复位） */
  const initialCenterDoneRef = React.useRef(false)
  /** 居中复位回调的稳定引用（供配置广播订阅回调调用，规避闭包过期） */
  const resetCenterRef = React.useRef<(() => void) | null>(null)

  // ===== 透明窗口背景加固 =====
  React.useEffect(() => {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    document.body.style.overflow = 'hidden'
    const rootEl = document.getElementById('root')
    if (rootEl) rootEl.style.background = 'transparent'
  }, [])

  // ===== 启动引导 + 订阅 =====
  React.useEffect(() => {
    if (!api) return
    let alive = true

    void api.petGetBootstrap().then((boot) => {
      if (!alive) return
      setConfig(boot.config)
      setMessages(boot.history)
      setLocalViewport(boot.viewport)
      setViewport(boot.viewport)
      setPresented(boot.presented)
      setXp(boot.config.petPosition.x)
      setYp(boot.config.petPosition.y)
      setDirection(boot.config.dialogPosition)
      setCardVisible(!boot.config.isCollapsed)
      bootedRef.current = true
    }).catch((err: unknown) => logIpcError('petGetBootstrap', err))

    const unsubState = api.onPetStateChanged((state) => {
      if (!alive) return
      setLocalViewport(state.viewport)
      setViewport(state.viewport)
      setPresented(state.presented)
      // 仅当配置被显式修改（原生菜单等）时应用配置，避免视口高频广播回写本地朝向
      if (state.configRevision !== lastConfigRevisionRef.current) {
        lastConfigRevisionRef.current = state.configRevision
        setConfig(state.config)
        setCardVisible(!state.config.isCollapsed)
        setDirection(state.config.dialogPosition)
        // 主进程「🐉 复位至屏幕正中央」以旧版占位坐标投递，交由渲染层按真实视口精确居中
        if (isLegacyDefaultPosition(state.config.petPosition)) {
          resetCenterRef.current?.()
        } else {
          setXp(state.config.petPosition.x)
          setYp(state.config.petPosition.y)
        }
      }
    })

    const unsubHistoryCleared = api.onPetHistoryCleared(() => {
      if (alive) setMessages([])
    })

    const unsubTourFill = api.onPetTourFill((event) => {
      if (!alive) return
      setCardVisible(true)
      setFillRequest({ text: event.text, nonce: Date.now() })
    })

    const unsubStream = api.onPetStream((event) => {
      if (!alive) return
      if (event.type === 'delta' && event.delta) {
        setStreamText((prev) => prev + event.delta)
      } else if (event.type === 'reasoning' && event.reasoning) {
        setReasoning((prev) => prev + event.reasoning)
      } else if (event.type === 'tool-start' && event.tool) {
        setActiveTools((prev) => [...prev.filter((t) => t.id !== event.tool!.id), event.tool!])
      } else if (event.type === 'tool-end' && event.tool) {
        setActiveTools((prev) => prev.map((t) => (t.id === event.tool!.id ? event.tool! : t)))
      } else if (event.type === 'error') {
        if (event.error) toast.error(event.error)
      } else if (event.type === 'done') {
        void refreshHistory()
      }
    })

    return () => {
      alive = false
      unsubState()
      unsubStream()
      unsubHistoryCleared()
      unsubTourFill()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api])

  /** 从主进程拉取权威历史（对话结束后同步） */
  const refreshHistory = React.useCallback(async (): Promise<void> => {
    if (!api) return
    try {
      const history: YanhuPetMessage[] = await api.petGetHistory()
      setMessages(history)
    } catch (err) {
      logIpcError('petGetHistory', err)
    }
  }, [api, setMessages, logIpcError])

  // ===== 卡片高度测量（输入条可自动增高，气泡/历史面板高度确定） =====
  React.useEffect(() => {
    const el = cardRef.current
    if (!el || !cardVisible) return
    const measure = (): void => {
      const h = Math.ceil(el.getBoundingClientRect().height)
      if (h > 0) setCardHeight(h)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [cardVisible])

  // ===== 布局：视口推回 / 夹取（纯计算，渲染与上报共用同一结果） =====
  const layout = React.useMemo(() => {
    const vw = viewport?.width ?? FALLBACK_VIEWPORT.width
    const vh = viewport?.height ?? FALLBACK_VIEWPORT.height
    if (!cardVisible) {
      const clamped = clampPetPosition(xp, yp, vw, vh)
      return { xp: clamped.xp, yp: clamped.yp, direction, kind: 'pet' as const }
    }
    const pushed = computePushBackCoordinates({ xp, yp, direction, vw, vh, cardH: cardHeight })
    return {
      xp: pushed.nextXp,
      yp: pushed.nextYp,
      direction: pushed.autoFlippedDirection,
      kind: 'card' as const,
    }
  }, [xp, yp, direction, cardVisible, cardHeight, viewport])

  const bounds = React.useMemo(
    () =>
      layout.kind === 'pet'
        ? computePetOnlyLayout({ xp: layout.xp, yp: layout.yp })
        : computePetCardLayout({
            xp: layout.xp,
            yp: layout.yp,
            direction: layout.direction,
            cardHeight,
          }),
    [layout, cardHeight],
  )
  const boundsSignature = `${bounds.winX},${bounds.winY},${bounds.winWidth},${bounds.winHeight}`

  /**
   * 交互命中并集矩形（窗口本地坐标）：立绘 + 透明间隙 + 卡片视为**一个整体**命中区，
   * 杜绝鼠标在立绘与卡片之间穿越间隙时反复触发穿透开关（碰撞箱不稳定根因）。
   */
  const hitRect = React.useMemo(
    () =>
      computeInteractionUnionRect({
        petLocalX: bounds.petLocalX,
        petLocalY: bounds.petLocalY,
        cardLocalX: bounds.cardLocalX,
        cardLocalY: bounds.cardLocalY,
        cardVisible,
        cardHeight,
      }),
    [bounds, cardVisible, cardHeight],
  )
  const hitRectRef = React.useRef(hitRect)
  hitRectRef.current = hitRect

  // 收敛本地坐标到推回后的最终值
  React.useEffect(() => {
    if (layout.xp !== xp) setXp(layout.xp)
    if (layout.yp !== yp) setYp(layout.yp)
    if (layout.direction !== direction) setDirection(layout.direction)
  }, [layout, xp, yp, direction])

  // 上报紧凑包裹窗口几何（首帧上报完成后才允许透明留白穿透）
  React.useEffect(() => {
    if (!api) return
    void api.petUpdateGeometry({
      x: bounds.winX,
      y: bounds.winY,
      width: bounds.winWidth,
      height: bounds.winHeight,
    }).then(() => setReady(true)).catch((err: unknown) => {
      logIpcError('petUpdateGeometry', err)
      // 即便上报失败也视作首帧完成，避免输入与交互被永久冻结
      setReady(true)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, boundsSignature])

  // ===== 闲置计时与四态切变 =====
  React.useEffect(() => {
    const tick = (): void => {
      const now = Date.now()
      let next: YanhuPetSpriteState
      if (streamingRef.current) {
        next = 'walking'
      } else if (now < typingUntilRef.current) {
        next = 'blinking'
      } else if (now - mountedAtRef.current < INITIAL_BLINK_MS) {
        next = 'blinking'
      } else if (now - lastInteractionRef.current > IDLE_YAWN_MS) {
        next = 'yawning'
      } else {
        next = 'breathing'
      }
      setSprite(next)
    }
    tick()
    const timer = setInterval(tick, 500)
    return () => clearInterval(timer)
  }, [setSprite])

  const markInteraction = React.useCallback((): void => {
    lastInteractionRef.current = Date.now()
  }, [])

  const markTyping = React.useCallback((): void => {
    const now = Date.now()
    lastInteractionRef.current = now
    typingUntilRef.current = now + TYPING_BLINK_MS
  }, [])

  // ===== 拖拽 =====
  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    markInteraction()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // 忽略
    }
    dragRef.current = { startX: event.screenX, startY: event.screenY, baseXp: xp, baseYp: yp }
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    setXp(drag.baseXp + (event.screenX - drag.startX))
    setYp(drag.baseYp + (event.screenY - drag.startY))
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragRef.current) return
    dragRef.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // 忽略
    }
    if (api) void api.petSaveConfig({ petPosition: { x: xp, y: yp } }).catch((err: unknown) => logIpcError('petSaveConfig', err))
  }

  // ===== 配置变更 =====
  const persist = React.useCallback(
    (patch: Parameters<NonNullable<typeof api>['petSaveConfig']>[0]): void => {
      if (!api) return
      void api.petSaveConfig(patch).then((next) => setConfig(next)).catch((err: unknown) => logIpcError('petSaveConfig', err))
    },
    [api, setConfig, logIpcError],
  )

  // ===== 正中央复位：按真实视口精确计算联合外框的物理正中心 =====
  const handleResetCenter = React.useCallback((): void => {
    const vw = viewport?.width ?? FALLBACK_VIEWPORT.width
    const vh = viewport?.height ?? FALLBACK_VIEWPORT.height
    const center = computeCenterPetPosition(vw, vh, cardVisible, direction)
    setXp(center.x)
    setYp(center.y)
    persist({ petPosition: { x: center.x, y: center.y } })
  }, [viewport, cardVisible, direction, persist])
  resetCenterRef.current = handleResetCenter

  // 首帧自动居中：启动引导到达且视口有效后，若坐标为旧版死值 / 越界 / 未初始化则平滑复位到正中央
  React.useEffect(() => {
    if (initialCenterDoneRef.current) return
    if (!bootedRef.current) return
    const vw = viewport?.width ?? 0
    const vh = viewport?.height ?? 0
    if (vw <= 4 || vh <= 4) return
    initialCenterDoneRef.current = true
    const outside = xp < 0 || yp < 0 || xp > vw - PET_WIDTH || yp > vh - PET_HEIGHT
    if (isLegacyDefaultPosition({ x: xp, y: yp }) || outside) {
      handleResetCenter()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport, xp, yp, handleResetCenter])

  const handleHideCard = (): void => {
    setHistoryExpanded(false)
    setCardVisible(false)
    persist({ isCollapsed: true })
  }

  const handleShowCard = (): void => {
    setCardVisible(true)
    persist({ isCollapsed: false })
  }

  const handleToggleHistory = (): void => {
    if (!cardVisible) {
      handleShowCard()
      setHistoryExpanded(true)
      return
    }
    setHistoryExpanded((v) => !v)
  }

  const handlePetDoubleClick = (): void => {
    handleToggleHistory()
  }

  // ===== 对话 =====
  const handleSend = (text: string): void => {
    if (!api) return
    markInteraction()
    setStreamText('')
    setReasoning('')
    setActiveTools([])
    setStreaming(true)
    if (!cardVisible) handleShowCard()
    void api.petSendChat({ text }).then((result) => {
      if (!result.success && result.error) {
        toast.error(result.error)
      }
      return refreshHistory()
    }).catch((err: unknown) => {
      toast.error(err instanceof Error ? err.message : String(err))
    }).finally(() => {
      setStreaming(false)
      setStreamText('')
      setReasoning('')
      setActiveTools([])
    })
  }

  const handleAbort = (): void => {
    if (api) void api.petAbortChat().catch((err: unknown) => logIpcError('petAbortChat', err))
  }

  const handleDevCommand = (): void => {
    // 隐藏指令：持久化切换开发者级工具暴露开关（下一轮对话生效），并顺带唤起实时诊断控制台
    const next = !config.devToolsEnabled
    persist({ devToolsEnabled: next })
    if (api) void api.openDiagnosticConsole().catch((err: unknown) => logIpcError('openDiagnosticConsole', err))
    toast.success(next ? '开发者级工具已开启（下一轮生效）' : '开发者级工具已关闭')
  }

  // ===== 鼠标穿透控制：仅立绘 / 卡片命中区捕获事件，透明留白区无感穿透 =====
  const isInputFocusedRef = React.useRef(false)
  /** 最近一次下达的穿透开关值：去重，避免同一状态反复 IPC 造成命中抖动 */
  const lastIgnoreRef = React.useRef<boolean | null>(null)
  const updateMouseIgnore = React.useCallback(
    (ignore: boolean) => {
      if (!api) return
      // 拖拽中或输入框聚焦时，绝不切到穿透，避免交互被中途打断
      if (ignore && (dragRef.current || isInputFocusedRef.current)) return
      if (lastIgnoreRef.current === ignore) return
      lastIgnoreRef.current = ignore
      void api.petSetIgnoreMouse(ignore).catch((err: unknown) => logIpcError('petSetIgnoreMouse', err))
    },
    [api, logIpcError],
  )

  // 仅在首帧几何上报完成后，才根据光标位置驱动透明留白穿透，杜绝启动瞬间交互冻结
  React.useEffect(() => {
    if (!ready) return
    // 窗口/内容重建后需重新同步一次真实穿透态，故复位去重缓存
    lastIgnoreRef.current = null
    updateMouseIgnore(true)
  }, [ready, updateMouseIgnore])

  /**
   * 全局光标命中判定（唯一穿透驱动源）。
   *
   * 不依赖单个元素的 onPointerEnter/Leave——那两个回调会在穿透开关切换后丢事件，
   * 导致命中判定时灵时不灵。这里改为监听全局 pointermove（穿透开启时 forward=true
   * 仍会投递移动事件），以「并集矩形 + 滞后余量」稳定判定，且状态未变时不下发 IPC。
   */
  React.useEffect(() => {
    if (!ready) return
    const onPointerMove = (event: PointerEvent): void => {
      const inside = isPointInsideRect(event.clientX, event.clientY, hitRectRef.current, IGNORE_HYSTERESIS_PX)
      updateMouseIgnore(!inside)
    }
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    return () => window.removeEventListener('pointermove', onPointerMove)
  }, [ready, updateMouseIgnore])

  // ===== 原生上下文菜单（OS 顶层菜单，彻底消除紧凑透明窗口边界裁切） =====
  const handleOpenSettings = React.useCallback(() => {
    updateMouseIgnore(false)
    if (api) void api.petShowContextMenu().catch((err: unknown) => logIpcError('petShowContextMenu', err))
  }, [api, updateMouseIgnore, logIpcError])

  // ===== 渲染定位 =====
  const petLocal = { x: bounds.petLocalX, y: bounds.petLocalY }
  const cardLocal = { x: bounds.cardLocalX, y: bounds.cardLocalY }
  const tailTop = petLocal.y + PET_HEIGHT / 2 - cardLocal.y

  return (
    <div
      className="relative h-screen w-screen select-none overflow-hidden bg-transparent"
      onFocusCapture={() => {
        // 输入框聚焦期间禁止切到穿透，避免移动鼠标导致输入焦点被夺走 / 键盘弹回
        isInputFocusedRef.current = true
        updateMouseIgnore(false)
      }}
      onBlurCapture={() => {
        isInputFocusedRef.current = false
      }}
    >
      {cardVisible ? (
        <div
          ref={cardRef}
          className="absolute"
          style={{ left: cardLocal.x, top: cardLocal.y, width: CARD_WIDTH }}
          onMouseEnter={() => updateMouseIgnore(false)}
        >
          <YanhuPetDialog
            messages={messages}
            streamText={streamText}
            reasoning={reasoning}
            activeTools={activeTools}
            streaming={streaming}
            historyExpanded={historyExpanded}
            direction={layout.direction}
            tailTop={tailTop}
            sleepy={sprite === 'yawning'}
            fillRequest={fillRequest}
            onToggleHistory={handleToggleHistory}
            onHideCard={handleHideCard}
            onSend={handleSend}
            onAbort={handleAbort}
            onOpenSettings={handleOpenSettings}
            onDevCommand={handleDevCommand}
            onInputActivity={() => {
              markTyping()
              updateMouseIgnore(false)
            }}
          />
        </div>
      ) : null}

      <div
        className="absolute cursor-grab touch-none active:cursor-grabbing"
        style={{ left: petLocal.x, top: petLocal.y, width: PET_WIDTH, height: PET_HEIGHT }}
        onPointerDown={(e) => {
          updateMouseIgnore(false)
          handlePointerDown(e)
        }}
        onPointerMove={handlePointerMove}
        onPointerUp={(e) => {
          handlePointerUp(e)
          // 释放后按真实光标位置重算穿透态，避免「光标仍在立绘上却被切成穿透」
          const inside = isPointInsideRect(e.clientX, e.clientY, hitRectRef.current, IGNORE_HYSTERESIS_PX)
          updateMouseIgnore(!inside)
        }}
        onPointerEnter={() => {
          markInteraction()
          updateMouseIgnore(false)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          handleOpenSettings()
        }}
        onDoubleClick={handlePetDoubleClick}
        title="拖动我；右键设置；双击展开历史"
      >
        <YanhuPetAvatar state={sprite} size={PET_WIDTH} />
      </div>
    </div>
  )
}
