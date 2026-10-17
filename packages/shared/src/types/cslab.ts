/**
 * CDUT Science (CSLab) - 共享类型契约与 IPC 通道常量
 *
 * 模块代号：CSLab
 * 雫窝中央实验室接管的 CDUT Science 专区共享数据契约
 */

export const CSLAB_IPC_CHANNELS = {
  VERIFY_KEY: 'cslab:verify-key',
  GET_TELEMETRY: 'cslab:get-telemetry',
  GET_NODES: 'cslab:get-nodes',
  GET_LOGS: 'cslab:get-logs',
  PING: 'cslab:ping',
} as const

export type CsLabChannelKey = keyof typeof CSLAB_IPC_CHANNELS

export type CsLabOperationalStatus = 'operational' | 'standby' | 'syncing' | 'restricted'

export interface CsLabVerificationResult {
  success: boolean
  message: string
  token?: string
  timestamp: number
  clearanceLevel?: string
}

export interface CsLabTelemetry {
  status: CsLabOperationalStatus
  labName: string
  labCode: string
  quantumCoherence: number
  frequencyGhz: number
  uptimeSeconds: number
  activeNodesCount: number
  sysLoadPercent: number
  lastHeartbeat: number
  controllerMessage: string
}

export interface CsLabNode {
  id: string
  name: string
  role: string
  status: 'online' | 'synced' | 'standby'
  latencyMs: number
  loadPercent: number
  ip: string
}

export interface CsLabLogEntry {
  id: string
  timestamp: number
  level: 'INFO' | 'SYS' | 'WARN' | 'SEC'
  module: string
  message: string
}
