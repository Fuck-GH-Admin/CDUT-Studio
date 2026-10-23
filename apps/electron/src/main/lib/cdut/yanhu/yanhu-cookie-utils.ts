/**
 * 智联万站 · 瑞数动态签名 Cookie 清洗工具
 *
 * 根因诊断（详见 AGENTS.md 3.6）：
 *   校内青果教务等系统部署了瑞数（RuiShu）动态安全 WAF，采用
 *   「服务端会话 Cookie（以 O 结尾，如 sMLAeTqisZbFO）+ 客户端页面级动态签名
 *   Cookie（以 P 结尾，如 sMLAeTqisZbFP）」双轨校验。
 *   持久化分区 `persist:cdut-auth-zone` 会把上一轮页面签发、绑定前序路径与时钟的
 *   *P 签名留存下来；当发起一次全新的顶层导航时，Chromium 原生网络栈会连同这枚
 *   已失效的 *P 一并发出，瑞数网关判定签名被篡改，直接返回 HTTP 400 Bad Request
 *   （空响应体），页面白屏且瑞数客户端 JS 无从注入更新 *P，形成刷新死锁。
 *
 * 解法：在导航/请求发出前剔除成对出现的陈旧 *P，仅保留会话 O 与 JSESSIONID；
 *       网关放行后由服务端按会话 Cookie 正常响应，并交回瑞数 JS 重新签发 *P。
 *
 * 范围声明：本模块纯粹操作 Cookie，不加载页面、不持有窗口、不产生其它副作用。
 */

import type { Session } from 'electron'

/** 瑞数动态签名默认目标域（青果教务系统） */
export const DEFAULT_RUISHU_DOMAIN = 'jw.cdut.edu.cn'

/**
 * 剔除指定域下所有「陈旧」的瑞数 *P 动态签名。
 *
 * 识别规则：仅当存在同前缀的 *O 会话 Cookie 时，才判定该 *P 为瑞数成对签名并剔除；
 * 绝不触碰 JSESSIONID、SERVERID、themeSkinColor 等普通业务 Cookie。
 *
 * @param ses 目标会话（必须是携带校内 Cookie 的专属分区 Session）
 * @param domain 目标域（默认 jw.cdut.edu.cn）
 * @returns 实际剔除的 *P 数量；任何异常均静默吞掉并返回 0，绝不抛出。
 */
export async function stripStaleRuiShuCookies(
  ses: Session,
  domain: string = DEFAULT_RUISHU_DOMAIN,
): Promise<number> {
  try {
    const cookies = await ses.cookies.get({ domain })
    const names = new Set(cookies.map((c) => c.name))
    let removed = 0
    for (const c of cookies) {
      // 瑞数成对签名特征：以 P 结尾的动态签名，且存在同前缀以 O 结尾的会话 Cookie
      if (!c.name.endsWith('P') || !names.has(c.name.slice(0, -1) + 'O')) continue

      // Chromium 依据 RFC 6265 按「域 + 路径」匹配删除，URL 隐式路径必须与 Cookie 作用域一致
      const cookieDomain = c.domain?.replace(/^\./, '') || domain
      const rawPath = c.path || '/'
      const cookiePath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
      // 青果网关存在 /、/jsxsd、/jsxsd/ 三种作用域写法，逐一兜底并去重
      const candidatePaths = new Set([cookiePath, '/jsxsd/', '/jsxsd'])

      let removedThisCookie = false
      for (const path of candidatePaths) {
        for (const protocol of ['https', 'http'] as const) {
          try {
            await ses.cookies.remove(`${protocol}://${cookieDomain}${path}`, c.name)
            removedThisCookie = true
            break
          } catch {
            // 当前协议/路径不匹配，继续尝试下一组合
          }
        }
        if (removedThisCookie) break
      }

      if (removedThisCookie) {
        removed += 1
      } else {
        console.warn(
          `[瑞数Cookie清洗] 删除失败: domain=${cookieDomain} path=${cookiePath} name=${c.name}`,
        )
      }
    }
    return removed
  } catch {
    return 0
  }
}
