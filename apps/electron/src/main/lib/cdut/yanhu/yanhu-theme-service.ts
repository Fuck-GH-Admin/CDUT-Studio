/**
 * 智联万站主题跟随服务（YanhuThemeService）
 *
 * 三位一体联动机制（见规格书 4.1）：
 *   1. 底层 WebContentsView 底色防白闪（深色 #09090b / 浅色 #ffffff）；
 *   2. 网页 `prefers-color-scheme` 媒体特征动态仿真（CDP Emulation，失败降级注入 CSS）；
 *   3. 全局主题切换时遍历所有活跃视图热更新，无需重载页面。
 *
 * 说明：前端外壳的语义化配色由渲染层 Tailwind 类承担，本服务只负责「原生侧」跟随。
 */

import type { WebContents, WebContentsView } from 'electron'
import { resolveAppThemeIsDark } from '../../app-theme-service'
import {
  YANHU_DARK_SCROLLBAR_CSS,
  YANHU_LIGHT_SCROLLBAR_CSS,
  resolveYanhuViewBackground,
} from './yanhu-constants'
import { nativeTheme } from 'electron'

/** 智联万站关注的三态主题模式（special 皮肤由 app-theme-service 统一解析） */
export type YanhuThemeMode = 'light' | 'dark' | 'system'

/**
 * 纯函数：依据主题模式与系统明暗解析最终明暗。
 * （light/dark 直接判定；system 跟随系统；供单元测试确定性命中）
 */
export function resolveYanhuIsDark(mode: YanhuThemeMode, systemIsDark: boolean): boolean {
  if (mode === 'light') return false
  if (mode === 'dark') return true
  return systemIsDark
}

/**
 * 纯函数：依据主题模式与系统明暗解析底层视图底色。
 */
export function resolveYanhuThemeBackground(mode: YanhuThemeMode, systemIsDark: boolean): string {
  return resolveYanhuViewBackground(resolveYanhuIsDark(mode, systemIsDark))
}

/** 主题变更监听器 */
export type YanhuThemeListener = (isDark: boolean) => void

/**
 * 将主题明暗同步到单个网页 WebContents 的 `prefers-color-scheme`。
 *
 * 优先走 CDP `Emulation.setEmulatedMedia`（真媒体模拟，页面无需重载）；
 * 若调试器不可用（已被占用 / 附加失败），降级注入细滚动条 CSS，保证暗色体验不刺眼。
 */
/**
 * 已注入的降级 CSS key（按 WebContents 记账）。
 * 重复注入前先回收上一次，避免反复切换深浅主题时样式表无限累积。
 */
const insertedCssKeys = new WeakMap<WebContents, string>()

export async function syncThemeToWebContents(wc: WebContents, isDark: boolean): Promise<void> {
  // 关键约束：严禁为普通主题跟随主动附加调试器！
  // 办事大厅与青果教务部署的瑞数动态安全（Botgate）在检测到调试器附着时会激活断点陷阱。
  // 若 CDP 已由 AI/调试总线附着，则走 Emulation 仿真；否则走 insertCSS 降级，恪守 0 调试器介入红线。
  if (wc.debugger.isAttached()) {
    try {
      await wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
        media: 'page',
        features: [{ name: 'prefers-color-scheme', value: isDark ? 'dark' : 'light' }],
      })
      return
    } catch {
      // 忽略 CDP 命令异常
    }
  }

  // 降级兜底：注入 CSS 变量与细滚动条（先回收上一次注入，避免反复切主题累积样式表）
  try {
    const previousKey = insertedCssKeys.get(wc)
    if (previousKey) {
      insertedCssKeys.delete(wc)
      try {
        await wc.removeInsertedCSS(previousKey)
      } catch {
        // 页面可能已销毁，忽略
      }
    }
    const key = await wc.insertCSS(isDark ? YANHU_DARK_SCROLLBAR_CSS : YANHU_LIGHT_SCROLLBAR_CSS)
    insertedCssKeys.set(wc, key)
  } catch {
    // 页面可能已销毁，忽略
  }
}

/**
 * 智联万站主题跟随服务。
 *
 * 维护所有活跃 `WebContentsView` 引用，主题变化时一次性热更新。
 */
export class YanhuThemeService {
  private readonly views = new Set<WebContentsView>()
  private readonly listeners = new Set<YanhuThemeListener>()
  private systemThemeSubscribed = false

  /** 解析当前 CDUT Studio 客户端生效明暗（含 special 皮肤） */
  public resolveCurrentIsDark(): boolean {
    return resolveAppThemeIsDark()
  }

  /** 把当前主题底色应用到指定视图（防白闪） */
  public applyViewBackground(view: WebContentsView): void {
    try {
      view.setBackgroundColor(resolveYanhuViewBackground(this.resolveCurrentIsDark()))
    } catch {
      // 视图可能已销毁，忽略
    }
  }

  /** 注册一个活跃视图并立即应用当前底色 */
  public registerView(view: WebContentsView): void {
    this.views.add(view)
    this.applyViewBackground(view)
    this.ensureSystemThemeSubscription()
  }

  /** 注销视图（标签关闭或休眠释放时调用） */
  public unregisterView(view: WebContentsView): void {
    this.views.delete(view)
  }

  /** 订阅主题变更（渲染层可据此更新外壳颜色） */
  public onThemeChanged(listener: YanhuThemeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * 全局热更新：遍历所有活跃视图，秒级更新底色与媒体仿真，并广播给监听者。
   */
  public async syncAll(): Promise<void> {
    const isDark = this.resolveCurrentIsDark()
    for (const view of this.views) {
      this.applyViewBackground(view)
      try {
        if (!view.webContents.isDestroyed()) {
          await syncThemeToWebContents(view.webContents, isDark)
        }
      } catch {
        // 单个视图失败不影响其余视图
      }
    }
    for (const listener of this.listeners) {
      try {
        listener(isDark)
      } catch {
        // 监听器异常不影响主流程
      }
    }
  }

  /** 订阅系统主题变化（system 模式下跟随操作系统） */
  private ensureSystemThemeSubscription(): void {
    if (this.systemThemeSubscribed) return
    this.systemThemeSubscribed = true
    try {
      nativeTheme.on('updated', () => {
        void this.syncAll()
      })
    } catch {
      // 测试环境或不可用时忽略
    }
  }
}

/** 全局单例 */
export const yanhuThemeService = new YanhuThemeService()
