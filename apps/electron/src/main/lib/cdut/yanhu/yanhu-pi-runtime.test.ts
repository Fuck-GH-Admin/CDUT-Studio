/**
 * 砚小龙 · 阉割版 Pi 运行时记忆子系统测试
 *
 * 覆盖：memoryLimit = 0 时无历史注入、memoryLimit = 50 时正确滑动窗口、
 * 配置边界收敛、原子落盘持久化与一键清空。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { YanhuPetMessage } from '@profer/shared'
import {
  MAX_YANHU_MEMORY,
  YanhuPetMemoryStore,
  healYanhuMessages,
  normalizeYanhuPetConfig,
  resolveInjectedHistory,
  toChatMessages,
} from './yanhu-pet-memory'

function buildMessages(count: number): YanhuPetMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `msg-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `内容 ${index}`,
    timestamp: index,
  }))
}

describe('resolveInjectedHistory（滑动窗口）', () => {
  test('memoryLimit = 0 时不注入任何历史', () => {
    expect(resolveInjectedHistory(buildMessages(10), 0)).toEqual([])
    expect(resolveInjectedHistory(buildMessages(10), -5)).toEqual([])
  })

  test('memoryLimit = 50 时取最近 50 条', () => {
    const messages = buildMessages(120)
    const injected = resolveInjectedHistory(messages, 50)
    expect(injected).toHaveLength(50)
    expect(injected[0]?.id).toBe('msg-70')
    expect(injected[49]?.id).toBe('msg-119')
  })

  test('历史不足窗口时全量返回完整成对历史', () => {
    expect(resolveInjectedHistory(buildMessages(4), 50)).toHaveLength(4)
  })

  test('窗口上限被硬约束在 1000', () => {
    const injected = resolveInjectedHistory(buildMessages(MAX_YANHU_MEMORY + 50), 5000)
    expect(injected).toHaveLength(MAX_YANHU_MEMORY)
  })
})

describe('normalizeYanhuPetConfig（配置边界收敛）', () => {
  test('memoryLimit 越界被夹取', () => {
    expect(normalizeYanhuPetConfig({ memoryLimit: -10 }).memoryLimit).toBe(0)
    expect(normalizeYanhuPetConfig({ memoryLimit: 9999 }).memoryLimit).toBe(MAX_YANHU_MEMORY)
  })

  test('缺省与非法字段回退默认', () => {
    const config = normalizeYanhuPetConfig(null)
    expect(config.dialogPosition).toBe('right')
    // 默认进入常驻伴随模式（输入条与气泡始终可见）
    expect(config.isCollapsed).toBe(false)
    expect(config.memoryLimit).toBe(50)
    expect(config.petPosition).toEqual({ x: 24, y: 24 })
  })

  test('视觉截图辅助感知（enableVision）仅显式开启才生效，缺省一律关闭', () => {
    expect(normalizeYanhuPetConfig(null).enableVision).toBeUndefined()
    expect(normalizeYanhuPetConfig({ enableVision: false }).enableVision).toBeUndefined()
    // 非布尔脏数据一律视为关闭
    expect(normalizeYanhuPetConfig({ enableVision: 'yes' }).enableVision).toBeUndefined()
    expect(normalizeYanhuPetConfig({ enableVision: true }).enableVision).toBe(true)
  })
})

describe('toChatMessages（父链构建）', () => {
  test('首条 parentId 为 null，其余指向前一条', () => {
    const chat = toChatMessages(buildMessages(3))
    expect(chat[0]?.parentId).toBeNull()
    expect(chat[1]?.parentId).toBe('msg-0')
    expect(chat[2]?.parentId).toBe('msg-1')
  })
})

describe('YanhuPetMemoryStore（原子落盘持久化）', () => {
  test('写入后可由新实例读回，clear 后为空', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yanhu-pet-'))
    const filePath = join(dir, 'yanhu-pet-history.json')
    try {
      const store = new YanhuPetMemoryStore(filePath)
      store.saveConfig({ memoryLimit: 80, dialogPosition: 'left' })
      store.appendMessages(buildMessages(4))

      const reopened = new YanhuPetMemoryStore(filePath)
      expect(reopened.getConfig().memoryLimit).toBe(80)
      expect(reopened.getConfig().dialogPosition).toBe('left')
      expect(reopened.getMessages()).toHaveLength(4)

      reopened.clear()
      expect(new YanhuPetMemoryStore(filePath).getMessages()).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('旧版 v1 落盘数据升级时强制切回常驻伴随模式', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yanhu-pet-'))
    const filePath = join(dir, 'yanhu-pet-history.json')
    try {
      writeFileSync(
        filePath,
        JSON.stringify({ version: 1, config: { isCollapsed: true, memoryLimit: 30 }, messages: [] }),
      )
      const store = new YanhuPetMemoryStore(filePath)
      expect(store.getConfig().isCollapsed).toBe(false)
      expect(store.getConfig().memoryLimit).toBe(30)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('旧版 v2 落盘的散落坐标升级时复位为占位值（§5 一次性居中迁移）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yanhu-pet-'))
    const filePath = join(dir, 'yanhu-pet-history.json')
    try {
      writeFileSync(
        filePath,
        JSON.stringify({
          version: 2,
          config: { isCollapsed: false, memoryLimit: 50, petPosition: { x: 591, y: 413 } },
          messages: [],
        }),
      )
      // 旧版散落坐标复位为占位值，交由渲染层首帧按真实视口自动居中
      expect(new YanhuPetMemoryStore(filePath).getConfig().petPosition).toEqual({ x: 24, y: 24 })

      // 迁移后落盘即为最新版本：用户此后手动拖拽的坐标不再被复位（仅迁移一次）
      const store = new YanhuPetMemoryStore(filePath)
      store.saveConfig({ petPosition: { x: 591, y: 413 } })
      expect(new YanhuPetMemoryStore(filePath).getConfig().petPosition).toEqual({ x: 591, y: 413 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('记忆超硬上限时自动截断', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yanhu-pet-'))
    const filePath = join(dir, 'yanhu-pet-history.json')
    try {
      const store = new YanhuPetMemoryStore(filePath)
      store.appendMessages(buildMessages(MAX_YANHU_MEMORY + 20))
      expect(store.getMessages()).toHaveLength(MAX_YANHU_MEMORY)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('healYanhuMessages 与 resolveInjectedHistory（孤儿消息与角色交替自愈防线）', () => {
  test('连续两个 user 时自动垫入 assistant 虚拟消息，阻断 HTTP 400 协议错误', () => {
    const raw: YanhuPetMessage[] = [
      { id: 'u1', role: 'user', content: '第一条提问', timestamp: 100 },
      { id: 'u2', role: 'user', content: '第二条提问', timestamp: 200 },
    ]
    const healed = healYanhuMessages(raw)
    expect(healed).toHaveLength(3)
    expect(healed[0]?.role).toBe('user')
    expect(healed[1]?.role).toBe('assistant')
    expect(healed[2]?.role).toBe('user')
  })

  test('连续两个 assistant 时自动合并内容', () => {
    const raw: YanhuPetMessage[] = [
      { id: 'u1', role: 'user', content: '提问', timestamp: 100 },
      { id: 'a1', role: 'assistant', content: '回答1', timestamp: 200 },
      { id: 'a2', role: 'assistant', content: '回答2', timestamp: 300 },
    ]
    const healed = healYanhuMessages(raw)
    expect(healed).toHaveLength(2)
    expect(healed[0]?.role).toBe('user')
    expect(healed[1]?.role).toBe('assistant')
    expect(healed[1]?.content).toContain('回答1')
    expect(healed[1]?.content).toContain('回答2')
  })

  test('resolveInjectedHistory 确保注入模型的历史末尾绝对不是孤儿 user', () => {
    const raw: YanhuPetMessage[] = [
      { id: 'u1', role: 'user', content: '未完成的孤儿提问', timestamp: 100 },
    ]
    const injected = resolveInjectedHistory(raw, 50)
    // 必须自动闭环补入 assistant，防止注入适配器时与即将发送的当前 user 冲突
    expect(injected.length).toBeGreaterThanOrEqual(2)
    expect(injected[injected.length - 1]?.role).toBe('assistant')
  })
})

describe('padAbortedToolResults（中止回执配对）', () => {
  test('部分执行后中止：为剩余 toolCall 补齐占位回执，保持 1:1 配对', async () => {
    const { padAbortedToolResults } = await import('./yanhu-pi-runtime')
    const calls = [
      { id: 'call-1', name: 'yanhu_fill', arguments: {} },
      { id: 'call-2', name: 'yanhu_click', arguments: {} },
      { id: 'call-3', name: 'yanhu_navigate', arguments: {} },
    ]
    const padded = padAbortedToolResults(calls, [
      { toolCallId: 'call-1', content: '已填写', isError: false },
    ])
    expect(padded).toHaveLength(3)
    expect(padded.map((item) => item.toolCallId)).toEqual(['call-1', 'call-2', 'call-3'])
    expect(padded[1]!.isError).toBe(true)
    expect(padded[2]!.content).toContain('中止')
  })

  test('结果已齐时原样返回（不追加占位）', async () => {
    const { padAbortedToolResults } = await import('./yanhu-pi-runtime')
    const calls = [
      { id: 'call-1', name: 'yanhu_fill', arguments: {} },
      { id: 'call-2', name: 'yanhu_click', arguments: {} },
    ]
    const results = [
      { toolCallId: 'call-1', content: '已填写', isError: false },
      { toolCallId: 'call-2', content: '已点击', isError: false },
    ]
    expect(padAbortedToolResults(calls, results)).toBe(results)
  })
})
