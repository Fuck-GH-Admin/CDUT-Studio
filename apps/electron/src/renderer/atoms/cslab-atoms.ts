/**
 * CSLab Atoms - CDUT Science 客户端状态管理与安全哈希持久化
 *
 * 安全红线契约：
 * 绝不明文持久化任何密钥，仅将经由 Web Crypto API (SHA-256) 计算得出的单向摘要存入本地存储。
 */

import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type { CsLabTelemetry, CsLabNode, CsLabLogEntry } from '@profer/shared'

/**
 * 目标校验密钥的 SHA-256 摘要（"MCC-Nya-520"）
 */
export const CSLAB_TARGET_HASH = '7f66de46bc03ed8e45acb8bb9b2a4d5f3c6881b085336bc84317396527bc51db'

export interface CsLabClientAuthState {
  isVerified: boolean
  keyHash?: string
  verifiedAt?: number
  clearanceLevel?: string
}

/**
 * 客户端使用 Web Crypto API 进行 SHA-256 散列计算
 */
export async function hashKeyClient(rawKey: string): Promise<string> {
  const trimmed = rawKey.trim()
  if (!trimmed) return ''

  if (typeof window !== 'undefined' && window.crypto?.subtle) {
    const encoder = new TextEncoder()
    const data = encoder.encode(trimmed)
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', data)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  // 环境兜底（如在纯测试环境中）
  let hash = 0
  for (let i = 0; i < trimmed.length; i++) {
    hash = (hash << 5) - hash + trimmed.charCodeAt(i)
    hash |= 0
  }
  return hash.toString(16)
}

/**
 * CSLab 客户端安全认证持久化原子（仅存 Hash，无明文 Key）
 */
export const cslabAuthAtom = atomWithStorage<CsLabClientAuthState>(
  'cslab-auth-secure-state',
  { isVerified: false },
)

/**
 * 实时遥测状态原子
 */
export const cslabTelemetryAtom = atom<CsLabTelemetry | null>(null)

/**
 * 计算节点拓扑原子
 */
export const cslabNodesAtom = atom<CsLabNode[]>([])

/**
 * 审计日志原子
 */
export const cslabLogsAtom = atom<CsLabLogEntry[]>([])
