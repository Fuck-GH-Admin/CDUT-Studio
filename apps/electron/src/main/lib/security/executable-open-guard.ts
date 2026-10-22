/**
 * Windows 可执行文件打开确认守卫（CVE-2026-96951 Windows Shell MotW 绕过防御）
 *
 * 背景：Windows Shell 解析器存在 MotW 绕过/命令注入缺陷（2026 年 10 月零日），
 * `shell.openPath` 拉起 `.exe`/`.bat`/`.ps1` 等可执行与脚本文件时会被静默执行。
 *
 * 策略：仅在 Windows 平台生效——所有「用系统默认应用打开文件」入口在放行前，
 * 若目标命中潜在可执行后缀且用户未勾选「不再提醒」，弹出绑定主窗口的模态
 * 确认框。用户的选择持久化到应用设置（`executableOpenWarningDismissed`）。
 *
 * 防挂起三保险：绑定主窗口模态展示；`BUN_TEST` 环境无头拒止；主窗口不可用时
 * 回退无 parent 形式。macOS/Linux 直接放行（决策：仅 Windows 平台生效）。
 */

import { dialog } from 'electron'

import { isPotentiallyExecutableFile } from '@profer/shared'

import { getMainWindow } from '../main-window-state'
import { getSettings, updateSettings } from '../settings-service'

/**
 * 判断是否应弹出可执行文件确认框（纯逻辑，便于测试）。
 * 非 Windows、测试环境、已勾选「不再提醒」、非可执行后缀 → 均不弹。
 */
export function shouldConfirmExecutableOpen(
  absPath: string,
  platform: NodeJS.Platform = process.platform,
  underTest: boolean = Boolean(process.env.BUN_TEST),
  dismissedGetter: () => boolean | undefined = () => getSettings().executableOpenWarningDismissed,
): boolean {
  if (platform !== 'win32') return false
  if (underTest) return false
  if (!isPotentiallyExecutableFile(absPath)) return false
  return dismissedGetter() !== true
}

/**
 * 「用系统默认应用打开文件」前的安全确认。
 * 返回 true = 允许继续调用 shell.openPath；false = 用户取消或环境拒止。
 */
export async function confirmExecutableFileOpen(absPath: string): Promise<boolean> {
  if (!shouldConfirmExecutableOpen(absPath)) return true

  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: '打开可执行文件确认',
    message: '该文件属于可执行文件/脚本，可能对系统带来安全隐患',
    detail: `文件：${absPath}\n\n运行来路不明的可执行文件或脚本，可能被恶意利用。请确认您信任该文件的来源。`,
    buttons: ['取消', '仍要运行'],
    defaultId: 0,
    cancelId: 0,
    checkboxLabel: '不再提醒（对可执行/脚本文件直接放行）',
    checkboxChecked: false,
    noLink: true,
  }

  // 绑定主窗口模态展示（防弹到屏幕角落被遮挡导致用户无感知卡等）；不可用时回退无 parent。
  const mainWindow = getMainWindow()
  const { response, checkboxChecked } = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options)

  if (checkboxChecked) {
    try {
      updateSettings({ executableOpenWarningDismissed: true })
    } catch (error) {
      // 持久化失败不阻塞本次放行决策，仅留痕
      console.warn('[安全] 可执行文件确认「不再提醒」写入失败:', error)
    }
  }
  return response === 1
}
