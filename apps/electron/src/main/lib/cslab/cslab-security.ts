/**
 * CSLab (CDUT Science Laboratory) - 本机访问密码与门禁会话
 *
 * 安全红线：
 *   1. 访问密码只以 PBKDF2-SHA256 单向摘要落盘，绝不保存可逆密文或明文；
 *   2. 验证态只存在于主进程内存，应用重启后必须重新验密；
 *   3. 摘要比对使用 timingSafeEqual，并在比对前校验长度，避免时序侧信道与崩溃；
 *   4. PBKDF2 计算采用异步形式，绝不阻塞主进程事件循环；
 *   5. 连续错误引入失败退避与临时锁定，阻断本地暴力猜测。
 */

import { createHash, pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, unlinkSync } from 'node:fs'
import { promisify } from 'node:util'
import type { CsLabAuthResult, CsLabAuthStatus } from '@profer/shared'
import { getCsLabSecurityPath } from '../config-paths'
import { decryptToken } from '../token-crypto'
import { readJsonFileSafe, writeJsonFileAtomic } from '../safe-file'

const pbkdf2Async = promisify(pbkdf2)

const MIN_PASSWORD_LENGTH = 6
const MAX_PASSWORD_LENGTH = 128
const SALT_BYTES = 16
const KEY_BYTES = 32
const PBKDF2_ITERATIONS = 310_000
const PBKDF2_DIGEST = 'sha256'
const MAX_FAILED_ATTEMPTS = 5
const LOCKOUT_MS = 30_000

let failedAttempts = 0
let lockoutUntil = 0

export interface CsLabSecurityConfig {
  /** v1 使用可逆密文，v2 起改为单向摘要；仅保留 v1 读取兼容。 */
  version: 1 | 2
  isInitialized: boolean
  /** v2：PBKDF2-SHA256 摘要（hex） */
  passwordHash?: string
  /** v2：随机盐（hex） */
  salt?: string
  /** v2：迭代次数 */
  iterations?: number
  /** v1 遗留：token-crypto 加密后的密文，仅用于一次性迁移 */
  encryptedPassword?: string
  createdAt?: number
  updatedAt?: number
}

/** 当前运行会话是否已通过门禁（仅内存，重启即失效） */
let sessionVerified = false

function readConfig(): CsLabSecurityConfig | null {
  return readJsonFileSafe<CsLabSecurityConfig>(getCsLabSecurityPath())
}

function hasPassword(config: CsLabSecurityConfig | null): boolean {
  if (config?.isInitialized !== true) return false
  if (typeof config.passwordHash === 'string' && config.passwordHash.length > 0) {
    return typeof config.salt === 'string' && config.salt.length > 0
  }
  return typeof config.encryptedPassword === 'string' && config.encryptedPassword.length > 0
}

/** 对两侧取等长摘要后恒定时间比对，避免长度差异泄露 */
function constantTimeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest()
  const digestB = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(digestA, digestB)
}

/** PBKDF2-SHA256 异步派生，返回 hex 摘要；避免 31 万次迭代阻塞主进程事件循环。 */
async function derivePasswordHash(password: string, salt: string, iterations: number): Promise<string> {
  const derived = await pbkdf2Async(password, salt, iterations, KEY_BYTES, PBKDF2_DIGEST)
  return derived.toString('hex')
}

/** 恒定时间比对两个 hex 摘要；长度不一致时直接返回 false，绝不抛 RangeError。 */
function hashesMatch(computedHex: string, expectedHex: string): boolean {
  const computed = Buffer.from(computedHex, 'hex')
  const expected = Buffer.from(expectedHex, 'hex')
  if (expected.length === 0 || computed.length !== expected.length) return false
  return timingSafeEqual(computed, expected)
}

async function writePasswordHash(password: string): Promise<void> {
  const salt = randomBytes(SALT_BYTES).toString('hex')
  const now = Date.now()
  const existing = readConfig()
  writeJsonFileAtomic(getCsLabSecurityPath(), {
    version: 2,
    isInitialized: true,
    passwordHash: await derivePasswordHash(password, salt, PBKDF2_ITERATIONS),
    salt,
    iterations: PBKDF2_ITERATIONS,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  } satisfies CsLabSecurityConfig)
}

/** 读取本机门禁状态 */
export function getCsLabAuthStatus(): CsLabAuthStatus {
  const initialized = hasPassword(readConfig())
  return {
    isInitialized: initialized,
    isVerified: initialized && sessionVerified,
  }
}

/**
 * 主进程硬门禁：所有 CSLab 敏感 IPC 必须先通过此断言。
 * 前端门禁只是体验层，不能作为授权依据。
 */
export function assertCsLabUnlocked(): void {
  const status = getCsLabAuthStatus()
  if (!status.isInitialized) throw new Error('CSLab 尚未设置本机访问密码')
  if (!status.isVerified) throw new Error('CSLab 已锁定，请先输入访问密码')
}

/** 首次启用：为本台设备设置访问密码 */
export async function initCsLabPassword(password: string): Promise<CsLabAuthResult> {
  if (typeof password !== 'string') {
    return { success: false, message: '无效的密码参数类型' }
  }

  if (hasPassword(readConfig())) {
    return { success: false, message: '本机已设置访问密码' }
  }

  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    return { success: false, message: `访问密码长度需在 ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} 位之间` }
  }

  try {
    await writePasswordHash(password)
  } catch {
    return { success: false, message: '本机安全存储写入失败，无法保存访问密码' }
  }

  sessionVerified = true
  return { success: true }
}

/** 日常进入：校验本机访问密码 */
export async function verifyCsLabPassword(password: string): Promise<CsLabAuthResult> {
  if (Date.now() < lockoutUntil) {
    const remainingSeconds = Math.ceil((lockoutUntil - Date.now()) / 1000)
    return { success: false, message: `尝试次数过多，请等待 ${remainingSeconds} 秒后重试` }
  }

  if (typeof password !== 'string' || password.length === 0) {
    return { success: false, message: '请输入访问密码' }
  }

  const config = readConfig()
  if (!hasPassword(config)) {
    return { success: false, message: '本机尚未设置访问密码' }
  }

  /** 累计失败次数，达到阈值后进入临时锁定，阻断本地暴力猜测。 */
  const recordFailure = (message: string): CsLabAuthResult => {
    failedAttempts += 1
    if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
      failedAttempts = 0
      lockoutUntil = Date.now() + LOCKOUT_MS
      return { success: false, message: `尝试次数过多，请等待 ${LOCKOUT_MS / 1000} 秒后重试` }
    }
    return { success: false, message }
  }

  // v2：单向摘要比对
  if (typeof config!.passwordHash === 'string' && typeof config!.salt === 'string') {
    const iterations = Number.isFinite(config!.iterations) ? Number(config!.iterations) : PBKDF2_ITERATIONS
    const computed = await derivePasswordHash(password, config!.salt, iterations)
    if (!hashesMatch(computed, config!.passwordHash)) {
      return recordFailure('密码不正确，请重新输入')
    }
    failedAttempts = 0
    sessionVerified = true
    return { success: true }
  }

  // v1：解密比对成功后立即迁移为 v2，迁移失败不影响本次登录
  let decrypted = ''
  try {
    decrypted = decryptToken(config!.encryptedPassword as string)
  } catch {
    return { success: false, message: '本机凭据已损坏，请重设访问密码' }
  }

  if (!decrypted || !constantTimeEqual(password, decrypted)) {
    return recordFailure('密码不正确，请重新输入')
  }

  try {
    await writePasswordHash(decrypted)
  } catch (error) {
    console.warn('[CSLab] 门禁凭据迁移到 PBKDF2 失败，将在下次验密时重试:', error)
  }

  failedAttempts = 0
  sessionVerified = true
  return { success: true }
}

/** 锁定当前会话：下次进入必须重新验密 */
export function lockCsLabSession(): void {
  sessionVerified = false
}

/** 仅供单元测试：清空内存会话与失败计数，并删除本机凭据文件 */
export function __resetCsLabSecurityForTest(): void {
  sessionVerified = false
  failedAttempts = 0
  lockoutUntil = 0
  const path = getCsLabSecurityPath()
  for (const target of [path, `${path}.tmp`, `${path}.bak`]) {
    if (existsSync(target)) {
      try {
        unlinkSync(target)
      } catch {
        // 清理失败不阻塞测试
      }
    }
  }
}
