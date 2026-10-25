/**
 * sse-client 单测：SSE 帧解析、事件 id 去重与 Last-Event-ID 续传
 *
 * 覆盖 P1-2（断线重连丢事件）：
 * - parseSseFrame 解析 `id:`，无 id 时返回 undefined
 * - rememberEventId / isDuplicateEventId 的 FIFO 容量与去重判定
 * - sseClient 端到端：重复 id 帧不再回调监听器，重连请求带 Last-Event-ID
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'

// ===== undici fetch 替身（sse-client 只用到 fetch） =====

interface FetchCall {
  url: string
  headers: Record<string, string>
}

const fetchCalls: FetchCall[] = []
/** 每次 connect 依次消费一批帧文本（同一批内按 chunk 顺序拼接） */
let pendingStreams: string[][] = []

function makeBody(chunks: string[]): unknown {
  let index = 0
  return {
    getReader: () => ({
      read: async () => {
        if (index >= chunks.length) return { done: true, value: undefined }
        const value = new TextEncoder().encode(chunks[index++])
        return { done: false, value }
      },
    }),
  }
}

const fakeFetch = async (url: unknown, init?: { headers?: Record<string, string> }) => {
  fetchCalls.push({ url: String(url), headers: { ...(init?.headers ?? {}) } })
  const chunks = pendingStreams.shift() ?? []
  return { ok: true, status: 200, body: makeBody(chunks) }
}

mock.module('undici', () => ({
  fetch: fakeFetch,
  // 若 sse-client 的传递依赖引入 undici 其它导出，保证不被 mock 打断
  ProxyAgent: class {},
  Agent: class {},
  setGlobalDispatcher: () => undefined,
}))

const {
  parseSseFrame,
  isDuplicateEventId,
  rememberEventId,
  MAX_SEEN_EVENT_IDS,
  sseClient,
} = await import('./sse-client')

afterEach(() => {
  fetchCalls.length = 0
  pendingStreams = []
})

function frame(fields: { id?: string; event: string; data: unknown }): string {
  const lines: string[] = []
  if (fields.id !== undefined) lines.push(`id: ${fields.id}`)
  lines.push(`event: ${fields.event}`)
  lines.push(`data: ${JSON.stringify(fields.data)}`)
  return `${lines.join('\n')}\n\n`
}

// ===== parseSseFrame =====

describe('parseSseFrame', () => {
  test('解析 event / data / id', () => {
    const parsed = parseSseFrame('id: 42\nevent: task.updated\ndata: {"taskId":"t1"}')
    expect(parsed.eventType).toBe('task.updated')
    expect(parsed.eventData).toBe('{"taskId":"t1"}')
    expect(parsed.eventId).toBe('42')
  })

  test('无 id 字段时 eventId 为 undefined', () => {
    const parsed = parseSseFrame('event: message\ndata: {"n":1}')
    expect(parsed.eventId).toBeUndefined()
    expect(parsed.eventType).toBe('message')
  })

  test('id 值缺失（空）时视为 undefined', () => {
    expect(parseSseFrame('id:\nevent: message\ndata: {}').eventId).toBeUndefined()
    expect(parseSseFrame('id: \nevent: message\ndata: {}').eventId).toBeUndefined()
  })

  test('兼容无空格 id 与 CRLF 行尾', () => {
    expect(parseSseFrame('id:7\nevent: message\ndata: {}').eventId).toBe('7')
    expect(parseSseFrame('id: 8\r\nevent: message\r\ndata: {}\r').eventId).toBe('8')
  })

  test('heartbeat 注释帧不产生事件数据', () => {
    const parsed = parseSseFrame(': ping')
    expect(parsed.eventType).toBe('')
    expect(parsed.eventData).toBe('')
    expect(parsed.eventId).toBeUndefined()
  })
})

// ===== 去重记录 =====

describe('事件 id 去重记录', () => {
  test('isDuplicateEventId 对已记录 id 返回 true', () => {
    const meta: { lastEventId?: string; seenEventIds?: Set<string> } = { seenEventIds: new Set() }
    expect(isDuplicateEventId(meta.seenEventIds, 'evt-1')).toBe(false)
    rememberEventId(meta, 'evt-1')
    expect(isDuplicateEventId(meta.seenEventIds, 'evt-1')).toBe(true)
    expect(meta.lastEventId).toBe('evt-1')
  })

  test('无 id 时从不判定为重复', () => {
    const seen = new Set(['evt-1'])
    expect(isDuplicateEventId(seen, undefined)).toBe(false)
    expect(isDuplicateEventId(undefined, 'evt-1')).toBe(false)
  })

  test('超出上限时删除最早记录', () => {
    const meta: { lastEventId?: string; seenEventIds?: Set<string> } = {}
    for (let i = 0; i < MAX_SEEN_EVENT_IDS + 1; i++) {
      rememberEventId(meta, `evt-${i}`)
    }
    expect(meta.seenEventIds?.size).toBe(MAX_SEEN_EVENT_IDS)
    expect(meta.seenEventIds?.has('evt-0')).toBe(false)
    expect(meta.seenEventIds?.has(`evt-${MAX_SEEN_EVENT_IDS}`)).toBe(true)
    expect(meta.lastEventId).toBe(`evt-${MAX_SEEN_EVENT_IDS}`)
  })
})

// ===== sseClient 端到端行为 =====

describe('sseClient 重连去重与续传', () => {
  test('重复 id 帧只回调一次，重连请求携带 Last-Event-ID', async () => {
    const workspaceId = 'ws-sse-dedupe'
    const received: Array<{ type: string; data: unknown }> = []
    const listener = (_ws: string, event: { type: string; data: unknown }) => {
      received.push({ type: event.type, data: event.data })
    }
    sseClient.onEvent(listener)

    try {
      pendingStreams = [
        [
          frame({ id: 'evt-1', event: 'task.created', data: { n: 1 } }),
          frame({ id: 'evt-1', event: 'task.created', data: { n: 1 } }),
        ],
        [
          // 重连后服务端重放 evt-1，应被丢弃；evt-2 是新事件
          frame({ id: 'evt-1', event: 'task.created', data: { n: 1 } }),
          frame({ id: 'evt-2', event: 'task.updated', data: { n: 2 } }),
        ],
      ]

      await sseClient.connect(workspaceId, 'http://127.0.0.1:1', 'token-a')
      expect(received).toHaveLength(1)
      expect(fetchCalls[0]?.headers['Last-Event-ID']).toBeUndefined()

      // 同一 workspace 重新 connect（模拟窗口重新聚焦触发的主动重连）
      await sseClient.connect(workspaceId, 'http://127.0.0.1:1', 'token-a')

      expect(fetchCalls).toHaveLength(2)
      expect(fetchCalls[1]?.headers['Last-Event-ID']).toBe('evt-1')
      expect(received.map((e) => e.type)).toEqual(['task.created', 'task.updated'])
      expect(received[1]?.data).toEqual({ n: 2 })
    } finally {
      sseClient.removeListener(listener)
      await sseClient.disconnect(workspaceId)
    }
  })

  test('无 id 的帧不去重，全部回调', async () => {
    const workspaceId = 'ws-sse-no-id'
    const received: string[] = []
    const listener = (_ws: string, event: { type: string }) => {
      received.push(event.type)
    }
    sseClient.onEvent(listener)

    try {
      pendingStreams = [
        [
          frame({ event: 'message', data: { n: 1 } }),
          frame({ event: 'message', data: { n: 1 } }),
        ],
      ]

      await sseClient.connect(workspaceId, 'http://127.0.0.1:1', 'token-b')
      expect(received).toHaveLength(2)
      expect(fetchCalls[0]?.headers['Last-Event-ID']).toBeUndefined()
    } finally {
      sseClient.removeListener(listener)
      await sseClient.disconnect(workspaceId)
    }
  })
})
