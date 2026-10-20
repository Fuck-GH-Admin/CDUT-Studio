/**
 * CSLab (CDUT Science Laboratory) - 后端运行状态服务
 *
 * 模块代号：CSLab
 * 统一管理本地工作台遥测指标、运行时节点状态与审计日志。
 */

import os from 'node:os'
import type {
  CsLabTelemetry,
  CsLabNode,
  CsLabLogEntry,
} from './cslab-types'

/** 本机内存占用率（0-100），作为本地运行时负载的真实指标 */
function getMemoryLoadPercent(): number {
  const total = os.totalmem()
  if (total <= 0) return 0
  const used = total - os.freemem()
  return Math.min(100, Math.max(0, Math.round((used / total) * 100)))
}

export class CsLabService {
  private static instance: CsLabService | null = null

  private startTime = Date.now()

  private logs: CsLabLogEntry[] = [
    {
      id: 'log-1',
      timestamp: Date.now() - 3600000,
      level: 'SYS',
      module: 'CSLAB-CORE',
      message: '本地科研工作区初始化完毕，实验室索引通道就绪。',
    },
    {
      id: 'log-2',
      timestamp: Date.now() - 1800000,
      level: 'INFO',
      module: 'LOCAL-RUNTIME',
      message: '本地运行时状态采集已启动。',
    },
    {
      id: 'log-3',
      timestamp: Date.now() - 600000,
      level: 'SEC',
      module: 'AUTH-GATE',
      message: '本机访问密码门禁就绪，等待验密进入。',
    },
  ]

  public static getInstance(): CsLabService {
    if (!CsLabService.instance) {
      CsLabService.instance = new CsLabService()
    }
    return CsLabService.instance
  }

  /**
   * 获取当前本地运行状态
   */
  public getTelemetry(): CsLabTelemetry {
    const uptime = Math.floor((Date.now() - this.startTime) / 1000)

    return {
      status: 'operational',
      labName: 'CDUT Science 科研工作台',
      labCode: 'CSLAB',
      // 历史契约字段，本地工作台不涉及量子相干与射频指标
      quantumCoherence: 0,
      frequencyGhz: 0,
      uptimeSeconds: uptime,
      activeNodesCount: 1,
      sysLoadPercent: getMemoryLoadPercent(),
      lastHeartbeat: Date.now(),
      controllerMessage: '本地科研环境已就绪，等待进入实验室。',
    }
  }

  /**
   * 获取运行时节点（本机单节点）
   */
  public getNodes(): CsLabNode[] {
    return [
      {
        id: 'CDUT-LOCAL-01',
        name: '本机 CDUT Science 工作台',
        role: 'LOCAL_RUNTIME',
        status: 'online',
        latencyMs: 0,
        loadPercent: getMemoryLoadPercent(),
        ip: '127.0.0.1',
      },
    ]
  }

  /**
   * 获取运行时审计日志
   */
  public getLogs(): CsLabLogEntry[] {
    return [...this.logs]
  }

  /**
   * 心跳与往返时延测试（本机调用时延）
   */
  public ping(): { timestamp: number; latencyMs: number } {
    return {
      timestamp: Date.now(),
      latencyMs: 0,
    }
  }
}

export const csLabService = CsLabService.getInstance()
