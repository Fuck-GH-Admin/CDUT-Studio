/**
 * 智联万站指纹伪装注入脚本（纯模块，无 Electron 依赖）
 *
 * 该模块由 `yanhu-preload.ts` 消费：独立 Preload 在已实例化视图中以「最早时序」注入主世界。
 *
 * 说明：`navigator.webdriver` 的原生抹除改由 Chromium C++ 引擎级启动开关权威完成，
 * 故本脚本不再做 CDP document-start 注入，也不再进行 JS 原型链劫持。
 *
 * 脚本必须幂等（可重复安全执行）且全程 try/catch 兜底，绝不因注入失败影响页面加载。
 */

/**
 * 构建防侦测注入脚本源码字符串。
 *
 * 核心设计原则（零黑魔法与原生原型链保护）：
 *   1. 原生环境保障：`navigator.webdriver` 的原生抹除已改由 Chromium C++ 引擎级启动开关
 *      （`--disable-blink-features=AutomationControlled`）权威完成，访问器为真实 `[native code]`；
 *   2. 原生对象保护：Chromium 原生已提供真实的 `PluginArray` (5 plugins)、`MimeTypeArray`、
 *      `window.chrome` 与宿主语言环境。严禁通过 JS 原型链劫持伪造 plugins/mimeTypes/languages，
 *      否则会导致 `instanceof PluginArray` 失败、访问器非 `[native code]`，遭瑞数 5/6 动态 VM 识破
 *      并使服务端 WAF 拒止连接（返回 HTTP 400 空包）；
 *   3. 防泄漏兜底：确保极端情况下不暴露 Node.js 运行时特权对象（process / require / module）。
 */
export function buildYanhuFingerprintScript(): string {
  return `;(function () {
  'use strict';
  try {
    if (typeof window !== 'undefined') {
      try { delete window.process; } catch (e) {}
      try { delete window.require; } catch (e) {}
      try { delete window.module; } catch (e) {}
    }
  } catch (e) {}
})();`
}

