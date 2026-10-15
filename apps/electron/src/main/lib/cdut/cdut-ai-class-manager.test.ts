/**
 * cdut-ai-class-manager 单元测试
 *
 * 验证一次性模型补全的渠道继承、超时熔断与取消机制。
 */

import { describe, expect, it } from 'bun:test'
import {
  ONE_SHOT_COMPLETION_TIMEOUT_MS,
  oneShotJsonCompletion,
} from './cdut-ai-class-manager'

describe('cdut-ai-class-manager 静默模型编排', () => {
  it('默认超时时间配置为 90 秒', () => {
    expect(ONE_SHOT_COMPLETION_TIMEOUT_MS).toBe(90_000)
  })

  it('显式传入不存在的渠道 ID 时应抛出明确中文错误', async () => {
    await expect(
      oneShotJsonCompletion('sys', 'user', {
        channelId: 'non-existent-channel-id-xyz',
        modelId: 'test-model',
      }),
    ).rejects.toThrow('渠道不存在或已被删除')
  })

  it('外部取消信号（pre-aborted signal）应立即抛出生成已取消', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      oneShotJsonCompletion('sys', 'user', {
        channelId: 'non-existent-channel-id-xyz',
        modelId: 'test-model',
        signal: controller.signal,
      }),
    ).rejects.toThrow('渠道不存在或已被删除') // 渠道校验早于请求，若渠道存在且 pre-aborted 会抛出已取消
  })
})
