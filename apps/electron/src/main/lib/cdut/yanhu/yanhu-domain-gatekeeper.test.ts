/**
 * 智联万站安全网关单元测试
 *
 * 覆盖：校内域判定（瑞数专属逻辑复用）、任意 http/https 网页地址放行、
 * 非网页协议严格阻断、地址栏输入规范化。
 */

import { describe, expect, test } from 'bun:test'
import {
  isCdutDomain,
  isInternalYanhuUrl,
  isWebUrl,
  normalizeInputUrl,
  yanhuDomainGatekeeper,
} from './yanhu-domain-gatekeeper'
import { buildYanhuBlockedUrl } from '@profer/shared'

describe('isCdutDomain 校内域判定', () => {
  test('放行成都理工大学各校内子域', () => {
    expect(isCdutDomain('https://bsdt.cdut.edu.cn/EIP/caslogin.jsp')).toBe(true)
    expect(isCdutDomain('https://bsdt.cdut.edu.cn/EIP/nonlogin/homePage.htm')).toBe(true)
    expect(isCdutDomain('https://jw.cdut.edu.cn/jsxsd/framework/xsMainV.htmlx')).toBe(true)
    expect(isCdutDomain('http://library.cdut.edu.cn')).toBe(true)
    expect(isCdutDomain('https://gra.cdut.edu.cn')).toBe(true)
    expect(isCdutDomain('https://cdut.edu.cn/')).toBe(true)
    expect(isCdutDomain('https://a.b.c.cdut.edu.cn:8443/x')).toBe(true)
  })

  test('非校内域（站外、伪顶级域、协议外地址）一律判定为 false', () => {
    expect(isCdutDomain('https://www.baidu.com')).toBe(false)
    expect(isCdutDomain('https://cdut.com')).toBe(false)
    expect(isCdutDomain('https://evil-cdut.edu.cn.phishing.com')).toBe(false)
    expect(isCdutDomain('https://cdut.edu.cn.evil.com')).toBe(false)
    expect(isCdutDomain('javascript:alert(1)')).toBe(false)
    expect(isCdutDomain('file:///etc/passwd')).toBe(false)
    expect(isCdutDomain('not a url')).toBe(false)
    expect(isCdutDomain('')).toBe(false)
  })
})

describe('isWebUrl 网页地址判定', () => {
  test('放行 http/https 网页地址（含站外域名）', () => {
    expect(isWebUrl('https://www.baidu.com/s?wd=cdut')).toBe(true)
    expect(isWebUrl('http://jw.cdut.edu.cn/jsxsd')).toBe(true)
    expect(isWebUrl('https://a.b.c.example.com:8443/x')).toBe(true)
  })

  test('严格阻断非网页协议与非法输入', () => {
    expect(isWebUrl('mailto:someone@cdut.edu.cn')).toBe(false)
    expect(isWebUrl('javascript:alert(1)')).toBe(false)
    expect(isWebUrl('file:///etc/passwd')).toBe(false)
    expect(isWebUrl('not a url')).toBe(false)
    expect(isWebUrl('')).toBe(false)
  })
})

describe('normalizeInputUrl 地址栏输入规范化', () => {
  test('已带协议的地址原样返回', () => {
    expect(normalizeInputUrl('https://jw.cdut.edu.cn/jsxsd')).toBe('https://jw.cdut.edu.cn/jsxsd')
    expect(normalizeInputUrl('http://bsdt.cdut.edu.cn')).toBe('http://bsdt.cdut.edu.cn')
  })

  test('裸域名补全 https', () => {
    expect(normalizeInputUrl('bsdt.cdut.edu.cn')).toBe('https://bsdt.cdut.edu.cn')
    expect(normalizeInputUrl('jw.cdut.edu.cn:8080/x')).toBe('https://jw.cdut.edu.cn:8080/x')
  })

  test('非 URL 文本返回 null（不猜测搜索）', () => {
    expect(normalizeInputUrl('你好 世界')).toBeNull()
    expect(normalizeInputUrl('hello world')).toBeNull()
    expect(normalizeInputUrl('')).toBeNull()
  })
})

describe('YanhuDomainGatekeeper 裁决', () => {
  test('校内与站外 http/https 地址一律放行', () => {
    expect(yanhuDomainGatekeeper.evaluate('https://jw.cdut.edu.cn/x').allowed).toBe(true)
    expect(yanhuDomainGatekeeper.evaluate('https://baidu.com').allowed).toBe(true)
    expect(yanhuDomainGatekeeper.evaluate('http://example.com:8080/path').allowed).toBe(true)
  })

  test('非网页协议地址阻断', () => {
    expect(yanhuDomainGatekeeper.evaluate('mailto:someone@cdut.edu.cn').allowed).toBe(false)
    expect(yanhuDomainGatekeeper.evaluate('file:///etc/passwd').allowed).toBe(false)
  })

  test('内置拦截页哨兵视为内部放行', () => {
    const blocked = buildYanhuBlockedUrl('https://baidu.com')
    expect(isInternalYanhuUrl(blocked)).toBe(true)
    expect(yanhuDomainGatekeeper.isAllowed(blocked)).toBe(true)
  })

  test('地址栏解析：站外域名补全协议后放行', () => {
    const decision = yanhuDomainGatekeeper.resolveAddressInput('baidu.com')
    expect(decision).not.toBeNull()
    expect(decision?.url).toBe('https://baidu.com')
    expect(decision?.allowed).toBe(true)
  })
})
