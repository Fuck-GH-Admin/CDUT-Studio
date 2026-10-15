/**
 * Node 专用 `node:zlib` 在**浏览器构建**里的替身。
 *
 * 为什么需要：`@profer/core` 的 PDF/Office 解析引擎依赖 Node 原生 `node:zlib`
 * （如 `inflateRawSync` 解析 ZIP 中央目录）。这些引擎只应由主进程通过 subpath
 * 消费；渲染进程绝不承担文档解析职责。
 *
 * 但若未来某个第三方库在深层依赖里 `import { inflateRawSync } from 'node:zlib'`，
 * Vite 会把它替换成「访问即抛异常」的浏览器外部化 Stub，导致模块求值阶段（首屏
 * import 时）直接崩溃、白屏假死。这里给出显式替身：**构建期可解析、import 期不抛错**，
 * 只有在真被调用时才抛出可读错误，避免构建被打挂、又不会静默产出错误结果。
 *
 * 由 vite.config.ts 的 resolve.alias 挂上（同时覆盖 `node:zlib` 与 `zlib`）。
 */
function unavailable(): never {
  throw new Error(
    '渲染进程不应调用 Node zlib（node:zlib）；文档解析等逻辑必须留在主进程，请检查 vite.config.ts 的别名配置',
  )
}

export const inflateSync = unavailable
export const inflateRawSync = unavailable
export const deflateSync = unavailable
export const deflateRawSync = unavailable
export const gzipSync = unavailable
export const gunzipSync = unavailable
export const unzipSync = unavailable
export const inflate = unavailable
export const inflateRaw = unavailable
export const deflate = unavailable
export const deflateRaw = unavailable
export const gzip = unavailable
export const gunzip = unavailable
export const unzip = unavailable
export const createInflate = unavailable
export const createInflateRaw = unavailable
export const createDeflate = unavailable
export const createDeflateRaw = unavailable
export const createGzip = unavailable
export const createGunzip = unavailable

export const constants = {}

export default {
  inflateSync,
  inflateRawSync,
  deflateSync,
  deflateRawSync,
  gzipSync,
  gunzipSync,
  unzipSync,
  inflate,
  inflateRaw,
  deflate,
  deflateRaw,
  gzip,
  gunzip,
  unzip,
  createInflate,
  createInflateRaw,
  createDeflate,
  createDeflateRaw,
  createGzip,
  createGunzip,
  constants,
}
