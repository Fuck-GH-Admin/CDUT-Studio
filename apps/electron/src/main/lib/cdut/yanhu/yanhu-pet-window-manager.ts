/**
 * 智联万站 · 桌宠紧凑包裹子窗口调度（YanhuPetWindowManager）
 *
 * 为彻底解决 Electron 中 `WebContentsView` 原生图层遮挡渲染层 React DOM 的痼疾，
 * 桌宠「砚小龙」运行在独立、透明、无边框的原生子窗口内：
 *   - 子窗口 Bounds 动态严密贴合「桌宠 + 对话框」的几何外框（Tight-Wrapping）；
 *   - 窗口之外的整个内嵌网页保持 100% 原生点击、文本选中与滚轮响应；
 *   - 随同主窗口移动 / 最小化 / 恢复 / 关闭。
 *
 * 坐标契约：主渲染窗口上报智联万站视口（CSS 像素）→ 本管理器按主窗口缩放换算为 DIP，
 * 桌宠渲染进程再以视口左上角为原点上报紧凑包裹几何，最终折算为屏幕坐标应用。
 */

import { BrowserWindow, Menu, app, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { join } from 'node:path'
import { VITE_DEV_SERVER_URL } from '../../config-paths'
import type {
  YanhuPetBootstrap,
  YanhuPetChatStatus,
  YanhuPetConfig,
  YanhuPetMessage,
  YanhuPetStateEvent,
  YanhuPetTourFillEvent,
  YanhuPetViewport,
  YanhuPetWindowGeometry,
  YanhuPetStreamEvent,
} from '@profer/shared'
import { YANHU_EXPRESS_IPC_CHANNELS } from '@profer/shared'
import { yanhuPiRuntime } from './yanhu-pi-runtime'

/** 视口矩形（DIP，相对主窗口内容区左上角） */
interface DipViewport {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 桌宠几何常量（严格镜像渲染层 `pet-geometry.ts`，用于主进程原生菜单一键居中复位）。
 * 任一侧调整尺寸时必须同步，避免菜单复位落点与渲染层实际布局产生偏移。
 */
const PET_WIDTH = 160
const PET_HEIGHT = 160
const PET_GAP = 12
const CARD_WIDTH = 420
const PET_MARGIN = 16
/** 阴影 / 圆角留白缓冲（DIP），镜像渲染层 SHADOW_PADDING */
const SHADOW_PADDING = 16
/** 气泡态面板高度 / 内间距 / 输入条高度（DIP），镜像渲染层 pet-geometry 对应常量 */
const BUBBLE_HEIGHT = 150
const CARD_INNER_GAP = 8
const INPUT_BAR_HEIGHT = 60

/** 气泡态伴随卡片内容高度（DIP） */
const DEFAULT_CARD_HEIGHT = BUBBLE_HEIGHT + CARD_INNER_GAP + INPUT_BAR_HEIGHT
/** 几何未上报时的兜底窗口宽（DIP）：立绘 + 间距 + 卡片 + 两侧阴影留白 */
const DEFAULT_GEOMETRY_WIDTH = PET_WIDTH + PET_GAP + CARD_WIDTH + 2 * SHADOW_PADDING
/** 几何未上报时的兜底窗口高（DIP）：联合外框高度 + 上下阴影留白 */
const DEFAULT_GEOMETRY_HEIGHT = Math.max(PET_HEIGHT, DEFAULT_CARD_HEIGHT) + 2 * SHADOW_PADDING

/**
 * 桌宠子窗口管理器。
 */
export class YanhuPetWindowManager {
  private owner: BrowserWindow | null = null
  private petWindow: BrowserWindow | null = null
  private presented = false
  private dipViewport: DipViewport | null = null
  private geometry: YanhuPetWindowGeometry | null = null
  private ownerListenersBound = false
  /** 失焦焦点核对定时器 */
  private focusTimer: ReturnType<typeof setTimeout> | null = null
  /** 首帧呈现看门狗定时器（几何未及时上报时兜底保活） */
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null
  /** 应用焦点切回监听器 */
  private appFocusListener: ((event: unknown, focusedWindow: BrowserWindow) => void) | null = null
  /** 应用失焦监听器（切到外部第三方应用时触发失焦裁决） */
  private appBlurListener: ((event: unknown, window: BrowserWindow) => void) | null = null
  /** 主窗口生命周期监听器（具名保存，dispose 时精确解绑，避免主窗口重建后残留回调把桌宠再次显示） */
  private ownerHandlers: {
    move: () => void
    resize: () => void
    minimize: () => void
    restore: () => void
    show: () => void
    hide: () => void
    focus: () => void
    blur: () => void
    closed: () => void
  } | null = null
  /** 配置修订号：仅显式 saveConfig 递增，供渲染层判定是否应用配置 */
  private configRevision = 0
  /** 桌宠窗口是否已完成首次加载（新手引导轮询） */
  private ready = false
  /** 桌宠当前一轮对话运行态（新手引导轮询） */
  private chatRunning = false
  private chatStartedAt: number | null = null
  private chatDoneAt: number | null = null
  private chatError: string | null = null
  /** 新手引导保活：原生浏览器视图因引导蒙层隐藏时，桌宠仍保持可见 */
  private tourKeepAlive = false

  /** 绑定主窗口（主窗口重建时重新挂载生命周期监听） */
  public setOwnerWindow(window: BrowserWindow): void {
    if (this.owner === window) return
    this.owner = window
    this.ownerListenersBound = false
    this.bindOwnerListeners(window)
  }

  /** 监听主窗口生命周期，保证子窗口随动（具名 handler，便于 dispose 精确解绑） */
  private bindOwnerListeners(window: BrowserWindow): void {
    if (this.ownerListenersBound) return
    this.ownerListenersBound = true
    const reapply = (): void => {
      this.raiseToTop()
      this.applyBounds()
    }
    const hideWhenHidden = (): void => {
      if (!this.petWindow || this.petWindow.isDestroyed()) return
      if (window.isMinimized() || !window.isVisible()) this.petWindow.hide()
      else if (this.presented) reapply()
    }
    this.ownerHandlers = {
      move: reapply,
      resize: reapply,
      minimize: hideWhenHidden,
      restore: hideWhenHidden,
      show: hideWhenHidden,
      hide: hideWhenHidden,
      // 主窗口重新获得焦点时瞬时复位到应用顶层
      focus: reapply,
      // 失焦后延迟判定：若整个应用失焦（切到外部第三方应用），隐藏子窗口避免流氓置顶
      blur: () => this.scheduleFocusReconcile(),
      closed: () => this.dispose(),
    }
    window.on('move', this.ownerHandlers.move)
    window.on('resize', this.ownerHandlers.resize)
    window.on('minimize', this.ownerHandlers.minimize)
    window.on('restore', this.ownerHandlers.restore)
    window.on('show', this.ownerHandlers.show)
    window.on('hide', this.ownerHandlers.hide)
    window.on('focus', this.ownerHandlers.focus)
    window.on('blur', this.ownerHandlers.blur)
    window.on('closed', this.ownerHandlers.closed)

    if (!this.appFocusListener) {
      this.appFocusListener = (_event: unknown, focusedWindow: BrowserWindow): void => {
        if (focusedWindow === this.owner || focusedWindow === this.petWindow) {
          if (this.presented) {
            this.restorePetWindow()
            reapply()
          }
        }
      }
      app.on('browser-window-focus', this.appFocusListener)
    }
    // 全应用失焦监听：用户切到 VS Code / Chrome / 记事本等外部应用或点击任务栏时，
    // 立即启动 80ms 快速裁决，确认焦点未在本应用内交接即隐藏桌宠，杜绝流氓常驻悬浮。
    if (!this.appBlurListener) {
      this.appBlurListener = (): void => {
        this.scheduleFocusReconcile()
      }
      app.on('browser-window-blur', this.appBlurListener)
    }
  }

  /** 抬高桌宠窗口到主窗口内容之上的绝对顶层 */
  private raiseToTop(): void {
    const win = this.petWindow
    if (!win || win.isDestroyed() || !win.isVisible()) return
    win.moveTop()
  }

  /**
   * 首帧呈现看门狗：呈现激活后 2s 再兜底重应用一次边界与置顶。
   * 覆盖「桌宠渲染进程慢启动 / geometry 长期未上报」导致窗口未显示或落点漂移的场景。
   */
  private scheduleWatchdog(): void {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer)
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null
      if (!this.presented || !this.dipViewport) return
      const owner = this.owner
      if (!owner || owner.isDestroyed() || !owner.isVisible() || owner.isMinimized()) return
      this.applyBounds()
      this.raiseToTop()
    }, 2000)
    // 定时器不得阻塞进程退出（AGENTS.md 红线）
    if (typeof this.watchdogTimer.unref === 'function') this.watchdogTimer.unref()
  }

  /**
   * 失焦后 80ms 快速核对焦点归属，避免切到外部应用时桌宠仍置顶漂浮。
   *
   * 裁决依据严格收敛为 OS 级窗口聚合判定（见 {@link isAppInForeground}），
   * **绝不使用 `webContents.getFocusedWebContents()`**：Electron 在切到外部应用时会恒定保留
   * 上一激活 WebContents 指针而永不置 null，历史实现据此判定会导致 `anyFocused` 恒为 true、
   * `win.hide()` 永不触发的「失焦背景常驻流氓」漏洞。
   */
  private scheduleFocusReconcile(): void {
    if (this.focusTimer) clearTimeout(this.focusTimer)
    this.focusTimer = setTimeout(() => {
      this.focusTimer = null
      const win = this.petWindow
      if (!win || win.isDestroyed()) return
      if (!this.presented) return

      // 操作系统前台焦点未落在本应用（主窗口 / 桌宠窗口）→ 瞬时隐藏，杜绝流氓置顶
      if (!this.isAppInForeground()) {
        this.hidePetWindow()
        return
      }
      // 焦点仍在应用内交接（如主窗口 <-> 桌宠窗口切换）→ 保持显示并复位层级
      this.restorePetWindow()
      this.raiseToTop()
      this.applyBounds()
    }, 80)
    // 定时器不得阻塞进程退出（AGENTS.md 红线）
    if (typeof this.focusTimer.unref === 'function') this.focusTimer.unref()
  }

  /**
   * OS 级前台聚合判定：仅当主窗口可见、未最小化，且操作系统前台焦点确实落在
   * 主窗口或桌宠窗口上时，才认定本应用处于前台。
   */
  private isAppInForeground(): boolean {
    const owner = this.owner
    if (!owner || owner.isDestroyed() || !owner.isVisible() || owner.isMinimized()) {
      return false
    }
    const focusedWin = BrowserWindow.getFocusedWindow()
    return focusedWin === owner || focusedWin === this.petWindow
  }

  /** 瞬时隐藏桌宠窗口（不改动呈现态，供失焦裁决与全局模态联动调用） */
  public hidePetWindow(): void {
    const win = this.petWindow
    if (win && !win.isDestroyed() && win.isVisible()) win.hide()
  }

  /** 复位恢复桌宠窗口（仅当仍处于呈现态且应用处于 OS 前台时生效） */
  public restorePetWindow(): void {
    const win = this.petWindow
    if (!win || win.isDestroyed()) return
    if (!this.presented || !this.dipViewport) return
    if (!this.isAppInForeground()) return
    this.applyBounds()
    this.raiseToTop()
  }

  /** 设置智联万站呈现态（进入 / 离开子页面） */
  public setPresented(presented: boolean): void {
    this.presented = presented
    if (presented) {
      this.ensureWindow()
      this.broadcastState()
      this.applyBounds()
      this.raiseToTop()
      this.scheduleWatchdog()
    } else {
      this.hideWindow()
    }
  }

  /**
   * 同步智联万站视口矩形（CSS 像素，来自主渲染窗口）。
   * 主窗口缩放系数不为 1 时按缩放换算为 DIP，保证与子窗口坐标系一致。
   */
  public syncViewport(rect: YanhuPetViewport): void {
    // 仅更新几何，绝不隐式改变呈现态：
    // 呈现态的唯一来源是 SHOW_VIEW / HIDE_VIEW / UPDATE_BOUNDS(visible)，
    // 否则渲染层每帧上报视口都会把桌宠重新「置为呈现」，与隐藏指令互相打架造成 show/hide 抖动。
    const owner = this.owner
    const zoom = owner && !owner.isDestroyed() ? owner.webContents.getZoomFactor() : 1
    const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
    this.dipViewport = {
      x: Math.round(rect.x * scale),
      y: Math.round(rect.y * scale),
      width: Math.max(0, Math.round(rect.width * scale)),
      height: Math.max(0, Math.round(rect.height * scale)),
    }
    this.broadcastState()
    this.applyBounds()
  }

  /** 应用桌宠渲染进程上报的紧凑包裹几何（DIP，相对视口左上角） */
  public applyGeometry(geometry: YanhuPetWindowGeometry): void {
    this.geometry = {
      x: Math.round(geometry.x),
      y: Math.round(geometry.y),
      width: Math.max(1, Math.round(geometry.width)),
      height: Math.max(1, Math.round(geometry.height)),
    }
    this.applyBounds()
  }

  /** 拉取启动引导数据（配置 + 历史 + 视口 + 呈现态） */
  public getBootstrap(): YanhuPetBootstrap {
    const viewport =
      this.dipViewport && this.dipViewport.width > 0 && this.dipViewport.height > 0
        ? { width: this.dipViewport.width, height: this.dipViewport.height }
        : null
    return {
      config: yanhuPiRuntime.getConfig(),
      history: yanhuPiRuntime.getHistory(),
      viewport,
      presented: this.presented,
    }
  }

  /** 读取配置 */
  public getConfig(): YanhuPetConfig {
    return yanhuPiRuntime.getConfig()
  }

  /** 保存配置并广播到桌宠窗口 */
  public saveConfig(patch: Partial<YanhuPetConfig>): YanhuPetConfig {
    const config = yanhuPiRuntime.saveConfig(patch)
    this.configRevision += 1
    this.broadcastState()
    return config
  }

  /** 读取历史消息 */
  public getHistory(): YanhuPetMessage[] {
    return yanhuPiRuntime.getHistory()
  }

  /** 清空历史消息（并广播给桌宠窗口同步 UI） */
  public clearHistory(): void {
    yanhuPiRuntime.clearHistory()
    this.send(YANHU_EXPRESS_IPC_CHANNELS.PET_HISTORY_CLEARED, null)
  }

  /** 向桌宠子窗口派发流式事件（仅桌宠窗口消费；主渲染窗口不经此通道） */
  public emitStream(event: YanhuPetStreamEvent): void {
    this.send(YANHU_EXPRESS_IPC_CHANNELS.PET_CHAT_STREAM_CHUNK, event)
  }

  /** 标记一轮桌宠对话开始 */
  public markChatStarted(): void {
    this.chatRunning = true
    this.chatStartedAt = Date.now()
    this.chatError = null
  }

  /** 标记一轮桌宠对话结束（error 为 null 表示正常完成） */
  public markChatFinished(error?: string): void {
    this.chatRunning = false
    this.chatDoneAt = Date.now()
    this.chatError = error ?? null
  }

  /** 读取桌宠窗口就绪与对话运行态（新手引导轮询） */
  public getChatStatus(): YanhuPetChatStatus {
    return {
      ready: this.ready && !!this.getPetWebContents(),
      running: this.chatRunning,
      lastStartedAt: this.chatStartedAt,
      lastDoneAt: this.chatDoneAt,
      lastError: this.chatError,
    }
  }

  /**
   * 新手引导：把演示指令填入桌宠输入框（不代发送）。
   * 桌宠窗口未就绪时静默丢弃，由引导侧轮询 ready 后再调用。
   */
  public tourFill(text: string): void {
    const payload: YanhuPetTourFillEvent = { text }
    this.send(YANHU_EXPRESS_IPC_CHANNELS.PET_TOUR_FILL, payload)
  }

  /**
   * 新手引导：确保桌宠窗口在前台且伴随卡片展开。
   * 主窗口聚光灯无法跨原生窗口绘制，这里负责把桌宠抬到操作系统最上层。
   */
  public ensureTourForeground(): YanhuPetChatStatus {
    this.tourKeepAlive = true
    this.setPresented(true)
    this.saveConfig({ isCollapsed: false })
    const win = this.petWindow
    if (win && !win.isDestroyed()) {
      this.applyBounds()
      win.show()
      win.moveTop()
      this.raiseToTop()
    }
    return this.getChatStatus()
  }

  /** 结束新手引导保活：恢复「原生视图隐藏即桌宠隐藏」的常规裁决 */
  public releaseTourForeground(): void {
    this.tourKeepAlive = false
  }

  /** 新手引导保活是否生效（UPDATE_BOUNDS 的 visible=false 分支据此放行） */
  public isTourKeepAlive(): boolean {
    return this.tourKeepAlive
  }

  /** 桌宠窗口是否就绪（用于回退转发） */
  public getPetWebContents(): WebContents | null {
    if (!this.petWindow || this.petWindow.isDestroyed()) return null
    return this.petWindow.webContents
  }

  /** 设置桌宠窗口透明区域的鼠标穿透（forward: true 允许继续派发移动事件驱动悬浮态） */
  public setIgnoreMouseEvents(ignore: boolean): void {
    const win = this.petWindow
    if (win && !win.isDestroyed()) {
      win.setIgnoreMouseEvents(ignore, { forward: true })
    }
  }

  /** 弹出桌宠原生上下文菜单（OS 顶层菜单，绝不被透明子窗口紧凑边界裁剪） */
  public showContextMenu(): void {
    const win = this.petWindow
    if (!win || win.isDestroyed()) return

    const config = this.getConfig()
    const memoryLimit = config.memoryLimit
    const template: MenuItemConstructorOptions[] = [
      {
        label: '🐉 复位至屏幕正中央',
        click: () => {
          this.resetToCenter()
        },
      },
      { type: 'separator' },
      {
        label: '砚小龙设置',
        enabled: false,
      },
      { type: 'separator' },
      {
        label: config.isCollapsed ? '显示伴随卡片' : '仅显示桌宠',
        click: () => {
          this.saveConfig({ isCollapsed: !config.isCollapsed })
        },
      },
      {
        label: '视觉多模态截图感知（截图标定辅助）',
        type: 'checkbox',
        checked: Boolean(config.enableVision),
        click: () => {
          this.saveConfig({ enableVision: !config.enableVision })
        },
      },
      { type: 'separator' },
      {
        label: '对话框位置',
        submenu: [
          {
            label: '靠左',
            type: 'radio',
            checked: config.dialogPosition === 'left',
            click: () => {
              this.saveConfig({ dialogPosition: 'left' })
            },
          },
          {
            label: '靠右',
            type: 'radio',
            checked: config.dialogPosition === 'right',
            click: () => {
              this.saveConfig({ dialogPosition: 'right' })
            },
          },
        ],
      },
      {
        label: `记忆保留条数 (${memoryLimit} 条)`,
        submenu: [0, 10, 20, 50, 100, 200, 500, 1000].map((limit) => ({
          label: limit === 0 ? '0 条（不保留记忆）' : `${limit} 条`,
          type: 'radio',
          checked: memoryLimit === limit,
          click: () => {
            this.saveConfig({ memoryLimit: limit })
          },
        })),
      },
      { type: 'separator' },
      {
        label: '清空当前对话记忆',
        click: () => {
          this.clearHistory()
        },
      },
    ]

    const menu = Menu.buildFromTemplate(template)
    menu.popup({ window: win })
  }

  /**
   * 一键复位：依据当前智联万站视口（DIP）重新计算正中央坐标并落盘。
   *
   * 伴随卡片可见时以「立绘 + 间距 + 卡片」联合外框整体居中；仅桌宠态则以立绘单体居中。
   * 复位后立即抬高到绝对顶层，避免被原生网页图层抢占 Z-Order。
   */
  public resetToCenter(): void {
    const vp = this.dipViewport
    if (!vp || vp.width <= 0 || vp.height <= 0) return
    const config = this.getConfig()
    const centerY = Math.max(PET_MARGIN, Math.round((vp.height - PET_HEIGHT) / 2))
    let centerX: number
    if (config.isCollapsed) {
      centerX = Math.max(PET_MARGIN, Math.round((vp.width - PET_WIDTH) / 2))
    } else {
      const unionWidth = PET_WIDTH + PET_GAP + CARD_WIDTH
      const unionLeft = Math.max(PET_MARGIN, Math.round((vp.width - unionWidth) / 2))
      centerX = config.dialogPosition === 'left' ? unionLeft + PET_GAP + CARD_WIDTH : unionLeft
    }
    this.saveConfig({ petPosition: { x: centerX, y: centerY } })
    this.raiseToTop()
    this.applyBounds()
  }

  /** 释放桌宠窗口 */
  public dispose(): void {
    this.presented = false
    this.geometry = null
    // 解绑主窗口生命周期监听：主窗口重建 / 重新 setOwnerWindow 时不残留旧回调
    const owner = this.owner
    const handlers = this.ownerHandlers
    if (handlers && owner && !owner.isDestroyed()) {
      owner.off('move', handlers.move)
      owner.off('resize', handlers.resize)
      owner.off('minimize', handlers.minimize)
      owner.off('restore', handlers.restore)
      owner.off('show', handlers.show)
      owner.off('hide', handlers.hide)
      owner.off('focus', handlers.focus)
      owner.off('blur', handlers.blur)
      owner.off('closed', handlers.closed)
    }
    this.ownerHandlers = null
    this.ownerListenersBound = false
    if (this.focusTimer) {
      clearTimeout(this.focusTimer)
      this.focusTimer = null
    }
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer)
      this.watchdogTimer = null
    }
    if (this.appFocusListener) {
      app.removeListener('browser-window-focus', this.appFocusListener)
      this.appFocusListener = null
    }
    if (this.appBlurListener) {
      app.removeListener('browser-window-blur', this.appBlurListener)
      this.appBlurListener = null
    }
    this.hideWindow()
    if (this.petWindow && !this.petWindow.isDestroyed()) {
      this.petWindow.destroy()
    }
    this.petWindow = null
  }

  // ===== 内部实现 =====

  /** 惰性创建桌宠子窗口 */
  private ensureWindow(): BrowserWindow | null {
    const owner = this.owner
    if (!owner || owner.isDestroyed()) return null
    if (this.petWindow && !this.petWindow.isDestroyed()) return this.petWindow

    const win = new BrowserWindow({
      width: 400,
      height: 560,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      // 核心保证：独立全局顶层（脱离 parent 绑定），HWND 提升至 screen-saver 层级，
      // 彻底免疫 WebContentsView 在 DirectComposition 树中抢占 Z-Order 吞噬桌宠的问题。
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    // 提升至 screen-saver 全局最高层：高于所有 Windows 应用程序内部原生视图图层
    win.setAlwaysOnTop(true, 'screen-saver')

    // 安全加固：禁止新窗口与外部导航
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      console.warn(`[yanhu-pet:did-fail-load] code=${errorCode} ${errorDescription}: ${validatedURL}`)
    })
    // 日志透明化管道：镜像桌宠子窗口控制台到主进程，杜绝模块加载 / 未捕获异常的隐式静默失败
    win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      const severity = ['verbose', 'info', 'warning', 'error'][level] ?? String(level)
      console.log(`[yanhu-pet:console:${severity}] ${sourceId}:${line} ${message}`)
    })

    const isDev = !app.isPackaged
    if (isDev) {
      void win.loadURL(`${VITE_DEV_SERVER_URL}?window=yanhu-pet`)
    } else {
      void win.loadFile(join(__dirname, 'renderer', 'index.html'), { query: { window: 'yanhu-pet' } })
    }

    win.webContents.once('did-finish-load', () => {
      this.ready = true
      this.broadcastState()
      this.applyBounds()
    })

    win.on('closed', () => {
      this.ready = false
      this.petWindow = null
    })
    // 子窗口自身失焦：覆盖「点击桌宠后随即切到外部应用」的场景，同样纳入 80ms 前台裁决
    win.on('blur', () => {
      this.scheduleFocusReconcile()
    })

    this.petWindow = win
    return win
  }

  private hideWindow(): void {
    if (this.focusTimer) {
      clearTimeout(this.focusTimer)
      this.focusTimer = null
    }
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer)
      this.watchdogTimer = null
    }
    if (this.petWindow && !this.petWindow.isDestroyed()) {
      this.petWindow.hide()
    }
  }

  /**
   * 依据视口 + 紧凑几何计算并应用窗口屏幕边界。
   *
   * 直接调用 setBounds 应用紧凑包裹矩形（DIP）。
   * 严禁无谓调用 hide()，避免 Windows DWM 透明分层窗口撕裂闪黑与打断输入框键盘焦点。
   */
  private applyBounds(): void {
    const win = this.petWindow
    if (!win || win.isDestroyed()) return
    const owner = this.owner
    // 桌宠显隐与客户端主窗口强绑定（单一裁决点）：
    // 主窗口不存在 / 已销毁 / 不可见 / 最小化 / 未呈现 / 无有效视口 → 一律隐藏，绝不单独漂浮。
    if (!owner || owner.isDestroyed() || !this.presented || !this.dipViewport
      || !owner.isVisible() || owner.isMinimized()) {
      win.hide()
      return
    }

    const vp = this.dipViewport
    // 桌宠渲染进程尚未上报 geometry 时，使用由几何常量推导的默认紧凑外框保底（居中），
    // 维持窗口显示，绝不调用 win.hide()，彻底消除启动竞争条件导致的桌宠不可见死锁。
    const geometry = this.geometry ?? {
      x: Math.max(0, Math.round((vp.width - DEFAULT_GEOMETRY_WIDTH) / 2)),
      y: Math.max(0, Math.round((vp.height - DEFAULT_GEOMETRY_HEIGHT) / 2)),
      width: DEFAULT_GEOMETRY_WIDTH,
      height: DEFAULT_GEOMETRY_HEIGHT,
    }

    const content = owner.getContentBounds()
    const bounds = {
      x: Math.round(content.x + vp.x + geometry.x),
      y: Math.round(content.y + vp.y + geometry.y),
      width: Math.max(1, geometry.width),
      height: Math.max(1, geometry.height),
    }

    const current = win.getBounds()
    const sizeChanged = current.width !== bounds.width || current.height !== bounds.height
    const positionChanged = current.x !== bounds.x || current.y !== bounds.y

    if (sizeChanged || positionChanged || !win.isVisible()) {
      win.setBounds(bounds)
    }
    if (!win.isVisible()) {
      // showInactive 避免无谓抢占网页焦点
      win.showInactive()
      if (!win.isVisible()) win.show()
    }
    // 无条件抬高到绝对顶层：每次移动 / 重排 / 显示时，均在 Windows DWM 中维持 HWND 最上层，
    // 消除原生 WebContentsView 图层在 DirectComposition 树中抢占同级 Z-Order 遮挡桌宠的问题。
    this.raiseToTop()
  }

  /** 广播呈现态 + 视口尺寸 + 最新配置到桌宠窗口 */
  private broadcastState(): void {
    const viewport =
      this.dipViewport && this.dipViewport.width > 0 && this.dipViewport.height > 0
        ? { width: this.dipViewport.width, height: this.dipViewport.height }
        : null
    const event: YanhuPetStateEvent = {
      viewport,
      presented: this.presented,
      configRevision: this.configRevision,
      config: this.getConfig(),
    }
    this.send(YANHU_EXPRESS_IPC_CHANNELS.PET_STATE_CHANGED, event)
  }

  private send(channel: string, payload: unknown): void {
    const wc = this.getPetWebContents()
    if (wc && !wc.isDestroyed()) wc.send(channel, payload)
  }
}

/** 全局单例 */
export const yanhuPetWindowManager = new YanhuPetWindowManager()
