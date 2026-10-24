/**
 * Zotero 写回桥接（本地 REST 插件 HTTP 客户端）
 *
 * 架构红线：外部进程绝不 INSERT/UPDATE zotero.sqlite —— 任何写回都必须
 * 经过用户安装的 Zotero 本地 REST 插件（默认端口 23119）以 HTTP 完成。
 * 本模块只做端点探活与规范写回调用，绝不触碰任何 sqlite 文件。
 *
 * 防御：
 * - itemKey / collectionKey 必须命中 /^[A-Za-z0-9_-]{4,32}$/，杜绝路径拼接注入；
 * - PATCH 写回携带 If-Unmodified-Since-Version 版本头，防并发覆盖丢失；
 * - 全部请求 1.5s 超时，失败一律返回结果对象，绝不抛未捕获异常。
 */

import { existsSync, promises as fs } from 'node:fs'
import { join } from 'node:path'
import type {
  CsLabZoteroBridgeStatus,
  CsLabZoteroBridgeWriteInput,
  CsLabZoteroBridgeWriteResult,
} from '@profer/shared'
import { getConfigDir } from '../config-paths'

export interface ZoteroBridgeConfig {
  enabled: boolean
  port: number
  /** 本地 REST 插件可选 Bearer Token。 */
  token?: string
}

export function getZoteroBridgeConfigPath(): string {
  return join(getConfigDir(), 'zotero-bridge.json')
}

async function readBridgeConfig(): Promise<ZoteroBridgeConfig | null> {
  const configPath = getZoteroBridgeConfigPath()
  if (!existsSync(configPath)) return null
  try {
    const raw = await fs.readFile(configPath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ZoteroBridgeConfig>
    if (!parsed.enabled) return null
    const port = Number(parsed.port)
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return null
    const token = typeof parsed.token === 'string' && parsed.token.trim() ? parsed.token.trim() : undefined
    return { enabled: true, port, token }
  } catch {
    return null
  }
}

const BRIDGE_TIMEOUT_MS = 1_500

async function bridgeFetch(
  port: number,
  path: string,
  init: RequestInit & { token?: string; timeoutMs?: number } = {},
): Promise<Response> {
  const { token, timeoutMs = BRIDGE_TIMEOUT_MS, ...rest } = init
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    const headers = new Headers(rest.headers)
    headers.set('Content-Type', 'application/json')
    if (token) headers.set('Authorization', `Bearer ${token}`)
    return await fetch(`http://127.0.0.1:${port}${path}`, { ...rest, headers, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** 探测本地回环桥接；失败一律视为不可达。 */
export async function getZoteroBridgeStatus(): Promise<CsLabZoteroBridgeStatus> {
  const config = await readBridgeConfig()
  if (!config) {
    return {
      enabled: false,
      reachable: false,
      message: '写回桥接未配置（默认只读同步；写回需安装 Zotero 本地 REST 插件）',
    }
  }

  const endpoint = `http://127.0.0.1:${config.port}`
  try {
    const response = await bridgeFetch(config.port, '/connector/ping', { token: config.token })
    return {
      enabled: true,
      reachable: response.ok,
      endpoint,
      message: response.ok
        ? '写回桥接可达（Zotero 本地 REST 插件）'
        : `写回桥接返回 HTTP ${response.status}`,
    }
  } catch {
    // 部分旧版插件仅提供 /ping 根路径，回退探测一次。
    try {
      const response = await bridgeFetch(config.port, '/ping', { token: config.token })
      return {
        enabled: true,
        reachable: response.ok,
        endpoint,
        message: response.ok
          ? '写回桥接可达（Zotero 本地 REST 插件）'
          : `写回桥接返回 HTTP ${response.status}`,
      }
    } catch {
      return {
        enabled: true,
        reachable: false,
        endpoint,
        message: '写回桥接已配置但不可达（请确认 Zotero 与本地 REST 插件已启动）',
      }
    }
  }
}

// ===== 写回客户端 =====

/** Zotero 标识符（8 位 [23456789ABCDEFGHIJKLMNOPQRSTUVWXYZ] 为主，放宽为字母数字-_）。 */
const ZOTERO_KEY_RE = /^[A-Za-z0-9_-]{4,32}$/

function assertZoteroKey(value: unknown, label: string): string {
  const key = typeof value === 'string' ? value.trim() : ''
  if (!ZOTERO_KEY_RE.test(key)) {
    throw new Error(`${label}标识符非法`)
  }
  return key
}

interface BridgeWritePayload {
  itemKey?: unknown
  collectionKey?: unknown
  annotationType?: unknown
  text?: unknown
  comment?: unknown
  color?: unknown
  position?: unknown
  pageIndex?: unknown
  tags?: unknown
}

async function getItemVersion(
  port: number,
  token: string | undefined,
  itemKey: string,
): Promise<{ ok: true; version: number } | { ok: false; status?: number; message: string }> {
  try {
    const response = await bridgeFetch(port, `/api/users/0/items/${itemKey}`, {
      token,
    })
    if (!response.ok) {
      return { ok: false, status: response.status, message: `读取条目失败（HTTP ${response.status}）` }
    }
    const body = (await response.json().catch(() => null)) as { version?: unknown } | null
    const version = Number(body?.version)
    if (!Number.isFinite(version)) {
      return { ok: false, message: '条目响应缺少 version 字段' }
    }
    return { ok: true, version }
  } catch {
    return { ok: false, message: '无法连接 Zotero 本地 REST 插件' }
  }
}

async function patchItem(
  port: number,
  token: string | undefined,
  itemKey: string,
  version: number,
  body: Record<string, unknown>,
): Promise<CsLabZoteroBridgeWriteResult> {
  try {
    const response = await bridgeFetch(port, `/api/users/0/items/${itemKey}`, {
      method: 'PATCH',
      token,
      headers: { 'If-Unmodified-Since-Version': String(version) },
      body: JSON.stringify(body),
    })
    if (response.status === 412) {
      return {
        ok: false,
        status: 412,
        message: '版本冲突（条目在读取后被修改），请重试',
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      message: response.ok
        ? '写回成功'
        : `Zotero 返回 HTTP ${response.status}，写回未生效`,
    }
  } catch {
    return { ok: false, message: '无法连接 Zotero 本地 REST 插件' }
  }
}

async function createAnnotation(
  port: number,
  token: string | undefined,
  payload: BridgeWritePayload,
): Promise<CsLabZoteroBridgeWriteResult> {
  const itemKey = assertZoteroKey(payload.itemKey, '条目')
  // annotationType: 1=highlight 2=note 3=image（Zotero 数值枚举）。
  const annotationType = Number(payload.annotationType ?? 1)
  const annotation: Record<string, unknown> = {
    itemType: 'annotation',
    parentItem: itemKey,
    annotationType: Number.isFinite(annotationType) ? annotationType : 1,
    annotationComment: typeof payload.comment === 'string' ? payload.comment : '',
    annotationColor: typeof payload.color === 'string' ? payload.color : '#ffd400',
    annotationPageIndex: Number(payload.pageIndex ?? 0) || 0,
    annotationPosition:
      typeof payload.position === 'object' && payload.position != null
        ? JSON.stringify(payload.position)
        : '{}',
  }
  if (typeof payload.text === 'string' && payload.text.trim()) {
    annotation.annotationText = payload.text
  }
  try {
    const response = await bridgeFetch(port, '/api/users/0/items', {
      method: 'POST',
      token,
      body: JSON.stringify([annotation]),
    })
    return {
      ok: response.ok,
      status: response.status,
      message: response.ok
        ? '批注已写回 Zotero'
        : `Zotero 返回 HTTP ${response.status}，批注未写入`,
    }
  } catch {
    return { ok: false, message: '无法连接 Zotero 本地 REST 插件' }
  }
}

async function updateItemTags(
  port: number,
  token: string | undefined,
  payload: BridgeWritePayload,
): Promise<CsLabZoteroBridgeWriteResult> {
  const itemKey = assertZoteroKey(payload.itemKey, '条目')
  if (!Array.isArray(payload.tags) || payload.tags.some((tag) => typeof tag !== 'string')) {
    return { ok: false, message: '标签列表非法' }
  }
  const versionResult = await getItemVersion(port, token, itemKey)
  if (!versionResult.ok) {
    return { ok: false, status: versionResult.status, message: versionResult.message }
  }
  return patchItem(
    port,
    token,
    itemKey,
    versionResult.version,
    { tags: payload.tags.map((tag) => ({ tag: String(tag) })) },
  )
}

async function addItemCollection(
  port: number,
  token: string | undefined,
  payload: BridgeWritePayload,
): Promise<CsLabZoteroBridgeWriteResult> {
  const itemKey = assertZoteroKey(payload.itemKey, '条目')
  const collectionKey = assertZoteroKey(payload.collectionKey, '收藏夹')
  const versionResult = await getItemVersion(port, token, itemKey)
  if (!versionResult.ok) {
    return { ok: false, status: versionResult.status, message: versionResult.message }
  }
  // 先读现有 collections，避免覆盖既有归属。
  try {
    const current = await bridgeFetch(port, `/api/users/0/items/${itemKey}`, { token })
    if (!current.ok) {
      return { ok: false, status: current.status, message: `读取条目失败（HTTP ${current.status}）` }
    }
    const body = (await current.json().catch(() => null)) as {
      data?: { collections?: unknown }
      version?: unknown
    } | null
    const existing = Array.isArray(body?.data?.collections) ? body!.data!.collections : []
    const version = Number(body?.version)
    if (!Number.isFinite(version)) {
      return { ok: false, message: '条目响应缺少 version 字段' }
    }
    return patchItem(
      port,
      token,
      itemKey,
      version,
      { collections: [...existing, collectionKey] },
    )
  } catch {
    return { ok: false, message: '无法连接 Zotero 本地 REST 插件' }
  }
}

/** 写回统一入口（IPC 调用）。 */
export async function writeZoteroBridge(
  input: CsLabZoteroBridgeWriteInput,
): Promise<CsLabZoteroBridgeWriteResult> {
  const config = await readBridgeConfig()
  if (!config) {
    return {
      ok: false,
      message: '写回桥接未配置：请安装 Zotero 本地 REST 插件并在配置文件中启用',
    }
  }
  if (!input || typeof input !== 'object' || typeof input.op !== 'string') {
    return { ok: false, message: '写回参数无效' }
  }
  const payload = (input.payload ?? {}) as BridgeWritePayload
  try {
    switch (input.op) {
      case 'createAnnotation':
        return await createAnnotation(config.port, config.token, payload)
      case 'updateItemTags':
        return await updateItemTags(config.port, config.token, payload)
      case 'addItemCollection':
        return await addItemCollection(config.port, config.token, payload)
      default:
        return { ok: false, message: `不支持的写回操作：${input.op}` }
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '写回失败（未知错误）',
    }
  }
}
