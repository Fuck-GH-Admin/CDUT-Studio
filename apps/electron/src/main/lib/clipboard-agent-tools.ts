/**
 * Agent 系统剪贴板工具服务
 *
 * 提供 `clipboard_write_text` 的正规主进程实现，底层用 Electron `clipboard`
 * （UTF-8，天然无 Windows 代码页乱码问题）。
 *
 * 安全红线（Bug 19，**推翻此前「完全放开」的旧决策**）：
 * **Agent 严禁读取系统剪贴板**。剪贴板内容只能由用户显式粘贴或前台操作提供，
 * 因此本模块不提供读取能力，`clipboard_read_text` 在工具层硬拦截返回
 * `CLIPBOARD_READ_BLOCKED`。写入不构成信息窃取，保留能力。
 */

import { clipboard } from 'electron'

/** 单次写剪贴板的字符上限，防止超大内容影响输出与内存。 */
export const MAX_CLIPBOARD_TEXT_CHARS = 64_000

export class ClipboardAgentToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClipboardAgentToolError'
  }
}

/** 带上限的写剪贴板文本；空输入或超长抛错。 */
export function writeClipboardText(text: string): { writtenChars: number } {
  if (!text) throw new ClipboardAgentToolError('要写入剪贴板的文本不能为空。')
  const charCount = Array.from(text).length
  if (charCount > MAX_CLIPBOARD_TEXT_CHARS) {
    throw new ClipboardAgentToolError(`文本超过 ${MAX_CLIPBOARD_TEXT_CHARS} 个字符上限，请先精简后再写入剪贴板。`)
  }
  clipboard.writeText(text)
  return { writtenChars: charCount }
}
