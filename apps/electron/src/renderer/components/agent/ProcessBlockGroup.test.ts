import { describe, expect, test } from 'bun:test'
import { buildAssistantTurnRenderItems, buildProcessGroupToolNames } from './ProcessBlockGroup'
import type { SDKContentBlock } from '@profer/shared'

const tool = (id: string, name = 'Read'): SDKContentBlock => ({
  type: 'tool_use',
  id,
  name,
  input: {},
})

const askTool = (id = 'ask-1'): SDKContentBlock => tool(id, 'AskUserQuestion')

const thinking = (text = '分析中'): SDKContentBlock => ({
  type: 'thinking',
  thinking: text,
})

const text = (value: string): SDKContentBlock => ({
  type: 'text',
  text: value,
})

describe('Agent 过程块折叠分组', () => {
  test('given continuous thinking and tools before final text when grouping then folds them into one process group', () => {
    const items = buildAssistantTurnRenderItems([
      thinking(),
      tool('tool-1'),
      tool('tool-2'),
      text('最终输出'),
    ])

    expect(items).toHaveLength(2)
    expect(items[0]?.type).toBe('process-group')
    expect(items[1]?.type).toBe('block')
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0, 1, 2])
    }
  })

  test('given intermediate text between tool runs when grouping then keeps only final output outside process group', () => {
    const items = buildAssistantTurnRenderItems([
      tool('tool-1'),
      text('中间说明'),
      tool('tool-2'),
      text('最终输出'),
    ])

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0, 1, 2])
    }
    if (items[1]?.type === 'block') {
      expect(items[1].item.index).toBe(3)
    }
  })

  test('given streaming turn with trailing text when grouping then keeps the whole turn inside process group', () => {
    const items = buildAssistantTurnRenderItems([
      tool('tool-1'),
      text('可能还是中间说明'),
    ], { isStreaming: true })

    expect(items).toHaveLength(1)
    expect(items[0]?.type).toBe('process-group')
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0, 1])
    }
  })

  test('given streaming turn with completed tools before trailing text when grouping then keeps final output outside process group', () => {
    const items = buildAssistantTurnRenderItems([
      tool('tool-1'),
      text('最终输出'),
    ], { isStreaming: true, completedToolResultIds: new Set(['tool-1']) })

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0])
    }
    if (items[1]?.type === 'block') {
      expect(items[1].item.index).toBe(1)
    }
  })

  test('given keep expanded after complete when grouping then still keeps final output outside process group', () => {
    const items = buildAssistantTurnRenderItems([
      tool('tool-1'),
      text('最终输出'),
    ])

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
    expect(items[0]?.type).toBe('process-group')
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0])
    }
  })

  test('given pure text streaming turn when grouping then keeps text as normal output', () => {
    const items = buildAssistantTurnRenderItems([
      text('普通回答'),
    ], { isStreaming: true })

    expect(items).toHaveLength(1)
    expect(items[0]?.type).toBe('block')
  })

  test('given process only turn when grouping then folds the whole turn', () => {
    const items = buildAssistantTurnRenderItems([
      thinking(),
      tool('tool-1'),
    ])

    expect(items).toHaveLength(1)
    expect(items[0]?.type).toBe('process-group')
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0, 1])
    }
  })

  test('given streaming turn with thinking and no tools when grouping then displays the text outside the thinking group', () => {
    // 总文档要求：没有工具时，正文立即显示；思考仍可折叠，不造成假等待。
    const items = buildAssistantTurnRenderItems([
      thinking(),
      text('暂时的回答片段'),
    ], { isStreaming: true, completedToolResultIds: new Set() })

    expect(items).toHaveLength(2)
    expect(items[0]?.type).toBe('process-group')
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0])
    }
    expect(items[1]?.type).toBe('block')
    if (items[1]?.type === 'block') expect(items[1].item.block).toEqual(text('暂时的回答片段'))
  })

  test('given streaming multi-tool turn with only the last tool result pending when grouping then keeps final text outside process group', () => {
    // 修复「最终回复被折叠」：多工具长序列中最后一个工具结果晚到时，
    // 末尾 text 几乎可确定是最终回复，应外置而非整组折叠。
    const items = buildAssistantTurnRenderItems([
      tool('tool-1'),
      tool('tool-2'),
      tool('tool-3'),
      text('最终回复'),
    ], { isStreaming: true, completedToolResultIds: new Set(['tool-1', 'tool-2']) })

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0, 1, 2])
    }
    if (items[1]?.type === 'block') {
      expect(items[1].item.index).toBe(3)
    }
  })

  test('given streaming multi-tool turn with a non-last tool result pending when grouping then keeps the whole turn inside process group', () => {
    // 中间工具未完成：末尾 text 仍可能是给后续工具看的中间说明，保持折叠。
    const items = buildAssistantTurnRenderItems([
      tool('tool-1'),
      tool('tool-2'),
      text('可能的中间说明'),
    ], { isStreaming: true, completedToolResultIds: new Set(['tool-2']) })

    expect(items).toHaveLength(1)
    expect(items[0]?.type).toBe('process-group')
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0, 1, 2])
    }
  })

  test('given final answer followed by a trailing thinking block when grouping then keeps the answer outside the process group', () => {
    // 修复「最终回复被折叠」：真实流式数据里同一条 assistant 消息可能是 [text, thinking]
    // （reasoning 晚于正文到达），旧实现因末块不是 text 而把整段回复折叠成「执行过程」。
    const items = buildAssistantTurnRenderItems([
      text('这是最终回复'),
      thinking('收尾思考'),
    ])

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([1])
    }
    if (items[1]?.type === 'block') {
      expect(items[1].item.index).toBe(0)
    }
  })

  test('given final answer between steps and a trailing thinking block when grouping then only folds the process blocks', () => {
    // turn 内聚合后以 thinking 收尾时，正文仍然必须外置。
    const items = buildAssistantTurnRenderItems([
      thinking('开工思考'),
      text('最终回复'),
      thinking('收尾思考'),
    ])

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0, 2])
    }
    if (items[1]?.type === 'block') {
      expect(items[1].item.index).toBe(1)
    }
  })

  test('given intermediate text with later tools and a trailing thinking block when grouping then keeps the whole turn folded', () => {
    // 正文之后仍有 tool_use：这段 text 是给工具看的中间说明，继续整组折叠。
    const items = buildAssistantTurnRenderItems([
      text('中间说明'),
      thinking('中间思考'),
      tool('tool-1'),
      thinking('还在干活'),
    ])

    expect(items).toHaveLength(1)
    expect(items[0]?.type).toBe('process-group')
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0, 1, 2, 3])
    }
  })

  test('given trailing thinking before final answer when grouping then folds thinking and keeps answer outside', () => {
    const items = buildAssistantTurnRenderItems([
      tool('tool-1'),
      thinking('收尾思考'),
      text('最终回复'),
    ])

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0, 1])
    }
    if (items[1]?.type === 'block') {
      expect(items[1].item.index).toBe(2)
    }
  })

  test('given multi-block pure text answer when grouping then renders all text blocks as normal output', () => {
    const items = buildAssistantTurnRenderItems([
      text('第一段'),
      text('第二段'),
    ])

    expect(items.map((item) => item.type)).toEqual(['block', 'block'])
  })

  test('given repeated tools when building capability icons then returns unique tool names in order', () => {
    const toolNames = buildProcessGroupToolNames([
      tool('tool-1', 'Grep'),
      thinking(),
      tool('tool-2', 'Read'),
      tool('tool-3', 'Grep'),
      tool('tool-4', 'Bash'),
    ])

    expect(toolNames).toEqual(['Grep', 'Read', 'Bash'])
  })

  test('given text followed by AskUserQuestion when grouping then text is externalized and AskUser is silently hidden', () => {
    // grill-me 修复：AskUserQuestion 由底部横幅承接，消息流静默隐藏；
    // 「质询开场白 + AskUserQuestion」过滤后即纯正文，必须外置展示。
    const items = buildAssistantTurnRenderItems([
      text('我需要先弄清楚你的并发模型预期'),
      askTool(),
    ])

    expect(items).toHaveLength(1)
    expect(items[0]?.type).toBe('block')
    if (items[0]?.type === 'block') {
      expect(items[0].item.block).toEqual(text('我需要先弄清楚你的并发模型预期'))
    }
  })

  test('given streaming text followed by AskUserQuestion when grouping then text stays externalized during streaming', () => {
    const items = buildAssistantTurnRenderItems([
      text('我需要先弄清楚你的并发模型预期'),
      askTool(),
    ], { isStreaming: true, completedToolResultIds: new Set() })

    expect(items).toHaveLength(1)
    expect(items[0]?.type).toBe('block')
  })

  test('given thinking then text then AskUserQuestion when grouping then only thinking folds and text externalizes', () => {
    const items = buildAssistantTurnRenderItems([
      thinking('先分析背景'),
      text('质询正文'),
      askTool(),
    ])

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0])
    }
    if (items[1]?.type === 'block') {
      expect(items[1].item.index).toBe(1)
    }
  })

  test('given streaming text followed by trailing thinking when grouping then text externalizes even at index 0', () => {
    // 去除 textStartIndex > 0 硬阻碍的回归守卫：首段正文 + 尾随 thinking 流式期间也必须外置。
    const items = buildAssistantTurnRenderItems([
      text('首段正文'),
      thinking('收尾思考'),
    ], { isStreaming: true, completedToolResultIds: new Set() })

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([1])
    }
    if (items[1]?.type === 'block') {
      expect(items[1].item.index).toBe(0)
    }
  })
})
