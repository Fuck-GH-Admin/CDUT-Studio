import { describe, expect, test } from 'bun:test'
import {
  MAX_TITLE_LENGTH,
  planAutoTitle,
  SHORT_MESSAGE_THRESHOLD,
  TITLE_SOURCE_MAX_CHARS,
  TITLE_SOURCE_MAX_COUNT,
  buildTitlePrompt,
  buildWindowTitlePrompt,
  collectTitleSources,
  createFallbackTitle,
  createWindowFallbackTitle,
  evaluateTitleSource,
  sanitizeGeneratedTitle,
} from './title-generation'

/** Chat 与 Agent 统一后的唯一标题生成 prompt（精简单轮版）。 */
const UNIFIED_TITLE_PROMPT =
  'Based on the user\'s first request, distill a short, clear session title (no more than 10 characters) in the same language as the user\'s message. Output the title text itself only; never output any punctuation, quotation marks, book-title marks, or boilerplate prefixes like "Title:". If the request is a casual greeting or too short (e.g., "你好"), distill it as "日常问候". If the intent is unclear, directly take the first 10 meaningful characters of the user\'s message.\n\nUser message: '

describe('buildTitlePrompt', () => {
  test('Given 用户消息 When 构建 Then 使用 Chat/Agent 统一 prompt', () => {
    expect(buildTitlePrompt('帮我修复登录')).toBe(UNIFIED_TITLE_PROMPT + '帮我修复登录')
  })

  test('Given 多行用户消息 When 构建 Then 原样保留换行', () => {
    expect(buildTitlePrompt('第一行\n第二行')).toBe(UNIFIED_TITLE_PROMPT + '第一行\n第二行')
  })

  test('Given 任意长度消息 When 构建 Then 始终包含过短消息的本地处理约束', () => {
    expect(buildTitlePrompt('1')).toContain('If the request is a casual greeting or too short (e.g., "你好"), distill it as "日常问候"')
    expect(buildTitlePrompt('1')).toContain('directly take the first 10 meaningful characters')
  })
})

describe('sanitizeGeneratedTitle', () => {
  test('Given 字符串标题 When 清洗 Then 去首尾引号并保留正文', () => {
    expect(sanitizeGeneratedTitle('"直引号标题"')).toBe('直引号标题')
  })

  // 回归：内联副本的正则曾在编码往返中把 “”‘’ 退化成重复直引号，
  // 导致中文弯引号与书名号无法被剥离。收敛到共享模块后必须能正确剥离。
  test('Given 中文弯引号 When 清洗 Then 剥离弯引号', () => {
    expect(sanitizeGeneratedTitle('“修复 OAuth 登录”')).toBe('修复 OAuth 登录')
    expect(sanitizeGeneratedTitle('‘单引号标题’')).toBe('单引号标题')
  })

  test('Given 中文书名号 When 清洗 Then 剥离书名号', () => {
    expect(sanitizeGeneratedTitle('「标题」')).toBe('标题')
    expect(sanitizeGeneratedTitle('《标题》')).toBe('标题')
  })

  // 回归：部分 OpenAI 兼容端点把 message.content 返回为内容块数组，
  // 旧实现直接 .trim() 会抛异常并被 catch 静默丢弃标题。
  test('Given 内容块数组 When 清洗 Then 拼接 text 字段而不抛异常', () => {
    expect(sanitizeGeneratedTitle([
      { type: 'text', text: '修复' },
      { type: 'text', text: '登录问题' },
    ])).toBe('修复登录问题')
  })

  test('Given reasoning/thinking/tool 块含 text When 清洗 Then 只保留显式 text 块', () => {
    expect(sanitizeGeneratedTitle([
      { type: 'thinking', text: '让我先分析用户意图' },
      { type: 'reasoning', text: '再推理一下' },
      { type: 'toolCall', text: '工具调用内容' },
      { type: 'text', text: '登录修复' },
    ])).toBe('登录修复')
  })

  test('Given 内容块数组只有非文本类型 When 清洗 Then 返回 null', () => {
    expect(sanitizeGeneratedTitle([
      { type: 'thinking', text: '内部推理' },
      { type: 'toolCall', text: '工具内容' },
    ])).toBeNull()
  })

  test('Given 无 type 的兼容内容块 When 清洗 Then 保留 text 字段', () => {
    expect(sanitizeGeneratedTitle([{ text: '兼容标题' }])).toBe('兼容标题')
    expect(sanitizeGeneratedTitle({ text: '对象标题' })).toBe('对象标题')
  })

  test('Given 显式 text 块和无 type 块混合 When 清洗 Then 仅采用显式 text 块', () => {
    expect(sanitizeGeneratedTitle([
      { text: '非权威兼容文本' },
      { type: 'text', text: '权威标题' },
    ])).toBe('权威标题')
  })

  test('Given 单个非文本类型对象含 text When 清洗 Then 返回 null', () => {
    expect(sanitizeGeneratedTitle({ type: 'thinking', text: '内部推理' })).toBeNull()
  })

  test('Given 数组内块无 text 字段 When 清洗 Then 跳过该块', () => {
    expect(sanitizeGeneratedTitle([
      { type: 'toolCall' },
      { type: 'text', text: '标题' },
    ])).toBe('标题')
  })

  test('Given 非文本内容 When 清洗 Then 返回 null', () => {
    expect(sanitizeGeneratedTitle([{ type: 'toolCall' }])).toBeNull()
    expect(sanitizeGeneratedTitle('')).toBeNull()
    expect(sanitizeGeneratedTitle('""')).toBeNull()
    expect(sanitizeGeneratedTitle(null)).toBeNull()
    expect(sanitizeGeneratedTitle(undefined)).toBeNull()
  })

  // 回归：深度思考模型常把推理包进 <think>...</think>，标题必须剥离推理只留真实文本。
  test('Given 思考块包裹文本 When 清洗 Then 剥离 <think> 推理块', () => {
    expect(sanitizeGeneratedTitle('<think>让我分析用户意图</think>登录修复')).toBe('登录修复')
    expect(sanitizeGeneratedTitle('登录修复<thinking>内部推理</thinking>')).toBe('登录修复')
    expect(sanitizeGeneratedTitle('<reasoning>推理过程</reasoning>')).toBeNull()
  })

  // 回归：模型只返回推理、正文为空时，用首句本地兜底，绝不返回 null。
  test('Given 只有推理且传入来源 When 清洗 Then 回退首句本地兜底', () => {
    expect(sanitizeGeneratedTitle('<think>只有推理没有标题</think>', '\n\n修复登录缺陷\n细节')).toBe('修复登录缺陷')
    expect(sanitizeGeneratedTitle('', '修复登录缺陷')).toBe('修复登录缺陷')
  })

  test('Given 超长标题 When 清洗 Then 截断到 MAX_TITLE_LENGTH', () => {
    const long = '一'.repeat(50)
    expect(sanitizeGeneratedTitle(long)).toHaveLength(MAX_TITLE_LENGTH)
  })
})

describe('createFallbackTitle', () => {
  test('Given 多行消息 When 兜底 Then 取第一个非空行', () => {
    expect(createFallbackTitle('\n\n第一行主题\n第二行细节')).toBe('第一行主题')
  })

  test('Given Markdown 前缀 When 兜底 Then 去掉前缀与多余空白', () => {
    expect(createFallbackTitle('##   标题   内容  ')).toBe('标题 内容')
  })

  test('Given 超长首行 When 兜底 Then 截断到 MAX_TITLE_LENGTH', () => {
    expect(createFallbackTitle('一'.repeat(50))).toHaveLength(MAX_TITLE_LENGTH)
  })

  test('Given 空白消息 When 兜底 Then 返回 null', () => {
    expect(createFallbackTitle('   ')).toBeNull()
    expect(createFallbackTitle('')).toBeNull()
  })
})

describe('常量', () => {
  test('短消息阈值与标题长度保持既有取值', () => {
    expect(SHORT_MESSAGE_THRESHOLD).toBe(4)
    expect(MAX_TITLE_LENGTH).toBe(20)
  })
})

// ===== 命名来源收集（手动「重新生成标题」路径） =====

describe('evaluateTitleSource', () => {
  test('Given 纯斜杠命令 When 判定 Then 无信息量', () => {
    expect(evaluateTitleSource('/compact').informative).toBe(false)
    expect(evaluateTitleSource('/clear').informative).toBe(false)
    expect(evaluateTitleSource('  /compact  ').informative).toBe(false)
  })

  test('Given 斜杠命令带载荷 When 判定 Then 只取载荷', () => {
    const result = evaluateTitleSource('/compact 继续优化登录流程')
    expect(result.informative).toBe(true)
    expect(result.text).toBe('继续优化登录流程')
  })

  test('Given 路径形态消息 When 判定 Then 不当作命令剥离', () => {
    // `/Users/...` 与 `/tmp/x` 都不是命令，不能被剥成半截路径
    expect(evaluateTitleSource('/Users/mac/profer 这个目录').text).toBe('/Users/mac/profer 这个目录')
    expect(evaluateTitleSource('/tmp/x 这个文件').informative).toBe(true)
  })

  test('Given 寒暄/确认/催促 When 判定 Then 无信息量', () => {
    for (const message of ['hi', 'hello', '你好', '好的', '好的谢谢', '提交吧', '推送吧', '测试一下', '帮我看一下', '这个', '继续', '优化', 'ok', '嗯嗯', '？', '1', '   ']) {
      expect(evaluateTitleSource(message).informative).toBe(false)
    }
  })

  test('Given 有主题的消息 When 判定 Then 有信息量', () => {
    for (const message of ['修复流式缺陷', '帮我看一下这个bug', '继续优化顶栏高度', '别测了是1M', '这个怎么改', '优化一下顶栏高度']) {
      expect(evaluateTitleSource(message).informative).toBe(true)
    }
  })

  test('Given 注入上下文块 When 判定 Then 先剥离再判断', () => {
    const withAttachmentOnly = '<attached_files>\n/x/a.png\n</attached_files>'
    expect(evaluateTitleSource(withAttachmentOnly).informative).toBe(false)

    const withPayload = '<attached_files>\n/x/a.png\n</attached_files>\n\n帮我改这个组件'
    expect(evaluateTitleSource(withPayload)).toEqual({ text: '帮我改这个组件', informative: true })
  })

  // 回归：SYSTEM_CONTEXT 连内容剥离，USER_REQUEST 只去标签保留正文。
  test('Given 新消息封装 When 判定 Then 不把系统上下文当主题', () => {
    const packaged = [
      '<SYSTEM_CONTEXT>',
      '<document_evidence>',
      '第1页：这份材料讲的是热力学',
      '</document_evidence>',
      '</SYSTEM_CONTEXT>',
      '',
      '<USER_REQUEST>',
      '修复登录流程',
      '</USER_REQUEST>',
    ].join('\n')

    expect(evaluateTitleSource(packaged)).toEqual({ text: '修复登录流程', informative: true })
    expect(evaluateTitleSource('<SYSTEM_CONTEXT>\n<document_evidence>材料</document_evidence>\n</SYSTEM_CONTEXT>').informative).toBe(false)
  })

  test('Given 划词引用块 When 判定 Then 剥离引用后保留用户正文', () => {
    const withQuote = '<quoted_context source="agent-history" label="Agent 历史">\n被引用内容\n</quoted_context>\n\n继续任务'
    expect(evaluateTitleSource(withQuote)).toEqual({ text: '继续任务', informative: true })
  })

  test('Given 调度标记 When 判定 Then 剥离后正常判断', () => {
    const result = evaluateTitleSource('<!--PROMA_SCHEDULED_RUN-->巡检线上错误日志')
    expect(result).toEqual({ text: '巡检线上错误日志', informative: true })
  })
})

describe('collectTitleSources', () => {
  test('Given 混入命令与寒暄 When 收集 Then 只留有效来源', () => {
    expect(collectTitleSources(['你好', '/compact', 'ok，现在继续转战未来规划类', '修复流式缺陷']))
      .toEqual(['ok，现在继续转战未来规划类', '修复流式缺陷'])
  })

  test('Given 重复消息 When 收集 Then 按归一化文本去重', () => {
    expect(collectTitleSources(['修复流式缺陷', '修复流式缺陷！'])).toEqual(['修复流式缺陷'])
  })

  test('Given 超长来源 When 收集 Then 截断到 TITLE_SOURCE_MAX_CHARS', () => {
    const long = `修复流式缺陷${'补'.repeat(TITLE_SOURCE_MAX_CHARS + 50)}`
    const sources = collectTitleSources([long])
    expect(sources[0]).toHaveLength(TITLE_SOURCE_MAX_CHARS)
  })

  test('Given 超过条数上限 When 收集 Then 只取最早的几条', () => {
    const messages = Array.from({ length: 10 }, (_, i) => `第${i}个有主题的任务描述`)
    expect(collectTitleSources(messages)).toHaveLength(TITLE_SOURCE_MAX_COUNT)
  })

  test('Given 全是寒暄 When 收集 Then 返回空数组（不命名）', () => {
    expect(collectTitleSources(['hi', '你好', '提交吧'])).toEqual([])
  })
})

describe('buildWindowTitlePrompt', () => {
  test('Given 多条来源 When 构建 Then 编号列出且禁止照抄原文', () => {
    const prompt = buildWindowTitlePrompt(['修复流式缺陷', '顶栏控件遮罩'])
    expect(prompt).toContain('1. 修复流式缺陷')
    expect(prompt).toContain('2. 顶栏控件遮罩')
    expect(prompt).toContain('never copy the verbatim text of one message')
  })
})

describe('createWindowFallbackTitle', () => {
  test('Given 多条来源 When 兜底 Then 取最早一条的首行', () => {
    expect(createWindowFallbackTitle(['\n第一行主题\n第二行细节', '另一条主题'])).toBe('第一行主题')
  })

  test('Given 空来源 When 兜底 Then 返回 null', () => {
    expect(createWindowFallbackTitle([])).toBeNull()
  })
})

// ===== 自动命名首轮单次裁决（Chat 与 Agent 共用的唯一决策入口） =====

describe('planAutoTitle', () => {
  const base = { title: '新 Agent 会话', defaultTitle: '新 Agent 会话' }

  test('Given 首轮默认标题 When 决策 Then 生成一次', () => {
    expect(planAutoTitle(base)).toEqual({ action: 'generate', reason: 'default' })
  })

  test('Given 已定稿 When 决策 Then 短路跳过（后续轮次不再命名）', () => {
    expect(planAutoTitle({ ...base, titleLockedAt: 1 })).toEqual({ action: 'skip', reason: 'locked' })
  })

  test('Given 已自动命名过 When 决策 Then 短路跳过（首轮已生成，后续不再变动）', () => {
    expect(planAutoTitle({ ...base, titleAutoGeneratedAt: 100 })).toEqual({ action: 'skip', reason: 'auto-generated' })
  })

  test('Given 标题由用户手动命名 When 决策 Then 跳过且不覆盖', () => {
    expect(planAutoTitle({ ...base, title: '我的名字' })).toEqual({ action: 'skip', reason: 'human-named' })
  })

  test('Given 探索分支继承父标题 When 允许非默认标题 Then 仍可命名', () => {
    const input = { ...base, title: '父会话 (fork)', allowNonDefaultTitle: true }
    expect(planAutoTitle(input)).toEqual({ action: 'generate', reason: 'exploration' })
    expect(planAutoTitle({ ...input, allowNonDefaultTitle: false }))
      .toEqual({ action: 'skip', reason: 'human-named' })
  })
})
