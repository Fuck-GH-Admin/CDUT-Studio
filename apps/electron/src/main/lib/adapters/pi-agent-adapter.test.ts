import { describe, expect, test } from 'bun:test'

// 只验证 Pi 侧 AskUserQuestion 工具注册契约与权限包装闭环，不启动真实 Pi SDK。
const {
  buildPromaProductToolDefinitions,
  shouldBlockToolForAskUserQuestion,
  mapSDKErrorToTypedError,
  isConversationHistoryLookupCommand,
  isConversationHistoryLookupToolCall,
} = await import('./pi-agent-adapter')

interface CapturedTool {
  name: string
  label?: string
  description: string
  promptSnippet?: string
  parameters?: unknown
  execute?: (toolCallId: string, params: unknown) => Promise<unknown>
}

function createPiSdkStub(): {
  sdk: typeof import('@earendil-works/pi-coding-agent')
  tools: CapturedTool[]
} {
  const tools: CapturedTool[] = []
  const sdk = {
    defineTool(tool: CapturedTool): CapturedTool {
      tools.push(tool)
      return tool
    },
  } as unknown as typeof import('@earendil-works/pi-coding-agent')
  return { sdk, tools }
}

interface AskUserToolResult {
  content: Array<{ text: string }>
  details?: { answers?: Record<string, string> }
}

describe('Pi AskUserQuestion 提问闭环（工具注册契约）', () => {
  test('Given a mixed tool batch containing AskUserQuestion When checking a later tool Then blocks it until the user responds', () => {
    expect(shouldBlockToolForAskUserQuestion(['AskUserQuestion', 'Bash'], 'Bash')).toBe(true)
    expect(shouldBlockToolForAskUserQuestion(['AskUserQuestion', 'Bash'], 'AskUserQuestion')).toBe(false)
    expect(shouldBlockToolForAskUserQuestion(['Bash'], 'Bash')).toBe(false)
  })

  test('Given Pi runtime When building Proma product tools Then AskUserQuestion is registered with the interactive question schema', () => {
    const { sdk } = createPiSdkStub()

    const definitions = buildPromaProductToolDefinitions(sdk, async () => ({ behavior: 'allow' }))

    const askUser = (definitions as unknown as CapturedTool[]).find((tool) => tool.name === 'AskUserQuestion')
    expect(askUser).toBeDefined()
    expect(askUser?.label).toBe('询问用户')
    expect(askUser?.description).toContain('问答横幅')

    // 受管 Deck Brief metadata 与普通 AskUser 输入共用同一 Pi schema。
    expect(JSON.stringify(askUser?.parameters)).toContain('proferConfirmation')
  })

  test('Given AskUserQuestion When inspecting schema Then supports single/multiple/fill-blank', () => {
    const { sdk } = createPiSdkStub()

    const definitions = buildPromaProductToolDefinitions(sdk, async () => ({ behavior: 'allow' }))
    const askUser = (definitions as unknown as CapturedTool[]).find((tool) => tool.name === 'AskUserQuestion')
    const schema = JSON.stringify(askUser?.parameters)

    expect(schema).toContain('fill-blank')
    expect(schema).toContain('placeholder')
    expect(schema).toContain('"type"')
    expect(askUser?.description).toContain('单选')
    expect(askUser?.description).toContain('多选')
  })

  test('Given 用户回答注入 answers When AskUserQuestion executes Then 统一 canUseTool 被调用且答案返回给模型', async () => {
    const { sdk } = createPiSdkStub()
    const calls: Array<{ toolName: string; input: Record<string, unknown>; toolUseID: string; displayName: string }> = []

    const definitions = buildPromaProductToolDefinitions(sdk, async (toolName, input, options) => {
      calls.push({
        toolName,
        input,
        toolUseID: options.toolUseID ?? '',
        displayName: options.displayName ?? '',
      })
      // 模拟 agent-ask-user-service 在用户回答后注入 answers 的 updatedInput
      return { behavior: 'allow', updatedInput: { ...input, answers: { q1: '选项 A' } } }
    })

    const askUser = (definitions as unknown as CapturedTool[]).find((tool) => tool.name === 'AskUserQuestion')
    const result = await askUser?.execute?.('call-1', {
      questions: [{ question: '选择哪个方向？' }],
    }) as AskUserToolResult

    // 权限分派走统一 canUseTool，工具名保持 AskUserQuestion 以便编排器拦截
    expect(calls).toHaveLength(1)
    expect(calls[0]?.toolName).toBe('AskUserQuestion')
    expect(calls[0]?.toolUseID).toBe('call-1')
    expect(calls[0]?.displayName).toBe('询问用户')

    // 注入的 answers 经 restorePiInput 合并进参数，工具结果把答案交还模型
    const payload = JSON.parse(result.content[0]!.text) as { answers: Record<string, string> }
    expect(payload.answers.q1).toBe('选项 A')
    expect(result.details?.answers?.q1).toBe('选项 A')
  })

  test('Given 用户未回答即拒绝 When AskUserQuestion executes Then 抛出拒绝消息并中断工具执行', async () => {
    const { sdk } = createPiSdkStub()

    const definitions = buildPromaProductToolDefinitions(sdk, async () => ({
      behavior: 'deny',
      message: '用户取消回答',
    }))

    const askUser = (definitions as unknown as CapturedTool[]).find((tool) => tool.name === 'AskUserQuestion')
    await expect(
      askUser?.execute?.('call-2', { questions: [{ question: '继续吗？' }] }),
    ).rejects.toThrow('用户取消回答')
  })
})

describe('mapSDKErrorToTypedError 覆盖中转 5xx / 瞬时文案（回归：曾经误判为 unknown_error 且不重试）', () => {
  const cases: Array<[string, 'service_error' | 'service_unavailable' | 'provider_error']> = [
    ['520 status code (no body)', 'service_error'],
    ['503: {"message":"Service temporarily unavailable","type":"api_error"}', 'service_unavailable'],
    ['Request could not be completed', 'service_error'],
    ['服务繁忙，请稍后重试', 'provider_error'],
  ]
  test.each(cases)('Given “%s” Then 归类为 %s 且允许自动重试', (text, expectedCode) => {
    const typed = mapSDKErrorToTypedError('provider_error', text, text)
    expect(typed.code).toBe(expectedCode)
    expect(typed.canRetry).toBe(true)
  })

  test('Given thinking-only empty output Then maps to a retryable structured error', () => {
    const typed = mapSDKErrorToTypedError('empty_output', '模型未生成可见回复', '模型未生成可见回复')
    expect(typed.code).toBe('empty_output')
    expect(typed.title).toBe('模型未生成回复')
    expect(typed.canRetry).toBe(true)
  })

  test('Given 认证失败 Then 仍不误判为 5xx 可重试', () => {
    const typed = mapSDKErrorToTypedError('invalid_api_key', 'invalid api key', 'invalid api key')
    expect(typed.code).toBe('invalid_api_key')
  })
})

describe('索引模式历史检索护栏', () => {
  test('Given transcript / agent-sessions 历史路径 When 判断 shell 命令 Then 命中', () => {
    expect(isConversationHistoryLookupCommand(
      'grep -r Isomorphic ~/.cdutai/brain/session-1/.system_generated/logs/transcript.jsonl',
    )).toBe(true)
    expect(isConversationHistoryLookupCommand(
      'Select-String -Path "~/.cdutai/agent-sessions/session-1.jsonl" -Pattern Isomorphic',
    )).toBe(true)
    expect(isConversationHistoryLookupCommand(
      'Get-Content ~/.cdutai/brain/session-1/.system_generated/logs/transcript_full.jsonl',
    )).toBe(true)
  })

  test('Given 正常源码搜索 When 判断 shell 命令 Then 不误伤', () => {
    expect(isConversationHistoryLookupCommand('Get-ChildItem src')).toBe(false)
    expect(isConversationHistoryLookupCommand('grep -r "transcript" src/components')).toBe(false)
    expect(isConversationHistoryLookupCommand('bun test apps/electron')).toBe(false)
  })

  test('Given 文件读取工具命中历史路径 When 判断工具调用 Then 命中', () => {
    expect(isConversationHistoryLookupToolCall('read', {
      file_path: '~/.cdutai/brain/session-1/.system_generated/logs/transcript_full.jsonl',
    })).toBe(true)
    expect(isConversationHistoryLookupToolCall('grep', {
      path: '~/.cdutai/agent-sessions/session-1.jsonl',
      pattern: 'Isomorphic',
    })).toBe(true)
    expect(isConversationHistoryLookupToolCall('powershell', {
      command: 'Get-Content C:\\Users\\me\\.cdutai\\agent-sessions\\s1.jsonl',
    })).toBe(true)
  })

  test('Given 普通工作区文件 When 判断工具调用 Then 不拦截', () => {
    expect(isConversationHistoryLookupToolCall('read', { file_path: 'src/index.ts' })).toBe(false)
    expect(isConversationHistoryLookupToolCall('glob', { pattern: '**/*.ts' })).toBe(false)
    expect(isConversationHistoryLookupToolCall('bash', { command: 'git status --short' })).toBe(false)
  })
})
