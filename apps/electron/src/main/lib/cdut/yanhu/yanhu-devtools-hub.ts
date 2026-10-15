/**
 * 智联万站工业级 CDP 静默总线（YanhuDevToolsHub）
 *
 * 前端 100% 不暴露任何调试 UI；主进程在此建立标准 Chrome DevTools Protocol 数据总线，
 * 开启 DOM/CSS、Page、Network、Log/Runtime 四域，并以环形缓冲区留存采集结果，
 * 为二期 AI 自动化（模拟操作、学籍档案提取、网络协议抓取）预留高可用 IPC 通道。
 *
 * 设计要点（见规格书 4.5）：
 *   - Network 环形缓冲区（最近 1000 条）、Console 实时日志广播池；
 *   - 全部能力以 `YanhuCdpResult` 语义安全降级，任一 CDP 命令失败都不抛出到 IPC 层；
 *   - 与主题服务共享同一调试器连接（附加前先判 `isAttached`，避免重复 attach 抛错）。
 */

import type { WebContents } from 'electron'
import type {
  YanhuConsoleEntry,
  YanhuLoadedResource,
  YanhuNetworkEntry,
} from '@profer/shared'

/** 网络环形缓冲区容量 */
const MAX_NETWORK_ENTRIES = 1000
/** 控制台日志环形缓冲区容量 */
const MAX_CONSOLE_ENTRIES = 500
/** 单条 CDP 命令硬超时（防止页面进程卡死拖垮主进程） */
const CDP_TIMEOUT_MS = 6000
/** executeScript 表达式长度上限（防超大脚本注入） */
const MAX_SCRIPT_CHARS = 64_000
/** 单条控制台文本长度上限 */
const MAX_CONSOLE_TEXT_CHARS = 4000
/** 在途请求强制逐出阈值（毫秒）：长轮询 / SSE 等永不结束的请求据此剪除，防止卡死阻塞稳态判定 */
export const YANHU_INFLIGHT_EVICT_MS = 10_000
/** 不计入在途请求集的持续连接类型（WebSocket / SSE / Ping 不代表页面业务加载进度） */
const NON_INFLIGHT_TYPES = new Set(['WebSocket', 'EventSource', 'Ping'])

type CdpMessageListener = (event: unknown, method: string, params: Record<string, unknown>) => void

interface TabCdpBuffer {
  webContents: WebContents
  network: YanhuNetworkEntry[]
  /** requestId -> 网络条目索引，用于响应事件回填状态/头信息 */
  networkIndex: Map<string, YanhuNetworkEntry>
  console: YanhuConsoleEntry[]
  resources: YanhuLoadedResource[]
  resourceKeys: Set<string>
  /** 在途业务请求：requestId -> 发起时间戳（毫秒），用于网络平面静止判定 */
  inflight: Map<string, number>
  /** 最近一次网络活动时间戳（毫秒）：请求发起 / 完成 / 失败均刷新 */
  lastNetworkActivityAt: number
  /** 已知框架 ID 集合（跨 Frame 上下文管理） */
  frames: Set<string>
  /** 已发现的关联 Target（OOPIF / Worker）ID -> 类型，供跨进程框架感知 */
  targets: Map<string, string>
  /** 断点免疫是否已确立（Debugger.setSkipAllPauses 成功 + 原生 debugger 暂停自动恢复） */
  breakpointImmune: boolean
  onMessage: CdpMessageListener
  onDetach: () => void
}

/** 安全读取字符串字段 */
function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** 安全读取对象字段 */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/** 归一化请求 / 响应头为纯字符串映射 */
function normalizeHeaders(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  const record = asRecord(value)
  for (const [key, val] of Object.entries(record)) {
    out[key] = typeof val === 'string' ? val : String(val)
  }
  return out
}

/** 将 CDP consoleAPICalled 的 type 映射为受支持的日志级别 */
function normalizeConsoleType(rawType: string): YanhuConsoleEntry['type'] {
  switch (rawType) {
    case 'warning':
      return 'warn'
    case 'error':
      return 'error'
    case 'debug':
      return 'debug'
    case 'info':
      return 'info'
    default:
      return 'log'
  }
}

/** 将 Log.entryAdded 的 level 映射为受支持的日志级别 */
function normalizeLogLevel(rawLevel: string): YanhuConsoleEntry['type'] {
  switch (rawLevel) {
    case 'error':
      return 'error'
    case 'warning':
      return 'warn'
    case 'verbose':
      return 'debug'
    default:
      return 'info'
  }
}

/** 截断超长控制台文本，避免环形缓冲区内存膨胀 */
function truncateText(text: string): string {
  return text.length > MAX_CONSOLE_TEXT_CHARS ? `${text.slice(0, MAX_CONSOLE_TEXT_CHARS)}…（已截断）` : text
}

/**
 * 解析 CDP `exceptionDetails` 为可读异常信息（纯函数，便于单测）。
 *
 * 关键：Chrome 对未捕获异常只在 `details.text` 给出笼统的 `"Uncaught"`，真正的
 * `TypeError: Illegal invocation` 等有效信息位于 `details.exception.description`。
 * 优先取 description 首行，避免此前把「Illegal invocation」吞成毫无诊断价值的 "Uncaught"。
 *
 * @returns 无异常时返回 null（调用方据此判定是否抛出）
 */
export function resolveCdpExceptionMessage(exceptionDetails: unknown): string | null {
  if (!exceptionDetails || typeof exceptionDetails !== 'object') return null
  const details = exceptionDetails as Record<string, unknown>
  const exception = asRecord(details.exception)
  const description = asString(exception.description).trim()
  if (description) return description.split('\n')[0]!.trim()
  const text = asString(details.text).trim()
  return text || null
}

/**
 * 智联万站 CDP 采集总线。
 */
export class YanhuDevToolsHub {
  private readonly buffers = new Map<string, TabCdpBuffer>()

  /** 是否已对该标签建立 CDP 总线 */
  public has(tabId: string): boolean {
    return this.buffers.has(tabId)
  }

  /** 读取标签底层 WebContents（不存在或已销毁返回 null） */
  public getWebContents(tabId: string): WebContents | null {
    const buffer = this.buffers.get(tabId)
    if (!buffer) return null
    return buffer.webContents && !buffer.webContents.isDestroyed() ? buffer.webContents : null
  }

  /** 公开发送 CDP 命令（带硬超时与安全降级），供浏览器工具层驱动底层交互 */
  public send(
    tabId: string,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const buffer = this.buffers.get(tabId)
    if (!buffer) return Promise.reject(new Error('目标标签未建立 CDP 总线'))
    return this.sendCommand(buffer, method, params)
  }

  /**
   * 为标签建立 CDP 总线：附加调试器、开启四域、挂载环形缓冲区采集。
   * 幂等：同一 tabId 重复调用直接返回。
   */
  public async attach(tabId: string, wc: WebContents): Promise<void> {
    if (this.buffers.has(tabId) || !wc || wc.isDestroyed()) return

    try {
      if (!wc.debugger.isAttached()) {
        wc.debugger.attach('1.3')
      }
    } catch (err) {
      console.warn('[智联万站·CDP] 附加调试器失败，CDP 采集不可用:', err)
      return
    }

    const onMessage: CdpMessageListener = (_event, method, params) => {
      try {
        this.consumeCdpEvent(tabId, method, params)
      } catch (err) {
        console.warn('[智联万站·CDP] 采集事件异常:', err)
      }
    }
    const onDetach = (): void => {
      this.disposeBuffer(tabId)
    }

    const buffer: TabCdpBuffer = {
      webContents: wc,
      network: [],
      networkIndex: new Map(),
      console: [],
      resources: [],
      resourceKeys: new Set(),
      inflight: new Map(),
      lastNetworkActivityAt: 0,
      frames: new Set(),
      targets: new Map(),
      breakpointImmune: false,
      onMessage,
      onDetach,
    }
    this.buffers.set(tabId, buffer)

    try {
      wc.debugger.on('message', onMessage)
      wc.debugger.on('detach', onDetach)
    } catch (err) {
      console.warn('[智联万站·CDP] 挂载监听失败:', err)
    }

    // 关键防御 1：最优先启用断点忽略，彻底解除瑞数反调试 debugger; 导致 V8 挂起与事件循环饥饿
    try {
      await this.sendCommand(buffer, 'Debugger.enable')
      await this.sendCommand(buffer, 'Debugger.setSkipAllPauses', { skip: true })
      await this.sendCommand(buffer, 'Debugger.setBreakpointsActive', { active: false })
      // 断点免疫确认：三项命令全部成功后置位，供稳态算法判定交互是否可信
      buffer.breakpointImmune = true
    } catch {
      // 忽略
    }

    // 关键防御 2：断点免疫确立后，再开启其余全量数据监听域（任一域失败不影响其余）
    for (const domain of [
      'Network.enable',
      'Runtime.enable',
      'Log.enable',
      'Page.enable',
      'DOM.enable',
      'Accessibility.enable',
    ]) {
      try {
        await this.sendCommand(buffer, domain)
      } catch {
        // 忽略单个域启用失败
      }
    }

    // 关键防御 3：Target 状态感知——发现 OOPIF / Worker 等关联目标，供跨进程框架因果分析
    try {
      await this.sendCommand(buffer, 'Target.setDiscoverTargets', { discover: true })
    } catch {
      // 忽略：部分环境不支持该命令，不影响主链路
    }
  }

  /** 释放某标签的 CDP 总线（移除监听 + 清空缓冲区；不主动 detach，交由视图销毁回收） */
  public release(tabId: string): void {
    this.disposeBuffer(tabId)
  }

  private disposeBuffer(tabId: string): void {
    const buffer = this.buffers.get(tabId)
    if (!buffer) return
    this.buffers.delete(tabId)
    try {
      buffer.webContents.debugger.removeListener('message', buffer.onMessage)
      buffer.webContents.debugger.removeListener('detach', buffer.onDetach)
    } catch {
      // 视图可能已销毁
    }
  }

  /** 消费一条 CDP 事件并写入环形缓冲区 */
  private consumeCdpEvent(tabId: string, method: string, params: Record<string, unknown>): void {
    const buffer = this.buffers.get(tabId)
    if (!buffer) return

    // 遇到反调试 debugger 暂停立即恢复执行
    if (method === 'Debugger.paused') {
      try {
        void buffer.webContents.debugger.sendCommand('Debugger.resume')
      } catch {
        // 忽略
      }
      return
    }

    switch (method) {
      case 'Network.requestWillBeSent':
        this.onRequestWillBeSent(buffer, params)
        break
      case 'Network.responseReceived':
        this.onResponseReceived(buffer, params)
        break
      case 'Network.loadingFinished':
        this.onLoadingFinished(buffer, params)
        break
      case 'Network.loadingFailed':
        this.onLoadingFailed(buffer, params)
        break
      case 'Runtime.consoleAPICalled':
        this.onConsoleApiCalled(buffer, params)
        break
      case 'Runtime.exceptionThrown':
        this.onExceptionThrown(buffer, params)
        break
      case 'Log.entryAdded':
        this.onLogEntryAdded(buffer, params)
        break
      case 'Page.frameAttached':
        this.onFrameAttached(buffer, params)
        break
      case 'Page.frameDetached':
        this.onFrameDetached(buffer, params)
        break
      case 'Page.frameNavigated':
        this.onFrameNavigated(buffer, params)
        break
      case 'Target.targetCreated':
      case 'Target.targetInfoChanged':
        this.onTargetInfoChanged(buffer, params)
        break
      case 'Target.targetDestroyed':
        this.onTargetDestroyed(buffer, params)
        break
      default:
        break
    }
  }

  /** 跨 Frame 上下文：记录子框架接入 */
  private onFrameAttached(buffer: TabCdpBuffer, params: Record<string, unknown>): void {
    const frameId = asString(params.frameId)
    if (frameId) buffer.frames.add(frameId)
  }

  /** 跨 Frame 上下文：移除已分离的子框架 */
  private onFrameDetached(buffer: TabCdpBuffer, params: Record<string, unknown>): void {
    const frameId = asString(params.frameId)
    if (frameId) buffer.frames.delete(frameId)
  }

  /** 跨 Frame 上下文：主/子框架导航后刷新框架集 */
  private onFrameNavigated(buffer: TabCdpBuffer, params: Record<string, unknown>): void {
    const frame = asRecord(params.frame)
    const frameId = asString(frame.id)
    if (frameId) buffer.frames.add(frameId)
    // 顶层框架导航：旧框架树作废，仅保留新顶层框架，避免陈旧框架 ID 累积
    if (!frame.parentId) {
      buffer.frames.clear()
      buffer.frames.add(frameId)
    }
  }

  /** Target 状态感知：登记关联目标类型 */
  private onTargetInfoChanged(buffer: TabCdpBuffer, params: Record<string, unknown>): void {
    const info = asRecord(params.targetInfo)
    const targetId = asString(info.targetId)
    if (!targetId) return
    buffer.targets.set(targetId, asString(info.type, 'unknown'))
  }

  /** Target 状态感知：移除已销毁目标 */
  private onTargetDestroyed(buffer: TabCdpBuffer, params: Record<string, unknown>): void {
    const targetId = asString(params.targetId)
    if (targetId) buffer.targets.delete(targetId)
  }

  private pushNetwork(buffer: TabCdpBuffer, entry: YanhuNetworkEntry): void {
    buffer.network.push(entry)
    buffer.networkIndex.set(entry.requestId, entry)
    if (buffer.network.length > MAX_NETWORK_ENTRIES) {
      const removed = buffer.network.shift()
      if (removed) buffer.networkIndex.delete(removed.requestId)
    }
  }

  private recordResource(buffer: TabCdpBuffer, url: string, type: string): void {
    if (!url) return
    const key = `${type}::${url}`
    if (buffer.resourceKeys.has(key)) return
    buffer.resourceKeys.add(key)
    buffer.resources.push({ url, type })
    if (buffer.resources.length > MAX_NETWORK_ENTRIES) {
      const removed = buffer.resources.shift()
      if (removed) buffer.resourceKeys.delete(`${removed.type}::${removed.url}`)
    }
  }

  private pushConsole(buffer: TabCdpBuffer, entry: YanhuConsoleEntry): void {
    buffer.console.push(entry)
    if (buffer.console.length > MAX_CONSOLE_ENTRIES) buffer.console.shift()
  }

  private onRequestWillBeSent(buffer: TabCdpBuffer, params: Record<string, unknown>): void {
    const requestId = asString(params.requestId)
    const request = asRecord(params.request)
    const url = asString(request.url)
    if (!requestId || !url) return

    const timestamp = typeof params.timestamp === 'number' ? params.timestamp * 1000 : Date.now()
    const entry: YanhuNetworkEntry = {
      requestId,
      url,
      method: asString(request.method, 'GET'),
      requestHeaders: normalizeHeaders(request.headers),
      timing: { start: Math.round(timestamp) },
      postData: typeof request.postData === 'string' ? request.postData : undefined,
    }
    this.pushNetwork(buffer, entry)
    this.recordResource(buffer, url, asString(params.type, 'Other'))
    // 网络平面：登记在途业务请求（过滤 WebSocket / SSE / Ping 等持续连接）
    const type = asString(params.type, 'Other')
    if (!NON_INFLIGHT_TYPES.has(type)) {
      buffer.inflight.set(requestId, Date.now())
    }
    buffer.lastNetworkActivityAt = Date.now()
  }

  private onResponseReceived(buffer: TabCdpBuffer, params: Record<string, unknown>): void {
    const requestId = asString(params.requestId)
    const entry = buffer.networkIndex.get(requestId)
    if (!entry) return
    const response = asRecord(params.response)
    if (typeof response.status === 'number') entry.status = response.status
    if (response.headers) entry.responseHeaders = normalizeHeaders(response.headers)
    if (typeof response.mimeType === 'string') entry.mimeType = response.mimeType
    const timing = asRecord(response.timing)
    if (typeof timing.requestTime === 'number' && entry.timing) {
      entry.timing.start = Math.round(timing.requestTime * 1000)
    }
  }

  private onLoadingFinished(buffer: TabCdpBuffer, params: Record<string, unknown>): void {
    const requestId = asString(params.requestId)
    buffer.inflight.delete(requestId)
    const entry = buffer.networkIndex.get(requestId)
    const end = typeof params.timestamp === 'number' ? params.timestamp * 1000 : Date.now()
    if (entry?.timing) {
      entry.timing.end = Math.round(end)
      entry.timing.durationMs = Math.max(0, entry.timing.end - entry.timing.start)
    }
    buffer.lastNetworkActivityAt = Date.now()
  }

  private onLoadingFailed(buffer: TabCdpBuffer, params: Record<string, unknown>): void {
    const requestId = asString(params.requestId)
    buffer.inflight.delete(requestId)
    const entry = buffer.networkIndex.get(requestId)
    if (!entry) return
    if (typeof entry.status !== 'number') entry.status = 0
    const end = typeof params.timestamp === 'number' ? params.timestamp * 1000 : Date.now()
    if (entry.timing) {
      entry.timing.end = Math.round(end)
      entry.timing.durationMs = Math.max(0, entry.timing.end - entry.timing.start)
    }
    buffer.lastNetworkActivityAt = Date.now()
  }

  private onConsoleApiCalled(buffer: TabCdpBuffer, params: Record<string, unknown>): void {
    const type = normalizeConsoleType(asString(params.type, 'log'))
    const args = Array.isArray(params.args) ? params.args : []
    const text = args
      .map((arg) => {
        const record = asRecord(arg)
        if ('value' in record) return String(record.value)
        return asString(record.description, asString(record.type, ''))
      })
      .join(' ')
    const timestamp = typeof params.timestamp === 'number' ? Math.round(params.timestamp) : Date.now()
    const stackTrace = this.formatStackTrace(asRecord(params.stackTrace))
    this.pushConsole(buffer, { type, text: truncateText(text), timestamp, stackTrace })
  }

  private onExceptionThrown(buffer: TabCdpBuffer, params: Record<string, unknown>): void {
    const details = asRecord(params.exceptionDetails)
    const exception = asRecord(details.exception)
    const text = asString(exception.description, asString(details.text, '未捕获异常'))
    const timestamp =
      typeof details.timestamp === 'number' ? Math.round(details.timestamp) : Date.now()
    this.pushConsole(buffer, {
      type: 'error',
      text: truncateText(text),
      timestamp,
      stackTrace: this.formatStackTrace(asRecord(details.stackTrace)),
    })
  }

  private onLogEntryAdded(buffer: TabCdpBuffer, params: Record<string, unknown>): void {
    const entry = asRecord(params.entry)
    const text = asString(entry.text)
    if (!text) return
    const timestamp = typeof entry.timestamp === 'number' ? Math.round(entry.timestamp) : Date.now()
    const source = asString(entry.url)
    this.pushConsole(buffer, {
      type: normalizeLogLevel(asString(entry.level, 'info')),
      text: truncateText(text),
      timestamp,
      stackTrace: source || undefined,
    })
  }

  private formatStackTrace(trace: Record<string, unknown>): string | undefined {
    const frames = Array.isArray(trace.callFrames) ? trace.callFrames : []
    if (frames.length === 0) return undefined
    return frames
      .map((frame) => {
        const record = asRecord(frame)
        const fn = asString(record.functionName, '<anonymous>')
        const url = asString(record.url)
        const line = typeof record.lineNumber === 'number' ? record.lineNumber + 1 : 0
        return `    at ${fn} (${url}:${line})`
      })
      .join('\n')
  }

  /**
   * 发送 CDP 命令（带硬超时，失败安全降级）。
   */
  private sendCommand(
    buffer: TabCdpBuffer,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const wc = buffer.webContents
    if (!wc || wc.isDestroyed() || !wc.debugger.isAttached()) {
      return Promise.reject(new Error('CDP 未附加'))
    }
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP ${method} 超时`)), CDP_TIMEOUT_MS)
      wc.debugger.sendCommand(method, params).then(
        (result) => {
          clearTimeout(timer)
          resolve((result as Record<string, unknown>) ?? {})
        },
        (err) => {
          clearTimeout(timer)
          reject(err instanceof Error ? err : new Error(String(err)))
        },
      )
    })
  }

  private getBuffer(tabId: string): TabCdpBuffer | null {
    return this.buffers.get(tabId) ?? null
  }

  /** 1. Elements：提取当前页面完整 DOM 树（可指定深度） */
  public async getDomTree(tabId: string, depth?: number): Promise<unknown> {
    const buffer = this.getBuffer(tabId)
    if (!buffer) return null
    const result = await this.sendCommand(buffer, 'DOM.getDocument', {
      depth: typeof depth === 'number' && depth >= 0 ? depth : -1,
      pierce: true,
    })
    return result.root ?? null
  }

  /** 2. Accessibility：获取全框架无障碍树（含 iframe/frameset 子文档），供纯文本 Agent 语义消费 */
  public async getFullAXTree(tabId: string): Promise<unknown> {
    const buffer = this.getBuffer(tabId)
    if (!buffer) return null
    const result = await this.sendCommand(buffer, 'Accessibility.getFullAXTree')
    return Array.isArray(result.nodes) ? result.nodes : []
  }

  /** 2. Sources：获取当前页面主 HTML 源码 */
  public async getPageSource(tabId: string): Promise<string> {
    const buffer = this.getBuffer(tabId)
    if (!buffer) return ''
    const result = await this.sendCommand(buffer, 'Runtime.evaluate', {
      expression: 'document.documentElement ? document.documentElement.outerHTML : ""',
      returnByValue: true,
      awaitPromise: true,
    })
    const evaluated = asRecord(result.result)
    return asString(evaluated.value)
  }

  /** 2. Sources：获取已加载资源清单（含类型） */
  public async getLoadedResources(tabId: string): Promise<YanhuLoadedResource[]> {
    const buffer = this.getBuffer(tabId)
    if (!buffer) return []
    try {
      const result = await this.sendCommand(buffer, 'Page.getResourceTree')
      const resources: YanhuLoadedResource[] = []
      const walk = (node: unknown): void => {
        const record = asRecord(node)
        const url = asString(record.url)
        if (url) resources.push({ url, type: asString(record.type, 'Other') })
        const children = Array.isArray(record.children) ? record.children : []
        for (const child of children) walk(child)
      }
      walk(asRecord(result.frameTree).frame)
      if (resources.length > 0) return resources
    } catch {
      // 降级使用网络缓冲区记录
    }
    return [...buffer.resources]
  }

  /** 3. Network：获取网络请求日志流（支持 URL 正则过滤） */
  public getNetworkLogs(tabId: string, filterRegex?: string): YanhuNetworkEntry[] {
    const buffer = this.getBuffer(tabId)
    if (!buffer) return []
    const entries = [...buffer.network]
    if (!filterRegex) return entries
    try {
      const regex = new RegExp(filterRegex, 'i')
      return entries.filter((entry) => regex.test(entry.url))
    } catch {
      // 非法正则会话：返回全量而非报错
      return entries
    }
  }

  /** 4. Console：获取控制台实时日志输出与异常抛出 */
  public getConsoleLogs(tabId: string): YanhuConsoleEntry[] {
    const buffer = this.getBuffer(tabId)
    return buffer ? [...buffer.console] : []
  }

  /**
   * 网络平面：读取当前在途业务请求数（先执行陈旧请求逐出，杜绝长轮询永久阻塞稳态判定）。
   */
  public getInflightCount(tabId: string): number {
    const buffer = this.getBuffer(tabId)
    if (!buffer) return 0
    const now = Date.now()
    for (const [requestId, startedAt] of buffer.inflight) {
      if (now - startedAt > YANHU_INFLIGHT_EVICT_MS) buffer.inflight.delete(requestId)
    }
    return buffer.inflight.size
  }

  /** 网络平面：读取最近一次网络活动时间戳（无活动返回 0） */
  public getNetworkActivityAt(tabId: string): number {
    const buffer = this.getBuffer(tabId)
    return buffer ? buffer.lastNetworkActivityAt : 0
  }

  /** 跨 Frame 上下文：读取当前已感知的框架总数（含顶层框架） */
  public getFrameCount(tabId: string): number {
    const buffer = this.getBuffer(tabId)
    return buffer ? buffer.frames.size : 0
  }

  /** Target 状态感知：读取关联目标（OOPIF / Worker 等）数量 */
  public getRelatedTargetCount(tabId: string): number {
    const buffer = this.getBuffer(tabId)
    return buffer ? buffer.targets.size : 0
  }

  /** 断点免疫确认：是否已成功确立反调试断点忽略（未建立 CDP 总线时返回 false） */
  public isBreakpointImmune(tabId: string): boolean {
    return this.getBuffer(tabId)?.breakpointImmune ?? false
  }

  /** 5. 高级能力：在隔离环境中求值（为二期 AI 自动化预留） */
  public async executeScript(tabId: string, expression: string): Promise<unknown> {
    const buffer = this.getBuffer(tabId)
    if (!buffer) throw new Error('目标标签未建立 CDP 总线')
    if (typeof expression !== 'string' || expression.length === 0) {
      throw new Error('脚本表达式为空')
    }
    if (expression.length > MAX_SCRIPT_CHARS) {
      throw new Error('脚本表达式超出长度上限')
    }
    const result = await this.sendCommand(buffer, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    const exceptionMessage = resolveCdpExceptionMessage(result.exceptionDetails)
    if (exceptionMessage !== null) throw new Error(exceptionMessage)
    return asRecord(result.result).value
  }
}

/** 全局单例 */
export const yanhuDevToolsHub = new YanhuDevToolsHub()
