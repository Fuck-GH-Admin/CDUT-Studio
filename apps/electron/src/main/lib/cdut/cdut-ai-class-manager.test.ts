/**
 * cdut-ai-class-manager 单元测试
 *
 * 验证一次性模型补全的渠道继承、超时熔断与取消机制。
 */

import { describe, expect, it } from 'bun:test'
import {
  ONE_SHOT_COMPLETION_TIMEOUT_MS,
  inspectCompletionResponse,
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

describe('inspectCompletionResponse 协议感知解析', () => {
  it('Given OpenAI Chat 空正文且 finish_reason=length When 检查 Then 正文为空并透出终止原因', () => {
    const result = inspectCompletionResponse('openai-chat', {
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
    })

    expect(result.text).toBeNull()
    expect(result.finishReason).toBe('length')
  })

  it('Given OpenAI Chat content=null When 检查 Then 不抛异常且正文为空', () => {
    const result = inspectCompletionResponse('openai-chat', {
      choices: [{ message: { content: null }, finish_reason: 'stop' }],
    })

    expect(result.text).toBeNull()
    expect(result.finishReason).toBe('stop')
  })

  it('Given OpenAI Chat 内容块数组含对象与字符串 When 检查 Then 正确拼接正文', () => {
    const result = inspectCompletionResponse('openai-chat', {
      choices: [
        {
          message: { content: [{ type: 'text', text: '{"a":1}' }, '尾部'] },
          finish_reason: 'stop',
        },
      ],
    })

    expect(result.text).toBe('{"a":1}尾部')
    expect(result.textChars).toBe(9)
  })

  it('Given OpenAI Chat 思考字段命名不一 When 检查 Then 只计入 reasoningChars 而不回填正文', () => {
    const result = inspectCompletionResponse('openai-chat', {
      choices: [
        {
          message: {
            content: '',
            reasoning_content: '思考一',
            reasoning: '思考二',
            thinking: '思考三',
          },
          finish_reason: 'length',
        },
      ],
    })

    expect(result.text).toBeNull()
    expect(result.reasoningChars).toBe(9)
  })

  it('Given OpenAI Chat finish_reason=content_filter When 检查 Then 原样透出终止原因', () => {
    const result = inspectCompletionResponse('openai-chat', {
      choices: [{ message: { content: '' }, finish_reason: 'content_filter' }],
    })

    expect(result.text).toBeNull()
    expect(result.finishReason).toBe('content_filter')
  })

  it('Given Anthropic thinking 与 text 混合 When 检查 Then 只返回 text 块并识别 max_tokens', () => {
    const result = inspectCompletionResponse('anthropic', {
      content: [
        { type: 'thinking', thinking: '长篇思考过程' },
        { type: 'text', text: '{"questions":[]}' },
      ],
      stop_reason: 'max_tokens',
    })

    expect(result.text).toBe('{"questions":[]}')
    expect(result.finishReason).toBe('max_tokens')
    expect(result.reasoningChars).toBe(6)
  })

  it('Given Google 响应含 thought 片段 When 检查 Then 只取非思考正文', () => {
    const result = inspectCompletionResponse('google', {
      candidates: [
        {
          content: {
            parts: [
              { text: '内部思考', thought: true },
              { text: '{"a":1}' },
            ],
          },
          finishReason: 'MAX_TOKENS',
        },
      ],
    })

    expect(result.text).toBe('{"a":1}')
    expect(result.finishReason).toBe('MAX_TOKENS')
  })

  it('Given Responses 响应 When 检查 Then 同时支持 output_text 与 output 兜底', () => {
    const direct = inspectCompletionResponse('openai-responses', {
      output_text: ' {"a":1} ',
      status: 'completed',
    })
    const fallback = inspectCompletionResponse('openai-responses', {
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"b":2}' }] }],
      incomplete_details: { reason: 'max_output_tokens' },
    })

    expect(direct.text).toBe('{"a":1}')
    expect(fallback.text).toBe('{"b":2}')
    expect(fallback.finishReason).toBe('max_output_tokens')
  })

  it('Given data 为 null / 字符串 / 空对象 When 检查 Then 统一返回空正文且不抛异常', () => {
    for (const data of [null, 'oops', {}]) {
      const result = inspectCompletionResponse('openai-chat', data)
      expect(result.text).toBeNull()
      expect(result.textChars).toBe(0)
    }
  })
})
