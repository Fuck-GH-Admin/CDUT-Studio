/**
 * SSE 客户端 — 连接团队服务器 SSE 端点，接收实时事件推送
 *
 * 在主进程中运行，解析 SSE 帧后通过 webContents.send() 转发到渲染进程。
 * 支持断线重连（指数退避）和窗口聚焦感知的自动连接管理。
 */

import { fetch as undiciFetch } from 'undici'
import { BrowserWindow, app } from 'electron'
import { SSE_IPC_CHANNELS } from '@profer/shared'

// ===== 类型定义 =====

export interface SSEEvent {
  type: string
  data: unknown
  workspaceId: string
  timestamp: number
}

type EventCallback = (workspaceId: string, event: SSEEvent) => void

interface SSEMeta {
  baseUrl: string
  token: string
  abortController: AbortController
  reconnectTimer?: ReturnType<typeof setTimeout>
  retryCount: number
  retryDelay: number
  connected: boolean
  /** 最近一次收到的 SSE 事件 id，用于重连时携带 Last-Event-ID 续传 */
  lastEventId?: string
  /** 已处理过的事件 id（带容量上限），用于重连后丢弃重复帧 */
  seenEventIds?: Set<string>
}

/** 已处理事件 id 的保留上限，超出时删除最早写入的项 */
export const MAX_SEEN_EVENT_IDS = 500

/** 单个 SSE 帧的解析结果 */
export interface ParsedSseFrame {
  eventType: string
  eventData: string
  /** 帧内 `id:` 字段；无 id 或 id 为空时为 undefined */
  eventId?: string
}

/**
 * 解析单个 SSE 帧（纯函数，供单测使用）
 *
 * 只处理 `event:` / `data:` / `id:` 与注释行；data 多行时取最后一行，与既有行为保持一致。
 */
export function parseSseFrame(frame: string): ParsedSseFrame {
  let eventType = ''
  let eventData = ''
  let eventId: string | undefined

  for (const rawLine of frame.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine

    if (line.startsWith('event:')) {
      eventType = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      eventData = line.slice(5).replace(/^ /, '')
    } else if (line.startsWith('id:')) {
      const value = line.slice(3).replace(/^ /, '')
      if (value) eventId = value
    } else if (line.startsWith(':')) {
      // heartbeat 注释，忽略
    }
  }

  return { eventType, eventData, eventId }
}

/** 该 id 是否已被处理过（重复帧应整帧丢弃） */
export function isDuplicateEventId(
  seenEventIds: Set<string> | undefined,
  eventId: string | undefined,
): boolean {
  if (!eventId) return false
  return seenEventIds?.has(eventId) ?? false
}

/** 记录已处理的事件 id，并按 FIFO 维持容量上限 */
export function rememberEventId(
  meta: { lastEventId?: string; seenEventIds?: Set<string> },
  eventId: string,
): void {
  const seen = meta.seenEventIds ?? (meta.seenEventIds = new Set<string>())
  seen.add(eventId)
  meta.lastEventId = eventId

  while (seen.size > MAX_SEEN_EVENT_IDS) {
    const oldest = seen.values().next().value
    if (oldest === undefined) break
    seen.delete(oldest)
  }
}

// ===== SSE 客户端 =====

const DEFAULT_RETRY_DELAY = 1000
const MAX_RETRY_DELAY = 30000
const RETRY_BACKOFF = 2

class SSEClientManager {
  private connections = new Map<string, SSEMeta>()
  private listeners: EventCallback[] = []
  private focused = true
  private initialized = false

  /** 初始化：监听窗口聚焦事件 */
  init(): void {
    if (this.initialized) return
    this.initialized = true

    // 监听窗口可见性
    app.on('browser-window-blur', () => {
      this.focused = false
    })
    app.on('browser-window-focus', () => {
      this.focused = true
      // 重新聚焦时恢复所有连接
      for (const [workspaceId, meta] of this.connections) {
        if (!meta.connected) {
          this.connect(workspaceId, meta.baseUrl, meta.token).catch(() => {})
        }
      }
    })
  }

  /** 注册事件监听器 */
  onEvent(callback: EventCallback): void {
    this.listeners.push(callback)
  }

  /** 注销事件监听器 */
  removeListener(callback: EventCallback): void {
    this.listeners = this.listeners.filter((l) => l !== callback)
  }

  /** 连接到指定工作区的 SSE 端点 */
  async connect(workspaceId: string, baseUrl: string, token: string): Promise<void> {
    // 重建连接前保留续传游标，避免窗口重新聚焦等主动重连丢事件
    const previous = this.connections.get(workspaceId)
    const previousLastEventId = previous?.lastEventId
    const previousSeenEventIds = previous?.seenEventIds

    // 如果已有连接，先断开
    await this.disconnect(workspaceId)

    const meta: SSEMeta = {
      baseUrl,
      token,
      abortController: new AbortController(),
      retryCount: 0,
      retryDelay: DEFAULT_RETRY_DELAY,
      connected: false,
      lastEventId: previousLastEventId,
      seenEventIds: previousSeenEventIds ?? new Set<string>(),
    }
    this.connections.set(workspaceId, meta)

    await this.doConnect(workspaceId, meta)
  }

  private async doConnect(workspaceId: string, meta: SSEMeta): Promise<void> {
    const url = `${meta.baseUrl}/v1/workspaces/${workspaceId}/events`

    // 重连时携带 Last-Event-ID，让服务端从上次事件之后续传
    const headers: Record<string, string> = {
      Authorization: `Bearer ${meta.token}`,
      Accept: 'text/event-stream',
    }
    if (meta.lastEventId) {
      headers['Last-Event-ID'] = meta.lastEventId
    }

    try {
      const response = await (undiciFetch as unknown as typeof fetch)(url, {
        headers,
        signal: meta.abortController.signal,
      })

      if (!response.ok) {
        if (response.status === 401) {
          console.warn(`[SSE] 认证失败 (workspace=${workspaceId})，停止重连`)
          this.broadcastStatus(workspaceId, 'auth-error')
          return
        }
        throw new Error(`HTTP ${response.status}`)
      }

      if (!response.body) {
        throw new Error('无响应体')
      }

      meta.connected = true
      meta.retryCount = 0
      meta.retryDelay = DEFAULT_RETRY_DELAY
      this.broadcastStatus(workspaceId, 'connected')
      console.log(`[SSE] 已连接 workspace=${workspaceId}`)

      // 流式读取 SSE 帧
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })

          // 按 \n\n 分割 SSE 帧
          while (buffer.includes('\n\n')) {
            const idx = buffer.indexOf('\n\n')
            const frame = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 2)
            this.parseFrame(workspaceId, meta, frame)
          }
        }
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return
        throw err
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return

      meta.connected = false
      console.warn(`[SSE] 连接断开 (workspace=${workspaceId}):`, (err as Error).message)

      // 指数退避重连
      if (!meta.abortController.signal.aborted) {
        meta.retryCount++
        meta.retryDelay = Math.min(
          DEFAULT_RETRY_DELAY * Math.pow(RETRY_BACKOFF, meta.retryCount - 1),
          MAX_RETRY_DELAY,
        )
        // 加少量随机抖动
        const jitter = Math.floor(Math.random() * 1000)
        const delay = meta.retryDelay + jitter

        this.broadcastStatus(workspaceId, 'reconnecting')
        console.log(`[SSE] ${delay}ms 后重连 (attempt #${meta.retryCount})`)

        meta.reconnectTimer = setTimeout(() => {
          if (!meta.abortController.signal.aborted) {
            this.doConnect(workspaceId, meta).catch(() => {})
          }
        }, delay)
      }
    }
  }

  /** 解析单个 SSE 帧 */
  private parseFrame(workspaceId: string, meta: SSEMeta, frame: string): void {
    const { eventType, eventData, eventId } = parseSseFrame(frame)

    // 重复 id 的整帧直接丢弃（重连后服务端可能重放）
    if (isDuplicateEventId(meta.seenEventIds, eventId)) {
      return
    }
    // 先记录游标：即使该帧后续被跳过，重连时也能从它之后继续
    if (eventId) {
      rememberEventId(meta, eventId)
    }

    if (!eventType || !eventData) return

    // 跳过 heartbeat 和 connected 事件 => 不转发到前端
    if (eventType === 'connected') return

    try {
      const data = JSON.parse(eventData)
      const event: SSEEvent = {
        type: eventType,
        data,
        workspaceId,
        timestamp: Date.now(),
      }

      for (const listener of this.listeners) {
        try {
          listener(workspaceId, event)
        } catch { /* 单个监听器崩溃不影响其他 */ }
      }

      // 转发到所有渲染进程窗口
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) {
          win.webContents.send(SSE_IPC_CHANNELS.EVENT, event)
        }
      })
    } catch {
      // 非 JSON 数据，跳过
    }
  }

  /** 广播连接状态到渲染进程 */
  private broadcastStatus(workspaceId: string, status: string): void {
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send(SSE_IPC_CHANNELS.CONNECTION_CHANGED, { workspaceId, status })
      }
    })
  }

  /** 断开指定工作区的 SSE 连接 */
  async disconnect(workspaceId: string): Promise<void> {
    const meta = this.connections.get(workspaceId)
    if (!meta) return

    if (meta.reconnectTimer) {
      clearTimeout(meta.reconnectTimer)
      meta.reconnectTimer = undefined
    }

    meta.abortController.abort()
    meta.connected = false
    this.connections.delete(workspaceId)
    console.log(`[SSE] 已断开 workspace=${workspaceId}`)
  }

  /** 断开所有连接 */
  disconnectAll(): void {
    for (const workspaceId of this.connections.keys()) {
      this.disconnect(workspaceId).catch(() => {})
    }
  }

  /** 获取活跃连接数 */
  getConnectionCount(): number {
    let count = 0
    for (const meta of this.connections.values()) {
      if (meta.connected) count++
    }
    return count
  }

  /** 是否已连接 */
  isConnected(workspaceId: string): boolean {
    return this.connections.get(workspaceId)?.connected ?? false
  }
}

/** 全局单例 */
export const sseClient = new SSEClientManager()
