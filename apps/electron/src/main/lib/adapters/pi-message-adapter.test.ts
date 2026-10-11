import { describe, expect, test } from 'bun:test'
import type { AssistantMessage } from '@earendil-works/pi-ai/compat'
import { convertPiMessage, convertResultMessage, EMPTY_IMAGE_PLACEHOLDER_TEXT, EMPTY_OUTPUT_ERROR_MESSAGE, hasTerminalErrorWithContent, sanitizePiContextMessages, stripErrorFromContentMessage } from './pi-message-adapter'
import type { AgentMessage } from '@earendil-works/pi-agent-core'

function textAssistant(content: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: content }],
    ...overrides,
  } as unknown as AssistantMessage
}

function thinkingOnlyAssistant(overrides?: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'thinking', thinking: '先分析，但没有生成正文' }],
    stopReason: 'stop',
    ...overrides,
  } as unknown as AssistantMessage
}

function writeToolCall(content: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{
      type: 'toolCall',
      id: 'tool-call-1',
      name: 'write',
      arguments: {
        path: 'C:\\Users\\WNI10\\.proma\\agent-workspaces\\moneybull\\workspace-files\\large.md',
        content,
      },
    }],
  } as unknown as AssistantMessage
}

describe('convertPiMessage', () => {
  test('Given thinking-only final message When converting Then marks empty_output instead of success content', () => {
    const message = convertPiMessage(
      thinkingOnlyAssistant(),
      'session-empty-output',
      undefined,
      { final: true, uuid: 'assistant-empty-output' },
    ) as { error?: { message: string; errorType: string }; _emptyOutput?: boolean }

    expect(message.error).toEqual({ message: EMPTY_OUTPUT_ERROR_MESSAGE, errorType: 'empty_output' })
    expect(message._emptyOutput).toBe(true)
  })

  test('omits cumulative write content from partial tool-call frames', () => {
    const message = convertPiMessage(writeToolCall('x'.repeat(10_240)), 'session-1', undefined, {
      final: false,
      uuid: 'assistant-1',
    }) as { _partial?: boolean; message: { content: Array<{ input?: unknown }> } }

    expect(message._partial).toBe(true)
    expect(message.message.content[0]?.input).toEqual({})
    expect(JSON.stringify(message).length).toBeLessThan(1_000)
  })

  test('keeps complete write input in the final tool-call frame', () => {
    const content = 'x'.repeat(10_240)
    const message = convertPiMessage(writeToolCall(content), 'session-1', undefined, {
      final: true,
      uuid: 'assistant-1',
    }) as { message: { content: Array<{ input?: Record<string, unknown> }> } }

    expect(message.message.content[0]?.input).toEqual({
      path: 'C:\\Users\\WNI10\\.proma\\agent-workspaces\\moneybull\\workspace-files\\large.md',
      file_path: 'C:\\Users\\WNI10\\.proma\\agent-workspaces\\moneybull\\workspace-files\\large.md',
      content,
    })
    expect(JSON.stringify(message).length).toBeGreaterThan(content.length)
  })

  test('Given thinking-only final message When converting result Then subtype is execution error', () => {
    const result = convertResultMessage(
      [thinkingOnlyAssistant()],
      'session-empty-output',
    ) as { subtype?: string; terminal_reason?: string; errors?: string[] }

    expect(result.subtype).toBe('error_during_execution')
    expect(result.terminal_reason).toBe('empty_output')
    expect(result.errors).toEqual([EMPTY_OUTPUT_ERROR_MESSAGE])
  })

  test('Given Pi 剥离 SDK 后缀 When 持久化 result Then 保存真实窗口、请求模型和渠道主模型', () => {
    const result = convertResultMessage(
      [],
      'session-1',
      undefined,
      1_000_000,
      'gateway/deepseek-v4-pro',
      'gateway/deepseek-v4-pro[1m]',
    ) as {
      modelUsage?: Record<string, { contextWindow?: number }>
      _channelModelId?: string
    }

    expect(result.modelUsage).toEqual({
      'gateway/deepseek-v4-pro': { contextWindow: 1_000_000 },
    })
    expect(result._channelModelId).toBe('gateway/deepseek-v4-pro[1m]')
  })

  // #1267: 流式断连应被识别为 network_error 而非 provider_error
  test('Given chunked read 流式断连错误 When 终态 Then errorType 为 network_error', () => {
    const message = convertPiMessage(
      textAssistant('这是一段正常的助手回复内容', {
        stopReason: 'error',
        errorMessage: 'incomplete chunked read',
      }),
      'session-1',
      undefined,
      { final: true, uuid: 'assistant-1' },
    ) as { error?: { message: string; errorType: string } }

    expect(message.error).toBeDefined()
    expect(message.error!.errorType).toBe('network_error')
    expect(message.error!.message).toBe('incomplete chunked read')
  })

  test('Given peer closed 断连错误 When 终态 Then errorType 为 network_error', () => {
    const message = convertPiMessage(
      textAssistant('部分回复', {
        stopReason: 'error',
        errorMessage: 'peer closed connection',
      }),
      'session-1',
      undefined,
      { final: true, uuid: 'assistant-2' },
    ) as { error?: { message: string; errorType: string } }

    expect(message.error).toBeDefined()
    expect(message.error!.errorType).toBe('network_error')
  })

  test('Given provider 业务错误 When 终态 Then errorType 仍为 provider_error', () => {
    const message = convertPiMessage(
      textAssistant('部分回复', {
        stopReason: 'error',
        errorMessage: 'invalid api key',
      }),
      'session-1',
      undefined,
      { final: true, uuid: 'assistant-3' },
    ) as { error?: { message: string; errorType: string } }

    expect(message.error).toBeDefined()
    expect(message.error!.errorType).toBe('provider_error')
  })

  // #1268: 断流保消息 — content + error 分离
  test('Given 带正文的终端错误 When 分离 Then 返回不含 error 的正文消息和错误文本', () => {
    const textContent = '这是回复的前半部分，正在处理中...'
    const message = convertPiMessage(
      textAssistant(textContent, {
        stopReason: 'error',
        errorMessage: 'stream ended before terminal response event',
      }),
      'session-1',
      undefined,
      { final: true, uuid: 'assistant-sep' },
    )

    expect(hasTerminalErrorWithContent(message!)).toBe(true)

    const separated = stripErrorFromContentMessage(message!)
    expect(separated).not.toBeNull()
    expect(separated!.errorText).toBe('stream ended before terminal response event')
    // 正文消息不含 error 字段
    expect((separated!.contentMessage as Record<string, unknown>).error).toBeUndefined()
    // 正文消息保留了原始 uuid
    expect((separated!.contentMessage as Record<string, unknown>).uuid).toBe('assistant-sep')
    // 正文消息保留文本内容
    const content = (separated!.contentMessage as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content
    expect(content).toBeDefined()
    expect(content![0]?.text).toBe(textContent)
  })

  test('Given 纯错误（无正文）When 检测 Then 不判定为 terminal error with content', () => {
    const message = convertPiMessage(
      textAssistant('', {
        stopReason: 'error',
        errorMessage: 'invalid api key',
      }),
      'session-1',
      undefined,
      { final: true, uuid: 'assistant-no-content' },
    )

    expect(hasTerminalErrorWithContent(message!)).toBe(false)
    expect(stripErrorFromContentMessage(message!)).toBeNull()
  })

  test('Given 正文只是错误文案副本 When 检测 Then 不冒充断流前有效正文', () => {
    const errorText = 'OpenAI 官方上游服务当前请求量较大，请稍后重试。'
    const message = convertPiMessage(
      textAssistant(errorText, {
        stopReason: 'error',
        errorMessage: errorText,
      }),
      'session-1',
      undefined,
      { final: true, uuid: 'assistant-duplicated-error' },
    )

    expect(hasTerminalErrorWithContent(message!)).toBe(false)
    expect(stripErrorFromContentMessage(message!)).toBeNull()
  })

  test('Given 正常消息（无错误）When 检测 Then 不判定为 terminal error with content', () => {
    const message = convertPiMessage(
      textAssistant('正常回复内容'),
      'session-1',
      undefined,
      { final: true, uuid: 'assistant-normal' },
    )

    expect(hasTerminalErrorWithContent(message!)).toBe(false)
    expect(stripErrorFromContentMessage(message!)).toBeNull()
  })
})

describe('sanitizePiContextMessages', () => {
  test('空图像块被替换为文本占位，防止带空 data 的 image part 让上游挂起', () => {
    const toolResult = {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'BrowserScreenshot',
      isError: false,
      content: [
        { type: 'text', text: '已截取当前页面：cdut-file://x/index.html' },
        { type: 'image', data: '', mimeType: 'image/png' },
      ],
    } as unknown as AgentMessage

    const result = sanitizePiContextMessages([toolResult])
    const sanitized = result[0]! as unknown as { content: Array<Record<string, unknown>> }

    expect(sanitized.content).toEqual([
      { type: 'text', text: '已截取当前页面：cdut-file://x/index.html' },
      { type: 'text', text: EMPTY_IMAGE_PLACEHOLDER_TEXT },
    ])
    // 不修改原始消息对象
    expect((toolResult as unknown as { content: Array<Record<string, unknown>> }).content[1]!.data).toBe('')
  })

  test('非空图像与其余消息原样透传；无需改动时返回原数组引用', () => {
    const validImage = {
      role: 'toolResult',
      toolCallId: 'call-2',
      toolName: 'BrowserScreenshot',
      isError: false,
      content: [{ type: 'image', data: 'iVBORw0KGgoAAAANSUhEUg', mimeType: 'image/png' }],
    } as unknown as AgentMessage
    const user = { role: 'user', content: [{ type: 'text', text: 'hi' }] } as unknown as AgentMessage

    const messages = [validImage, user]
    const result = sanitizePiContextMessages(messages)

    expect(result).toBe(messages)
    expect(result[0]).toBe(validImage)
  })

  test('超过最近 6 步的历史超长 Write/Edit 参数与 ToolResult 文本被自动折叠瘦身，最近 6 步保持完整', () => {
    const hugeContent = 'A'.repeat(4000)
    const oldAssistantWrite = {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'call-write-1',
          name: 'write',
          arguments: { path: 'paper.md', content: hugeContent },
        },
      ],
    } as unknown as AgentMessage
    const oldToolResult = {
      role: 'toolResult',
      toolCallId: 'call-read-1',
      toolName: 'read',
      isError: false,
      content: [{ type: 'text', text: 'B'.repeat(4500) }],
    } as unknown as AgentMessage

    const recentMessages = Array.from({ length: 6 }, (_, idx) => ({
      role: idx % 2 === 0 ? 'assistant' : 'toolResult',
      content: [{ type: 'text', text: 'R'.repeat(3000) }],
    })) as unknown as AgentMessage[]

    const result = sanitizePiContextMessages([oldAssistantWrite, oldToolResult, ...recentMessages])
    const maskedCall = (result[0] as any).content[0]
    expect(maskedCall.arguments.content).toContain('历史写入内容已成功落盘并折叠')
    expect(maskedCall.arguments.content.length).toBeLessThan(700)

    const maskedResultText = (result[1] as any).content[0].text
    expect(maskedResultText).toContain('历史工具输出已折叠')
    expect(maskedResultText.length).toBeLessThan(1300)

    // 最近 6 步不被折叠
    expect((result[2] as any).content[0].text.length).toBe(3000)
  })
})
