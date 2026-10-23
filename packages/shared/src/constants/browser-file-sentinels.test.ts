import { describe, expect, test } from 'bun:test'

import {
  BROWSER_CERT_INTERSTITIAL_ALLOW_URL,
  BROWSER_CERT_INTERSTITIAL_BACK_URL,
  BROWSER_CERT_INTERSTITIAL_HOST,
  BROWSER_LOCAL_FILE_OPEN_DEFAULT_URL,
  BROWSER_LOCAL_FILE_SELECTION_MAX_CHARS,
  BROWSER_LOCAL_FILE_SELECTION_URL_PREFIX,
  encodeBrowserLocalFileSelection,
  parseBrowserLocalFileSelection,
  parseCertInterstitialSentinel,
} from './browser-file-sentinels'

describe('browser-file-sentinels', () => {
  test('哨兵前缀覆盖「打开」与「划词」两类，且互不误伤', () => {
    expect(BROWSER_LOCAL_FILE_OPEN_DEFAULT_URL).toBe('profer-action://open-in-default-app')
    expect(BROWSER_LOCAL_FILE_SELECTION_URL_PREFIX).toBe('profer-selection://')
    expect(parseBrowserLocalFileSelection(BROWSER_LOCAL_FILE_OPEN_DEFAULT_URL)).toBeNull()
  })

  test('划词往返：中文、换行、特殊字符都能原样还原', () => {
    const text = '第一段\n第二段 with spaces & symbols ?#%[]'
    expect(parseBrowserLocalFileSelection(encodeBrowserLocalFileSelection(text))).toBe(text)
  })

  test('空选区也能回投（用于让渲染进程撤掉引用胶囊）', () => {
    expect(parseBrowserLocalFileSelection(encodeBrowserLocalFileSelection(''))).toBe('')
  })

  test('编码时截断到上限，避免超长 URL', () => {
    const long = 'x'.repeat(BROWSER_LOCAL_FILE_SELECTION_MAX_CHARS + 500)
    expect(parseBrowserLocalFileSelection(encodeBrowserLocalFileSelection(long))).toHaveLength(
      BROWSER_LOCAL_FILE_SELECTION_MAX_CHARS,
    )
  })

  test('解析侧对超长内容再截一次（边界兜底）', () => {
    const long = 'x'.repeat(BROWSER_LOCAL_FILE_SELECTION_MAX_CHARS + 10)
    const url = `${BROWSER_LOCAL_FILE_SELECTION_URL_PREFIX}${encodeURIComponent(long)}`
    expect(parseBrowserLocalFileSelection(url)).toHaveLength(BROWSER_LOCAL_FILE_SELECTION_MAX_CHARS)
  })

  test('畸形百分号编码返回 null，不抛异常', () => {
    expect(parseBrowserLocalFileSelection(`${BROWSER_LOCAL_FILE_SELECTION_URL_PREFIX}%E4%BD`)).toBeNull()
    expect(parseBrowserLocalFileSelection(`${BROWSER_LOCAL_FILE_SELECTION_URL_PREFIX}%`)).toBeNull()
  })

  test('非本协议一律返回 null', () => {
    expect(parseBrowserLocalFileSelection('https://example.com/%00')).toBeNull()
    expect(parseBrowserLocalFileSelection('file:///etc/passwd')).toBeNull()
    expect(parseBrowserLocalFileSelection('profer-selection:/typo')).toBeNull()
  })

  test('证书插页哨兵为标准 HTTPS 伪域名形式', () => {
    expect(BROWSER_CERT_INTERSTITIAL_HOST).toBe('profer-security.local')
    expect(BROWSER_CERT_INTERSTITIAL_ALLOW_URL).toBe('https://profer-security.local/cert-allow')
    expect(BROWSER_CERT_INTERSTITIAL_BACK_URL).toBe('https://profer-security.local/cert-back')
  })

  test('证书插页哨兵解析：allow / back / 非哨兵', () => {
    expect(parseCertInterstitialSentinel('https://profer-security.local/cert-allow')).toBe('allow')
    expect(parseCertInterstitialSentinel('https://profer-security.local/cert-allow?x=1')).toBe('allow')
    expect(parseCertInterstitialSentinel('https://profer-security.local/cert-back')).toBe('back')
    expect(parseCertInterstitialSentinel('https://example.com/cert-allow')).toBeNull()
    expect(parseCertInterstitialSentinel('profer-action://open-in-default-app')).toBeNull()
    expect(parseCertInterstitialSentinel('https://profer-security.local/other')).toBeNull()
  })
})
