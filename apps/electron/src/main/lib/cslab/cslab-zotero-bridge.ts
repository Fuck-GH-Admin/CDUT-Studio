/**
 * Zotero 写回桥接状态（预留，不实际写库）
 *
 * 架构红线：外部进程绝不 INSERT/UPDATE zotero.sqlite。
 * 本模块只读取用户可选配置并探活本地回环插件，为后续 Zotero WebExtension
 * 写回预留位置；Phase 2 不提供任何写操作。
 */

import { existsSync, promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { CsLabZoteroBridgeStatus } from '@profer/shared'
import { getConfigDir } from '../config-paths'

export interface ZoteroBridgeConfig {
  enabled: boolean
  port: number
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
    return { enabled: true, port }
  } catch {
    return null
  }
}

/** 探测本地回环桥接；500ms 超时，失败一律视为不可达。 */
export async function getZoteroBridgeStatus(): Promise<CsLabZoteroBridgeStatus> {
  const config = await readBridgeConfig()
  if (!config) {
    return {
      enabled: false,
      reachable: false,
      message: '写回桥接未配置（本阶段仅只读同步）',
    }
  }

  const endpoint = `http://127.0.0.1:${config.port}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 500)
  timer.unref?.()

  try {
    const response = await fetch(`${endpoint}/ping`, { signal: controller.signal })
    clearTimeout(timer)
    return {
      enabled: true,
      reachable: response.ok,
      endpoint,
      message: response.ok
        ? '写回桥接可达（Phase 2 不会自动写入）'
        : `写回桥接返回 HTTP ${response.status}`,
    }
  } catch {
    clearTimeout(timer)
    return {
      enabled: true,
      reachable: false,
      endpoint,
      message: '写回桥接已配置但不可达（请确认 Zotero 插件已启动）',
    }
  }
}
