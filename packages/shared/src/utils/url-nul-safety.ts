/**
 * URL 空字符（NUL）截断防御（CVE-2026-105482 加固）
 *
 * 背景：Node.js（含 Electron 内置 Node）在主机名解析/URL 处理的底层 C 逻辑中
 * 存在 NUL 字符截断缺陷，攻击者可借 `%00` 或裸 `\0` 欺骗 DNS 解析、绕过主机名校验。
 *
 * 策略：在任何 URL 进入「解析 → DNS → 网络」链路之前，对原始串与解析后的
 * hostname 做前置硬校验——命中 NUL、百分号编码 NUL 或其余 C0 控制字符时
 * 直接抛错拒绝，杜绝任何后续处理。
 *
 * 本模块为纯函数、零运行时依赖，主进程与渲染进程共用，可直接在 Bun 测试中验证。
 */

/** C0 控制字符 + DEL（含裸 NUL） */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
/** 百分号编码的控制字符（%00-%1f 与 %7f，大小写不敏感），可能绕过字符串级裸字符检测 */
const ENCODED_CONTROL_CHARS = /%(?:[01][\da-f]|7f)/i

/** 断言错误：URL 含 NUL/控制字符。 */
export class UnsafeUrlCharacterError extends Error {
  constructor(message = 'URL 包含空字符或控制字符，已拒绝处理。') {
    super(message)
    this.name = 'UnsafeUrlCharacterError'
  }
}

/**
 * 校验 URL 不含 NUL 与控制字符，安全则原样返回，否则抛出 UnsafeUrlCharacterError。
 *
 * 双重检查：原始字符串（捕获裸控制字符与编码 NUL）+ 解析后 hostname
 * （捕获 WHATWG URL 解析阶段可能保留的编码残留）。
 */
export function assertSafeUrlNoNul(rawUrl: string): string {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    throw new UnsafeUrlCharacterError('URL 不能为空。')
  }
  if (CONTROL_CHARS.test(rawUrl) || ENCODED_CONTROL_CHARS.test(rawUrl)) {
    throw new UnsafeUrlCharacterError()
  }
  try {
    const parsed = new URL(rawUrl)
    if (CONTROL_CHARS.test(parsed.hostname) || ENCODED_CONTROL_CHARS.test(parsed.hostname)) {
      throw new UnsafeUrlCharacterError()
    }
  } catch (error) {
    if (error instanceof UnsafeUrlCharacterError) throw error
    // 无法解析的 URL 交给调用方的既有解析逻辑处理，本工具只负责字符级防线
  }
  return rawUrl
}
