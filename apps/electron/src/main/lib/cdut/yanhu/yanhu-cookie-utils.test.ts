/**
 * 智联万站 · 瑞数陈旧签名清洗工具单元测试
 *
 * 覆盖：成对 *O/*P 识别与单向精准剔除、独立 P 签名与非瑞数 Cookie 不受影响、
 * 目标域参数透传、默认域回落，以及异常兜底不抛出。
 */

import { describe, expect, test } from 'bun:test'
import type { Session } from 'electron'
import { DEFAULT_RUISHU_DOMAIN, stripStaleRuiShuCookies } from './yanhu-cookie-utils'

interface FakeCookie {
  name: string
  domain?: string
  path?: string
}

interface FakeSessionHandles {
  session: Session
  getFilters: Array<{ domain?: string }>
  removeCalls: Array<{ url: string; name: string }>
}

/**
 * 构造最小可用的伪造 Session：仅实现被测函数触及的 cookies.get / cookies.remove。
 * `onGetError` 用于验证异常兜底路径。
 */
function createFakeSession(cookies: FakeCookie[], onGetError = false): FakeSessionHandles {
  const getFilters: Array<{ domain?: string }> = []
  const removeCalls: Array<{ url: string; name: string }> = []
  const removed = new Set<string>()

  const session = {
    cookies: {
      get: async (filter: { domain?: string }) => {
        getFilters.push(filter)
        if (onGetError) throw new Error('cookie store unavailable')
        return cookies.filter((c) => !removed.has(c.name))
      },
      remove: async (url: string, name: string) => {
        removeCalls.push({ url, name })
        removed.add(name)
      },
    },
  }

  return { session: session as unknown as Session, getFilters, removeCalls }
}

describe('stripStaleRuiShuCookies 成对签名识别', () => {
  test('存在同前缀 *O 会话 Cookie 时，剔除成对 *P 并返回剔除计数', async () => {
    const { session, removeCalls } = createFakeSession([
      { name: 'sMLAeTqisZbFO' },
      { name: 'sMLAeTqisZbFP' },
      { name: 'JSESSIONID' },
    ])

    const removed = await stripStaleRuiShuCookies(session)

    expect(removed).toBe(1)
    // 缺省路径按根路径处理，删除 URL 必须携带与 Cookie 作用域一致的路径
    expect(removeCalls).toEqual([
      { url: `https://${DEFAULT_RUISHU_DOMAIN}/`, name: 'sMLAeTqisZbFP' },
    ])
  })

  test('缺少配对 *O 的独立 P 签名绝不被剔除', async () => {
    const { session, removeCalls } = createFakeSession([{ name: 'abcP' }, { name: 'JSESSIONID' }])

    const removed = await stripStaleRuiShuCookies(session)

    expect(removed).toBe(0)
    expect(removeCalls).toHaveLength(0)
  })

  test('普通业务 Cookie（JSESSIONID / SERVERID / themeSkinColor）完全不受影响', async () => {
    const { session, removeCalls } = createFakeSession([
      { name: 'JSESSIONID' },
      { name: 'SERVERID' },
      { name: 'themeSkinColor' },
    ])

    const removed = await stripStaleRuiShuCookies(session)

    expect(removed).toBe(0)
    expect(removeCalls).toHaveLength(0)
  })

  test('多组成对签名时逐一剔除并累计计数', async () => {
    const { session, removeCalls } = createFakeSession([
      { name: 'aaaO' },
      { name: 'aaaP' },
      { name: 'bbbO' },
      { name: 'bbbP' },
      { name: 'cccO' },
    ])

    const removed = await stripStaleRuiShuCookies(session)

    expect(removed).toBe(2)
    expect(removeCalls.map((c) => c.name)).toEqual(['aaaP', 'bbbP'])
  })

  test('按 Cookie 自身 domain/path 构造删除 URL，路径作用域不丢失', async () => {
    const { session, removeCalls } = createFakeSession([
      { name: 'ruiO', domain: '.jw.cdut.edu.cn', path: '/jsxsd' },
      { name: 'ruiP', domain: '.jw.cdut.edu.cn', path: '/jsxsd' },
    ])

    const removed = await stripStaleRuiShuCookies(session)

    expect(removed).toBe(1)
    expect(removeCalls).toEqual([
      { url: 'https://jw.cdut.edu.cn/jsxsd', name: 'ruiP' },
    ])
  })

  test('精确路径删除失败时兜底尝试 /jsxsd/ 作用域', async () => {
    const removeCalls: Array<{ url: string; name: string }> = []
    const session = {
      cookies: {
        get: async () => [
          { name: 'ruiO', domain: 'jw.cdut.edu.cn', path: '/' },
          { name: 'ruiP', domain: 'jw.cdut.edu.cn', path: '/' },
        ],
        remove: async (url: string, name: string) => {
          removeCalls.push({ url, name })
          // 根路径不存在，仅 /jsxsd/ 作用域可成功删除
          if (!url.endsWith('/jsxsd/')) throw new Error('cookie not found')
        },
      },
    } as unknown as Session

    const removed = await stripStaleRuiShuCookies(session)

    expect(removed).toBe(1)
    expect(removeCalls.at(-1)).toEqual({
      url: 'https://jw.cdut.edu.cn/jsxsd/',
      name: 'ruiP',
    })
  })
})

describe('stripStaleRuiShuCookies 目标域与兜底', () => {
  test('默认以青果教务域作为过滤条件', async () => {
    const { session, getFilters } = createFakeSession([])

    await stripStaleRuiShuCookies(session)

    expect(getFilters).toEqual([{ domain: DEFAULT_RUISHU_DOMAIN }])
  })

  test('可指定校内其它系统域，剔除操作同步使用该域', async () => {
    const { session, getFilters, removeCalls } = createFakeSession([
      { name: 'xO' },
      { name: 'xP' },
    ])

    const removed = await stripStaleRuiShuCookies(session, 'bsdt.cdut.edu.cn')

    expect(removed).toBe(1)
    expect(getFilters).toEqual([{ domain: 'bsdt.cdut.edu.cn' }])
    expect(removeCalls).toEqual([
      { url: 'https://bsdt.cdut.edu.cn/', name: 'xP' },
    ])
  })

  test('Cookie 读取异常时静默兜底返回 0，绝不抛出', async () => {
    const { session } = createFakeSession([], true)

    await expect(stripStaleRuiShuCookies(session)).resolves.toBe(0)
  })
})
