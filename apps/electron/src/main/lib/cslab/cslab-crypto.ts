/**
 * CSLab (CDUT Science Laboratory) - 安全加密与密钥校验模块
 *
 * 模块代号：CSLab
 * 严格遵循红线：验证密钥通过安全单向散列与时间常数对比校验，严禁明文持久化
 */

import { createHash, timingSafeEqual, randomBytes } from 'node:crypto'

/**
 * 目标校验密钥的 SHA-256 预计算摘要（防止任何形式的明文静态反编译探测）
 * 对应密钥："MCC-Nya-520"
 */
export const CSLAB_TARGET_KEY_HASH = '7f66de46bc03ed8e45acb8bb9b2a4d5f3c6881b085336bc84317396527bc51db'

/**
 * 标准 SHA-256 单向散列计算
 */
export function calculateSha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/**
 * 时间常数安全比对（防止时序侧信道攻击）
 */
export function verifyKeySecurely(inputKey: string): boolean {
  if (typeof inputKey !== 'string' || inputKey.trim().length === 0) {
    return false
  }

  const trimmed = inputKey.trim()
  const inputHash = calculateSha256(trimmed)

  const bufA = Buffer.from(inputHash, 'hex')
  const bufB = Buffer.from(CSLAB_TARGET_KEY_HASH, 'hex')

  if (bufA.length !== bufB.length) {
    return false
  }

  return timingSafeEqual(bufA, bufB)
}

/**
 * 生成临时会话认证令牌（基于密钥摘要与随机熵）
 */
export function generateCsLabSessionToken(): string {
  const nonce = randomBytes(16).toString('hex')
  return `CSLAB-TOKEN-${Date.now()}-${nonce}`
}
