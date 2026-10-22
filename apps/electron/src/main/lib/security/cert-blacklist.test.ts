import { describe, expect, test } from 'bun:test'

import {
  BROWSER_CERT_INTERSTITIAL_ALLOW_URL,
  BROWSER_CERT_INTERSTITIAL_BACK_URL,
} from '@profer/shared'

import {
  allowDomainTemporarily,
  buildSecurityInterstitialHtml,
  CERT_VERIFY_ACCEPT,
  CERT_VERIFY_REJECT,
  decideCertificateVerification,
  getCertBlockedRecord,
  isCompromisedEmudhraCertificate,
  isDomainTemporarilyAllowed,
  recordCertBlocked,
  resetCertSecurityStateForTest,
  revokeTabGrants,
  wipeSessionGrants,
} from './cert-blacklist'

import type { Certificate } from 'electron'

/** 构造测试用证书对象（Electron Certificate 结构子集）。 */
function fakeCert(fields: {
  subjectName?: string
  issuerName?: string
  issuerCert?: Certificate
}): Certificate {
  return fields as unknown as Certificate
}

describe('eMudhra 泄露链特征判定', () => {
  test('Given 精确泄露 CN（两种 emSign G3 根）When 判定 Then 命中', () => {
    expect(isCompromisedEmudhraCertificate(fakeCert({
      subjectName: 'example.com',
      issuerName: 'emSign ECC Root CA - G3',
    }))).toBe(true)
    expect(isCompromisedEmudhraCertificate(fakeCert({
      subjectName: 'example.com',
      issuerName: 'emSign Root CA - G3',
    }))).toBe(true)
  })

  test('Given 大小写混合或含 eMudhra/emSign 字样 When 判定 Then 不区分大小写命中', () => {
    expect(isCompromisedEmudhraCertificate(fakeCert({
      subjectName: 'CN=eMudhra敦煌中间CA',
      issuerName: 'emsign root ca - g3',
    }))).toBe(true)
    expect(isCompromisedEmudhraCertificate(fakeCert({
      subjectName: 'site',
      issuerName: 'EMSIGN ECC ROOT CA - G3',
    }))).toBe(true)
  })

  test('Given 叶子证书由泄露中间 CA 签发（多级链）When 遍历 issuerCert Then 命中', () => {
    const leaf = fakeCert({
      subjectName: 'bank.example.com',
      issuerName: 'eMudhra TLS Intermediate R3',
      issuerCert: fakeCert({
        subjectName: 'eMudhra TLS Intermediate R3',
        issuerName: 'emSign ECC Root CA - G3',
      }),
    })
    expect(isCompromisedEmudhraCertificate(leaf)).toBe(true)
  })

  test('Given 叶子主题名含 emudhra 但签发链为合法 Let\'s Encrypt（事故测试站误伤场景）When 判定 Then 不命中', () => {
    // 2026-10 事件官方测试站 emudhra.we-have-a-problem.com 的真实链形：
    // 叶 ← YR1（Let's Encrypt）← Root YR（ISRG）← ISRG Root X1，链本身完全合法。
    const leaf = fakeCert({
      subjectName: 'CN=emudhra.we-have-a-problem.com',
      issuerName: 'CN=YR1, O=Let\'s Encrypt, C=US',
      issuerCert: fakeCert({
        subjectName: 'CN=YR1, O=Let\'s Encrypt, C=US',
        issuerName: 'CN=Root YR, O=ISRG, C=US',
        issuerCert: fakeCert({
          subjectName: 'CN=Root YR, O=ISRG, C=US',
          issuerName: 'CN=ISRG Root X1, O=Internet Security Research Group, C=US',
        }),
      }),
    })
    expect(isCompromisedEmudhraCertificate(leaf)).toBe(false)
  })

  test('Given 叶子由真实泄露中间 CA（eMudhra BV）签发 When 判定 Then 经 issuerName 命中', () => {
    expect(isCompromisedEmudhraCertificate(fakeCert({
      subjectName: 'phish.example.com',
      issuerName: 'CN=EM DV TLS CA - G3B, O=eMudhra BV, C=NL',
    }))).toBe(true)
  })

  test('Given 干净信任链 When 判定 Then 不命中', () => {
    const clean = fakeCert({
      subjectName: 'www.google.com',
      issuerName: 'GTS Root R1',
      issuerCert: fakeCert({ subjectName: 'GTS Root R1', issuerName: 'GTS Root R1' }),
    })
    expect(isCompromisedEmudhraCertificate(clean)).toBe(false)
    expect(isCompromisedEmudhraCertificate(fakeCert({ subjectName: 'a', issuerName: 'b' }))).toBe(false)
  })

  test('Given 自引用病态链 When 判定 Then 深度上限终止不死循环', () => {
    const loop = fakeCert({ subjectName: 'x', issuerName: 'DigiCert Root' }) as Certificate
    ;(loop as unknown as { issuerCert?: Certificate }).issuerCert = loop
    expect(isCompromisedEmudhraCertificate(loop)).toBe(false)
  })
})

describe('临时放行登记生命周期', () => {
  test('Given 放行后 When 查询 Then 会话+域名命中；其他域名/会话不命中', () => {
    resetCertSecurityStateForTest()
    allowDomainTemporarily('s1', 'tab1', 'Compromised.Example.com')
    expect(isDomainTemporarilyAllowed('s1', 'compromised.example.com')).toBe(true)
    expect(isDomainTemporarilyAllowed('s1', 'other.example.com')).toBe(false)
    expect(isDomainTemporarilyAllowed('s2', 'compromised.example.com')).toBe(false)
  })

  test('Given 关闭标签页 When 撤销 Then 该标签放行失效（决策：关标签即失效）', () => {
    resetCertSecurityStateForTest()
    allowDomainTemporarily('s1', 'tab1', 'a.example.com')
    allowDomainTemporarily('s1', 'tab2', 'a.example.com')
    revokeTabGrants('s1', 'tab1')
    expect(isDomainTemporarilyAllowed('s1', 'a.example.com')).toBe(true)
    revokeTabGrants('s1', 'tab2')
    expect(isDomainTemporarilyAllowed('s1', 'a.example.com')).toBe(false)
  })

  test('Given 会话销毁 When 清空 Then 整会话放行失效', () => {
    resetCertSecurityStateForTest()
    allowDomainTemporarily('s1', 'tab1', 'a.example.com')
    wipeSessionGrants('s1')
    expect(isDomainTemporarilyAllowed('s1', 'a.example.com')).toBe(false)
  })
})

describe('证书校验四分支判定（顺序即安全）', () => {
  test('Given 外网命中泄露链且未放行 When 判定 Then 拒绝并登记阻断信息', () => {
    resetCertSecurityStateForTest()
    const decision = decideCertificateVerification({
      url: 'https://target.example.com/',
      errorCode: 0,
      certificate: fakeCert({ subjectName: 'target.example.com', issuerName: 'emSign ECC Root CA - G3' }),
      sessionId: 's1',
    })
    expect(decision.verdict).toBe(CERT_VERIFY_REJECT)
    expect(decision.recordBlocked?.hostname).toBe('target.example.com')
    expect(decision.recordBlocked?.issuerName).toBe('emSign ECC Root CA - G3')
  })

  test('Given 外网命中泄露链但已临时放行 When 判定 Then 接受且不登记', () => {
    resetCertSecurityStateForTest()
    allowDomainTemporarily('s1', 'tab1', 'target.example.com')
    const decision = decideCertificateVerification({
      url: 'https://target.example.com/',
      errorCode: 0,
      certificate: fakeCert({ subjectName: 't', issuerName: 'emSign Root CA - G3' }),
      sessionId: 's1',
    })
    expect(decision.verdict).toBe(CERT_VERIFY_ACCEPT)
    expect(decision.recordBlocked).toBeUndefined()
  })

  test('Given 校内域名未命中泄露链且证书校验失败 When 判定 Then 放行（内网非标证书现状）', () => {
    const decision = decideCertificateVerification({
      url: 'https://jw.cdut.edu.cn/jsxsd/framework/xsMainV.htmlx',
      errorCode: -202,
      certificate: fakeCert({ subjectName: 'jw.cdut.edu.cn', issuerName: 'CDUT Internal CA' }),
      sessionId: 's1',
    })
    expect(decision.verdict).toBe(CERT_VERIFY_ACCEPT)
  })

  test('Given 校内域名命中泄露链 When 判定 Then 依然拒绝（顺序即安全红线）', () => {
    resetCertSecurityStateForTest()
    const decision = decideCertificateVerification({
      url: 'https://jw.cdut.edu.cn/',
      errorCode: 0,
      certificate: fakeCert({ subjectName: 'jw.cdut.edu.cn', issuerName: 'emSign ECC Root CA - G3' }),
      sessionId: 's1',
    })
    expect(decision.verdict).toBe(CERT_VERIFY_REJECT)
    expect(decision.recordBlocked).toBeDefined()
  })

  test('Given 外网正常受信证书 When 判定 Then 接受', () => {
    const decision = decideCertificateVerification({
      url: 'https://api.deepseek.com/',
      errorCode: 0,
      certificate: fakeCert({ subjectName: 'api.deepseek.com', issuerName: "DigiCert Global G3" }),
      sessionId: 's1',
    })
    expect(decision.verdict).toBe(CERT_VERIFY_ACCEPT)
  })

  test('Given 误伤场景（主题含 emudhra 的合法 LE 链、errorCode=0）When 判定 Then 接受', () => {
    const decision = decideCertificateVerification({
      url: 'https://emudhra.we-have-a-problem.com/',
      errorCode: 0,
      certificate: fakeCert({
        subjectName: 'CN=emudhra.we-have-a-problem.com',
        issuerName: 'CN=YR1, O=Let\'s Encrypt, C=US',
      }),
      sessionId: 's1',
    })
    expect(decision.verdict).toBe(CERT_VERIFY_ACCEPT)
  })

  test('Given 外网非泄露链校验失败 When 判定 Then 按原错误码拒绝（维持默认）', () => {
    const decision = decideCertificateVerification({
      url: 'https://expired.example.com/',
      errorCode: -201,
      certificate: fakeCert({ subjectName: 'expired.example.com', issuerName: 'Some CA' }),
      sessionId: 's1',
    })
    expect(decision.verdict).toBe(-201)
  })
})

describe('阻断登记', () => {
  test('Given 登记后 When 查询 Then 大小写不敏感命中', () => {
    resetCertSecurityStateForTest()
    recordCertBlocked('s1', {
      url: 'https://mitm.example.com/',
      hostname: 'mitm.example.com',
      issuerName: 'emSign ECC Root CA - G3',
      subjectName: 'mitm.example.com',
      blockedAt: 1_760_000_000_000,
    })
    expect(getCertBlockedRecord('s1', 'MITM.Example.COM')?.issuerName).toBe('emSign ECC Root CA - G3')
    expect(getCertBlockedRecord('s2', 'mitm.example.com')).toBeUndefined()
  })
})

describe('安全插页 HTML', () => {
  const certInfo = { issuerName: 'emSign ECC Root CA - G3', subjectName: 'phish.example.com' }

  test('Given 阻断信息 When 生成插页 Then 含主机、签发者、事件背景与双按钮哨兵', () => {
    const html = buildSecurityInterstitialHtml('https://phish.example.com/path', certInfo)
    expect(html).toContain('phish.example.com')
    expect(html).toContain('emSign ECC Root CA - G3')
    expect(html).toContain('d &lt; 256')
    expect(html).toContain('中间人劫持')
    expect(html).toContain(BROWSER_CERT_INTERSTITIAL_ALLOW_URL)
    expect(html).toContain(BROWSER_CERT_INTERSTITIAL_BACK_URL)
    expect(html).toContain('返回安全页面')
    expect(html).toContain('我已知晓风险，忽略并继续访问')
  })

  test('Given 恶意构造的站点字段 When 生成插页 Then HTML 已转义防注入', () => {
    const html = buildSecurityInterstitialHtml('https://evil.example.com/', {
      issuerName: '<script>alert(1)</script>',
      subjectName: '" onmouseover="alert(1)',
    })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  test('Given 畸形 URL When 生成插页 Then 不抛异常并原样展示', () => {
    expect(buildSecurityInterstitialHtml('not-a-url', certInfo)).toContain('not-a-url')
  })
})
