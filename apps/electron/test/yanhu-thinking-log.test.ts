/**
 * 砚小龙 · 思考链落盘（yanhu-thinking-log）单元测试
 *
 * 覆盖：思考正文与工具结果的按上限截断、JSONL 单行可还原、追加式落盘（两轮 = 两行）。
 */

import { describe, expect, it } from 'bun:test'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendYanhuThinkingRecord,
  buildYanhuThinkingRecord,
  MAX_THINKING_REASONING_CHARS,
  MAX_THINKING_TOOL_RESULT_CHARS,
  serializeYanhuThinkingRecord,
} from '../src/main/lib/cdut/yanhu/yanhu-thinking-log'

describe('buildYanhuThinkingRecord（思考链记录组装）', () => {
  it('Given 正常输入 When 组装 Then 保留提问 / 思考 / 工具时间线', () => {
    const record = buildYanhuThinkingRecord({
      messageId: 'yanhu-msg-1',
      userText: '我要请个假',
      reasoning: '先读页面，再点我要请假。',
      tools: [{ label: '⚡ 正在读取页面', status: 'success', result: '[已读取页面: 学生请假]' }],
      at: 1792148000000,
    })
    expect(record.at).toBe(1792148000000)
    expect(record.messageId).toBe('yanhu-msg-1')
    expect(record.userText).toBe('我要请个假')
    expect(record.reasoning).toBe('先读页面，再点我要请假。')
    expect(record.tools).toEqual([
      { label: '⚡ 正在读取页面', status: 'success', result: '[已读取页面: 学生请假]' },
    ])
  })

  it('Given 超长思考 When 组装 Then 按上限截断并标记原始长度（绝不静默丢内容）', () => {
    const record = buildYanhuThinkingRecord({
      messageId: 'yanhu-msg-2',
      userText: 'q',
      reasoning: 'x'.repeat(MAX_THINKING_REASONING_CHARS + 500),
    })
    expect(record.reasoning.length).toBeGreaterThan(MAX_THINKING_REASONING_CHARS)
    expect(record.reasoning).toContain(`已截断：原始 ${MAX_THINKING_REASONING_CHARS + 500} 字符`)
  })

  it('Given 工具结果超长 When 组装 Then 逐条截断，思考本体不受影响', () => {
    const record = buildYanhuThinkingRecord({
      messageId: 'yanhu-msg-3',
      userText: 'q',
      reasoning: 'ok',
      tools: [{ label: '👆 点击 [3]', status: 'error', result: 'y'.repeat(2000) }],
    })
    expect(record.reasoning).toBe('ok')
    expect(record.tools[0]?.result.startsWith('y'.repeat(MAX_THINKING_TOOL_RESULT_CHARS))).toBe(true)
    expect(record.tools[0]?.result).toContain('已截断')
  })

  it('Given 缺省工具时间线 When 组装 Then 为空数组而非 undefined', () => {
    const record = buildYanhuThinkingRecord({ messageId: 'm', userText: 'q', reasoning: 'r' })
    expect(record.tools).toEqual([])
  })
})

describe('serializeYanhuThinkingRecord（JSONL 单行契约）', () => {
  it('Given 记录 When 序列化 Then 恰好一行且可被 JSON.parse 完整还原', () => {
    const record = buildYanhuThinkingRecord({
      messageId: 'yanhu-msg-4',
      userText: '换行\n与"引号"',
      reasoning: '第一行\n第二行',
      tools: [{ label: 'a', status: 'success', result: 'b' }],
      at: 1,
    })
    const line = serializeYanhuThinkingRecord(record)
    expect(line.endsWith('\n')).toBe(true)
    expect(line.trimEnd().split('\n')).toHaveLength(1)
    expect(JSON.parse(line)).toEqual(record)
  })
})

describe('appendYanhuThinkingRecord（追加式落盘）', () => {
  it('Given 连续两轮 When 追加 Then 文件为两行且各自可解析', async () => {
    const filePath = join(tmpdir(), `yanhu-thinking-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`)
    try {
      await appendYanhuThinkingRecord(
        buildYanhuThinkingRecord({ messageId: 'm1', userText: 'u1', reasoning: 'r1', at: 1 }),
        filePath,
      )
      await appendYanhuThinkingRecord(
        buildYanhuThinkingRecord({ messageId: 'm2', userText: 'u2', reasoning: 'r2', at: 2 }),
        filePath,
      )
      const lines = (await readFile(filePath, 'utf8')).trimEnd().split('\n')
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0]!).messageId).toBe('m1')
      expect(JSON.parse(lines[1]!).reasoning).toBe('r2')
    } finally {
      await rm(filePath, { force: true })
    }
  })

  it('Given 目标路径不可写 When 追加 Then 静默告警，绝不抛错影响对话', async () => {
    // 指向一个不可能创建的路径（把文件当目录用）
    const broken = join(tmpdir(), `yanhu-not-a-dir-${Date.now()}`, 'x.jsonl')
    await expect(
      appendYanhuThinkingRecord(
        buildYanhuThinkingRecord({ messageId: 'm', userText: 'u', reasoning: 'r' }),
        broken,
      ),
    ).resolves.toBeUndefined()
  })
})
