/**
 * eMudhra 泄露证书链拦截与内置浏览器安全插页
 * （2026 年 10 月全球 PKI 信任链事件专项防御）
 *
 * 事件背景：eMudhra CA 的 8 张中间证书因签发仪式失误，私钥被配置为极小整数
 * （RSA d < 256），可被暴力分解破解。持有这些弱私钥的攻击者可伪造任意站点
 * 证书实施中间人劫持（MitM）、流量窃听与内容篡改。
 *
 * 防御语义（顺序即安全）：
 * 1. 证书链任一级命中 eMudhra/emSign 泄露特征 → 拒绝。此判定严格先于校内域名
 *    豁免——`*.cdut.edu.cn` 命中泄露链同样拒止，绝不静默放行；
 * 2. 校内非标证书（未命中泄露链）→ 维持现有放行现状，保障教务链路；
 * 3. 正常受信证书（errorCode === 0）→ 维持默认接受；
 * 4. 其余校验失败 → 维持默认拒绝。
 *
 * 实现分层：判定/登记/插页生成为纯逻辑（Electron 类型仅 `import type`），
 * 仅 `installCertificateSecurityPolicy` 触碰运行时，保证普通 Bun 测试可直跑。
 */

import type { Certificate, Session } from 'electron'

import { BROWSER_CERT_INTERSTITIAL_ALLOW_URL as SENTINEL_ALLOW_URL, BROWSER_CERT_INTERSTITIAL_BACK_URL as SENTINEL_BACK_URL } from '@profer/shared'

import { isCdutDomain } from '../cdut/yanhu/yanhu-domain-gatekeeper'

// ---------------------------------------------------------------------------
// eMudhra 泄露链特征判定
// ---------------------------------------------------------------------------

/** 已确认泄露的 eMudhra/emSign 根/中间 CA 精确 CN（小写） */
const EMUDHRA_COMPROMISED_EXACT_CNS = new Set([
  'emsign ecc root ca - g3',
  'emsign root ca - g3',
])

/** 证书链遍历深度上限：防病态自引用环导致死循环 */
const MAX_CERT_CHAIN_DEPTH = 8

/** 对 CA 名称做泄露特征匹配（仅用于各级 issuerName，见 isCompromisedEmudhraCertificate 注释）。 */
function matchesCompromisedIssuerName(name: string | undefined): boolean {
  if (!name) return false
  const lowered = name.toLowerCase()
  return EMUDHRA_COMPROMISED_EXACT_CNS.has(lowered)
    || lowered.includes('emudhra')
    || lowered.includes('emsign')
}

/**
 * 判定证书链上任一级是否命中 eMudhra 泄露特征。
 * 迭代遍历完整 issuerCert 链（含深度上限），杜绝多层中间 CA 穿透。
 *
 * 仅匹配各级 issuerName、不匹配 subjectName：中间 CA 的 subject DN 会原样作为
 * 下级证书的 issuerName 出现，仅遍历 issuerName 即可覆盖全链（含自签名根的
 * issuerName === subjectName 情形）。叶子证书的 subjectName 由站点方任意命名，
 * 攻击者伪造的钓鱼站不会叫 "eMudhra"，反而会与合法域名（如 2026-10 事件官方
 * 测试站 emudhra.we-have-a-problem.com，其签发链为正常 Let's Encrypt）撞名，
 * 参与匹配只会产生假阳性，无防御增益。
 */
export function isCompromisedEmudhraCertificate(cert: Certificate): boolean {
  let current: Certificate | undefined = cert
  for (let depth = 0; current && depth < MAX_CERT_CHAIN_DEPTH; depth++) {
    if (matchesCompromisedIssuerName(current.issuerName)) {
      return true
    }
    const next: Certificate | undefined = current.issuerCert
    if (!next || next === current) break
    current = next
  }
  return false
}

// ---------------------------------------------------------------------------
// 内存态临时放行登记（会话 × 标签页 × 域名）
// ---------------------------------------------------------------------------

/** sessionId -> hostname -> 持有放行授权的 tabId 集合 */
const temporaryGrants = new Map<string, Map<string, Set<string>>>()

/** 用户在插页选择「忽略并继续访问」后登记临时放行；仅内存态，重启即失效。 */
export function allowDomainTemporarily(sessionId: string, tabId: string, hostname: string): void {
  const host = hostname.toLowerCase()
  let byHost = temporaryGrants.get(sessionId)
  if (!byHost) {
    byHost = new Map()
    temporaryGrants.set(sessionId, byHost)
  }
  let tabIds = byHost.get(host)
  if (!tabIds) {
    tabIds = new Set()
    byHost.set(host, tabIds)
  }
  tabIds.add(tabId)
}

/**
 * 查询域名是否已被当前会话临时放行。verifyProc 无标签页上下文，
 * 故任一标签持有授权即放行（已知边界：同会话同域名的其他标签页一并受益）。
 */
export function isDomainTemporarilyAllowed(sessionId: string, hostname: string): boolean {
  return temporaryGrants.get(sessionId)?.get(hostname.toLowerCase())?.size ? true : false
}

/** 关闭标签页时撤销该标签的全部临时放行（决策：关标签页即失效）。 */
export function revokeTabGrants(sessionId: string, tabId: string): void {
  const byHost = temporaryGrants.get(sessionId)
  if (!byHost) return
  for (const [host, tabIds] of byHost) {
    tabIds.delete(tabId)
    if (tabIds.size === 0) byHost.delete(host)
  }
  if (byHost.size === 0) temporaryGrants.delete(sessionId)
}

/** 会话销毁/应用重启时清空该会话全部临时放行。 */
export function wipeSessionGrants(sessionId: string): void {
  temporaryGrants.delete(sessionId)
}

/** 测试专用：清空全部内存态登记。 */
export function resetCertSecurityStateForTest(): void {
  temporaryGrants.clear()
  blockedCertRecords.clear()
}

// ---------------------------------------------------------------------------
// 阻断登记（供 did-fail-load 判定是否展示插页）
// ---------------------------------------------------------------------------

export interface CertBlockedRecord {
  url: string
  hostname: string
  issuerName: string
  subjectName: string
  blockedAt: number
}

const blockedCertRecords = new Map<string, Map<string, CertBlockedRecord>>()

export function recordCertBlocked(sessionId: string, record: CertBlockedRecord): void {
  let byHost = blockedCertRecords.get(sessionId)
  if (!byHost) {
    byHost = new Map()
    blockedCertRecords.set(sessionId, byHost)
  }
  byHost.set(record.hostname.toLowerCase(), record)
}

export function getCertBlockedRecord(sessionId: string, hostname: string): CertBlockedRecord | undefined {
  return blockedCertRecords.get(sessionId)?.get(hostname.toLowerCase())
}

// ---------------------------------------------------------------------------
// 纯逻辑判定核心（verifyProc 的可测试形态）
// ---------------------------------------------------------------------------

/** Electron setCertificateVerifyProc 约定：0 = 接受，负数 = 拒绝（-2 = ERR_FAILED）。 */
export const CERT_VERIFY_ACCEPT = 0
export const CERT_VERIFY_REJECT = -2

export interface CertVerifyDecision {
  verdict: number
  /** 命中泄露链且被拒绝时携带阻断信息，供登记与插页展示 */
  recordBlocked?: Omit<CertBlockedRecord, 'blockedAt'>
}

export interface CertVerifyInput {
  /**
   * 目标 URL。Electron verifyProc 的 request 只暴露 `hostname`（无协议与路径），
   * 装配层统一以 `https://<hostname>/` 伪 URL 传入：isCdutDomain 只需真实 hostname，
   * 插页展示只取 host，均不受协议/路径缺失影响。
   */
  url: string
  errorCode: number
  certificate: Certificate
  sessionId: string
}

function extractHostname(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/**
 * 证书校验四分支判定（顺序即安全）：
 * 1. 命中 eMudhra 泄露链 → 已临时放行则接受，否则拒绝并登记阻断；
 * 2. 校内域名（未命中泄露链）→ 放行（维持内网非标证书现状）；
 * 3. 正常受信证书（errorCode === 0）→ 接受；
 * 4. 其余校验失败 → 按原错误码拒绝。
 */
export function decideCertificateVerification(input: CertVerifyInput): CertVerifyDecision {
  const { url, errorCode, certificate, sessionId } = input
  const hostname = extractHostname(url)

  if (isCompromisedEmudhraCertificate(certificate)) {
    if (isDomainTemporarilyAllowed(sessionId, hostname)) {
      return { verdict: CERT_VERIFY_ACCEPT }
    }
    return {
      verdict: CERT_VERIFY_REJECT,
      recordBlocked: {
        url,
        hostname,
        issuerName: certificate.issuerName || '',
        subjectName: certificate.subjectName || '',
      },
    }
  }

  if (isCdutDomain(url)) return { verdict: CERT_VERIFY_ACCEPT }
  if (errorCode === 0) return { verdict: CERT_VERIFY_ACCEPT }
  return { verdict: errorCode || CERT_VERIFY_REJECT }
}

// ---------------------------------------------------------------------------
// Electron 会话装配
// ---------------------------------------------------------------------------

const policyInstalledSessions = new WeakSet<Session>()

/** 缺省登记键：defaultSession 与未显式分配会话 id 的分区共用。 */
const DEFAULT_CERT_SECURITY_SESSION = 'default'

/**
 * 在会话上安装证书安全策略（幂等）。重复调用安全，供主进程多处装配。
 * 注意：一旦安装，该会话的 `certificate-error` 事件链路即被本 proc 接管。
 */
export function installCertificateSecurityPolicy(ses: Session, sessionId?: string): void {
  if (policyInstalledSessions.has(ses)) return
  policyInstalledSessions.add(ses)
  const effectiveSessionId = sessionId ?? DEFAULT_CERT_SECURITY_SESSION
  ses.setCertificateVerifyProc((request, callback) => {
    const decision = decideCertificateVerification({
      // verifyProc 的 request 仅含 hostname；统一补伪协议供 isCdutDomain / 插页展示解析。
      url: `https://${request.hostname}/`,
      errorCode: request.errorCode,
      certificate: request.certificate,
      sessionId: effectiveSessionId,
    })
    if (decision.recordBlocked) {
      recordCertBlocked(effectiveSessionId, { ...decision.recordBlocked, blockedAt: Date.now() })
    }
    callback(decision.verdict)
  })
}

// ---------------------------------------------------------------------------
// 内置浏览器安全插页
// ---------------------------------------------------------------------------

export interface InterstitialCertInfo {
  issuerName: string
  subjectName: string
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function displayHost(blockedUrl: string): string {
  try {
    return new URL(blockedUrl).host || blockedUrl
  } catch {
    return blockedUrl
  }
}

/**
 * 生成内置浏览器安全警告插页（现代红色盾牌卡片，深浅主题自适应）。
 * 按钮以标准 HTTPS 伪哨兵回投主进程（规避 data: opaque 源向自定义 scheme
 * 顶层导航被 Chromium 静默丢弃的风险），location.href 失败回退 window.open。
 */
export function buildSecurityInterstitialHtml(
  blockedUrl: string,
  certInfo: InterstitialCertInfo,
): string {
  const host = escapeHtml(displayHost(blockedUrl))
  const issuer = escapeHtml(certInfo.issuerName || '未知签发者')
  const subject = escapeHtml(certInfo.subjectName || '未知站点')
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>连接已被安全策略拦截</title>
<style>
  :root {
    --page-bg: #f6f7f9; --card-bg: #ffffff; --text: #1a1d21; --text-sub: #5c6470;
    --danger: #d92d20; --danger-soft: #fef3f2; --danger-line: #fecdca;
    --btn-ghost-bg: #ffffff; --btn-ghost-line: #d0d5dd; --shadow: 0 8px 32px rgba(16,24,40,.12);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --page-bg: #101318; --card-bg: #1a1f26; --text: #f2f4f7; --text-sub: #98a2b3;
      --danger: #f97066; --danger-soft: #2a1512; --danger-line: #5c2a24;
      --btn-ghost-bg: #1a1f26; --btn-ghost-line: #344054; --shadow: 0 8px 32px rgba(0,0,0,.5);
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    background: var(--page-bg); color: var(--text);
    display: flex; align-items: center; justify-content: center; padding: 24px;
  }
  .card {
    width: 100%; max-width: 560px; background: var(--card-bg); border-radius: 16px;
    box-shadow: var(--shadow); padding: 40px 36px 32px;
  }
  .shield {
    width: 56px; height: 56px; border-radius: 14px; background: var(--danger-soft);
    display: flex; align-items: center; justify-content: center; margin-bottom: 20px;
  }
  .shield svg { width: 30px; height: 30px; fill: var(--danger); }
  h1 { font-size: 20px; font-weight: 700; line-height: 1.4; margin-bottom: 10px; }
  .host { color: var(--danger); font-weight: 600; word-break: break-all; }
  p { font-size: 13.5px; line-height: 1.75; color: var(--text-sub); margin-bottom: 12px; }
  .banner {
    background: var(--danger-soft); border: 1px solid var(--danger-line); border-radius: 10px;
    padding: 12px 14px; font-size: 12.5px; line-height: 1.7; color: var(--text-sub); margin: 16px 0;
  }
  .banner strong { color: var(--danger); }
  .meta { font-size: 12px; color: var(--text-sub); border-top: 1px solid var(--btn-ghost-line); padding-top: 14px; margin-top: 4px; }
  .meta div { margin-top: 4px; word-break: break-all; }
  .actions { display: flex; gap: 12px; margin-top: 24px; }
  button {
    flex: 1; padding: 11px 16px; border-radius: 10px; font-size: 13.5px; font-weight: 600;
    cursor: pointer; border: 1px solid transparent; transition: filter .15s ease;
  }
  button:hover { filter: brightness(.96); }
  .back { background: var(--btn-ghost-bg); border-color: var(--btn-ghost-line); color: var(--text); }
  .proceed { background: var(--danger); color: #fff; }
</style>
</head>
<body>
<div class="card">
  <div class="shield" aria-hidden="true">
    <svg viewBox="0 0 24 24"><path d="M12 1.7 3.8 5v6.1c0 5.1 3.4 9.9 8.2 11.2 4.8-1.3 8.2-6.1 8.2-11.2V5L12 1.7zm3.6 8.1-4.6 5.6a1 1 0 0 1-1.5.06L7.3 13.3l1.3-1.4 1.5 1.5 3.9-4.8 1.6 1.2z"/></svg>
  </div>
  <h1>您的连接存在重大安全隐患</h1>
  <p>站点 <span class="host">${host}</span> 的证书属于 <strong>eMudhra/emSign 弱密钥信任链</strong>，CDUT Studio 已依据 2026 年 10 月全球 PKI 信任链事件防御策略拦截本次连接。</p>
  <div class="banner">
    <strong>事件背景：</strong>eMudhra CA 的 8 张中间证书因签发仪式失误，私钥被配置为极小整数（RSA d &lt; 256），可在极短时间内被暴力分解破解。攻击者持有这些弱私钥即可伪造任意站点证书。<br>
    <strong>当前风险：</strong>若继续访问，您的通信可能被中间人劫持（MitM），遭到窃听或内容篡改。
  </div>
  <div class="meta">
    <div>证书主题：${subject}</div>
    <div>签发者：${issuer}</div>
  </div>
  <div class="actions">
    <button type="button" class="back" id="cert-back">返回安全页面</button>
    <button type="button" class="proceed" id="cert-allow">我已知晓风险，忽略并继续访问</button>
  </div>
</div>
<script>
  // 哨兵回投：优先顶层导航（被主进程 will-navigate 拦截，不触网），
  // data: opaque 源下若被 Chromium 策略丢弃则回退 window.open（由 setWindowOpenHandler 拦截）。
  function sendSentinel(url) {
    try { location.href = url } catch (e) { /* 忽略，走回退 */ }
    setTimeout(function () {
      try { window.open(url, '_blank') } catch (e) { /* 双通道均失败时静默终止 */ }
    }, 250)
  }
  document.getElementById('cert-back').addEventListener('click', function () { sendSentinel(${JSON.stringify(SENTINEL_BACK_URL)}) })
  document.getElementById('cert-allow').addEventListener('click', function () { sendSentinel(${JSON.stringify(SENTINEL_ALLOW_URL)}) })
</script>
</body>
</html>`
}
