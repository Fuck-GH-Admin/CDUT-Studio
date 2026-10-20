/**
 * CSLab 主进程事件广播（Electron 边界）
 *
 * 本文件是 cslab 模块内唯一允许依赖 electron 的事件出口；
 * 其余 cslab-* 业务模块保持 Electron-free，便于 bun test 直跑。
 */

export function broadcastCsLabEvent(channel: string, payload: unknown): void {
  try {
    const { BrowserWindow } = require('electron') as typeof import('electron')
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    }
  } catch (error) {
    console.warn('[CSLab] 事件广播失败（可能处于非 Electron 环境）:', error)
  }
}
