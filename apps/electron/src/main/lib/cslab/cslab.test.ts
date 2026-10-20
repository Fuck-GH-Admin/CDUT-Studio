import { describe, expect, test } from 'bun:test'
import { csLabService } from './cslab-service'

describe('CSLab 本地运行状态', () => {
  test('遥测只声明本地科研工作台', () => {
    const telemetry = csLabService.getTelemetry()
    expect(telemetry.labCode).toBe('CSLAB')
    expect(telemetry.labName).toContain('CDUT Science')
    expect(telemetry.status).toBe('operational')
    expect(telemetry.controllerMessage).not.toContain('雫窝')
    // 历史契约字段在本地环境不伪造数值
    expect(telemetry.quantumCoherence).toBe(0)
    expect(telemetry.frequencyGhz).toBe(0)
    expect(telemetry.activeNodesCount).toBe(1)
  })

  test('运行时节点仅包含本机工作台', () => {
    const nodes = csLabService.getNodes()
    expect(nodes).toHaveLength(1)
    const node = nodes[0]!
    expect(node.id).toBe('CDUT-LOCAL-01')
    expect(node.ip).toBe('127.0.0.1')
    expect(node.loadPercent).toBeGreaterThanOrEqual(0)
  })

  test('审计日志与本地心跳结构有效', () => {
    expect(csLabService.getLogs().length).toBeGreaterThan(0)

    const ping = csLabService.ping()
    expect(ping.timestamp).toBeGreaterThan(0)
    expect(ping.latencyMs).toBe(0)
  })
})
