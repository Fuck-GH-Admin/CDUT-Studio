/**
 * CSLab uv 非官方指纹安装的用户确认与审计
 *
 * 设计：
 * 1. 不静态 import electron，避免 Bun 单测在导入链上加载 electron；
 * 2. 只有「镜像自证一致但无官方指纹」才允许用户确认，哈希不符不会走到这里；
 * 3. 允许与拒绝都写入 `tools/uv/install-audit.jsonl`，写盘失败不影响安装结果。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { getConfigDir } from '../config-paths'

export interface UvInstallAuditEntry {
  asset: string
  source: string
  sha256: string
  verdict: string
  decision: 'auto' | 'allowed' | 'declined'
}

const AUDIT_DIR_NAME = 'uv'
const AUDIT_FILE_NAME = 'install-audit.jsonl'

/** 同进程内串行追加，保证审计行序与安装顺序一致。 */
let auditQueue: Promise<void> = Promise.resolve()

/** 追加一条 uv 安装审计；内部吞掉写盘异常。 */
export function appendUvInstallAudit(entry: UvInstallAuditEntry): Promise<void> {
  const record = { at: new Date().toISOString(), ...entry }
  auditQueue = auditQueue
    .then(async () => {
      const dir = join(getConfigDir(), 'tools', AUDIT_DIR_NAME)
      await fs.mkdir(dir, { recursive: true })
      await fs.appendFile(join(dir, AUDIT_FILE_NAME), `${JSON.stringify(record)}\n`, 'utf-8')
    })
    .catch((error: unknown) => {
      console.warn('[CSLab] uv 安装审计写入失败:', error)
    })
  return auditQueue
}

/**
 * 非官方指纹安装确认：弹出原生警告框，默认按钮为「取消安装」。
 * 返回 true 表示用户明确选择继续安装。
 */
export async function confirmUvUntrustedInstall(info: {
  asset: string
  sourceUrl: string
  actualSha256: string
}): Promise<boolean> {
  const { dialog, BrowserWindow } = await import('electron')
  const options = {
    type: 'warning' as const,
    buttons: ['取消安装', '仍然信任并安装'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'uv 组件来源校验',
    message: 'uv 二进制未通过官方指纹验证',
    detail: [
      `资产：${info.asset}`,
      `来源：${info.sourceUrl}`,
      `SHA-256：${info.actualSha256}`,
      '',
      '该文件来自非官方镜像，未通过官方指纹验证，请确认来源可信后再继续。',
      '选择「取消安装」将放弃本次下载，并回退到系统 Python。',
    ].join('\n'),
  }

  const window = BrowserWindow.getFocusedWindow()
  const result = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options)
  const allowed = result.response === 1

  await appendUvInstallAudit({
    asset: info.asset,
    source: info.sourceUrl,
    sha256: info.actualSha256,
    verdict: 'mirror-consent',
    decision: allowed ? 'allowed' : 'declined',
  })

  return allowed
}
