/**
 * CSLab 本机访问密码门禁单元测试
 *
 * 覆盖：未初始化状态、长度校验、单向摘要落盘、重复初始化、验密、旧凭据迁移、
 * 锁定与重启语义、主进程硬门禁断言。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getCsLabSecurityPath } from '../config-paths'
import { encryptToken } from '../token-crypto'
import { writeJsonFileAtomic } from '../safe-file'
import {
  __resetCsLabSecurityForTest,
  assertCsLabUnlocked,
  getCsLabAuthStatus,
  initCsLabPassword,
  lockCsLabSession,
  verifyCsLabPassword,
} from './cslab-security'

const PASSWORD = '科研密码2026'
const originalConfigDir = process.env.PROFER_CONFIG_DIR
let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'profer-cslab-security-'))
  process.env.PROFER_CONFIG_DIR = root
  __resetCsLabSecurityForTest()
})

afterEach(() => {
  __resetCsLabSecurityForTest()
  if (originalConfigDir === undefined) {
    delete process.env.PROFER_CONFIG_DIR
  } else {
    process.env.PROFER_CONFIG_DIR = originalConfigDir
  }
  rmSync(root, { recursive: true, force: true })
})

describe('CSLab 本机门禁凭据', () => {
  test('未初始化时状态为未设置且未验证', () => {
    expect(getCsLabAuthStatus()).toEqual({ isInitialized: false, isVerified: false })
  })

  test('短密码初始化被拒绝且不产生配置文件', async () => {
    const result = await initCsLabPassword('12345')
    expect(result.success).toBe(false)
    expect(result.message).toContain('6')
    expect(existsSync(getCsLabSecurityPath())).toBe(false)
  })

  test('正常初始化后落盘为单向摘要并自动解锁当前会话', async () => {
    const result = await initCsLabPassword(PASSWORD)
    expect(result.success).toBe(true)
    expect(getCsLabAuthStatus()).toEqual({ isInitialized: true, isVerified: true })

    const raw = readFileSync(getCsLabSecurityPath(), 'utf-8')
    expect(raw).not.toContain(PASSWORD)

    const stored = JSON.parse(raw) as {
      version: number
      isInitialized: boolean
      passwordHash?: string
      salt?: string
      encryptedPassword?: string
    }
    expect(stored.version).toBe(2)
    expect(stored.isInitialized).toBe(true)
    expect(stored.passwordHash).toMatch(/^[a-f0-9]{64}$/)
    expect(stored.salt).toMatch(/^[a-f0-9]{32}$/)
    // 不允许再出现可逆密文
    expect(stored.encryptedPassword).toBeUndefined()
  })

  test('重复初始化被拒绝，且原有密码仍然有效', async () => {
    expect((await initCsLabPassword(PASSWORD)).success).toBe(true)

    const duplicated = await initCsLabPassword('另一个密码123')
    expect(duplicated.success).toBe(false)
    expect(duplicated.message).toContain('已设置')

    lockCsLabSession()
    expect((await verifyCsLabPassword(PASSWORD)).success).toBe(true)
  })

  test('验密：错误密码失败，正确密码通过', async () => {
    await initCsLabPassword(PASSWORD)
    lockCsLabSession()

    const wrong = await verifyCsLabPassword('错误密码')
    expect(wrong.success).toBe(false)
    expect(wrong.message).toContain('密码不正确')
    expect(getCsLabAuthStatus().isVerified).toBe(false)

    const ok = await verifyCsLabPassword(PASSWORD)
    expect(ok.success).toBe(true)
    expect(getCsLabAuthStatus().isVerified).toBe(true)
  })

  test('连续 5 次错误后进入 30 秒锁定，锁定期内正确密码也失败', async () => {
    await initCsLabPassword(PASSWORD)
    lockCsLabSession()

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const wrong = await verifyCsLabPassword('错误密码')
      expect(wrong.success).toBe(false)
      expect(wrong.message).toContain('密码不正确')
    }

    const locked = await verifyCsLabPassword('错误密码')
    expect(locked.success).toBe(false)
    expect(locked.message).toContain('尝试次数过多')

    // 锁定期内即使密码正确也必须拒绝，阻断自动化猜测。
    const blocked = await verifyCsLabPassword(PASSWORD)
    expect(blocked.success).toBe(false)
    expect(blocked.message).toContain('尝试次数过多')
    expect(getCsLabAuthStatus().isVerified).toBe(false)
  })

  test('锁定会话后凭据仍保留但必须重新验密（模拟应用重启）', async () => {
    await initCsLabPassword(PASSWORD)
    lockCsLabSession()

    expect(getCsLabAuthStatus()).toEqual({ isInitialized: true, isVerified: false })
  })

  test('非法参数与未初始化验密的健壮性', async () => {
    // @ts-expect-error 测试非法输入
    expect((await initCsLabPassword(123)).success).toBe(false)
    expect((await verifyCsLabPassword('')).success).toBe(false)
    expect((await verifyCsLabPassword(PASSWORD)).success).toBe(false)
  })

  test('旧版可逆密文验密成功后透明迁移为 PBKDF2 摘要', async () => {
    const legacyCipher = encryptToken(PASSWORD)
    expect(legacyCipher).not.toBe(PASSWORD)
    writeJsonFileAtomic(getCsLabSecurityPath(), {
      version: 1,
      isInitialized: true,
      encryptedPassword: legacyCipher,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })

    const result = await verifyCsLabPassword(PASSWORD)
    expect(result.success).toBe(true)
    expect(getCsLabAuthStatus()).toEqual({ isInitialized: true, isVerified: true })

    const stored = JSON.parse(readFileSync(getCsLabSecurityPath(), 'utf-8')) as {
      version: number
      passwordHash?: string
      salt?: string
      encryptedPassword?: string
    }
    expect(stored.version).toBe(2)
    expect(stored.passwordHash).toMatch(/^[a-f0-9]{64}$/)
    expect(stored.salt).toMatch(/^[a-f0-9]{32}$/)
    expect(stored.encryptedPassword).toBeUndefined()
  })

  test('凭据被截断时验密返回失败而非抛 RangeError', async () => {
    await initCsLabPassword(PASSWORD)
    lockCsLabSession()
    const config = JSON.parse(readFileSync(getCsLabSecurityPath(), 'utf-8')) as Record<string, unknown>
    config.passwordHash = 'deadbeef'
    writeJsonFileAtomic(getCsLabSecurityPath(), config)

    const result = await verifyCsLabPassword(PASSWORD)
    expect(result.success).toBe(false)
  })

  test('主进程硬门禁：未初始化与已锁定均抛错，解锁后放行', async () => {
    expect(() => assertCsLabUnlocked()).toThrow('尚未设置')

    await initCsLabPassword(PASSWORD)
    expect(() => assertCsLabUnlocked()).not.toThrow()

    lockCsLabSession()
    expect(() => assertCsLabUnlocked()).toThrow('已锁定')

    expect((await verifyCsLabPassword(PASSWORD)).success).toBe(true)
    expect(() => assertCsLabUnlocked()).not.toThrow()
  })
})
