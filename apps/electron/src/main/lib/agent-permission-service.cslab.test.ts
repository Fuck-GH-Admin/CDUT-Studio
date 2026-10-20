/**
 * AgentPermissionService × CSLab Python 工具审批加固测试
 *
 * 覆盖：禁用"总是允许"、无交互通道硬阻断、只读列表工具不受影响。
 */

import { describe, expect, test } from 'bun:test'
import { AgentPermissionService, type CanUseToolOptions } from './agent-permission-service'

const OPTIONS: CanUseToolOptions = {
  signal: new AbortController().signal,
  toolUseID: 'tool-use-id',
}

function createWorkerOptions(): CanUseToolOptions {
  return { ...OPTIONS, agentID: 'worker-id' }
}

describe('CSLab 工具审批加固', () => {
  test('Given 用户选择总是允许 When 再次调用同一 CSLab 工具 Then 仍产生新的审批请求', async () => {
    const service = new AgentPermissionService()

    const first = service.createCanUseTool('session', () => {})(
      'cslab_calculate',
      { value: 1 },
      OPTIONS,
    )
    const firstRequest = service.getPendingRequests()[0]
    expect(firstRequest).toBeDefined()
    service.respondToPermission(firstRequest!.requestId, 'allow', true)
    expect((await first).behavior).toBe('allow')

    // "总是允许"不应写入白名单：第二次调用必须重新排队审批。
    const second = service.createCanUseTool('session', () => {})(
      'cslab_calculate',
      { value: 2 },
      OPTIONS,
    )
    const secondRequest = service.getPendingRequests()[0]
    expect(secondRequest).toBeDefined()
    expect(secondRequest!.requestId).not.toBe(firstRequest!.requestId)
    service.respondToPermission(secondRequest!.requestId, 'deny', false)
    expect((await second).behavior).toBe('deny')
  })

  test('Given 子代理调用 CSLab 工具 When 没有交互审批通道 Then 硬阻断', async () => {
    const service = new AgentPermissionService()
    const result = await service.createCanUseTool('session', () => {})(
      'cslab_calculate',
      { value: 1 },
      createWorkerOptions(),
    )

    expect(result).toMatchObject({
      behavior: 'deny',
      interrupt: true,
      message: 'Custom Python tool execution is disabled in non-interactive subagent channels.',
    })
  })

  test('Given 只读的 cslab_list_lab_tools When 子代理调用 Then 不走 Python 执行硬阻断', async () => {
    const service = new AgentPermissionService()
    const result = await service.createCanUseTool('session', () => {})(
      'cslab_list_lab_tools',
      {},
      createWorkerOptions(),
    )

    expect(result.behavior).toBe('allow')
  })
})
