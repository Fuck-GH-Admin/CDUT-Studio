/**
 * 长期记忆审核器测试
 *
 * 覆盖：提示词隔离性、上下文截断、裁决解析容错（含思考模型推理块）、
 * 以及 complete 闭包的成功 / 空响应 / 异常降级。
 */

import { describe, expect, test } from 'bun:test'
import type { LongTermMemoryNodeInput } from '@profer/shared'
import {
  MAX_AUDIT_CONTEXT_CHARS,
  MEMORY_AUDIT_MAX_TOKENS,
  MEMORY_AUDIT_SYSTEM_PROMPT,
  auditLongTermMemoryCandidate,
  buildMemoryAuditPrompt,
  parseMemoryAuditVerdict,
} from './longterm-memory-auditor'

const candidate: LongTermMemoryNodeInput = {
  category: 'coding_preference',
  title: '状态管理统一用 Jotai',
  content: '以后都用 Jotai 管理状态',
  tags: ['jotai'],
  confidence: 0.65,
}

describe('审核提示词隔离', () => {
  test('Given 构建审核提示词，Then system 只含审核规则且不携带任何 Agent 上下文', () => {
    const prompt = buildMemoryAuditPrompt({ candidate, userMessage: '以后都用 Jotai 管理状态' })

    expect(prompt.systemPrompt).toBe(MEMORY_AUDIT_SYSTEM_PROMPT)
    expect(prompt.systemPrompt).not.toContain('CDUT Studio')
    expect(prompt.systemPrompt).not.toContain('<SYSTEM_CONTEXT>')
    expect(prompt.systemPrompt).not.toContain('<USER_REQUEST>')
    expect(prompt.systemPrompt).not.toContain('workspace')
    expect(prompt.maxTokens).toBe(MEMORY_AUDIT_MAX_TOKENS)
  })

  test('Given 候选与用户原文，Then userPrompt 结构化包含全部字段并用 XML 界定原文', () => {
    const prompt = buildMemoryAuditPrompt({ candidate, userMessage: '以后都用 Jotai 管理状态' })

    expect(prompt.userPrompt).toContain('- Category: coding_preference')
    expect(prompt.userPrompt).toContain('- Title: 状态管理统一用 Jotai')
    expect(prompt.userPrompt).toContain('- Content: 以后都用 Jotai 管理状态')
    expect(prompt.userPrompt).toContain('- Tags: jotai')
    expect(prompt.userPrompt).toContain('<user_message_context>\n以后都用 Jotai 管理状态\n</user_message_context>')
  })

  test('Given 超长用户消息，Then 上下文被截断到上限', () => {
    const prompt = buildMemoryAuditPrompt({
      candidate,
      userMessage: 'x'.repeat(MAX_AUDIT_CONTEXT_CHARS + 200),
    })

    expect(prompt.userPrompt).toContain('x'.repeat(MAX_AUDIT_CONTEXT_CHARS))
    expect(prompt.userPrompt).not.toContain('x'.repeat(MAX_AUDIT_CONTEXT_CHARS + 1))
  })
})

describe('审核裁决解析', () => {
  test('Given 标准通过 JSON，Then 解析为 approved', () => {
    expect(parseMemoryAuditVerdict('{"approved": true, "reason": "durable rule"}')).toEqual({
      status: 'approved',
      reason: 'durable rule',
    })
  })

  test('Given 标准拒绝 JSON，Then 解析为 rejected', () => {
    expect(parseMemoryAuditVerdict('{"approved": false, "reason": "one-time task"}')).toEqual({
      status: 'rejected',
      reason: 'one-time task',
    })
  })

  test('Given markdown 围栏与前后解释文字，Then 仍能提取裁决', () => {
    expect(parseMemoryAuditVerdict('Verdict:\n```json\n{"approved": true, "reason": "ok"}\n```\nDone')).toEqual({
      status: 'approved',
      reason: 'ok',
    })
  })

  test('Given 已闭合的思考块，Then 剥离后解析正文裁决', () => {
    expect(parseMemoryAuditVerdict('<think>long reasoning</think>{"approved": false, "reason": "question"}')).toEqual({
      status: 'rejected',
      reason: 'question',
    })
  })

  test('Given 未闭合的思考前缀，Then 仍从残留 JSON 中解析', () => {
    expect(parseMemoryAuditVerdict('<think>budget exhausted before closing {"approved": true, "reason": "ok"}')).toEqual({
      status: 'approved',
      reason: 'ok',
    })
  })

  test('Given 缺少 reason，Then 使用默认文案', () => {
    expect(parseMemoryAuditVerdict('{"approved": true}')).toEqual({ status: 'approved', reason: '审核通过' })
  })

  test('Given approved 非布尔，Then 判定审核不可用', () => {
    expect(parseMemoryAuditVerdict('{"approved": "yes", "reason": "x"}').status).toBe('unavailable')
  })

  test('Given 空响应 / 非法 JSON，Then 判定审核不可用', () => {
    expect(parseMemoryAuditVerdict(null).status).toBe('unavailable')
    expect(parseMemoryAuditVerdict('   ').status).toBe('unavailable')
    expect(parseMemoryAuditVerdict('no json here').status).toBe('unavailable')
    expect(parseMemoryAuditVerdict('{"approved": tru').status).toBe('unavailable')
  })
})

describe('审核执行', () => {
  test('Given complete 返回裁决文本，Then 透传 approved 并携带完整参数', async () => {
    let received: { systemPrompt: string; userPrompt: string; maxTokens: number } | null = null
    const verdict = await auditLongTermMemoryCandidate({
      candidate,
      userMessage: '以后都用 Jotai 管理状态',
      complete: async (args) => {
        received = args
        return '{"approved": true, "reason": "durable rule"}'
      },
    })

    expect(verdict.status).toBe('approved')
    expect(received!.systemPrompt).toBe(MEMORY_AUDIT_SYSTEM_PROMPT)
    expect(received!.maxTokens).toBe(MEMORY_AUDIT_MAX_TOKENS)
  })

  test('Given complete 返回 null，Then 降级为 unavailable', async () => {
    const verdict = await auditLongTermMemoryCandidate({
      candidate,
      userMessage: '以后都用 Jotai 管理状态',
      complete: async () => null,
    })

    expect(verdict.status).toBe('unavailable')
  })

  test('Given complete 抛出异常，Then 降级为 unavailable 而非向上抛错', async () => {
    const verdict = await auditLongTermMemoryCandidate({
      candidate,
      userMessage: '以后都用 Jotai 管理状态',
      complete: async () => {
        throw new Error('network down')
      },
    })

    expect(verdict.status).toBe('unavailable')
    expect(verdict.reason).toContain('network down')
  })
})
