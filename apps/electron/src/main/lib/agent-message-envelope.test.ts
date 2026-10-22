import { describe, expect, test } from 'bun:test'
import { buildAgentContextEnvelope, extractInjectedUserBlocks } from './agent-message-envelope'

describe('extractInjectedUserBlocks', () => {
  test('剥离附件清单与划词引用，只保留用户正文', () => {
    const message = [
      '<attached_files>',
      '- 报告: C:/docs/a.pdf',
      '</attached_files>',
      '',
      '<quoted_context source="agent-history" label="Agent 历史" message_id="m1" role="assistant">',
      '被引用内容',
      '</quoted_context>',
      '',
      '把这两份材料对比一下',
    ].join('\n')

    const result = extractInjectedUserBlocks(message)
    expect(result.pureText).toBe('把这两份材料对比一下')
    expect(result.contextBlocks).toHaveLength(2)
    expect(result.contextBlocks[0]).toContain('<attached_files>')
    expect(result.contextBlocks[1]).toContain('<quoted_context')
  })

  test('quoted_file 同样抽取为上下文块', () => {
    const result = extractInjectedUserBlocks('<quoted_file path="/tmp/demo.md">\n引用片段\n</quoted_file>\n\n继续优化')
    expect(result.pureText).toBe('继续优化')
    expect(result.contextBlocks[0]).toContain('<quoted_file path="/tmp/demo.md">')
  })
})

describe('buildAgentContextEnvelope', () => {
  test('系统上下文与用户请求严格分域', () => {
    const envelope = buildAgentContextEnvelope({
      userMessage: '<attached_files>\n- a.pdf\n</attached_files>\n\n总结这份文档',
      metadata: '<ADDITIONAL_METADATA>\nThe current time is 2026-10-22.\n</ADDITIONAL_METADATA>',
      contextBlocks: [
        '<document_evidence>\n第1页原文\n</document_evidence>',
        '<mentioned_tools>\n- MCP server: demo\n</mentioned_tools>',
        '',
        undefined,
      ],
    })

    const systemContext = envelope.slice(envelope.indexOf('<SYSTEM_CONTEXT>'), envelope.indexOf('</SYSTEM_CONTEXT>'))
    expect(systemContext).toContain('<attached_files>')
    expect(systemContext).toContain('<document_evidence>')
    expect(systemContext).toContain('<mentioned_tools>')
    expect(systemContext).not.toContain('总结这份文档')

    const userRequest = envelope.slice(envelope.indexOf('<USER_REQUEST>'), envelope.indexOf('</USER_REQUEST>'))
    expect(userRequest).toContain('总结这份文档')
    expect(userRequest).not.toContain('<attached_files>')
    expect(userRequest).not.toContain('<document_evidence>')

    // 顺序固定：metadata → SYSTEM_CONTEXT → USER_REQUEST
    expect(envelope.indexOf('<ADDITIONAL_METADATA>')).toBeLessThan(envelope.indexOf('<SYSTEM_CONTEXT>'))
    expect(envelope.indexOf('<SYSTEM_CONTEXT>')).toBeLessThan(envelope.indexOf('<USER_REQUEST>'))
  })

  test('无上下文块时不注入 SYSTEM_CONTEXT', () => {
    const envelope = buildAgentContextEnvelope({ userMessage: '你好' })
    expect(envelope).toBe('<USER_REQUEST>\n你好\n</USER_REQUEST>')
  })

  test('仅附件无正文时保留空 USER_REQUEST，不编造用户意图', () => {
    const envelope = buildAgentContextEnvelope({
      userMessage: '<attached_files>\n- a.pdf\n</attached_files>',
    })
    expect(envelope).toContain('<SYSTEM_CONTEXT>')
    expect(envelope).toContain('<attached_files>')
    expect(envelope).toContain('<USER_REQUEST>\n\n</USER_REQUEST>')
  })

  test('用户正文中的普通 XML 不被误剥离', () => {
    const envelope = buildAgentContextEnvelope({
      userMessage: '请解释 <bubble> 标签为什么不合法',
    })
    expect(envelope).toContain('请解释 <bubble> 标签为什么不合法')
  })
})
