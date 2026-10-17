import { describe, expect, test } from 'bun:test'
import {
  calculateSha256,
  verifyKeySecurely,
  CSLAB_TARGET_KEY_HASH,
} from './cslab-crypto'
import { csLabService } from './cslab-service'

describe('CSLab (CDUT Science Laboratory) 模块测试', () => {
  test('目标密钥 SHA-256 散列值符合预期且非明文存储', () => {
    const rawKey = 'MCC-Nya-520'
    const computedHash = calculateSha256(rawKey)
    expect(computedHash).toBe(CSLAB_TARGET_KEY_HASH)
    expect(computedHash).toBe('7f66de46bc03ed8e45acb8bb9b2a4d5f3c6881b085336bc84317396527bc51db')
  })

  test('verifyKeySecurely 正确验证正确密钥与拒绝错误密钥', () => {
    expect(verifyKeySecurely('MCC-Nya-520')).toBe(true)
    expect(verifyKeySecurely(' MCC-Nya-520 ')).toBe(true)
    expect(verifyKeySecurely('wrong-key')).toBe(false)
    expect(verifyKeySecurely('')).toBe(false)
    // @ts-expect-error testing invalid input
    expect(verifyKeySecurely(null)).toBe(false)
  })

  test('csLabService.verifyAccessKey 返回完整结构', () => {
    const successResult = csLabService.verifyAccessKey('MCC-Nya-520')
    expect(successResult.success).toBe(true)
    expect(successResult.token).toBeDefined()
    expect(successResult.token?.startsWith('CSLAB-TOKEN-')).toBe(true)
    expect(successResult.clearanceLevel).toBe('LEVEL-OMEGA')

    const failedResult = csLabService.verifyAccessKey('invalid-key')
    expect(failedResult.success).toBe(false)
    expect(failedResult.token).toBeUndefined()
  })

  test('csLabService.getTelemetry 返回完整遥测数据', () => {
    const telemetry = csLabService.getTelemetry()
    expect(telemetry.labCode).toBe('CSLab-NX')
    expect(telemetry.status).toBe('operational')
    expect(telemetry.quantumCoherence).toBeGreaterThan(95)
    expect(telemetry.activeNodesCount).toBeGreaterThan(0)
    expect(telemetry.controllerMessage).toContain('雫窝中央实验室')
  })

  test('csLabService.getNodes 返回集群节点列表', () => {
    const nodes = csLabService.getNodes()
    expect(nodes.length).toBeGreaterThanOrEqual(3)
    expect(nodes.some((n) => n.id === 'NYA-CORE-01')).toBe(true)
  })

  test('csLabService.ping 返回时延与时间戳', () => {
    const ping = csLabService.ping()
    expect(ping.timestamp).toBeGreaterThan(0)
    expect(ping.latencyMs).toBeGreaterThan(0)
  })
})
