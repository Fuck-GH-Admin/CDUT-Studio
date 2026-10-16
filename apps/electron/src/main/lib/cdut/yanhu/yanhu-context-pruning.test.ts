/**
 * 智联万站 · 多步工具循环上下文剪枝（yanhu-context-pruning）单元测试
 *
 * 覆盖：步骤不足时原样返回、超限时仅压缩旧步骤、更早的 read_page 巨型结果被替换为占位提示、
 * 最近一次观测结果（read_page / capture_visual）逐字保留、通用结果截断、
 * toolCallId / isError 完整性保留、keepSteps 可配置。
 */

import { describe, expect, test } from 'bun:test'
import type { ContinuationMessage } from '@profer/core'
import {
  HISTORY_ERROR_MAX_CHARS,
  HISTORY_RESULT_MAX_CHARS,
  PRUNE_KEEP_STEPS,
  pruneYanhuContinuationMessages,
  slimYanhuToolResultForHistory,
} from './yanhu-context-pruning'

/** 构造一步：assistant(工具调用) + tool(结果) */
function buildStep(
  stepNo: number,
  toolName: string,
  toolResult: string,
  isError = false,
): [ContinuationMessage, ContinuationMessage] {
  const id = `call-${stepNo}`
  return [
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id, name: toolName, arguments: {} }],
    },
    { role: 'tool', results: [{ toolCallId: id, content: toolResult, isError }] },
  ]
}

describe('pruneYanhuContinuationMessages（多步上下文剪枝）', () => {
  test('步骤数不超过 keepSteps 时原样返回', () => {
    const messages = [...buildStep(1, 'yanhu_read_page', 'A'), ...buildStep(2, 'yanhu_click', 'B')]
    const pruned = pruneYanhuContinuationMessages(messages)
    expect(pruned).toHaveLength(4)
    expect((pruned[1] as { results: Array<{ content: string }> }).results[0]?.content).toBe('A')
  })

  test('超过 keepSteps 时最旧步骤被压缩，保留窗口内步骤原样', () => {
    const messages = [
      ...buildStep(1, 'yanhu_read_page', '超长页面观察……'.repeat(50)),
      ...buildStep(2, 'yanhu_get_network_logs', 'HTTP 日志……'.repeat(50)),
      ...buildStep(3, 'yanhu_read_page', '最新的页面观察台账'),
      ...buildStep(4, 'yanhu_click', 'ok-4'),
    ]
    const pruned = pruneYanhuContinuationMessages(messages)
    expect(pruned).toHaveLength(8)

    // 第 1 步（最旧）：read_page → 压缩为占位提示（更晚的第 3 步已有更新的台账）
    const step1Tool = pruned[1] as { results: Array<{ content: string; toolCallId: string }> }
    expect(step1Tool.results[0]?.content).toContain('较早的页面观察记录已压缩')
    expect(step1Tool.results[0]?.toolCallId).toBe('call-1')

    // 第 2 步：network_logs → 日志压缩
    const step2Tool = pruned[3] as { results: Array<{ content: string }> }
    expect(step2Tool.results[0]?.content).toBe('[前序日志已压缩]')

    // 第 3、4 步（保留窗口内）：原样保留
    expect((pruned[5] as { results: Array<{ content: string }> }).results[0]?.content).toBe('最新的页面观察台账')
    expect((pruned[7] as { results: Array<{ content: string }> }).results[0]?.content).toBe('ok-4')
  })

  test('最近一次 read_page 台账即便远离保留窗口也逐字保留（杜绝模型失去 [BID] 台账）', () => {
    const ledger = '=== [PageDigest: 学生请假] ===\n- [BID: 8] textbox "请假开始时间"'
    const messages = [
      ...buildStep(1, 'yanhu_read_page', ledger),
      ...buildStep(2, 'yanhu_fill', 'ok-2'),
      ...buildStep(3, 'yanhu_fill', 'ok-3'),
      ...buildStep(4, 'yanhu_fill', 'ok-4'),
      ...buildStep(5, 'yanhu_click', 'ok-5'),
    ]
    const pruned = pruneYanhuContinuationMessages(messages)
    // 第 1 步的 read_page 是全场唯一观测结果：必须完整保留，否则模型无从得知任何 [BID]
    expect((pruned[1] as { results: Array<{ content: string }> }).results[0]?.content).toBe(ledger)
  })

  test('最近一次 capture_visual 标定表同样被保留（供后续视觉点击换算）', () => {
    const calibration = '地标：u=301,v=345 → x=489,y=300'
    const messages = [
      ...buildStep(1, 'yanhu_capture_visual', calibration),
      ...buildStep(2, 'yanhu_fill', 'ok-2'),
      ...buildStep(3, 'yanhu_fill', 'ok-3'),
      ...buildStep(4, 'yanhu_click', 'ok-4'),
    ]
    const pruned = pruneYanhuContinuationMessages(messages)
    expect((pruned[1] as { results: Array<{ content: string }> }).results[0]?.content).toBe(calibration)
  })

  test('通用长结果被截断至 80 字符并追加省略号', () => {
    const longResult = 'X'.repeat(200)
    const messages = [
      ...buildStep(1, 'yanhu_inspect_element', longResult),
      ...buildStep(2, 'yanhu_click', 'a'),
      ...buildStep(3, 'yanhu_click', 'b'),
    ]
    const pruned = pruneYanhuContinuationMessages(messages)
    const step1Tool = pruned[1] as { results: Array<{ content: string }> }
    expect(step1Tool.results[0]?.content).toBe(`${'X'.repeat(80)}…`)
  })

  test('isError 标志在压缩后保持完整', () => {
    const messages = [
      ...buildStep(1, 'yanhu_read_page', 'boom', true),
      ...buildStep(2, 'yanhu_read_page', 'later'),
      ...buildStep(3, 'yanhu_click', 'a'),
      ...buildStep(4, 'yanhu_click', 'b'),
    ]
    const pruned = pruneYanhuContinuationMessages(messages)
    const step1Tool = pruned[1] as { results: Array<{ isError?: boolean }> }
    expect(step1Tool.results[0]?.isError).toBe(true)
  })

  test('keepSteps 可配置：keepSteps=1 时压缩更早的步骤，但最新台账仍保留', () => {
    const messages = [
      ...buildStep(1, 'yanhu_read_page', 'p1'),
      ...buildStep(2, 'yanhu_read_page', 'p2'),
      ...buildStep(3, 'yanhu_click', 'ok'),
    ]
    const pruned = pruneYanhuContinuationMessages(messages, { keepSteps: 1 })
    // 第 1 步被压缩（更晚的第 2 步已有更新台账）
    expect((pruned[1] as { results: Array<{ content: string }> }).results[0]?.content).toContain(
      '较早的页面观察记录已压缩',
    )
    // 第 2 步是全场最新观测：即便超出 keepSteps=1 的窗口也必须逐字保留
    expect((pruned[3] as { results: Array<{ content: string }> }).results[0]?.content).toBe('p2')
    expect((pruned[5] as { results: Array<{ content: string }> }).results[0]?.content).toBe('ok')
  })

  test('默认保留步数为 2', () => {
    expect(PRUNE_KEEP_STEPS).toBe(2)
  })
})

describe('slimYanhuToolResultForHistory（跨轮次历史脱敏瘦身）', () => {
  test('巨型 PageDigest 被压为「已读取页面: 标题」单行摘要', () => {
    const giant = `=== [PageDigest: 砚湖易办] ===\nURL: https://jw.cdut.edu.cn/x\n${'- [BID: 1] link "查询"\n'.repeat(800)}`
    expect(slimYanhuToolResultForHistory('yanhu_read_page', giant)).toBe('[已读取页面: 砚湖易办]')
  })

  test('未变化提示被压为无变化摘要', () => {
    const notice = '=== [PageDigest: 页面无变化] ===\n当前页面与上一次观察完全一致'
    expect(slimYanhuToolResultForHistory('yanhu_read_page', notice)).toBe('[已读取页面: 无变化]')
  })

  test('无标题 PageDigest 回退为通用摘要', () => {
    expect(slimYanhuToolResultForHistory('yanhu_read_page', '随便一段文本')).toBe('[已读取页面]')
  })

  test('网络 / 控制台日志被替换为折叠摘要', () => {
    expect(slimYanhuToolResultForHistory('yanhu_get_network_logs', 'x'.repeat(5000))).toBe('[网络日志已折叠]')
    expect(slimYanhuToolResultForHistory('yanhu_get_console_logs', 'y'.repeat(5000))).toBe('[控制台日志已折叠]')
  })

  test('错误回执绝不套用成功态摘要模板（熔断 / 失败诊断必须保留）', () => {
    // 真实事故：read_page 的熔断提示不含 PageDigest 头，被压成 `[已读取页面]`，
    // 模型重启后从历史里只看到这句废话，只能靠猜。
    const notice = '【熔断拦截】当前页面与上一状态完全一致且未执行任何交互操作，禁止重复刷新读取！请直接使用已有 [BID] 执行点击、选择等操作，或向用户汇报结果。'
    expect(slimYanhuToolResultForHistory('yanhu_read_page', notice, true)).toBe(notice)
    // 成功态仍走原摘要模板
    expect(slimYanhuToolResultForHistory('yanhu_read_page', '随便一段文本', false)).toBe('[已读取页面]')
  })

  test('错误回执按更大的上限截断（保住完整诊断，而非 200 字的通用上限）', () => {
    const long = `选择失败：${'诊'.repeat(1000)}`
    const slimmed = String(slimYanhuToolResultForHistory('yanhu_select', long, true))
    expect(slimmed.length).toBe(HISTORY_ERROR_MAX_CHARS + 1)
    expect(slimmed.startsWith('选择失败：')).toBe(true)
  })

  test('通用超长结果被截断，短结果原样保留', () => {
    const long = 'Z'.repeat(HISTORY_RESULT_MAX_CHARS + 50)
    const slimmed = slimYanhuToolResultForHistory('yanhu_eval_script', long)
    expect(String(slimmed)).toBe(`${'Z'.repeat(HISTORY_RESULT_MAX_CHARS)}…`)
    expect(slimYanhuToolResultForHistory('yanhu_click', '已点击成功')).toBe('已点击成功')
  })
})
