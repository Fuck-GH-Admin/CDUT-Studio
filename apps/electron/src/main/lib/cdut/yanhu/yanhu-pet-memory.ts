/**
 * 砚小龙 · 记忆库与配置（YanhuPetMemoryStore）
 *
 * 0 ~ 1000 条滑动窗口，原子落盘 `~/.cdutai/yanhu-pet-history.json`。
 * 本模块刻意不依赖 Electron / 供应商适配器，便于纯函数单元测试。
 */

import { join } from 'node:path'
import type { ChatMessage, YanhuPetConfig, YanhuPetMessage } from '@profer/shared'
import { getConfigDir } from '../../config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from '../../safe-file'

/**
 * 落盘结构版本。
 * v2：默认进入常驻伴随模式，彻底修复「输入框看不见」；
 * v3：坐标迁移——旧版写死/散落的偏倚坐标复位为占位值，交由渲染层首帧自动居中。
 */
export const YANHU_PET_STORE_VERSION = 3
/** 记忆保留硬上限（对应滑动窗口 0 ~ 1000） */
export const MAX_YANHU_MEMORY = 1000
/** 记忆窗口默认条数 */
export const DEFAULT_MEMORY_LIMIT = 50

/** 落盘结构契约 */
export interface YanhuPetStoreData {
  version: number
  config: YanhuPetConfig
  messages: YanhuPetMessage[]
}

/** 默认配置（isCollapsed=false：默认常驻伴随模式，输入条与气泡始终可见） */
export function createDefaultYanhuPetConfig(): YanhuPetConfig {
  return {
    dialogPosition: 'right',
    isCollapsed: false,
    memoryLimit: DEFAULT_MEMORY_LIMIT,
    petPosition: { x: 24, y: 24 },
  }
}

/** 归一化配置（收敛非法值，保证 0 <= memoryLimit <= 1000） */
export function normalizeYanhuPetConfig(raw: unknown): YanhuPetConfig {
  const base = createDefaultYanhuPetConfig()
  if (!raw || typeof raw !== 'object') return base
  const candidate = raw as Partial<YanhuPetConfig>
  const limit =
    typeof candidate.memoryLimit === 'number' && Number.isFinite(candidate.memoryLimit)
      ? Math.max(0, Math.min(MAX_YANHU_MEMORY, Math.trunc(candidate.memoryLimit)))
      : base.memoryLimit
  const pos = candidate.petPosition
  return {
    dialogPosition: candidate.dialogPosition === 'left' ? 'left' : 'right',
    // 仅显式收起（true）才进入仅桌宠态；缺省一律为常驻伴随模式
    isCollapsed: candidate.isCollapsed === true,
    memoryLimit: limit,
    petPosition: {
      x: pos && typeof pos.x === 'number' && Number.isFinite(pos.x) ? Math.round(pos.x) : base.petPosition.x,
      y: pos && typeof pos.y === 'number' && Number.isFinite(pos.y) ? Math.round(pos.y) : base.petPosition.y,
    },
    selectedChannelId:
      typeof candidate.selectedChannelId === 'string' && candidate.selectedChannelId
        ? candidate.selectedChannelId
        : undefined,
    selectedModelId:
      typeof candidate.selectedModelId === 'string' && candidate.selectedModelId
        ? candidate.selectedModelId
        : undefined,
    // 仅显式开启才暴露开发者级工具；缺省一律关闭
    devToolsEnabled: candidate.devToolsEnabled === true ? true : undefined,
    // 仅显式开启才启用视觉截图辅助感知；缺省一律关闭
    enableVision: candidate.enableVision === true ? true : undefined,
  }
}

/** 归一化单条消息用量（无有效字段时返回 undefined，损坏字段丢弃） */
export function normalizeYanhuPetMessageUsage(raw: unknown): YanhuPetMessage['usage'] {
  if (!raw || typeof raw !== 'object') return undefined
  const candidate = raw as Partial<NonNullable<YanhuPetMessage['usage']>>
  const num = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined
  const usage = {
    inputTokens: num(candidate.inputTokens),
    outputTokens: num(candidate.outputTokens),
    cacheReadTokens: num(candidate.cacheReadTokens),
    cacheCreationTokens: num(candidate.cacheCreationTokens),
    totalTokens: num(candidate.totalTokens),
    durationMs: num(candidate.durationMs),
  }
  return Object.values(usage).some((value) => value !== undefined) ? usage : undefined
}

/** 归一化单条消息（损坏丢弃） */
export function normalizeYanhuPetMessage(raw: unknown): YanhuPetMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as Partial<YanhuPetMessage>
  if (candidate.role !== 'user' && candidate.role !== 'assistant' && candidate.role !== 'system') return null
  if (typeof candidate.content !== 'string') return null
  return {
    id:
      typeof candidate.id === 'string' && candidate.id
        ? candidate.id
        : `yanhu-msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    role: candidate.role,
    content: candidate.content,
    timestamp: typeof candidate.timestamp === 'number' ? candidate.timestamp : Date.now(),
    toolInvocations: Array.isArray(candidate.toolInvocations) ? candidate.toolInvocations : undefined,
    usage: normalizeYanhuPetMessageUsage(candidate.usage),
  }
}

/**
 * 历史消息角色交替校验与健康自愈。
 * 根治异常退出/网络中断导致的孤儿 user 消息及连续相同角色破坏模型协议（HTTP 400 Bad Request）的问题。
 */
export function healYanhuMessages(messages: YanhuPetMessage[]): YanhuPetMessage[] {
  if (messages.length === 0) return []
  const healed: YanhuPetMessage[] = []
  for (let i = 0; i < messages.length; i++) {
    const curr = messages[i]
    if (!curr || !curr.content) continue
    if (healed.length === 0) {
      healed.push({ ...curr })
      continue
    }
    const prev = healed[healed.length - 1]
    if (!prev) {
      healed.push({ ...curr })
      continue
    }
    if (curr.role === prev.role) {
      if (curr.role === 'user') {
        // 连续两个 user：补入 assistant 虚拟回复，阻断 API 400 校验错误
        healed.push({
          id: nextYanhuMessageId(),
          role: 'assistant',
          content: '（上一轮交互异常中断，已自动复位）',
          timestamp: curr.timestamp - 1,
        })
        healed.push({ ...curr })
      } else {
        // 连续两个 assistant：合并内容
        prev.content = `${prev.content}\n\n${curr.content}`
      }
    } else {
      healed.push({ ...curr })
    }
  }
  return healed
}

/**
 * 依记忆窗口截取注入大模型的历史消息。
 *
 * memoryLimit = 0 时返回空数组（完全不注入历史）；否则取最近 memoryLimit 条。
 * 自动应用健康自愈并保证历史末尾绝对不是孤儿 user 消息（避免与当前 user 冲突触发 consecutive user 错误）。
 */
export function resolveInjectedHistory(
  messages: readonly YanhuPetMessage[],
  memoryLimit: number,
): YanhuPetMessage[] {
  if (!Number.isFinite(memoryLimit) || memoryLimit <= 0) return []
  const limit = Math.min(Math.trunc(memoryLimit), MAX_YANHU_MEMORY)
  const sliced = messages.slice(-limit)
  const healed = healYanhuMessages(sliced.map((m) => ({ ...m })))
  // 关键保证：注入模型的历史消息，末尾绝对不能是 user！
  // 因为每次调用模型时，当前提问就是新的 user 角色；若历史末尾为 user，与当前 user 拼接必然触发 consecutive user 错误！
  const last = healed[healed.length - 1]
  if (last && last.role === 'user') {
    healed.push({
      id: nextYanhuMessageId(),
      role: 'assistant',
      content: '（上一轮任务已完成或已重置）',
      timestamp: Date.now(),
    })
  }
  return healed
}

/** 把桌宠消息转换为供应商无关的 ChatMessage（前序遍历父链） */
export function toChatMessages(messages: readonly YanhuPetMessage[]): ChatMessage[] {
  return messages.map((message, index) => ({
    id: message.id,
    parentId: index === 0 ? null : messages[index - 1]?.id ?? null,
    role: message.role,
    content: message.content,
    createdAt: message.timestamp,
  }))
}

/** 截断记忆至硬上限 */
export function trimYanhuHistory(messages: YanhuPetMessage[]): YanhuPetMessage[] {
  return messages.length > MAX_YANHU_MEMORY ? messages.slice(-MAX_YANHU_MEMORY) : messages
}

/** 生成消息 ID */
export function nextYanhuMessageId(): string {
  return `yanhu-msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

/** 智联万站默认落盘路径：~/.cdutai/yanhu-pet-history.json */
export function getYanhuPetHistoryPath(): string {
  return join(getConfigDir(), 'yanhu-pet-history.json')
}

/**
 * 桌宠记忆库与配置持久化。
 */
export class YanhuPetMemoryStore {
  private readonly filePath: string
  private data: YanhuPetStoreData

  constructor(filePath: string = getYanhuPetHistoryPath()) {
    this.filePath = filePath
    this.data = this.load()
  }

  private load(): YanhuPetStoreData {
    try {
      const raw = readJsonFileSafe<Partial<YanhuPetStoreData>>(this.filePath)
      const rawVersion = typeof raw?.version === 'number' ? raw.version : 0
      // v1 -> v2 迁移：历史默认 isCollapsed=true 会导致“输入框看不见”，升级时强制切回常驻伴随模式
      const config = normalizeYanhuPetConfig(
        rawVersion < 2 ? { ...(raw?.config ?? {}), isCollapsed: false } : raw?.config,
      )
      // v2 -> v3 迁移：旧版写死 (24,24) 与历史散落坐标复位为占位值，
      // 交由渲染层在首帧拿到真实视口后自动居中（此后遵循用户手动拖拽的位置）。
      if (rawVersion < YANHU_PET_STORE_VERSION) {
        config.petPosition = { ...createDefaultYanhuPetConfig().petPosition }
      }
      const loadedMessages = Array.isArray(raw?.messages)
        ? trimYanhuHistory(
            raw.messages.map(normalizeYanhuPetMessage).filter((m): m is YanhuPetMessage => !!m),
          )
        : []
      // 加载时自动自愈历史，防止此前由于崩溃遗留的连续 user 脏数据
      const messages = healYanhuMessages(loadedMessages)
      return { version: YANHU_PET_STORE_VERSION, config, messages }
    } catch (err) {
      console.warn('[砚小龙] 读取记忆库失败，回退默认:', err)
      return { version: YANHU_PET_STORE_VERSION, config: createDefaultYanhuPetConfig(), messages: [] }
    }
  }

  private persist(): void {
    try {
      writeJsonFileAtomic(this.filePath, {
        version: YANHU_PET_STORE_VERSION,
        config: this.data.config,
        messages: this.data.messages,
      })
    } catch (err) {
      console.error('[砚小龙] 写入记忆库失败:', err)
    }
  }

  /** 读取配置 */
  public getConfig(): YanhuPetConfig {
    return { ...this.data.config, petPosition: { ...this.data.config.petPosition } }
  }

  /** 保存配置（浅合并） */
  public saveConfig(patch: Partial<YanhuPetConfig>): YanhuPetConfig {
    this.data.config = normalizeYanhuPetConfig({ ...this.data.config, ...patch })
    this.persist()
    return this.getConfig()
  }

  /** 读取全部历史消息 */
  public getMessages(): YanhuPetMessage[] {
    return this.data.messages.map((m) => ({ ...m }))
  }

  /** 覆盖历史消息（自动截断至硬上限并落盘） */
  public setMessages(messages: YanhuPetMessage[]): void {
    this.data.messages = trimYanhuHistory(messages)
    this.persist()
  }

  /** 追加历史消息（自动截断至硬上限并落盘） */
  public appendMessages(messages: YanhuPetMessage[]): void {
    this.setMessages([...this.data.messages, ...messages])
  }

  /** 清空对话记忆 */
  public clear(): void {
    this.data.messages = []
    this.persist()
  }
}
