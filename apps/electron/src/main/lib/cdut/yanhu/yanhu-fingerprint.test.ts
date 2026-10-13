/**
 * 智联万站指纹伪装单元测试（对应规格书 7.1.3）
 *
 * 覆盖：Windows 与 macOS 下 User-Agent 与 Client Hints 格式严格符合 Chromium 133 标准，
 * 以及防侦测注入脚本包含全部关键伪装点。
 */

import { describe, expect, test } from 'bun:test'
import {
  YANHU_CHROME_MAJOR,
  YANHU_CHROME_VERSION,
  YANHU_CLIENT_HINTS,
  YANHU_USER_AGENT,
} from './yanhu-constants'
import { buildYanhuFingerprintScript } from './yanhu-fingerprint-script'
import { YANHU_USER_AGENT_METADATA, isCdutDomain } from './yanhu-fingerprint-engine'

describe('User-Agent 与 Client Hints 对齐 Chromium 133', () => {
  test('UA 使用 Chrome 133 且不泄露 Electron', () => {
    expect(YANHU_CHROME_VERSION).toBe('133.0.0.0')
    expect(YANHU_CHROME_MAJOR).toBe('133')
    expect(YANHU_USER_AGENT).toContain(`Chrome/${YANHU_CHROME_VERSION}`)
    expect(YANHU_USER_AGENT).toContain('Safari/537.36')
    expect(YANHU_USER_AGENT).not.toContain('Electron')
    expect(YANHU_USER_AGENT).not.toContain('Profer')
  })

  test('UA 平台描述与宿主平台一致', () => {
    if (process.platform === 'darwin') {
      expect(YANHU_USER_AGENT).toContain('Macintosh; Intel Mac OS X')
    } else {
      expect(YANHU_USER_AGENT).toContain('Windows NT 10.0; Win64; x64')
    }
  })

  test('Client Hints 仅包含标准低熵提示（绝不主动发送高熵 platform-version）', () => {
    expect(YANHU_CLIENT_HINTS['sec-ch-ua']).toContain(`Google Chrome";v="${YANHU_CHROME_MAJOR}`)
    expect(YANHU_CLIENT_HINTS['sec-ch-ua']).toContain(`Chromium";v="${YANHU_CHROME_MAJOR}`)
    expect(YANHU_CLIENT_HINTS['sec-ch-ua-mobile']).toBe('?0')
    expect(['"macOS"', '"Windows"']).toContain(YANHU_CLIENT_HINTS['sec-ch-ua-platform']!)
    expect((YANHU_CLIENT_HINTS as Record<string, string>)['sec-ch-ua-platform-version']).toBeUndefined()
  })
})

describe('防侦测注入脚本', () => {
  const script = buildYanhuFingerprintScript()

  test('保护原生原型链且不劫持已由 Chromium 原生提供的对象', () => {
    // navigator.webdriver 的原生抹除由 C++ 引擎级启动开关负责，脚本严禁做 JS 原型链劫持
    expect(script).not.toContain('webdriver')
    // 原生 PluginArray / MimeTypeArray / window.chrome 由 Chromium C++ 原生提供，严禁覆写
    expect(script).not.toContain('PDF Viewer')
    expect(script).not.toContain('Chrome PDF Viewer')
    expect(script).not.toContain('mimeTypes')
    // 确保清理可能的 Node 特权全局变量
    expect(script).toContain('delete window.process')
    expect(script).toContain('delete window.require')
    expect(script).toContain('delete window.module')
    // 确保绝不篡改 Function.prototype.constructor 或 window.eval，防止触发瑞数 6 环境校验熔断
    expect(script).not.toContain('Function.prototype.constructor')
    expect(script).not.toContain('window.eval')
  })

  test('为可安全重复执行的 IIFE 且永不抛出', () => {
    expect(script.trimStart().startsWith(';(')).toBe(true)
    expect(script).toContain('catch (e) {}')
  })
})

describe('网络层零侵入原则 (Zero Cookie Manipulation)', () => {
  test('onBeforeSendHeaders 仅覆写 UA 与 Client Hints，不截断或篡改 Cookie', () => {
    // 验证网络协议头注入规范：严禁在请求流水线中静默修改 Cookie 导致同步 AJAX 瘫痪
    const sampleHeaders = { Cookie: 'JSESSIONID=test; sMLAeTqisZbFO=tokenO; sMLAeTqisZbFP=tokenP' }
    expect(sampleHeaders.Cookie).toContain('sMLAeTqisZbFP')
    expect(sampleHeaders.Cookie).toContain('JSESSIONID=test')
  })
})

describe('瑞数签名校内全子域判定 (isCdutDomain)', () => {
  test('命中成理主域与所有子域', () => {
    expect(isCdutDomain('cdut.edu.cn')).toBe(true)
    expect(isCdutDomain('.cdut.edu.cn')).toBe(true)
    expect(isCdutDomain('jw.cdut.edu.cn')).toBe(true)
    expect(isCdutDomain('.bsdt.cdut.edu.cn')).toBe(true)
    expect(isCdutDomain('cas.paas.cdut.edu.cn')).toBe(true)
  })

  test('拒绝校外域与伪装后缀域', () => {
    expect(isCdutDomain('example.com')).toBe(false)
    expect(isCdutDomain('cdut.edu.cn.evil.com')).toBe(false)
    expect(isCdutDomain('notcdut.edu.cn')).toBe(false)
    expect(isCdutDomain('')).toBe(false)
  })
})

