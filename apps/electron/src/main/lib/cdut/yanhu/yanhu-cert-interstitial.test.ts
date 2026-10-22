import { describe, expect, test } from 'bun:test'

import type { CertBlockedRecord } from '../../security/cert-blacklist'

import { resolveYanhuCertBlockTarget } from './yanhu-cert-interstitial'

/** 构造测试用阻断登记（verifyProc 写入的形态：url 为 https://<hostname>/ 伪地址） */
function blockedRecord(hostname: string): CertBlockedRecord {
  return {
    url: `https://${hostname}/`,
    hostname,
    issuerName: 'emSign Root CA - G3',
    subjectName: `CN=${hostname}`,
    blockedAt: 1_760_000_000_000,
  }
}

describe('智联万站证书阻断解析', () => {
  test('Given 目标主机存在阻断登记 When 解析 Then 返回小写主机与登记记录', () => {
    const record = blockedRecord('mitm.example.com')
    const result = resolveYanhuCertBlockTarget(
      'https://MITM.Example.COM/path?x=1',
      (host) => (host === 'mitm.example.com' ? record : undefined),
    )
    expect(result).not.toBeNull()
    expect(result?.hostname).toBe('mitm.example.com')
    expect(result?.record).toBe(record)
  })

  test('Given 同主机无阻断登记 When 解析 Then 返回 null（普通网络失败不走证书插页）', () => {
    const result = resolveYanhuCertBlockTarget('https://normal.example.com/a', () => undefined)
    expect(result).toBeNull()
  })

  test('Given 请求 URL 缺失或非法 When 解析 Then 返回 null 且不抛异常', () => {
    expect(resolveYanhuCertBlockTarget(null, () => blockedRecord('a.example.com'))).toBeNull()
    expect(resolveYanhuCertBlockTarget('', () => blockedRecord('a.example.com'))).toBeNull()
    expect(resolveYanhuCertBlockTarget('not-a-url', () => blockedRecord('a.example.com'))).toBeNull()
  })
})
