import { describe, expect, test } from 'bun:test'
import { assertSafeBrowserSubresourceDestination, assertSafeBrowserUrl, isSafeBrowserSubresourceUrl, normalizeBrowserUrl } from './browser-policy'

describe('受管浏览器 URL 策略', () => {
  test('规范化常见地址栏输入为可导航的 HTTPS URL', () => {
    expect(normalizeBrowserUrl('example.com/docs')).toBe('https://example.com/docs')
    expect(normalizeBrowserUrl('//example.com/docs')).toBe('https://example.com/docs')
    expect(normalizeBrowserUrl('example.com:8443/docs')).toBe('https://example.com:8443/docs')
  })

  test('允许明确指定的本机开发地址，同时拒绝其他私网目标', () => {
    expect(assertSafeBrowserUrl('https://example.com/')).toBe('https://example.com/')
    expect(assertSafeBrowserUrl('http://example.com/')).toBe('http://example.com/')
    expect(assertSafeBrowserUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000/')
    expect(assertSafeBrowserUrl('http://localhost:5173/app')).toBe('http://localhost:5173/app')
    expect(assertSafeBrowserUrl('http://[::1]:3000')).toBe('http://[::1]:3000/')
    expect(assertSafeBrowserUrl('http://192.168.1.10:8080')).toBe('http://192.168.1.10:8080/')
    expect(assertSafeBrowserUrl('http://dev-machine.local:3000')).toBe('http://dev-machine.local:3000/')
    expect(() => assertSafeBrowserUrl('file:///tmp/index.html')).toThrow('不允许此 URL 协议')
    expect(() => assertSafeBrowserUrl('javascript:alert(1)')).toThrow('不允许此 URL 协议')
    expect(() => assertSafeBrowserUrl('https://user:pass@example.com')).toThrow('认证信息')
  })

  test('本地开发地址缺省使用 HTTP，公网地址缺省使用 HTTPS', () => {
    expect(normalizeBrowserUrl('127.0.0.1:3000')).toBe('http://127.0.0.1:3000')
    expect(normalizeBrowserUrl('localhost:5173/app')).toBe('http://localhost:5173/app')
    expect(normalizeBrowserUrl('//127.0.0.1:4173')).toBe('http://127.0.0.1:4173')
    expect(normalizeBrowserUrl('example.com:8443/docs')).toBe('https://example.com:8443/docs')
  })

  test('顶层本地开发页允许本地子资源，公网顶层页拒绝私网子资源', async () => {
    await expect(assertSafeBrowserSubresourceDestination('http://127.0.0.1:3000/@vite/client', 'http://localhost:5173/')).resolves.toBe('http://127.0.0.1:3000/@vite/client')
    await expect(assertSafeBrowserSubresourceDestination('http://192.168.1.10/api', 'http://dev-machine.local:3000/')).resolves.toBe('http://192.168.1.10/api')
    await expect(assertSafeBrowserSubresourceDestination('http://127.0.0.1:3000/admin', 'https://example.com/')).rejects.toThrow('公网页面不得访问')
    await expect(assertSafeBrowserSubresourceDestination('ws://127.0.0.1:5173/socket', 'http://localhost:5173/')).resolves.toBe('ws://127.0.0.1:5173/socket')
    await expect(assertSafeBrowserSubresourceDestination('wss://127.0.0.1:5173/socket', 'https://example.com/')).rejects.toThrow('公网页面不得访问')
  })

  test('子资源协议和认证信息使用同步策略', () => {
    expect(isSafeBrowserSubresourceUrl('https://cdn.example.com/app.js')).toBe(true)
    expect(isSafeBrowserSubresourceUrl('http://127.0.0.1:3000/app.js')).toBe(true)
    expect(isSafeBrowserSubresourceUrl('data:text/plain,ok')).toBe(false)
    expect(isSafeBrowserSubresourceUrl('https://user:pass@example.com/app.js')).toBe(false)
    expect(isSafeBrowserSubresourceUrl('not a url')).toBe(false)
  })

  test('NUL 截断攻击（CVE-2026-105482）在顶层与子资源校验中一律拒止', () => {
    expect(() => assertSafeBrowserUrl('https://example.com%00.evil.net/')).toThrow('空字符或控制字符')
    expect(() => assertSafeBrowserUrl('https://example.com/\0')).toThrow('空字符或控制字符')
    expect(() => assertSafeBrowserUrl('https://exa\u0000mple.com/')).toThrow('空字符或控制字符')
    expect(isSafeBrowserSubresourceUrl('https://cdn.example.com/app.js%00')).toBe(false)
    expect(isSafeBrowserSubresourceUrl('https://cdn.example\0.com/app.js')).toBe(false)
  })
})
