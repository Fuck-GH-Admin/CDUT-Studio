/**
 * CSLab Python 工具内存信任层测试
 *
 * 覆盖：显式授权/撤销、实验室切换失效、根会话上溯、双轨门禁判定矩阵。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let rootDir = ''

beforeAll(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'cslab-trust-'))
  process.env.PROFER_CONFIG_DIR = rootDir
})

afterAll(() => {
  delete process.env.PROFER_CONFIG_DIR
  try {
    rmSync(rootDir, { recursive: true, force: true })
  } catch {
    // Windows 句柄延迟释放，交给系统回收。
  }
})

describe('信任生命周期', () => {
  test('显式授权后可放行，撤销后立即失效', async () => {
    const { grantCsLabToolTrust, revokeCsLabToolTrust, isCsLabToolTrusted, resetCsLabToolTrustForTest } =
      await import('./cslab-tool-trust')
    resetCsLabToolTrustForTest()

    grantCsLabToolTrust('session-a', 'lab-a')
    expect(isCsLabToolTrusted('session-a', 'lab-a')).toBe(true)
    expect(isCsLabToolTrusted('session-a', 'lab-b')).toBe(false)
    expect(isCsLabToolTrusted('session-b', 'lab-a')).toBe(false)

    revokeCsLabToolTrust('session-a')
    expect(isCsLabToolTrusted('session-a', 'lab-a')).toBe(false)
  })

  test('切换实验室清空全部信任，重新打开同一实验室不清空', async () => {
    const {
      grantCsLabToolTrust,
      isCsLabToolTrusted,
      onCsLabOpened,
      resetCsLabToolTrustForTest,
    } = await import('./cslab-tool-trust')
    resetCsLabToolTrustForTest()

    grantCsLabToolTrust('session-a', 'lab-a')
    onCsLabOpened('lab-a')
    expect(isCsLabToolTrusted('session-a', 'lab-a')).toBe(true)

    onCsLabOpened('lab-b')
    expect(isCsLabToolTrusted('session-a', 'lab-a')).toBe(false)
  })

  test('同一实验室内多个会话可同时持有信任，互不覆盖', async () => {
    const { grantCsLabToolTrust, isCsLabToolTrusted, resetCsLabToolTrustForTest } = await import(
      './cslab-tool-trust'
    )
    resetCsLabToolTrustForTest()

    grantCsLabToolTrust('session-a', 'lab-a')
    grantCsLabToolTrust('session-b', 'lab-a')

    expect(isCsLabToolTrusted('session-a', 'lab-a')).toBe(true)
    expect(isCsLabToolTrusted('session-b', 'lab-a')).toBe(true)
    expect(isCsLabToolTrusted('session-c', 'lab-a')).toBe(false)
  })

  test('不同实验室的会话绑定彼此隔离，不会串用', async () => {
    const { grantCsLabToolTrust, isCsLabToolTrusted, resetCsLabToolTrustForTest } = await import(
      './cslab-tool-trust'
    )
    resetCsLabToolTrustForTest()

    grantCsLabToolTrust('session-a', 'lab-a')
    grantCsLabToolTrust('session-b', 'lab-b')

    expect(isCsLabToolTrusted('session-a', 'lab-a')).toBe(true)
    expect(isCsLabToolTrusted('session-b', 'lab-b')).toBe(true)
    expect(isCsLabToolTrusted('session-a', 'lab-b')).toBe(false)
    expect(isCsLabToolTrusted('session-b', 'lab-a')).toBe(false)
  })
})

describe('根会话上溯', () => {
  test('子会话与孙会话都可追溯到根会话', async () => {
    const { createDelegatedChildSessionMeta } = await import('../agent-session-manager')
    createDelegatedChildSessionMeta({
      childSessionId: 'trust-child',
      parentSessionId: 'trust-root',
      sourceDelegationId: 'delegation-1',
      title: '子会话',
    })
    createDelegatedChildSessionMeta({
      childSessionId: 'trust-grandchild',
      parentSessionId: 'trust-child',
      sourceDelegationId: 'delegation-2',
      title: '孙会话',
    })

    const { resolveRootSessionId } = await import('./cslab-tool-trust')
    expect(resolveRootSessionId('trust-grandchild')).toBe('trust-root')
    expect(resolveRootSessionId('trust-root')).toBe('trust-root')
    expect(resolveRootSessionId('trust-missing')).toBe('trust-missing')
  })
})

describe('双轨门禁判定矩阵', () => {
  test('按模式、信任与交互通道返回 allow / prompt / deny', async () => {
    const { decideCsLabToolGate } = await import('./cslab-tool-trust')

    const cases: Array<{
      label: string
      mode: 'auto' | 'bypassPermissions' | 'plan'
      trusted: boolean
      nonInteractive: boolean
      expected: 'allow' | 'prompt' | 'deny'
    }> = [
      { label: 'auto + 主会话', mode: 'auto', trusted: false, nonInteractive: false, expected: 'prompt' },
      { label: 'auto + 子代理', mode: 'auto', trusted: false, nonInteractive: true, expected: 'deny' },
      { label: 'bypass 未授权 + 主会话', mode: 'bypassPermissions', trusted: false, nonInteractive: false, expected: 'prompt' },
      { label: 'bypass 已授权 + 主会话', mode: 'bypassPermissions', trusted: true, nonInteractive: false, expected: 'allow' },
      { label: 'bypass 已授权 + 子代理', mode: 'bypassPermissions', trusted: true, nonInteractive: true, expected: 'allow' },
      { label: 'bypass 未授权 + 子代理', mode: 'bypassPermissions', trusted: false, nonInteractive: true, expected: 'deny' },
      { label: 'plan + 任意通道', mode: 'plan', trusted: true, nonInteractive: false, expected: 'deny' },
    ]

    for (const item of cases) {
      expect(
        decideCsLabToolGate({
          mode: item.mode,
          trusted: item.trusted,
          nonInteractive: item.nonInteractive,
        }),
        item.label,
      ).toBe(item.expected)
    }
  })
})
