/**
 * 智联万站安全网关（YanhuDomainGatekeeper）
 *
 * 职责：校验导航目标是否为可访问的 http/https 网页地址，并规范化地址栏输入，
 * 供主进程在 `will-navigate` / `setWindowOpenHandler` / 地址栏导航三处统一裁决。
 *
 * 访问范围：智联万站已解除「仅限成都理工大学校内域名」的限制，站外 http/https
 * 地址一律放行，仅拦截非网页协议（`mailto:` / `javascript:` / `file:` 等）与无法规范化的输入。
 *
 * 范围声明：本模块为纯逻辑，不加载页面、不持有会话；拦截页的渲染由渲染进程承担。
 */

import { isYanhuBlockedUrl } from '@profer/shared'
import { CDUT_DOMAIN_REGEX } from './yanhu-constants'

/**
 * 判定 URL 是否落在成都理工大学校内域名（http/https）。
 *
 * 双重校验：先以正则做快速门禁，再用 URL 解析确认真实 hostname，
 * 杜绝 `evil-cdut.edu.cn.phishing.com` 之类的伪装域误判。
 *
 * 说明：访问范围限制解除后，本函数不再参与放行裁决，仅供「仅校内适用」的
 * 专属逻辑（瑞数 *P 签名清洗、教务主框架路由等）复用。
 */
export function isCdutDomain(rawUrl: string): boolean {
  if (!rawUrl || !CDUT_DOMAIN_REGEX.test(rawUrl)) return false
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return url.hostname === 'cdut.edu.cn' || url.hostname.endsWith('.cdut.edu.cn')
  } catch {
    return false
  }
}

/**
 * 判定 URL 是否为智联万站内部哨兵协议（内置拦截页）。
 * 内部哨兵永远视为「放行」，因为它从不真正发起网络导航，只作为渲染层状态。
 */
export function isInternalYanhuUrl(rawUrl: string): boolean {
  return isYanhuBlockedUrl(rawUrl)
}

/**
 * 判定 URL 是否为可访问的网页地址（http/https）。
 *
 * 以 URL 解析确认真实协议，杜绝 `javascript:` / `file:` / 自定义协议等非网页导航。
 */
export function isWebUrl(rawUrl: string): boolean {
  if (!rawUrl) return false
  try {
    const url = new URL(rawUrl)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 规范化地址栏用户输入。
 *
 * - 已带 http/https 协议：原样返回；
 * - 形如 `bsdt.cdut.edu.cn` / `baidu.com:8080/path`：补全 `https://`；
 * - 其余（纯文本、含空格、非法字符）：返回 null（本浏览器不提供搜索，交由上层忽略）。
 */
export function normalizeInputUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (/^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+(:\d+)?(\/.*)?$/.test(trimmed)) return `https://${trimmed}`
  return null
}

/** 一次导航裁决结果 */
export interface YanhuGatekeeperDecision {
  /** 是否放行 */
  allowed: boolean
  /** 放行时的目标 URL（放行与阻断都回传规范化后的绝对地址） */
  url: string
}

/**
 * 安全网关。
 *
 * 无状态设计（不持有会话/标签），可安全地被多标签、多会话共享调用。
 */
export class YanhuDomainGatekeeper {
  /** 判定 URL 是否允许在智联万站内直接加载（http/https 网页地址或内部哨兵页） */
  public isAllowed(rawUrl: string): boolean {
    return isInternalYanhuUrl(rawUrl) || isWebUrl(rawUrl)
  }

  /** 裁决一次页面导航是否放行 */
  public evaluate(rawUrl: string): YanhuGatekeeperDecision {
    return { allowed: this.isAllowed(rawUrl), url: rawUrl }
  }

  /**
   * 解析地址栏输入并裁决。
   * @returns 输入无法规范化为 URL 时返回 null（上层应忽略该输入）。
   */
  public resolveAddressInput(raw: string): YanhuGatekeeperDecision | null {
    const normalized = normalizeInputUrl(raw)
    if (!normalized) return null
    return this.evaluate(normalized)
  }
}

/** 全局单例（无状态，可直接共享） */
export const yanhuDomainGatekeeper = new YanhuDomainGatekeeper()
