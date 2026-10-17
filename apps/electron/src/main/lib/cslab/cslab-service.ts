/**
 * CSLab (CDUT Science Laboratory) - 后端核心业务服务
 *
 * 模块代号：CSLab
 * 统一管理遥测指标、集群节点状态、验证日志与系统握手
 */

import type {
  CsLabTelemetry,
  CsLabNode,
  CsLabLogEntry,
  CsLabVerificationResult,
} from './cslab-types'
import {
  verifyKeySecurely,
  generateCsLabSessionToken,
} from './cslab-crypto'

export class CsLabService {
  private static instance: CsLabService | null = null

  private startTime = Date.now()
  private verifiedAt: number | null = null

  private nodes: CsLabNode[] = [
    {
      id: 'NYA-CORE-01',
      name: '雫窝主核中央计算节点',
      role: 'QUANTUM_PRIMARY',
      status: 'online',
      latencyMs: 8,
      loadPercent: 42,
      ip: '10.240.0.1',
    },
    {
      id: 'CDUT-GATE-02',
      name: '成都理工前哨遥测网关',
      role: 'TELEMETRY_RELAY',
      status: 'synced',
      latencyMs: 14,
      loadPercent: 28,
      ip: '10.240.12.88',
    },
    {
      id: 'DEEP-NEURAL-03',
      name: '中央实验室深层神经超算',
      role: 'COGNITIVE_FABRIC',
      status: 'online',
      latencyMs: 19,
      loadPercent: 64,
      ip: '10.240.99.12',
    },
  ]

  private logs: CsLabLogEntry[] = [
    {
      id: 'log-1',
      timestamp: Date.now() - 3600000,
      level: 'SYS',
      module: 'CSLAB-CORE',
      message: '雫窝中央实验室遥测子系统初始化完毕，频道就绪。',
    },
    {
      id: 'log-2',
      timestamp: Date.now() - 1800000,
      level: 'INFO',
      module: 'GRID-DISPATCH',
      message: '前哨遥测信道握手成功，时延采样: 12ms。',
    },
    {
      id: 'log-3',
      timestamp: Date.now() - 600000,
      level: 'SEC',
      module: 'AUTH-GATE',
      message: '访问控制屏障就绪，等待高阶授权密钥验证。',
    },
  ]

  public static getInstance(): CsLabService {
    if (!CsLabService.instance) {
      CsLabService.instance = new CsLabService()
    }
    return CsLabService.instance
  }

  /**
   * 校验用户输入的授权密钥
   */
  public verifyAccessKey(inputKey: string): CsLabVerificationResult {
    const isValid = verifyKeySecurely(inputKey)
    const now = Date.now()

    if (isValid) {
      this.verifiedAt = now
      const token = generateCsLabSessionToken()
      this.addLog('SEC', 'AUTH-GATE', '高阶验证密钥匹配通过，中央实验室权限接入成功。')

      return {
        success: true,
        message: '授权成功：雫窝中央实验室权限链路已连通',
        token,
        timestamp: now,
        clearanceLevel: 'LEVEL-OMEGA',
      }
    }

    this.addLog('WARN', 'AUTH-GATE', '访问控制门禁拦截：密钥无效或未通过散列校验。')

    return {
      success: false,
      message: '授权失败：验证密钥不正确',
      timestamp: now,
    }
  }

  /**
   * 获取当前高精遥测状态
   */
  public getTelemetry(): CsLabTelemetry {
    const uptime = Math.floor((Date.now() - this.startTime) / 1000)

    // 基于时间产生微小的真实波动
    const timeFactor = Math.sin(Date.now() / 10000)
    const coherence = Number((99.85 + timeFactor * 0.12).toFixed(2))
    const frequency = Number((4.82 + timeFactor * 0.05).toFixed(2))
    const sysLoad = Math.floor(45 + timeFactor * 10)

    return {
      status: this.verifiedAt ? 'operational' : 'standby',
      labName: '雫窝中央实验室 / Nya-Home Central Laboratory',
      labCode: 'CSLab-NX',
      quantumCoherence: coherence,
      frequencyGhz: frequency,
      uptimeSeconds: uptime,
      activeNodesCount: this.nodes.filter((n) => n.status === 'online' || n.status === 'synced').length,
      sysLoadPercent: sysLoad,
      lastHeartbeat: Date.now(),
      controllerMessage: '雫窝中央实验室已接管 CDUT Science 开发，敬请期待！',
    }
  }

  /**
   * 获取集群计算节点
   */
  public getNodes(): CsLabNode[] {
    return [...this.nodes]
  }

  /**
   * 获取遥测审计日志
   */
  public getLogs(): CsLabLogEntry[] {
    return [...this.logs]
  }

  /**
   * 心跳与往返时延测试
   */
  public ping(): { timestamp: number; latencyMs: number } {
    return {
      timestamp: Date.now(),
      latencyMs: Math.floor(8 + Math.random() * 8),
    }
  }

  private addLog(level: 'INFO' | 'SYS' | 'WARN' | 'SEC', module: string, message: string): void {
    this.logs.unshift({
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      level,
      module,
      message,
    })

    if (this.logs.length > 50) {
      this.logs.pop()
    }
  }
}

export const csLabService = CsLabService.getInstance()
