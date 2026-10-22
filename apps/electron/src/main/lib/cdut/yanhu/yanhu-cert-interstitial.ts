/**
 * 智联万站 · 证书阻断插页纯逻辑（可被 Bun 直接单测）
 *
 * 阻断记录由会话 verifyProc 在拒绝 eMudhra 泄露链证书时写入（见 security/cert-blacklist.ts），
 * 本模块只负责「本次实际请求 URL → 主机 → 阻断登记」的纯解析，不做任何 Electron 运行时调用。
 */

import type { CertBlockedRecord } from '../../security/cert-blacklist'

/** 命中阻断登记时的插页上下文 */
export interface YanhuCertBlockTarget {
  /** 已小写化的目标主机名 */
  hostname: string
  /** verifyProc 写入的阻断登记（含证书主题/签发者，供插页展示） */
  record: CertBlockedRecord
}

/**
 * 依据本次主框架请求的 URL 查询证书阻断登记。
 *
 * 注意：必须传入「真实请求目标」（含路径与查询参数的原始 URL），
 * 而非 verifyProc 登记的 `https://<hostname>/` 伪地址，否则临时放行时无法复原原页面。
 */
export function resolveYanhuCertBlockTarget(
  requestedUrl: string | null | undefined,
  lookup: (hostname: string) => CertBlockedRecord | undefined,
): YanhuCertBlockTarget | null {
  if (!requestedUrl) return null
  let hostname: string
  try {
    hostname = new URL(requestedUrl).hostname.toLowerCase()
  } catch {
    return null
  }
  if (!hostname) return null
  const record = lookup(hostname)
  return record ? { hostname, record } : null
}
