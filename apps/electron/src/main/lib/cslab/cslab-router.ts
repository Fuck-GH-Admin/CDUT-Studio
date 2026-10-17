/**
 * CSLab (CDUT Science Laboratory) - IPC 路由与分发层
 *
 * 模块代号：CSLab
 * 严格收敛于 cslab 隔离目录，由 main/ipc.ts 单点挂载
 */

import { ipcMain } from 'electron'
import { CSLAB_IPC_CHANNELS } from './cslab-types'
import { csLabService } from './cslab-service'

/**
 * 集中注册 CSLab 专属 IPC 处理器
 */
export function registerCsLabIpc(): void {
  // 校验授权密钥
  ipcMain.handle(CSLAB_IPC_CHANNELS.VERIFY_KEY, async (_event, key: unknown) => {
    if (typeof key !== 'string') {
      return {
        success: false,
        message: '无效的密钥参数类型',
        timestamp: Date.now(),
      }
    }
    return csLabService.verifyAccessKey(key)
  })

  // 获取实时遥测状态
  ipcMain.handle(CSLAB_IPC_CHANNELS.GET_TELEMETRY, async () => {
    return csLabService.getTelemetry()
  })

  // 获取计算节点列表
  ipcMain.handle(CSLAB_IPC_CHANNELS.GET_NODES, async () => {
    return csLabService.getNodes()
  })

  // 获取遥测日志
  ipcMain.handle(CSLAB_IPC_CHANNELS.GET_LOGS, async () => {
    return csLabService.getLogs()
  })

  // 节点 Ping
  ipcMain.handle(CSLAB_IPC_CHANNELS.PING, async () => {
    return csLabService.ping()
  })
}
