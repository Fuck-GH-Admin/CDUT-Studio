/**
 * 智联万站 · 专属门禁工具集（yanhu-browser-tools）单元测试
 *
 * 覆盖：门禁工具集装配、微胶囊标签生成、
 * 嵌套框架内页防扯脱守卫（严禁在 xsMainV 下直接导航子框架 URL）。
 */

import { describe, expect, test } from 'bun:test'
import type { YanhuBidNode, YanhuNetworkEntry } from '@profer/shared'
import type { ContinuationMessage } from '@profer/core'
import {
  asInt,
  buildEmapTreeSelectScript,
  buildForceTriggerScript,
  buildHardwareClickTargetScript,
  buildJqxSelectScript,
  buildOpenDropdownScript,
  buildPickCustomOptionScript,
  buildTreeItemCommitScript,
  buildUnchangedNotice,
  buildYanhuBrowserTools,
  createYanhuToolLabeler,
  DEFAULT_READ_PAGE_TOKENS,
  enforceYanhuHumanInterval,
  relocateBySemantics,
  resetYanhuActionThrottle,
  sanitizeYanhuNetworkLogs,
  stripDecorators,
  URL_DECORATORS,
  YANHU_ACTION_MIN_INTERVAL_MS,
} from './yanhu-browser-tools'
import {
  buildYanhuCollectorScript,
  normalizeStateString,
  yanhuDomDistillationEngine,
  type YanhuCollectedPage,
} from './yanhu-dom-distillation'
import {
  YANHU_CAUSAL_OBSERVATION_MS,
  YANHU_STABILIZE_WINDOW_MS,
  YanhuDeadlockGuard,
} from './yanhu-stabilization'
import { pruneYanhuContinuationMessages } from './yanhu-context-pruning'
import { buildOneTimeTicketSanitizeScript, buildSyntheticEnterScript, yanhuExpressManager } from './yanhu-express-manager'
import { hasOneTimeTicket, stripOneTimeTicket } from './yanhu-constants'

/**
 * 测试替身：为交互工具装配「因果边命中」的最小桩。
 *
 * 真实路径下点击后的因果探测会等待 2s 观察窗并在零因果边时升级 CDP 硬件级，
 * 单测环境无真实页面，故直接桩定「跨 Frame DOM 突变命中」，聚焦工具层编排契约。
 * 返回恢复函数，务必在 finally 中调用。
 */
function stubYanhuCausalityEdge(): () => void {
  const originalProbe = yanhuExpressManager.probeCrossFrameActivity
  const originalStable = yanhuExpressManager.awaitStable
  yanhuExpressManager.probeCrossFrameActivity = async () => ({
    settled: true,
    mutated: true,
    mutations: 1,
    frames: 1,
    elapsedMs: 5,
  })
  yanhuExpressManager.awaitStable = async () => ({
    settled: true,
    timedOut: false,
    elapsedMs: 5,
    inflight: 0,
    frames: 1,
    mutations: 0,
    lastActivityAt: 0,
  })
  return () => {
    yanhuExpressManager.probeCrossFrameActivity = originalProbe
    yanhuExpressManager.awaitStable = originalStable
  }
}

describe('YanhuBrowserTools（门禁工具集与防扯脱守卫）', () => {
  test('装配全部 14 项门禁工具并正确标记开发者级能力', () => {
    const tools = buildYanhuBrowserTools(() => 'tab-mock-1')
    expect(tools).toHaveLength(14)

    const toolNames = tools.map((t) => t.definition.name)
    expect(toolNames).toContain('yanhu_read_page')
    expect(toolNames).toContain('yanhu_click')
    expect(toolNames).toContain('yanhu_fill')
    expect(toolNames).toContain('yanhu_select')
    expect(toolNames).not.toContain('yanhu_set_date')
    expect(toolNames).toContain('yanhu_scroll')
    expect(toolNames).toContain('yanhu_navigate')
    expect(toolNames).toContain('yanhu_go_back')
    expect(toolNames).toContain('yanhu_go_forward')
    expect(toolNames).toContain('yanhu_reload')
    expect(toolNames).toContain('yanhu_eval_script')
    expect(toolNames).toContain('yanhu_inspect_element')
    expect(toolNames).toContain('yanhu_get_network_logs')
    expect(toolNames).toContain('yanhu_get_console_logs')
    expect(toolNames).toContain('yanhu_tab_actions')

    const devTools = tools.filter((t) => t.developer)
    expect(devTools.map((t) => t.definition.name)).toEqual([
      'yanhu_eval_script',
      'yanhu_inspect_element',
      'yanhu_get_network_logs',
      'yanhu_get_console_logs',
    ])
  })

  test('createYanhuToolLabeler 正确生成微胶囊标签', () => {
    const tools = buildYanhuBrowserTools(() => 'tab-mock-1')
    const labelOf = createYanhuToolLabeler(tools)

    expect(labelOf('yanhu_read_page', {})).toBe('⚡ 正在读取页面')
    expect(labelOf('yanhu_click', { bid: 3 })).toBe('👆 点击 [3]')
    expect(labelOf('yanhu_fill', { bid: 5, value: 'hello' })).toBe('⌨ 填写 [5]')
    expect(labelOf('yanhu_select', { bid: 2, valueOrText: '2025' })).toBe('🔽 选择 [2]')
    expect(labelOf('yanhu_scroll', { direction: 'down' })).toBe('🖱 滚动页面（down）')
    expect(labelOf('unknown_tool', {})).toBe('unknown_tool')
  })

  test('yanhu_navigate 多层框架智能承接：在 xsMainV 下将子页面平滑载入 mainFrame（免撕裂）', async () => {
    // 模拟当前标签处于教务主框架 xsMainV.htmlx
    const originalGetTabMeta = yanhuExpressManager.getTabMeta.bind(yanhuExpressManager)
    const originalEval = yanhuExpressManager.evalInPage
    yanhuExpressManager.getTabMeta = () => ({
      id: 'tab-frameset-1',
      url: 'https://jw.cdut.edu.cn/jsxsd/framework/xsMainV.htmlx',
      title: '教务系统主框架',
      loading: false,
      canGoBack: false,
      canGoForward: false,
    })
    // mainFrame 核心业务框架可用：路由脚本命中
    yanhuExpressManager.evalInPage = async () => ({ ok: true, redirectedInFrame: true })

    try {
      const tools = buildYanhuBrowserTools(() => 'tab-frameset-1')
      const navTool = tools.find((t) => t.definition.name === 'yanhu_navigate')!
      expect(navTool).toBeDefined()

      const result = await navTool.execute({
        url: 'https://jw.cdut.edu.cn/jsxsd/xskb/xskb_list.do',
      })

      expect(result.isError).toBeFalsy()
      expect(result.content).toContain('mainFrame')
      expect(result.content).toContain('平滑载入')
    } finally {
      yanhuExpressManager.getTabMeta = originalGetTabMeta
      yanhuExpressManager.evalInPage = originalEval
    }
  })

  test('yanhu_navigate 多层框架智能承接：无可用 mainFrame 时给出明确拦截指引', async () => {
    const originalGetTabMeta = yanhuExpressManager.getTabMeta.bind(yanhuExpressManager)
    const originalEval = yanhuExpressManager.evalInPage
    yanhuExpressManager.getTabMeta = () => ({
      id: 'tab-frameset-2',
      url: 'https://jw.cdut.edu.cn/jsxsd/framework/xsMainV.htmlx',
      title: '教务系统主框架',
      loading: false,
      canGoBack: false,
      canGoForward: false,
    })
    yanhuExpressManager.evalInPage = async () => ({ ok: false })

    try {
      const tools = buildYanhuBrowserTools(() => 'tab-frameset-2')
      const navTool = tools.find((t) => t.definition.name === 'yanhu_navigate')!

      const result = await navTool.execute({
        url: 'https://jw.cdut.edu.cn/jsxsd/xskb/xskb_list.do',
      })

      expect(result.isError).toBe(true)
      expect(result.content).toContain('【拦截提示】')
      expect(result.content).toContain('leftFrame')
      expect(result.content).toContain('mainFrame')
    } finally {
      yanhuExpressManager.getTabMeta = originalGetTabMeta
      yanhuExpressManager.evalInPage = originalEval
    }
  })
})

describe('sanitizeYanhuNetworkLogs（网络日志净化与硬熔断）', () => {
  test('过滤 data 协议、图片、脚本与 favicon，仅保留业务请求', () => {
    const entries: YanhuNetworkEntry[] = [
      {
        requestId: '1',
        url: 'https://jw.cdut.edu.cn/jsxsd/xskb_list.do',
        method: 'POST',
        status: 200,
        requestHeaders: {},
        timing: { start: 0, end: 1, durationMs: 12 },
      },
      { requestId: '2', url: 'data:image/png;base64,AAAA', method: 'GET', status: 200, requestHeaders: {} },
      { requestId: '3', url: 'https://jw.cdut.edu.cn/static/logo.png', method: 'GET', status: 200, requestHeaders: {} },
      { requestId: '4', url: 'https://jw.cdut.edu.cn/static/app.js?v=1', method: 'GET', status: 200, requestHeaders: {} },
      { requestId: '5', url: 'https://jw.cdut.edu.cn/favicon.ico', method: 'GET', status: 200, requestHeaders: {} },
    ]
    const out = sanitizeYanhuNetworkLogs(entries)
    expect(out).toContain('xskb_list.do')
    expect(out).not.toContain('data:image')
    expect(out).not.toContain('logo.png')
    expect(out).not.toContain('app.js')
    expect(out).not.toContain('favicon')
  })

  test('总字符数硬熔断在 1000 字符以内', () => {
    const entries: YanhuNetworkEntry[] = Array.from({ length: 50 }, (_, i) => ({
      requestId: String(i),
      url: `https://jw.cdut.edu.cn/api/long/path/segment/${i}/query?x=${'a'.repeat(60)}`,
      method: 'GET',
      status: 200,
      requestHeaders: {},
    }))
    const out = sanitizeYanhuNetworkLogs(entries)
    expect(out.length).toBeLessThanOrEqual(1050)
    expect(out).toContain('已按 token 预算截断')
  })

  test('空日志与全静态日志给出明确提示', () => {
    expect(sanitizeYanhuNetworkLogs([])).toBe('暂无网络日志。')
    expect(
      sanitizeYanhuNetworkLogs([
        { requestId: '1', url: 'https://jw.cdut.edu.cn/a.png', method: 'GET', status: 200, requestHeaders: {} },
      ]),
    ).toContain('静态资源')
  })
})

describe('开发者级工具暴露契约', () => {
  test('默认工具集共 14 项，其中开发者级 4 项（关闭时为 10 项）', () => {
    const tools = buildYanhuBrowserTools(() => 'tab-mock-1')
    expect(tools).toHaveLength(14)
    expect(tools.filter((t) => t.developer)).toHaveLength(4)
    expect(tools.filter((t) => !t.developer)).toHaveLength(10)
  })
})

describe('单轮 Token 预算硬截断（工具输出）', () => {
  test('yanhu_read_page 默认按 2500 token 预算截断巨型 PageDigest', async () => {
    const originalEval = yanhuExpressManager.evalInPage
    const originalAx = yanhuExpressManager.getFullAXTree
    try {
      const elements = Array.from({ length: 600 }, (_, i) => ({
        tag: 'a',
        role: 'link',
        name: `导航菜单项-${i}`,
        bounds: { x: i, y: i, width: 80, height: 20 },
        visible: true,
        ariaHidden: false,
        occluded: false,
        region: '数据表格',
        actionable: true,
      }))
      yanhuExpressManager.evalInPage = async (_tabId: string | undefined, expr: string) =>
        expr === buildYanhuCollectorScript()
          ? { url: 'https://jw.cdut.edu.cn', title: '教务', elements }
          : null
      yanhuExpressManager.getFullAXTree = async () => []
      const tools = buildYanhuBrowserTools(() => 'tab-readpage')
      const readPage = tools.find((t) => t.definition.name === 'yanhu_read_page')!
      const res = await readPage.execute({})
      expect(res.content.length).toBeLessThanOrEqual(DEFAULT_READ_PAGE_TOKENS * 4 + 60)
      expect(res.content).toContain('已按 maxTokens 截断')
    } finally {
      yanhuExpressManager.evalInPage = originalEval
      yanhuExpressManager.getFullAXTree = originalAx
    }
  })

  test('yanhu_eval_script 返回内容截断至 500 字符', async () => {
    const originalEval = yanhuExpressManager.evalInPage
    try {
      yanhuExpressManager.evalInPage = async () => ({ big: 'x'.repeat(2000) })
      const tools = buildYanhuBrowserTools(() => 'tab-eval')
      const evalTool = tools.find((t) => t.definition.name === 'yanhu_eval_script')!
      const res = await evalTool.execute({ expression: '1' })
      expect(res.content).toContain('已按 token 预算截断')
      expect(res.content.length).toBeLessThan(600)
    } finally {
      yanhuExpressManager.evalInPage = originalEval
    }
  })

  test('yanhu_inspect_element 总输出截断至 600 字符', async () => {
    const originalEval = yanhuExpressManager.evalInPage
    const originalAx = yanhuExpressManager.getFullAXTree
    try {
      const elements = [
        {
          tag: 'button',
          role: 'button',
          name: '查询',
          bounds: { x: 10, y: 20, width: 80, height: 32 },
          visible: true,
          ariaHidden: false,
          occluded: false,
          region: '表单区',
          actionable: true,
        },
      ]
      yanhuExpressManager.evalInPage = async (_tabId: string | undefined, expr: string) =>
        expr === buildYanhuCollectorScript()
          ? { url: 'https://jw.cdut.edu.cn', title: '教务', elements }
          : { html: 'y'.repeat(2000), rect: { x: 0, y: 0, width: 1, height: 1 }, style: { display: 'block' } }
      yanhuExpressManager.getFullAXTree = async () => []
      const tools = buildYanhuBrowserTools(() => 'tab-inspect')
      await tools.find((t) => t.definition.name === 'yanhu_read_page')!.execute({})
      const inspect = tools.find((t) => t.definition.name === 'yanhu_inspect_element')!
      const res = await inspect.execute({ bid: 1 })
      expect(res.content).toContain('已按 token 预算截断')
      expect(res.content.length).toBeLessThan(700)
    } finally {
      yanhuExpressManager.evalInPage = originalEval
      yanhuExpressManager.getFullAXTree = originalAx
    }
  })
})

describe('拟人化操作节流（防教务系统高频触发注销）', () => {
  test('常量契约：恒定物理间隔 500ms（无随机抖动）', () => {
    expect(YANHU_ACTION_MIN_INTERVAL_MS).toBe(500)
  })

  test('首次动作不等待，紧随其后的动作被强制恒定物理间隔', async () => {
    resetYanhuActionThrottle()
    const start = Date.now()
    await enforceYanhuHumanInterval()
    expect(Date.now() - start).toBeLessThan(150)

    const secondStart = Date.now()
    await enforceYanhuHumanInterval()
    // 强制间隔不低于 500ms，杜绝毫秒级连击被判定为机器爬虫
    const waited = Date.now() - secondStart
    expect(waited).toBeGreaterThanOrEqual(450)
    expect(waited).toBeLessThan(800)
  })
})

describe('页面指纹比对与防重复读屏（防死循环）', () => {
  test('结构未变的二次观察短路回传「页面无变化」，不再重放巨型 PageDigest', async () => {
    const originalEval = yanhuExpressManager.evalInPage
    const originalAx = yanhuExpressManager.getFullAXTree
    try {
      const elements = [
        {
          tag: 'button',
          role: 'button',
          name: '查询',
          bounds: { x: 10, y: 20, width: 80, height: 32 },
          visible: true,
          ariaHidden: false,
          occluded: false,
          region: '表单区',
          actionable: true,
        },
      ]
      yanhuExpressManager.evalInPage = async (_tabId: string | undefined, expr: string) =>
        expr === buildYanhuCollectorScript()
          ? { url: 'https://jw.cdut.edu.cn/jsxsd/xskbcx', title: '成绩查询', elements }
          : null
      yanhuExpressManager.getFullAXTree = async () => []

      const tools = buildYanhuBrowserTools(() => 'tab-unchanged-1')
      const readPage = tools.find((t) => t.definition.name === 'yanhu_read_page')!

      const first = await readPage.execute({})
      expect(first.content).toContain('=== [PageDigest: 成绩查询] ===')

      const second = await readPage.execute({})
      expect(second.content).toContain('页面无变化')
      expect(second.content).not.toContain('=== [PageDigest: 成绩查询] ===')
      // 附带完整可用控件索引（与全量摘要同口径：含当前值），避免模型因看不到任何 [BID] 而幻觉操作
      expect(second.content).toContain('当前可用控件索引')
      expect(second.content).toContain('[BID: 1] button "查询"')
      // 仍属「紧凑短路」，绝不等价于重放整份 PageDigest
      expect(second.content.length).toBeLessThan(400)
    } finally {
      yanhuExpressManager.evalInPage = originalEval
      yanhuExpressManager.getFullAXTree = originalAx
    }
  })
})

describe('工具层短路熔断器（Circuit Breaker）', () => {
  test('连续两次空操作 read_page 触发熔断报错阻断死循环', async () => {
    const originalEval = yanhuExpressManager.evalInPage
    const originalAx = yanhuExpressManager.getFullAXTree
    try {
      const elements = [
        {
          tag: 'button',
          role: 'button',
          name: '查询',
          bounds: { x: 10, y: 20, width: 80, height: 32 },
          visible: true,
          ariaHidden: false,
          occluded: false,
          region: '表单区',
          actionable: true,
        },
      ]
      yanhuExpressManager.evalInPage = async (_tabId: string | undefined, expr: string) =>
        expr === buildYanhuCollectorScript()
          ? { url: 'https://jw.cdut.edu.cn/jsxsd/kscj', title: '成绩查询', elements }
          : null
      yanhuExpressManager.getFullAXTree = async () => []

      const tools = buildYanhuBrowserTools(() => 'tab-cb-1')
      const readPage = tools.find((t) => t.definition.name === 'yanhu_read_page')!

      const first = await readPage.execute({})
      expect(first.isError).toBeFalsy()

      // 第一次空操作：页面无变化（正常短路）
      const second = await readPage.execute({})
      expect(second.content).toContain('页面无变化')
      expect(second.isError).toBeFalsy()

      // 第二次空操作：触发熔断拦截
      const third = await readPage.execute({})
      expect(third.isError).toBe(true)
      expect(third.content).toContain('【熔断拦截】')
      expect(third.content).toContain('禁止重复刷新读取')
    } finally {
      yanhuExpressManager.evalInPage = originalEval
      yanhuExpressManager.getFullAXTree = originalAx
    }
  })

  test('空读后执行有效交互动作可解除熔断', async () => {
    const originalEval = yanhuExpressManager.evalInPage
    const originalAx = yanhuExpressManager.getFullAXTree
    let restoreCausality: () => void = () => {}
    try {
      const elements = [
        {
          tag: 'button',
          role: 'button',
          name: '查询',
          bounds: { x: 10, y: 20, width: 80, height: 32 },
          visible: true,
          ariaHidden: false,
          occluded: false,
          region: '表单区',
          actionable: true,
        },
      ]
      yanhuExpressManager.evalInPage = async (_tabId: string | undefined, expr: string) =>
        expr === buildYanhuCollectorScript() ? { url: 'https://u/x', title: 't', elements } : { ok: true }
      yanhuExpressManager.getFullAXTree = async () => []
      restoreCausality = stubYanhuCausalityEdge()
      const tools = buildYanhuBrowserTools(() => 'tab-cb-2')
      const readPage = tools.find((t) => t.definition.name === 'yanhu_read_page')!
      const click = tools.find((t) => t.definition.name === 'yanhu_click')!

      await readPage.execute({})
      const unchanged = await readPage.execute({})
      expect(unchanged.content).toContain('页面无变化')

      // 交互动作解除熔断（命中因果边判定 verify-success）
      await click.execute({ bid: 1 })
      const afterClick = await readPage.execute({})
      expect(afterClick.isError).toBeFalsy()
    } finally {
      restoreCausality()
      yanhuExpressManager.evalInPage = originalEval
      yanhuExpressManager.getFullAXTree = originalAx
    }
  })
})

describe('读屏熔断的错误重置（根除「有错无解」死锁）', () => {
  test('非 read_page 工具出错后自动释放熔断，重新读页不再被错误拦截', async () => {
    const originalEval = yanhuExpressManager.evalInPage
    const originalAx = yanhuExpressManager.getFullAXTree
    try {
      const elements = [
        {
          tag: 'button',
          role: 'button',
          name: '查询',
          bounds: { x: 10, y: 20, width: 80, height: 32 },
          visible: true,
          ariaHidden: false,
          occluded: false,
          region: '表单区',
          actionable: true,
        },
      ]
      yanhuExpressManager.evalInPage = async (_tabId: string | undefined, expr: string) =>
        expr === buildYanhuCollectorScript() ? { url: 'https://u/x', title: 't', elements } : { ok: true }
      yanhuExpressManager.getFullAXTree = async () => []

      const tools = buildYanhuBrowserTools(() => 'tab-cb-reset')
      const readPage = tools.find((t) => t.definition.name === 'yanhu_read_page')!
      const navigate = tools.find((t) => t.definition.name === 'yanhu_navigate')!

      await readPage.execute({})
      const unchanged = await readPage.execute({})
      expect(unchanged.content).toContain('页面无变化')

      // navigate 因 URL 为空出错 → 应释放熔断
      const navRes = await navigate.execute({ url: '' })
      expect(navRes.isError).toBe(true)

      // 重新读页不再被熔断错误拦截（返回「页面无变化」而非【熔断拦截】）
      const afterError = await readPage.execute({})
      expect(afterError.isError).toBeFalsy()
      expect(afterError.content).not.toContain('【熔断拦截】')
      expect(afterError.content).toContain('页面无变化')
    } finally {
      yanhuExpressManager.evalInPage = originalEval
      yanhuExpressManager.getFullAXTree = originalAx
    }
  })
})

describe('危险操作硬拦截与 BID 历史回退容错', () => {
  function mockCollectionAndTrigger(elements: unknown[]) {
    return async (_tabId: string | undefined, expr: string) =>
      expr === buildYanhuCollectorScript() ? { url: 'https://u/x', title: 't', elements } : { ok: true }
  }

  test('点击「安全退出」类控件被底层硬拦截，保护当前会话', async () => {
    const originalEval = yanhuExpressManager.evalInPage
    const originalAx = yanhuExpressManager.getFullAXTree
    try {
      const elements = [
        {
          tag: 'a',
          role: 'link',
          name: '安全退出',
          bounds: { x: 10, y: 20, width: 80, height: 32 },
          visible: true,
          ariaHidden: false,
          occluded: false,
          region: '顶栏区',
          actionable: true,
        },
      ]
      yanhuExpressManager.evalInPage = mockCollectionAndTrigger(elements)
      yanhuExpressManager.getFullAXTree = async () => []

      const tools = buildYanhuBrowserTools(() => 'tab-danger-1')
      await tools.find((t) => t.definition.name === 'yanhu_read_page')!.execute({})
      const click = tools.find((t) => t.definition.name === 'yanhu_click')!
      const res = await click.execute({ bid: 1 })
      expect(res.isError).toBe(true)
      expect(res.content).toContain('【安全拦截】')
    } finally {
      yanhuExpressManager.evalInPage = originalEval
      yanhuExpressManager.getFullAXTree = originalAx
    }
  })

  test('BID 在 markDirty 后仍可通过历史回退执行，不抛出「BID 失效」', async () => {
    const originalEval = yanhuExpressManager.evalInPage
    const originalAx = yanhuExpressManager.getFullAXTree
    let restoreCausality: () => void = () => {}
    try {
      const elements = [
        {
          tag: 'button',
          role: 'button',
          name: '课程成绩查询',
          bounds: { x: 10, y: 20, width: 80, height: 32 },
          visible: true,
          ariaHidden: false,
          occluded: false,
          region: '导航菜单',
          actionable: true,
        },
      ]
      yanhuExpressManager.evalInPage = mockCollectionAndTrigger(elements)
      yanhuExpressManager.getFullAXTree = async () => []
      restoreCausality = stubYanhuCausalityEdge()

      const tabId = 'tab-fallback-1'
      const tools = buildYanhuBrowserTools(() => tabId)
      await tools.find((t) => t.definition.name === 'yanhu_read_page')!.execute({})

      // 模拟页面突变导致当前索引失效
      yanhuDomDistillationEngine.markDirty(tabId)

      const click = tools.find((t) => t.definition.name === 'yanhu_click')!
      const res = await click.execute({ bid: 1 })
      expect(res.isError).toBeFalsy()
      expect(res.content).toContain('已点击')
      expect(res.content).not.toContain('BID 失效')
    } finally {
      restoreCausality()
      yanhuExpressManager.evalInPage = originalEval
      yanhuExpressManager.getFullAXTree = originalAx
    }
  })

  test('yanhu_read_page 已废弃 forceRefresh 参数', () => {
    const tools = buildYanhuBrowserTools(() => 'tab-schema')
    const readPage = tools.find((t) => t.definition.name === 'yanhu_read_page')!
    const properties = readPage.definition.parameters.properties as Record<string, unknown>
    expect(properties.forceRefresh).toBeUndefined()
    expect(properties.maxTokens).toBeDefined()
  })
})

describe('深度审计修复回归（BUG 回归用例）', () => {
  const ELEMENTS = [
    {
      tag: 'button',
      role: 'button',
      name: '查询',
      bounds: { x: 10, y: 20, width: 80, height: 32 },
      visible: true,
      ariaHidden: false,
      occluded: false,
      region: '表单区',
      actionable: true,
    },
  ]

  test('BUG-1：yanhu_eval_script 对 undefined 返回值不再抛 TypeError', async () => {
    const originalEval = yanhuExpressManager.evalInPage
    try {
      yanhuExpressManager.evalInPage = async () => undefined
      const tools = buildYanhuBrowserTools(() => 'tab-eval-undef')
      const evalTool = tools.find((t) => t.definition.name === 'yanhu_eval_script')!
      const res = await evalTool.execute({ expression: 'void 0' })
      expect(res.isError).toBeFalsy()
      expect(res.content).toContain('undefined')
    } finally {
      yanhuExpressManager.evalInPage = originalEval
    }
  })

  test('参数别名容错：script / code / js 均等价于规范名 expression（未知工具故障同源修复）', async () => {
    const originalEval = yanhuExpressManager.evalInPage
    try {
      const seen: string[] = []
      yanhuExpressManager.evalInPage = async (_tabId: string | undefined, expr: string) => {
        seen.push(expr)
        return { ok: true }
      }
      const tools = buildYanhuBrowserTools(() => 'tab-eval-alias')
      const evalTool = tools.find((t) => t.definition.name === 'yanhu_eval_script')!
      for (const key of ['script', 'code', 'js']) {
        const res = await evalTool.execute({ [key]: 'document.title' })
        expect(res.isError).toBeFalsy()
      }
      expect(seen).toEqual(['document.title', 'document.title', 'document.title'])
      // 全空入参时给出可读错误，而不是带着空表达式继续执行
      const missing = await evalTool.execute({})
      expect(missing.isError).toBe(true)
    } finally {
      yanhuExpressManager.evalInPage = originalEval
    }
  })

  test('BUG-2：工具抛异常（非法 BID）后自动释放熔断，不再死锁', async () => {
    const originalEval = yanhuExpressManager.evalInPage
    const originalAx = yanhuExpressManager.getFullAXTree
    try {
      yanhuExpressManager.evalInPage = async (_tabId: string | undefined, expr: string) =>
        expr === buildYanhuCollectorScript() ? { url: 'https://u/x', title: 't', elements: ELEMENTS } : { ok: true }
      yanhuExpressManager.getFullAXTree = async () => []

      const tools = buildYanhuBrowserTools(() => 'tab-cb-throw')
      const readPage = tools.find((t) => t.definition.name === 'yanhu_read_page')!
      const click = tools.find((t) => t.definition.name === 'yanhu_click')!

      await readPage.execute({})
      const unchanged = await readPage.execute({})
      expect(unchanged.content).toContain('页面无变化')

      // 非法 BID 触发 requireBid 抛异常，应释放熔断（而非把异常路径漏掉）
      await expect(click.execute({ bid: 999 })).rejects.toThrow()

      const after = await readPage.execute({})
      expect(after.content).not.toContain('【熔断拦截】')
      expect(after.content).toContain('页面无变化')
    } finally {
      yanhuExpressManager.evalInPage = originalEval
      yanhuExpressManager.getFullAXTree = originalAx
    }
  })

  test('BUG-3：框架路由分支拒绝非校内 URL（校内域前置裁决）', async () => {
    const originalGetTabMeta = yanhuExpressManager.getTabMeta.bind(yanhuExpressManager)
    const originalEval = yanhuExpressManager.evalInPage
    const originalNavigate = yanhuExpressManager.navigate
    try {
      yanhuExpressManager.getTabMeta = () => ({
        id: 'tab-frameset-3',
        url: 'https://jw.cdut.edu.cn/jsxsd/framework/xsMainV.htmlx',
        title: '教务系统主框架',
        loading: false,
        canGoBack: false,
        canGoForward: false,
      })
      let routeEvaluated = false
      yanhuExpressManager.evalInPage = async () => {
        routeEvaluated = true
        return { ok: true, redirectedInFrame: true }
      }
      // 站外 URL 不得进入 mainFrame 路由（不应触发 routeScript）
      yanhuExpressManager.navigate = () => ({ tabs: [], activeTabId: 'tab-frameset-3' })

      const tools = buildYanhuBrowserTools(() => 'tab-frameset-3')
      const navTool = tools.find((t) => t.definition.name === 'yanhu_navigate')!
      await navTool.execute({ url: 'https://evil.com/jsxsd/x.jsp' })
      expect(routeEvaluated).toBe(false)
    } finally {
      yanhuExpressManager.getTabMeta = originalGetTabMeta
      yanhuExpressManager.evalInPage = originalEval
      yanhuExpressManager.navigate = originalNavigate
    }
  })

  test('BUG-14：yanhu_tab_actions 关闭 / 切换不存在的标签返回明确错误', async () => {
    const originalMeta = yanhuExpressManager.getTabMeta
    try {
      yanhuExpressManager.getTabMeta = () => null
      const tools = buildYanhuBrowserTools(() => 'tab-none')
      const tabTool = tools.find((t) => t.definition.name === 'yanhu_tab_actions')!
      const closed = await tabTool.execute({ action: 'close', tabId: 'ghost-tab' })
      expect(closed.isError).toBe(true)
      expect(closed.content).toContain('未找到标签')
      const switched = await tabTool.execute({ action: 'switch', tabId: 'ghost-tab' })
      expect(switched.isError).toBe(true)
      expect(switched.content).toContain('未找到标签')
    } finally {
      yanhuExpressManager.getTabMeta = originalMeta
    }
  })

  test('BUG-15：yanhu_get_network_logs 显式 limit=0 回落默认 30（不截断）', async () => {
    const originalLogs = yanhuExpressManager.cdpGetNetworkLogs
    try {
      const entries = Array.from({ length: 40 }, (_, i) => ({
        requestId: String(i),
        url: `https://jw.cdut.edu.cn/api/item/${i}`,
        method: 'GET',
        status: 200,
        requestHeaders: {},
      }))
      yanhuExpressManager.cdpGetNetworkLogs = () => entries
      const tools = buildYanhuBrowserTools(() => 'tab-net')
      const netTool = tools.find((t) => t.definition.name === 'yanhu_get_network_logs')!
      const res = await netTool.execute({ limit: 0 })
      // 默认 30 条，而非 0 条导致的空输出
      expect(res.content).toContain('/api/item/')
      expect(res.content).not.toContain('/api/item/0\n')
    } finally {
      yanhuExpressManager.cdpGetNetworkLogs = originalLogs
    }
  })

  test('BUG-16：页面无变化时回传完整控件索引（不再截断为前 8 项）', async () => {
    const originalEval = yanhuExpressManager.evalInPage
    const originalAx = yanhuExpressManager.getFullAXTree
    try {
      const elements = Array.from({ length: 12 }, (_, i) => ({
        tag: 'a',
        role: 'link',
        name: `菜单项-${i + 1}`,
        bounds: { x: i * 10, y: 0, width: 60, height: 20 },
        visible: true,
        ariaHidden: false,
        occluded: false,
        region: '导航菜单',
        actionable: true,
      }))
      yanhuExpressManager.evalInPage = async (_tabId: string | undefined, expr: string) =>
        expr === buildYanhuCollectorScript() ? { url: 'https://u/x', title: 't', elements } : { ok: true }
      yanhuExpressManager.getFullAXTree = async () => []

      const tools = buildYanhuBrowserTools(() => 'tab-full-idx')
      const readPage = tools.find((t) => t.definition.name === 'yanhu_read_page')!
      await readPage.execute({})
      const second = await readPage.execute({})
      expect(second.content).toContain('页面无变化')
      expect(second.content).toContain('共 12 项')
      // 第 9~12 项也必须可见（历史缺陷只回传前 8 项，导致 BID > 8 的控件永久不可见）
      expect(second.content).toContain('[BID: 12] link "菜单项-12"')
    } finally {
      yanhuExpressManager.evalInPage = originalEval
      yanhuExpressManager.getFullAXTree = originalAx
    }
  })

  test('BUG-17：未知 BID 回传当前可用 BID 台账（不再只报「已失效」）', async () => {
    const originalEval = yanhuExpressManager.evalInPage
    const originalAx = yanhuExpressManager.getFullAXTree
    try {
      yanhuExpressManager.evalInPage = async (_tabId: string | undefined, expr: string) =>
        expr === buildYanhuCollectorScript() ? { url: 'https://u/x', title: 't', elements: ELEMENTS } : { ok: true }
      yanhuExpressManager.getFullAXTree = async () => []

      const tools = buildYanhuBrowserTools(() => 'tab-unknown-bid')
      const readPage = tools.find((t) => t.definition.name === 'yanhu_read_page')!
      const click = tools.find((t) => t.definition.name === 'yanhu_click')!
      await readPage.execute({})

      let message = ''
      try {
        await click.execute({ bid: 99 })
      } catch (err) {
        message = err instanceof Error ? err.message : String(err)
      }
      expect(message).toContain('BID 99 不存在')
      expect(message).toContain('当前可用 BID')
      expect(message).toContain('[1] button "查询"')
    } finally {
      yanhuExpressManager.evalInPage = originalEval
      yanhuExpressManager.getFullAXTree = originalAx
    }
  })

  test('BUG-18：yanhu_fill 的 pressEnter 默认不触发原生表单提交（杜绝填写时误提交）', async () => {
    const originalEval = yanhuExpressManager.evalInPage
    const originalAx = yanhuExpressManager.getFullAXTree
    const originalTextInput = yanhuExpressManager.dispatchHumanTextInput
    const originalStable = yanhuExpressManager.awaitStable
    try {
      const elements = [
        {
          tag: 'input',
          role: 'textbox',
          name: '请查找',
          bounds: { x: 10, y: 20, width: 80, height: 24 },
          visible: true,
          ariaHidden: false,
          occluded: false,
          region: '业务表单',
          actionable: true,
        },
      ]
      yanhuExpressManager.evalInPage = async (_tabId: string | undefined, expr: string) => {
        if (expr === buildYanhuCollectorScript()) return { url: 'https://x/y', title: 't', elements }
        if (expr.includes('editableInput')) return { ok: true, editable: true, tag: 'input', type: 'text', role: '' }
        if (expr.includes('hitOk')) return { ok: true, x: 10, y: 20, hitOk: true }
        if (expr.includes('const cur')) return { ok: true, value: '病假' }
        return { ok: true }
      }
      yanhuExpressManager.getFullAXTree = async () => []
      const capturedOptions: { pressEnter?: boolean; allowFormSubmit?: boolean } = {}
      yanhuExpressManager.dispatchHumanTextInput = async (_tabId, _x, _y, _text, options) => {
        capturedOptions.pressEnter = options?.pressEnter
        capturedOptions.allowFormSubmit = options?.allowFormSubmit
      }
      yanhuExpressManager.awaitStable = async () => ({
        settled: true,
        timedOut: false,
        elapsedMs: 0,
        inflight: 0,
        frames: 0,
        mutations: 0,
        lastActivityAt: 0,
      })

      const tools = buildYanhuBrowserTools(() => 'tab-fill-enter')
      await tools.find((t) => t.definition.name === 'yanhu_read_page')!.execute({})
      const fill = tools.find((t) => t.definition.name === 'yanhu_fill')!
      const res = await fill.execute({ bid: 1, value: '病假', pressEnter: true })

      expect(capturedOptions.pressEnter).toBe(true)
      // 关键：未显式允许时绝不触发原生表单提交
      expect(capturedOptions.allowFormSubmit).toBe(false)
      expect(res.content).toContain('未触发原生表单提交')
    } finally {
      yanhuExpressManager.evalInPage = originalEval
      yanhuExpressManager.getFullAXTree = originalAx
      yanhuExpressManager.dispatchHumanTextInput = originalTextInput
      yanhuExpressManager.awaitStable = originalStable
    }
  })

  test('BUG-19：合成回车脚本只派发 KeyboardEvent，绝不调用 CDP 原生按键', () => {
    const script = buildSyntheticEnterScript()
    expect(script).toContain('KeyboardEvent')
    expect(script).toContain("'Enter'")
    expect(script).not.toContain('Input.dispatchKeyEvent')
  })

  test('BUG-20：yanhu_select 对自定义下拉不再误报「不存在选项」，并自动展开+点选', async () => {
    const originalEval = yanhuExpressManager.evalInPage
    const originalAx = yanhuExpressManager.getFullAXTree
    const originalStable = yanhuExpressManager.awaitStable
    try {
      const elements = [
        {
          tag: 'div',
          role: 'combobox',
          name: '请选择...',
          bounds: { x: 10, y: 20, width: 120, height: 32 },
          visible: true,
          ariaHidden: false,
          occluded: false,
          region: '业务表单',
          actionable: true,
        },
      ]
      const calls: string[] = []
      yanhuExpressManager.evalInPage = async (_tabId: string | undefined, expr: string) => {
        if (expr === buildYanhuCollectorScript()) return { url: 'https://x/y', title: 't', elements }
        if (expr.includes('isNativeSelect')) {
          calls.push('native')
          return { ok: false, isNativeSelect: false, reason: 'not-native-select', tag: 'div', role: 'combobox' }
        }
        if (expr.includes('selectors =')) {
          calls.push('pick')
          return { ok: false, reason: 'option-not-found', matched: 0 }
        }
        if (expr.includes('__unseal')) {
          calls.push('open')
          return { ok: true }
        }
        return { ok: true }
      }
      yanhuExpressManager.getFullAXTree = async () => []
      yanhuExpressManager.awaitStable = async () => ({
        settled: true,
        timedOut: false,
        elapsedMs: 0,
        inflight: 0,
        frames: 0,
        mutations: 0,
        lastActivityAt: 0,
      })

      const tools = buildYanhuBrowserTools(() => 'tab-select-custom')
      await tools.find((t) => t.definition.name === 'yanhu_read_page')!.execute({})
      const select = tools.find((t) => t.definition.name === 'yanhu_select')!
      const res = await select.execute({ bid: 1, valueOrText: '事假' })

      expect(res.isError).toBe(true)
      expect(res.content).toContain('不是原生下拉')
      expect(res.content).toContain('yanhu_click')
      // 关键：不再误导为「不存在选项」，且确实走过「展开 → 点选」确定性降级
      expect(res.content).not.toContain('不存在选项')
      expect(calls).toEqual(['native', 'open', 'pick'])
    } finally {
      yanhuExpressManager.evalInPage = originalEval
      yanhuExpressManager.getFullAXTree = originalAx
      yanhuExpressManager.awaitStable = originalStable
    }
  })

  test('BUG-20b：yanhu_select 自定义下拉自动点选成功', async () => {
    const originalEval = yanhuExpressManager.evalInPage
    const originalAx = yanhuExpressManager.getFullAXTree
    const originalStable = yanhuExpressManager.awaitStable
    try {
      const elements = [
        {
          tag: 'div',
          role: 'combobox',
          name: '请假类型',
          bounds: { x: 10, y: 20, width: 120, height: 32 },
          visible: true,
          ariaHidden: false,
          occluded: false,
          region: '业务表单',
          actionable: true,
        },
      ]
      let pickedOnce = false
      yanhuExpressManager.evalInPage = async (_tabId: string | undefined, expr: string) => {
        if (expr === buildYanhuCollectorScript()) return { url: 'https://x/y', title: 't', elements }
        if (expr.includes('isNativeSelect')) return { ok: false, isNativeSelect: false, reason: 'not-native-select', tag: 'div' }
        if (expr.includes('selectors =')) {
          pickedOnce = true
          return { ok: true, matched: 2, text: '事假' }
        }
        // 显示文本探针：真实控件在点选生效后会把显示文本改成所选选项（此处如实模拟）
        if (expr.includes('__yanhuOwnText')) return { ok: true, text: pickedOnce ? '事假' : '' }
        return { ok: true }
      }
      yanhuExpressManager.getFullAXTree = async () => []
      yanhuExpressManager.awaitStable = async () => ({
        settled: true,
        timedOut: false,
        elapsedMs: 0,
        inflight: 0,
        frames: 0,
        mutations: 0,
        lastActivityAt: 0,
      })

      const tools = buildYanhuBrowserTools(() => 'tab-select-custom-ok')
      await tools.find((t) => t.definition.name === 'yanhu_read_page')!.execute({})
      const select = tools.find((t) => t.definition.name === 'yanhu_select')!
      const res = await select.execute({ bid: 1, valueOrText: '事假' })

      expect(res.isError).toBeFalsy()
      expect(res.content).toContain('自定义下拉')
      expect(res.content).toContain('事假')
    } finally {
      yanhuExpressManager.evalInPage = originalEval
      yanhuExpressManager.getFullAXTree = originalAx
      yanhuExpressManager.awaitStable = originalStable
    }
  })

  test('BUG-20c：原生下拉无匹配选项时直接回传可用选项清单（杜绝盲试其它 BID）', async () => {
    const originalEval = yanhuExpressManager.evalInPage
    const originalAx = yanhuExpressManager.getFullAXTree
    try {
      const elements = [
        {
          tag: 'select',
          role: 'combobox',
          name: '请假类型',
          bounds: { x: 10, y: 20, width: 120, height: 32 },
          visible: true,
          ariaHidden: false,
          occluded: false,
          region: '业务表单',
          actionable: true,
        },
      ]
      yanhuExpressManager.evalInPage = async (_tabId: string | undefined, expr: string) => {
        if (expr === buildYanhuCollectorScript()) return { url: 'https://x/y', title: 't', elements }
        if (expr.includes('isNativeSelect')) return { ok: false, isNativeSelect: true, reason: 'option-not-found', options: ['事假', '病假', '公假'] }
        return { ok: true }
      }
      yanhuExpressManager.getFullAXTree = async () => []

      const tools = buildYanhuBrowserTools(() => 'tab-select-native-miss')
      await tools.find((t) => t.definition.name === 'yanhu_read_page')!.execute({})
      const select = tools.find((t) => t.definition.name === 'yanhu_select')!
      const res = await select.execute({ bid: 1, valueOrText: '婚假' })

      expect(res.isError).toBe(true)
      expect(res.content).toContain('原生下拉中不存在选项')
      expect(res.content).toContain('可用选项：事假 / 病假 / 公假')
    } finally {
      yanhuExpressManager.evalInPage = originalEval
      yanhuExpressManager.getFullAXTree = originalAx
    }
  })

  test('BUG-21：yanhu_fill 对非输入框（下拉）直接结构化拒绝，绝不写入', async () => {
    const originalEval = yanhuExpressManager.evalInPage
    const originalAx = yanhuExpressManager.getFullAXTree
    const originalTextInput = yanhuExpressManager.dispatchHumanTextInput
    try {
      const elements = [
        {
          tag: 'select',
          role: 'combobox',
          name: '请选择...',
          bounds: { x: 10, y: 20, width: 120, height: 32 },
          visible: true,
          ariaHidden: false,
          occluded: false,
          region: '业务表单',
          actionable: true,
        },
      ]
      yanhuExpressManager.evalInPage = async (_tabId: string | undefined, expr: string) => {
        if (expr === buildYanhuCollectorScript()) return { url: 'https://x/y', title: 't', elements }
        if (expr.includes('editableInput')) {
          return { ok: true, editable: false, tag: 'select', type: '', role: 'combobox' }
        }
        return { ok: true }
      }
      yanhuExpressManager.getFullAXTree = async () => []
      let textInputCalls = 0
      yanhuExpressManager.dispatchHumanTextInput = async () => {
        textInputCalls += 1
      }

      const tools = buildYanhuBrowserTools(() => 'tab-fill-guard')
      await tools.find((t) => t.definition.name === 'yanhu_read_page')!.execute({})
      const fill = tools.find((t) => t.definition.name === 'yanhu_fill')!
      const res = await fill.execute({ bid: 1, value: '事假' })

      expect(res.isError).toBe(true)
      expect(res.content).toContain('是下拉控件而不是输入框')
      expect(res.content).toContain('yanhu_select')
      // 关键：绝不对非输入框执行任何写入
      expect(textInputCalls).toBe(0)
    } finally {
      yanhuExpressManager.evalInPage = originalEval
      yanhuExpressManager.getFullAXTree = originalAx
      yanhuExpressManager.dispatchHumanTextInput = originalTextInput
    }
  })

  test('BUG-22：页面渲染内容未变时，同一控件重复点击被拦截（基于内容指纹而非 URL）', async () => {
    const originalEval = yanhuExpressManager.evalInPage
    const originalAx = yanhuExpressManager.getFullAXTree
    const originalDelivered = yanhuDomDistillationEngine.getDeliveredFingerprint
    let restoreCausality: () => void = () => {}
    try {
      const elements = [
        {
          tag: 'button',
          role: 'button',
          name: '我要请假',
          bounds: { x: 10, y: 20, width: 80, height: 32 },
          visible: true,
          ariaHidden: false,
          occluded: false,
          region: '表单区',
          actionable: true,
        },
      ]
      yanhuExpressManager.evalInPage = async (_tabId: string | undefined, expr: string) =>
        expr === buildYanhuCollectorScript() ? { url: 'https://u/x', title: 't', elements } : { ok: true }
      yanhuExpressManager.getFullAXTree = async () => []
      yanhuDomDistillationEngine.getDeliveredFingerprint = () => 'FP-UNCHANGED'
      restoreCausality = stubYanhuCausalityEdge()

      const tools = buildYanhuBrowserTools(() => 'tab-repeat-click')
      await tools.find((t) => t.definition.name === 'yanhu_read_page')!.execute({})
      const click = tools.find((t) => t.definition.name === 'yanhu_click')!

      const first = await click.execute({ bid: 1 })
      expect(first.isError).toBeFalsy()
      const second = await click.execute({ bid: 1 })
      expect(second.isError).toBe(true)
      expect(second.content).toContain('【重复点击拦截】')
      expect(second.content).toContain('渲染内容完全没有变化')
    } finally {
      restoreCausality()
      yanhuDomDistillationEngine.getDeliveredFingerprint = originalDelivered
      yanhuExpressManager.evalInPage = originalEval
      yanhuExpressManager.getFullAXTree = originalAx
    }
  })

  test('BUG-22b：渲染内容已变化时，同一控件可正常再次点击（不误拦）', async () => {
    const originalEval = yanhuExpressManager.evalInPage
    const originalAx = yanhuExpressManager.getFullAXTree
    const originalDelivered = yanhuDomDistillationEngine.getDeliveredFingerprint
    let restoreCausality: () => void = () => {}
    try {
      const elements = [
        {
          tag: 'button',
          role: 'button',
          name: '展开',
          bounds: { x: 10, y: 20, width: 80, height: 32 },
          visible: true,
          ariaHidden: false,
          occluded: false,
          region: '表单区',
          actionable: true,
        },
      ]
      yanhuExpressManager.evalInPage = async (_tabId: string | undefined, expr: string) =>
        expr === buildYanhuCollectorScript() ? { url: 'https://u/x', title: 't', elements } : { ok: true }
      yanhuExpressManager.getFullAXTree = async () => []
      let fingerprint = 'FP-1'
      yanhuDomDistillationEngine.getDeliveredFingerprint = () => fingerprint
      restoreCausality = stubYanhuCausalityEdge()

      const tools = buildYanhuBrowserTools(() => 'tab-repeat-click-2')
      await tools.find((t) => t.definition.name === 'yanhu_read_page')!.execute({})
      const click = tools.find((t) => t.definition.name === 'yanhu_click')!

      const first = await click.execute({ bid: 1 })
      expect(first.isError).toBeFalsy()
      // 内容已变化 → 允许再次点击
      fingerprint = 'FP-2'
      const second = await click.execute({ bid: 1 })
      expect(second.isError).toBeFalsy()
      expect(second.content).toContain('已点击')
    } finally {
      restoreCausality()
      yanhuDomDistillationEngine.getDeliveredFingerprint = originalDelivered
      yanhuExpressManager.evalInPage = originalEval
      yanhuExpressManager.getFullAXTree = originalAx
    }
  })

  test('BUG-23：yanhu_tab_actions(create) 对完全相同 URL 不重复新建，改为切换', async () => {
    const originalTabs = yanhuExpressManager.getTabsState
    const originalCreate = yanhuExpressManager.createTab
    const originalActivate = yanhuExpressManager.activateTab
    try {
      const url = 'https://xgfw.cdut.edu.cn/xsfw/sys/xsqjapp/*default/index.do#/wdqj'
      yanhuExpressManager.getTabsState = () => ({
        activeTabId: 'tab-a',
        tabs: [
          {
            id: 'tab-a',
            title: '学生请假',
            url,
            favicon: '',
            createdAt: 0,
            lastActiveAt: 0,
            zoomFactor: 1,
            isDormant: false,
            loading: false,
            canGoBack: false,
            canGoForward: false,
          },
        ],
      })
      let createCalls = 0
      yanhuExpressManager.createTab = () => {
        createCalls += 1
        return { activeTabId: 'tab-new', tabs: [] }
      }
      yanhuExpressManager.activateTab = () => ({ activeTabId: 'tab-a', tabs: [] })

      const tools = buildYanhuBrowserTools(() => 'tab-a')
      const tabTool = tools.find((t) => t.definition.name === 'yanhu_tab_actions')!
      const res = await tabTool.execute({ action: 'create', url })

      expect(createCalls).toBe(0)
      expect(res.content).toContain('未重复新建')
      expect(res.content).toContain('tab-a')
    } finally {
      yanhuExpressManager.getTabsState = originalTabs
      yanhuExpressManager.createTab = originalCreate
      yanhuExpressManager.activateTab = originalActivate
    }
  })
})

describe('最后一轮对话事故修复回归（白屏根除 BUG-24 ~ BUG-26）', () => {
  test('BUG-24：yanhu_reload 对携带一次性票据的地址剥离票据后净化加载，绝不裸重载', async () => {
    const originalLive = yanhuExpressManager.getTabLiveUrl
    const originalLoad = yanhuExpressManager.loadUrl
    const originalReload = yanhuExpressManager.reload
    const originalIdle = yanhuExpressManager.waitForIdle
    try {
      yanhuExpressManager.getTabLiveUrl = () =>
        'https://xgfw.cdut.edu.cn/xsfw/sys/xsqjapp/*default/index.do?ticket=ST-50677-abcd#/wdqj'
      let loadedUrl = ''
      let reloadCalls = 0
      let idleCalls = 0
      yanhuExpressManager.loadUrl = async (_tabId, url) => {
        loadedUrl = url
        return { tabs: [], activeTabId: 'tab-reload' }
      }
      yanhuExpressManager.reload = () => {
        reloadCalls += 1
        return { tabs: [], activeTabId: 'tab-reload' }
      }
      yanhuExpressManager.waitForIdle = async () => {
        idleCalls += 1
      }

      const tools = buildYanhuBrowserTools(() => 'tab-reload')
      const reload = tools.find((t) => t.definition.name === 'yanhu_reload')!
      const res = await reload.execute({})

      expect(res.isError).toBeFalsy()
      expect(res.content).toContain('安全净化地址刷新')
      // 关键：剥离票据后平滑导航，而非带废票裸重载（白屏根因）
      expect(loadedUrl).toContain('index.do')
      expect(loadedUrl).not.toContain('ticket=')
      expect(loadedUrl).toContain('#/wdqj')
      expect(reloadCalls).toBe(0)
      expect(idleCalls).toBe(1)
    } finally {
      yanhuExpressManager.getTabLiveUrl = originalLive
      yanhuExpressManager.loadUrl = originalLoad
      yanhuExpressManager.reload = originalReload
      yanhuExpressManager.waitForIdle = originalIdle
    }
  })

  test('BUG-24b：yanhu_reload 在无票据时仍按常规刷新（不误走净化分支）', async () => {
    const originalLive = yanhuExpressManager.getTabLiveUrl
    const originalLoad = yanhuExpressManager.loadUrl
    const originalReload = yanhuExpressManager.reload
    const originalIdle = yanhuExpressManager.waitForIdle
    try {
      yanhuExpressManager.getTabLiveUrl = () => 'https://xgfw.cdut.edu.cn/xsfw/sys/xsqjapp/default/index.do#/wdqj'
      let loadedUrl = ''
      let reloadCalls = 0
      yanhuExpressManager.loadUrl = async (_tabId, url) => {
        loadedUrl = url
        return { tabs: [], activeTabId: 'tab-reload-2' }
      }
      yanhuExpressManager.reload = () => {
        reloadCalls += 1
        return { tabs: [], activeTabId: 'tab-reload-2' }
      }
      yanhuExpressManager.waitForIdle = async () => {}

      const tools = buildYanhuBrowserTools(() => 'tab-reload-2')
      const reload = tools.find((t) => t.definition.name === 'yanhu_reload')!
      const res = await reload.execute({})

      expect(res.isError).toBeFalsy()
      expect(res.content).toBe('页面已刷新。')
      expect(reloadCalls).toBe(1)
      expect(loadedUrl).toBe('')
    } finally {
      yanhuExpressManager.getTabLiveUrl = originalLive
      yanhuExpressManager.loadUrl = originalLoad
      yanhuExpressManager.reload = originalReload
      yanhuExpressManager.waitForIdle = originalIdle
    }
  })

  test('BUG-25：yanhu_select 的选项点选脚本穿透 iframe 并覆盖金智 BH-UI 下拉类名', async () => {
    const originalEval = yanhuExpressManager.evalInPage
    const originalAx = yanhuExpressManager.getFullAXTree
    const originalStable = yanhuExpressManager.awaitStable
    const exprs: string[] = []
    try {
      const elements = [
        {
          tag: 'div',
          role: 'combobox',
          name: '请假类型',
          bounds: { x: 10, y: 20, width: 120, height: 32 },
          visible: true,
          ariaHidden: false,
          occluded: false,
          region: '业务表单',
          actionable: true,
        },
      ]
      yanhuExpressManager.evalInPage = async (_tabId: string | undefined, expr: string) => {
        exprs.push(expr)
        if (expr === buildYanhuCollectorScript()) return { url: 'https://x/y', title: 't', elements }
        if (expr.includes('isNativeSelect')) {
          return { ok: false, isNativeSelect: false, reason: 'not-native-select', tag: 'div' }
        }
        if (expr.includes('selectors =')) return { ok: false, reason: 'option-not-found', matched: 0 }
        return { ok: true }
      }
      yanhuExpressManager.getFullAXTree = async () => []
      yanhuExpressManager.awaitStable = async () => ({
        settled: true,
        timedOut: false,
        elapsedMs: 0,
        inflight: 0,
        frames: 0,
        mutations: 0,
        lastActivityAt: 0,
      })

      const tools = buildYanhuBrowserTools(() => 'tab-select-frame')
      await tools.find((t) => t.definition.name === 'yanhu_read_page')!.execute({})
      const select = tools.find((t) => t.definition.name === 'yanhu_select')!
      const res = await select.execute({ bid: 1, valueOrText: '事假' })

      const pickScript = exprs.find((e) => e.includes('selectors =')) ?? ''
      // 金智 EMAP / BH-UI 专属下拉类名必须被收录
      expect(pickScript).toContain('.bh-pull-down-list li')
      expect(pickScript).toContain('.bh-dropdown-menu li')
      expect(pickScript).toContain('.bh-select-dropdown li')
      // 跨 Frame 递归穿透（不再只查顶层 document）
      expect(pickScript).toContain('frame, iframe')
      expect(pickScript).toContain('collect(')
      // 未能匹配时仍给出确定的 yanhu_click 引导，而非误报「不存在选项」
      expect(res.isError).toBe(true)
      expect(res.content).toContain('不是原生下拉')
      expect(res.content).toContain('yanhu_click')
    } finally {
      yanhuExpressManager.evalInPage = originalEval
      yanhuExpressManager.getFullAXTree = originalAx
      yanhuExpressManager.awaitStable = originalStable
    }
  })

  test('BUG-26：一次性票据净化脚本覆盖顶层与子框架 replaceState，且不触发任何重载 / 导航', () => {
    const script = buildOneTimeTicketSanitizeScript()
    expect(script).toContain('replaceState')
    expect(script).toContain('ticket')
    expect(script).toContain('qzticket')
    expect(script).toContain('frame, iframe')
    // 纯地址栏净化：绝不重新加载或跳转
    expect(script).not.toContain('location.reload')
    expect(script).not.toContain('location.assign')
  })

  test('BUG-26b：stripOneTimeTicket 同时剥离 ticket 与 qzticket，hasOneTimeTicket 判定准确', () => {
    const withTicket =
      'https://xgfw.cdut.edu.cn/xsfw/sys/xsqjapp/*default/index.do?ticket=ST-1&qzticket=QZ-2#/wdqj'
    expect(hasOneTimeTicket(withTicket)).toBe(true)
    const cleaned = stripOneTimeTicket(withTicket)
    expect(cleaned).not.toContain('ticket=')
    expect(cleaned).not.toContain('qzticket=')
    expect(cleaned).toContain('#/wdqj')

    const clean = 'https://xgfw.cdut.edu.cn/xsfw/sys/xsqjapp/*default/index.do#/wdqj'
    expect(hasOneTimeTicket(clean)).toBe(false)
    expect(stripOneTimeTicket(clean)).toBe(clean)
  })
})

describe('2026 SOTA 学术范式回归（CI4A / Prune4Web / WebRollback，BUG-31 ~ BUG-36）', () => {
  /** 以模拟 DOM 运行采集脚本（复用既有测试的 new Function 注入手法） */
  function runCollector(elements: unknown[], cursor: (el: unknown) => string = () => 'auto') {
    const doc = {
      body: { querySelectorAll: () => elements },
      querySelectorAll: () => [],
      title: 't',
      defaultView: {
        getComputedStyle: (el: unknown) => ({
          display: 'block',
          visibility: 'visible',
          opacity: '1',
          cursor: cursor(el),
        }),
        innerWidth: 1200,
        innerHeight: 800,
      },
    }
    const runner = new Function('document', 'window', 'location', `return ${buildYanhuCollectorScript()}`)
    return runner(doc, doc.defaultView, { href: 'https://x/y' })
  }

  test('BUG-31：__yanhuDeriveName 经 closest(label) 与兄弟 span 将无名单选框正确命名', () => {
    const labelEl = { nodeType: 1, tagName: 'LABEL', textContent: '因私请假', getAttribute: () => '' }
    const radioViaLabel = {
      nodeType: 1,
      tagName: 'INPUT',
      className: '',
      id: '',
      getAttribute: (n: string) => (n === 'type' ? 'radio' : ''),
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 16, height: 16 }),
      innerText: '',
      textContent: '',
      closest: (sel: string) => (sel === 'label' ? labelEl : null),
      parentElement: null,
    }
    const viaLabel = runCollector([radioViaLabel])
    expect(viaLabel.elements).toHaveLength(1)
    expect(viaLabel.elements[0].role).toBe('radio')
    expect(viaLabel.elements[0].name).toBe('因私请假')

    const spanEl = { nodeType: 1, tagName: 'SPAN', textContent: '因公请假', getAttribute: () => '' }
    const radioViaSpan = {
      nodeType: 1,
      tagName: 'INPUT',
      className: '',
      id: '',
      getAttribute: (n: string) => (n === 'type' ? 'radio' : ''),
      getBoundingClientRect: () => ({ left: 40, top: 20, width: 16, height: 16 }),
      innerText: '',
      textContent: '',
      nextElementSibling: spanEl,
      parentElement: null,
    }
    const viaSpan = runCollector([radioViaSpan])
    expect(viaSpan.elements).toHaveLength(1)
    expect(viaSpan.elements[0].name).toBe('因公请假')
  })

  test('BUG-32：无名 generic 装饰节点被 100% 剪枝，绝不分配 BID', () => {
    // 代码级契约：采集脚本内置 Prune4Web 无名剪枝断言
    expect(buildYanhuCollectorScript()).toContain("(role === 'generic' || role === 'none') && !name")

    const decorEl = {
      nodeType: 1,
      tagName: 'DIV',
      className: 'deco',
      id: '',
      getAttribute: () => '',
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 40 }),
      innerText: '',
      textContent: '',
      parentElement: null,
    }
    const btnEl = {
      nodeType: 1,
      tagName: 'BUTTON',
      className: '',
      id: '',
      getAttribute: () => '',
      getBoundingClientRect: () => ({ left: 0, top: 60, width: 60, height: 24 }),
      innerText: '查询',
      textContent: '查询',
      parentElement: null,
    }
    const result = runCollector([decorEl, btnEl], (el) => (el === decorEl ? 'pointer' : 'auto'))
    // 装饰性无名 generic（即便 cursor:pointer 可交互）被剔除；有名按钮保留
    expect(result.elements).toHaveLength(1)
    expect(result.elements[0].name).toBe('查询')
  })

  test('BUG-33：YanhuDeadlockGuard 识别 A→B→A→B 乒乓振荡并触发动作空间遮罩', () => {
    const guard = new YanhuDeadlockGuard()
    expect(guard.evaluate('tab-dl', 'S1', 22, 'click').deadlock).toBe(false)
    expect(guard.evaluate('tab-dl', 'S2', 61, 'click').deadlock).toBe(false)
    expect(guard.evaluate('tab-dl', 'S1', 22, 'click').deadlock).toBe(false)

    const oscillating = guard.evaluate('tab-dl', 'S2', 61, 'click')
    expect(oscillating.deadlock).toBe(true)
    expect(oscillating.cyclePattern).toBe('click:22 ⇄ click:61')

    // 动作空间动态遮罩：再次尝试同一振荡动作被直接拦截
    const masked = guard.evaluate('tab-dl', 'S2', 61, 'click')
    expect(masked.deadlock).toBe(true)
    expect(masked.reason).toContain('动作空间已遮罩')

    // 历史按标签隔离，其他标签不受污染
    expect(guard.evaluate('tab-other', 'S1', 22, 'click').deadlock).toBe(false)
  })

  test('BUG-33b：环境状态持续推进的正常交替点击不被误判为死锁', () => {
    const guard = new YanhuDeadlockGuard()
    guard.evaluate('tab-ok', 'S1', 1, 'click')
    guard.evaluate('tab-ok', 'S2', 2, 'click')
    guard.evaluate('tab-ok', 'S3', 1, 'click')
    // 动作签名交替但状态未回退，不得熔断
    expect(guard.evaluate('tab-ok', 'S4', 2, 'click').deadlock).toBe(false)
  })

  test('BUG-34：normalizeStateString 剔除 Vue / EMAP 随机动态 ID 与挥发性 class', () => {
    const raw = '<div id="vue-1a2b3c" data-v-9f8a7b class="css-1x2y3z btn" bh-form-id="bh-12345">x</div>'
    const out = normalizeStateString(raw)
    expect(out).toContain('id="STRIPPED"')
    expect(out).toContain('data-v-STRIPPED')
    expect(out).toContain('class="STRIPPED"')
    expect(out).not.toContain('vue-1a2b3c')
    expect(out).not.toContain('9f8a7b')

    // 稳定语义 ID 不被误伤
    expect(normalizeStateString('<input id="studentName" name="reason">')).toContain('id="studentName"')
  })

  test('BUG-35：yanhu_select 对单选框调用时自动走 CI4A 语义单选匹配并成功', async () => {
    const originalEval = yanhuExpressManager.evalInPage
    const originalAx = yanhuExpressManager.getFullAXTree
    const originalStable = yanhuExpressManager.awaitStable
    let nativeEvaluated = false
    try {
      const elements = [
        {
          tag: 'input',
          role: 'radio',
          name: '因私请假',
          bounds: { x: 10, y: 20, width: 16, height: 16 },
          visible: true,
          ariaHidden: false,
          occluded: false,
          region: '业务表单',
          actionable: true,
        },
      ]
      yanhuExpressManager.evalInPage = async (_tabId: string | undefined, expr: string) => {
        if (expr === buildYanhuCollectorScript()) return { url: 'https://x/y', title: '学生请假', elements }
        if (expr.includes('__ci4aIsChoice')) return { ok: true, ci4a: 'radio', text: '因私请假' }
        if (expr.includes('isNativeSelect')) {
          nativeEvaluated = true
          return { ok: false, isNativeSelect: false, reason: 'not-native-select', tag: 'input' }
        }
        return { ok: true }
      }
      yanhuExpressManager.getFullAXTree = async () => []
      yanhuExpressManager.awaitStable = async () => ({
        settled: true,
        timedOut: false,
        elapsedMs: 0,
        inflight: 0,
        frames: 0,
        mutations: 0,
        lastActivityAt: 0,
      })

      const tools = buildYanhuBrowserTools(() => 'tab-ci4a-radio')
      await tools.find((t) => t.definition.name === 'yanhu_read_page')!.execute({})
      const select = tools.find((t) => t.definition.name === 'yanhu_select')!
      const res = await select.execute({ bid: 1, valueOrText: '因私请假' })

      expect(res.isError).toBeFalsy()
      expect(res.content).toContain('CI4A 语义单选匹配')
      expect(res.content).toContain('因私请假')
      // CI4A 命中即返回，绝不回落到原生下拉路径
      expect(nativeEvaluated).toBe(false)
    } finally {
      yanhuExpressManager.evalInPage = originalEval
      yanhuExpressManager.getFullAXTree = originalAx
      yanhuExpressManager.awaitStable = originalStable
    }
  })

  test('BUG-36：多步工具循环上下文剪枝严格压制 Token 膨胀', () => {
    const steps: ContinuationMessage[] = []
    for (let i = 0; i < 12; i += 1) {
      const id = `call-${i}`
      const name = i % 3 === 0 ? 'yanhu_read_page' : i % 3 === 1 ? 'yanhu_click' : 'yanhu_select'
      steps.push({ role: 'assistant', content: '', toolCalls: [{ id, name, arguments: {} }] })
      steps.push({
        role: 'tool',
        results: [{ toolCallId: id, content: 'X'.repeat(5000), isError: i % 2 === 0 }],
      })
    }

    const pruned = pruneYanhuContinuationMessages(steps)
    expect(pruned).toHaveLength(24)

    // 最旧步骤的巨型结果被压缩为极短占位 / 前缀
    const firstTool = pruned[1] as { results: Array<{ content: string }> }
    expect(firstTool.results[0]!.content.length).toBeLessThan(120)

    // 早期「错误回执」也被纳入精简压缩（保留 ≤60 字符诊断前缀）
    const errorStep = pruned[5] as { results: Array<{ content: string; isError?: boolean }> }
    expect(errorStep.results[0]!.isError).toBe(true)
    expect(errorStep.results[0]!.content.length).toBeLessThanOrEqual(61)

    // 整体序列化体积被严格压制：仅末尾 2 步原样保留，相对未剪枝体积下降 70% 以上
    const prunedChars = JSON.stringify(pruned).length
    const unprunedChars = JSON.stringify(steps).length
    expect(prunedChars).toBeLessThan(unprunedChars * 0.3)
  })
})

describe('选中事假/病假失败根因根治回归（BUG-37 ~ BUG-43）', () => {
  /** 合成事件替身：仅承载 type 与 init 透传，供被脚本驱动的最小 DOM 使用 */
  class YanhuMockEvent {
    type: string
    constructor(type: string, init?: Record<string, unknown>) {
      this.type = type
      if (init) Object.assign(this, init)
    }
  }

  /** 最小 DOM 环境：doc.querySelectorAll 由 selectorHit 决定命中，元素仅记录派发的事件序列 */
  function buildPickEnvironment(text: string, selectorHit: (sel: string) => boolean) {
    const dispatched: string[] = []
    const mockWindow = {
      MouseEvent: YanhuMockEvent,
      PointerEvent: YanhuMockEvent,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    }
    let item: {
      textContent: string
      children: unknown[]
      ownerDocument: unknown
      getBoundingClientRect: () => { left: number; top: number; width: number; height: number }
      dispatchEvent: (ev: { type?: string }) => boolean
      click: () => void
    } | null = null
    // 桩必须体现真实包含关系：选项位于**已展开的浮层**之内（.bh-pull-down-list / .jqx-listbox ...）。
    // 采集端现在要求「选项只能来自已展开的浮层」，否则会把页面上的泛化类名杂项误当选项回传。
    const popup = {
      textContent: text,
      children: [] as unknown[],
      ownerDocument: undefined as unknown,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 320 }),
      querySelectorAll: (sel: string) => (selectorHit(sel) && item ? [item] : []),
    }
    const mockDoc = {
      querySelectorAll: (sel: string) =>
        sel.indexOf('.bh-pull-down-list') >= 0 || sel.indexOf('.jqx-listbox') >= 0 ? [popup] : [],
      defaultView: mockWindow,
    }
    popup.ownerDocument = mockDoc
    item = {
      textContent: text,
      children: [],
      ownerDocument: mockDoc,
      getBoundingClientRect: () => ({ left: 10, top: 10, width: 60, height: 24 }),
      dispatchEvent: (ev: { type?: string }) => {
        dispatched.push(String(ev?.type))
        return true
      },
      click: () => dispatched.push('native-click'),
    }
    return { mockDoc, mockWindow, dispatched }
  }

  /** 以注入式 Function 运行生成脚本（复用既有测试的 new Function 手法），复用真实 Promise / 定时器 */
  function runPickScript(script: string, doc: unknown, win: unknown) {
    const runner = new Function('document', 'window', 'setTimeout', `return ${script}`)
    return runner(doc, win, setTimeout) as Promise<{ ok?: boolean; text?: string; reason?: string }>
  }

  const RADIO_RECORD: YanhuBidNode = {
    bid: 58,
    role: 'radio',
    name: '因私请假',
    tag: 'input',
    bounds: { x: 10, y: 20, width: 16, height: 16 },
  }
  const COMBO_RECORD: YanhuBidNode = {
    bid: 61,
    role: 'combobox',
    name: '请假类型',
    tag: 'div',
    bounds: { x: 10, y: 60, width: 160, height: 32 },
  }

  test('BUG-37：单选/复选框点击补齐 input + change + jQuery change 级联强触发', () => {
    const script = buildForceTriggerScript(RADIO_RECORD)
    // 原生 input / change 显式补齐（不依赖合成点击的隐式激活行为）
    expect(script).toContain('__cIsInputChoice')
    expect(script).toContain('el.checked = true')
    expect(script).toContain("new __cWin.Event('input'")
    expect(script).toContain("new __cWin.Event('change'")
    // jQuery 委托链穿透 + 同表单同名组联动（仅限最近表单作用域）
    expect(script).toContain("__cJq(el).trigger('change')")
    expect(script).toContain('input[name="')
    expect(script).toContain("closest('form')")
  })

  test('BUG-38：展开下拉脚本派发完整鼠标流并渗透至内部触发器', () => {
    const script = buildOpenDropdownScript(COMBO_RECORD)
    expect(script).toContain("'pointerdown'")
    expect(script).toContain("'mousedown'")
    expect(script).toContain("'pointerup'")
    expect(script).toContain("'mouseup'")
    expect(script).toContain("'click'")
    // 容器节点向内渗透至真实触发器（输入框 / 箭头 / 图标）
    expect(script).toContain('__isTriggerLike')
    expect(script).toContain('[class*="arrow"]')
    // jQuery 穿透与自适应展开判定
    expect(script).toContain("jq(primary).trigger('click')")
    expect(script).toContain('__panelOpen')
  })

  test('BUG-39：选项选择器解除 li 限定，可命中 div.jqx-listitem-element / div.bh-pull-down-item', async () => {
    const { mockDoc, mockWindow, dispatched } = buildPickEnvironment(
      '事假',
      (sel) => sel.includes('jqx-listitem-element') || sel.includes('bh-pull-down-item'),
    )
    const res = await runPickScript(buildPickCustomOptionScript('事假'), mockDoc, mockWindow)
    expect(res.ok).toBe(true)
    expect(res.text).toBe('事假')
    // 命中即派发完整鼠标流 + 单次 click（绝不重复点击造成多选切换）
    expect(dispatched).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
  })

  test('BUG-40：延迟 120ms 渲染的选项被 800ms 轮询探针成功捕获（不再瞬时误判不存在）', async () => {
    let ready = false
    const timer = setTimeout(() => {
      ready = true
    }, 120)
    const { mockDoc, mockWindow } = buildPickEnvironment('病假', (sel) => ready && sel.includes('bh-pull-down-item'))
    const startedAt = Date.now()
    const res = await runPickScript(buildPickCustomOptionScript('病假'), mockDoc, mockWindow)
    clearTimeout(timer)
    expect(res.ok).toBe(true)
    expect(res.text).toBe('病假')
    // 说明确实经历了异步等待，而非瞬时查找
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100)
  })

  test('BUG-40b：选项始终未渲染时探针在超时后返回 option-not-found（不误报成功）', async () => {
    const { mockDoc, mockWindow } = buildPickEnvironment('事假', () => false)
    const res = await runPickScript(buildPickCustomOptionScript('事假'), mockDoc, mockWindow)
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('option-not-found')
  })

  test('BUG-41：buildJqxSelectScript 在存在 $.fn.jqxDropDownList 时通过 API 极速选中并同步 input', () => {
    const script = buildJqxSelectScript(COMBO_RECORD, '事假')
    expect(script).toContain('jqxDropDownList')
    expect(script).toContain('getItems')
    expect(script).toContain('selectIndex')
    expect(script).toContain('input[type="hidden"]')
    expect(script).toContain("new Event('change'")
  })

  test('BUG-42：buildOpenDropdownScript 向内渗透点击 #dropdownlistArrow 与内部图标', () => {
    const script = buildOpenDropdownScript(COMBO_RECORD)
    expect(script).toContain('[id*="dropdownlistArrow"]')
    expect(script).toContain('[class*="icon-arrow"]')
    expect(script).toContain('innerArrow')
    expect(script).toContain('__fireAll(innerArrow)')
  })

  test('BUG-43：buildOpenDropdownScript 正确利用 aria-owns 判定 JQWidgets 浮层展开状态', () => {
    const script = buildOpenDropdownScript(COMBO_RECORD)
    expect(script).toContain('aria-owns')
    expect(script).toContain('getElementById(ariaOwns)')
    expect(script).toContain('innerListBox')
    expect(script).toContain('listBoxContent')
  })
})

describe('日期时间选择器根治与全链路提速回归（BUG-44 ~ BUG-47、BUG-49 ~ BUG-50）', () => {
  const DATE_RECORD: YanhuBidNode = {
    bid: 63,
    role: 'combobox',
    name: '请假开始时间',
    tag: 'input',
    bounds: { x: 10, y: 200, width: 180, height: 32 },
  }




  test('BUG-47：因果观察窗压缩至 300ms、静默窗口压缩至 150ms（消灭空等 2 秒假死）', () => {
    expect(YANHU_CAUSAL_OBSERVATION_MS).toBe(300)
    expect(YANHU_STABILIZE_WINDOW_MS).toBe(150)
  })


})

describe('复杂布局与表单加固回归（Shadow DOM / 富文本 / 吸顶遮挡）', () => {
  test('buildHardwareClickTargetScript 内置吸顶头遮挡绕过（微调可滚动祖先）', () => {
    const script = buildHardwareClickTargetScript({
      bid: 1,
      role: 'button',
      name: '提交',
      tag: 'button',
      bounds: { x: 10, y: 20, width: 80, height: 32 },
    })
    expect(script).toContain('__stickyBypass')
    expect(script).toContain('elementFromPoint')
    expect(script).toContain('overflowY')
    expect(script).toContain('scrollBy')
    // 生成的页面脚本必须能被 JS 引擎解析（防模板转义引入语法错误）
    expect(() => new Function('document', 'window', script)).not.toThrow()
  })

  test('yanhu_fill 对 contenteditable 的降级回退使用 execCommand(insertText)，绝不整体覆写 textContent', async () => {
    const originalEval = yanhuExpressManager.evalInPage
    const originalAx = yanhuExpressManager.getFullAXTree
    const originalStable = yanhuExpressManager.awaitStable
    const originalTextInput = yanhuExpressManager.dispatchHumanTextInput
    const exprs: string[] = []
    try {
      const elements = [
        {
          tag: 'div',
          role: 'textbox',
          name: '请假事由',
          bounds: { x: 10, y: 20, width: 200, height: 80 },
          visible: true,
          ariaHidden: false,
          occluded: false,
          region: '业务表单',
          actionable: true,
        },
      ]
      yanhuExpressManager.evalInPage = async (_tabId: string | undefined, expr: string) => {
        exprs.push(expr)
        if (expr === buildYanhuCollectorScript()) return { url: 'https://x/y', title: 't', elements }
        if (expr.includes('editableInput')) {
          return { ok: true, editable: true, tag: 'div', type: '', role: 'textbox' }
        }
        if (expr.includes('hitOk')) return { ok: false, reason: 'not-found' }
        return { ok: true }
      }
      yanhuExpressManager.getFullAXTree = async () => []
      yanhuExpressManager.awaitStable = async () => ({
        settled: true,
        timedOut: false,
        elapsedMs: 0,
        inflight: 0,
        frames: 0,
        mutations: 0,
        lastActivityAt: 0,
      })
      let textInputCalls = 0
      yanhuExpressManager.dispatchHumanTextInput = async () => {
        textInputCalls += 1
      }

      const tools = buildYanhuBrowserTools(() => 'tab-rich-editor')
      await tools.find((t) => t.definition.name === 'yanhu_read_page')!.execute({})
      const fill = tools.find((t) => t.definition.name === 'yanhu_fill')!
      const res = await fill.execute({ bid: 1, value: '因病请假' })

      expect(res.isError).toBeFalsy()
      const legacy = exprs.find((e) => e.includes('execCommand') && e.includes('createRange')) ?? ''
      expect(legacy).toContain("execCommand('insertText'")
      // 关键红线：绝不整体覆写 contenteditable 的 textContent（会摧毁编辑器内部 DOM 树）
      expect(legacy).not.toContain('el.textContent = next')
      // 生成的页面脚本必须能被 JS 引擎解析（防模板转义引入语法错误）
      expect(() => new Function('document', 'window', legacy)).not.toThrow()
      expect(textInputCalls).toBe(0)
    } finally {
      yanhuExpressManager.evalInPage = originalEval
      yanhuExpressManager.getFullAXTree = originalAx
      yanhuExpressManager.awaitStable = originalStable
      yanhuExpressManager.dispatchHumanTextInput = originalTextInput
    }
  })

  test('yanhu_fill 降级脚本的下发事件链完备（PointerDown->MouseDown->Focus->Value->Input->Change->PointerUp->MouseUp->Blur）', async () => {
    const originalEval = yanhuExpressManager.evalInPage
    const originalAx = yanhuExpressManager.getFullAXTree
    const originalStable = yanhuExpressManager.awaitStable
    const originalTextInput = yanhuExpressManager.dispatchHumanTextInput
    const exprs: string[] = []
    try {
      const elements = [
        {
          tag: 'input',
          role: 'textbox',
          name: '学号',
          bounds: { x: 10, y: 20, width: 200, height: 28 },
          visible: true,
          ariaHidden: false,
          occluded: false,
          region: '业务表单',
          actionable: true,
        },
      ]
      yanhuExpressManager.evalInPage = async (_tabId: string | undefined, expr: string) => {
        exprs.push(expr)
        if (expr === buildYanhuCollectorScript()) return { url: 'https://x/y', title: 't', elements }
        if (expr.includes('editableInput')) {
          return { ok: true, editable: true, tag: 'input', type: 'text', role: 'textbox' }
        }
        if (expr.includes('hitOk')) return { ok: false, reason: 'not-found' }
        return { ok: true }
      }
      yanhuExpressManager.getFullAXTree = async () => []
      yanhuExpressManager.awaitStable = async () => ({
        settled: true,
        timedOut: false,
        elapsedMs: 0,
        inflight: 0,
        frames: 0,
        mutations: 0,
        lastActivityAt: 0,
      })
      yanhuExpressManager.dispatchHumanTextInput = async () => {}

      const tools = buildYanhuBrowserTools(() => 'tab-event-chain')
      await tools.find((t) => t.definition.name === 'yanhu_read_page')!.execute({})
      const fill = tools.find((t) => t.definition.name === 'yanhu_fill')!
      await fill.execute({ bid: 1, value: '20210001' })

      const legacy = exprs.find((e) => e.includes('HTMLInputElement.prototype')) ?? ''
      expect(legacy).not.toBe('')
      // 完备合成事件链：缺任一环都可能导致 Vue v-model / React onChange 未同步而被回滚
      expect(legacy).toContain("'pointerdown'")
      expect(legacy).toContain("'mousedown'")
      expect(legacy).toContain("'pointerup'")
      expect(legacy).toContain("'mouseup'")
      expect(legacy).toContain("new Event('input'")
      expect(legacy).toContain("new Event('change'")
      // 原生原型 setter 写入（绝不直接 el.value = next，否则 Vue/React 感知不到）
      expect(legacy).toContain("Object.getOwnPropertyDescriptor(proto, 'value')")
      // 页面脚本必须可被 JS 引擎解析
      expect(() => new Function('document', 'window', legacy)).not.toThrow()
    } finally {
      yanhuExpressManager.evalInPage = originalEval
      yanhuExpressManager.getFullAXTree = originalAx
      yanhuExpressManager.awaitStable = originalStable
      yanhuExpressManager.dispatchHumanTextInput = originalTextInput
    }
  })

  test('跨域（OOPIF）框架元素采集失败时主框架感知不受影响', async () => {
    const originalEval = yanhuExpressManager.evalInPage
    const originalAx = yanhuExpressManager.getFullAXTree
    const originalOopif = yanhuExpressManager.collectCrossOriginFrameElements
    try {
      const elements = [
        {
          tag: 'button',
          role: 'button',
          name: '查询',
          bounds: { x: 10, y: 20, width: 80, height: 32 },
          visible: true,
          ariaHidden: false,
          occluded: false,
          region: '表单区',
          actionable: true,
        },
      ]
      yanhuExpressManager.evalInPage = async (_tabId: string | undefined, expr: string) =>
        expr === buildYanhuCollectorScript() ? { url: 'https://x/y', title: 't', elements } : { ok: true }
      yanhuExpressManager.getFullAXTree = async () => []
      // 跨域采集抛错 → 主框架蒸馏必须照常完成
      yanhuExpressManager.collectCrossOriginFrameElements = async () => {
        throw new Error('oopif-failed')
      }

      const tools = buildYanhuBrowserTools(() => 'tab-oopif-fail')
      const res = await tools.find((t) => t.definition.name === 'yanhu_read_page')!.execute({})
      expect(res.isError).toBeFalsy()
      expect(res.content).toContain('查询')
    } finally {
      yanhuExpressManager.evalInPage = originalEval
      yanhuExpressManager.getFullAXTree = originalAx
      yanhuExpressManager.collectCrossOriginFrameElements = originalOopif
    }
  })

  test('全部页面注入脚本在 V8 引擎中均可正常编译解析（零未闭合注释与语法错误）', () => {
    const dummyRecord: YanhuBidNode = {
      bid: 37,
      role: 'button',
      tag: 'button',
      name: '学生请假系统',
      bounds: { x: 120, y: 80, width: 90, height: 28 },
    }
    const scripts = [
      buildForceTriggerScript(dummyRecord),
      buildHardwareClickTargetScript(dummyRecord),
      buildOpenDropdownScript(dummyRecord),
      buildPickCustomOptionScript('事假'),
      buildJqxSelectScript(dummyRecord, '事假'),
      buildYanhuCollectorScript(),
      buildOneTimeTicketSanitizeScript(),
      buildSyntheticEnterScript(),
    ]
    for (const script of scripts) {
      expect(() => new Function('document', 'window', script)).not.toThrow()
    }
  })
});

/**
 * 入参净化与 BID 自愈重定位回归。
 *
 * 锁死两个高频故障：
 *   1. 模型把提示词示例里的反引号一并抄进入参（`"url": "\`https://...\`"`），导航拿到脏值必失败；
 *   2. 页面局部重绘后 BID 台账整体重新编号，工具报「定位失败」，模型被迫再花两轮 read_page
 *      才能拿到新 BID —— 现在由 relocateBySemantics 直接回传新编号。
 */
/**
 * 「页面无变化」短路的自证能力回归。
 *
 * 锁死历史故障：该短路口径曾只输出「[bid] role "name"」，把各控件**当前值**全部丢掉。
 * 长表单填写过程中绝大多数 read_page 都走这条短路，于是模型无法核对「刚填的值进没进去」，
 * 进而怀疑自己的历史操作是否真的发生过（思考链原话：「worried that many of the earlier fills
 * were hallucinated by me」）。台账必须与全量摘要同口径。
 */
describe('buildUnchangedNotice（页面无变化台账必须带当前值）', () => {
  test('每个控件都带 value / options 等当前状态，与全量摘要同口径', () => {
    const notice = buildUnchangedNotice({
      url: 'https://xgfw.cdut.edu.cn/x',
      title: '学生请假',
      digestText: '',
      bidCount: 2,
      timestamp: Date.now(),
      nodes: [
        {
          bid: 15,
          role: 'textbox',
          tag: 'input',
          name: '请假结束时间',
          value: '2026-10-17 18:00',
          bounds: { x: 480, y: 300, width: 200, height: 30 },
        },
        {
          bid: 6,
          role: 'combobox',
          tag: 'div',
          name: '请假类型',
          options: [
            { value: '1', text: '事假', selected: true },
            { value: '2', text: '病假', selected: false },
          ],
          bounds: { x: 480, y: 200, width: 200, height: 30 },
        },
      ],
    })
    expect(notice).toContain('value="2026-10-17 18:00"')
    expect(notice).toContain('current: "事假"')
    expect(notice).toContain('[BID: 15]')
    expect(notice).toContain('共 2 项，含当前值')
  })
})

/**
 * 自定义下拉失败回执必须自带「已渲染的可用选项」。
 *
 * 历史故障：级联选择的浮层不进 PageDigest，失败回执又只说「未能匹配到选项」，
 * 模型只能靠猜选项名反复空转（连试 武侯区 / 锦江区 / 青羊区 多轮全败）。
 */
describe('buildPickCustomOptionScript（失败时回传已渲染选项）', () => {
  test('匹配失败时列出可见选项文本，且剔除未渲染项', async () => {
    const makeOption = (text: string, display: string) => ({
      textContent: text,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 60, height: 20 }),
      ownerDocument: {
        defaultView: { getComputedStyle: () => ({ display, visibility: 'visible', opacity: '1' }) },
      },
    })
    const visible = makeOption('武侯区', 'block')
    const hidden = makeOption('隐藏模板项', 'none')
    const doc = {
      querySelectorAll: (selector: string) => (selector === '[role="option"]' ? [visible, hidden] : []),
    }
    const script = buildPickCustomOptionScript('锦江区')
    const runner = new Function('document', 'window', `return ${script}`)
    const result = (await runner(doc, {})) as { ok: boolean; options?: string[] }

    expect(result.ok).toBe(false)
    expect(result.options).toContain('武侯区')
    expect(result.options).not.toContain('隐藏模板项')
  })

  test('Given 浮层未展开 When 页面存在 .jqx-item 等泛化类名杂项 Then 绝不把它们当作选项回传', async () => {
    // 复现历史误导：回执曾回传「已渲染的可用选项：没有数据 / 事假 / 10 / 请选择...」
    const junk = {
      textContent: '没有数据',
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 80, height: 20 }),
      ownerDocument: {
        defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) },
      },
    }
    const doc = {
      querySelectorAll: (selector: string) => (selector === '.jqx-item' ? [junk] : []),
    }
    const runner = new Function('document', 'window', `return ${buildPickCustomOptionScript('香港特别行政区')}`)
    const result = (await runner(doc, {})) as { ok: boolean; options?: string[] }

    expect(result.ok).toBe(false)
    expect(result.options ?? []).toEqual([])
  })

  test('Given 浮层已展开 When 扫描选项 Then 只认浮层内的项，浮层外的同名文本不算', async () => {
    const makeNode = (text: string, children: unknown[] = []) => ({
      textContent: text,
      children,
      getBoundingClientRect: () => ({ left: 100, top: 100, width: 120, height: 24 }),
      ownerDocument: {
        defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) },
      },
    })
    const provinceItem = makeNode('吉林省')
    const popup = {
      ...makeNode('吉林省 贵州省'),
      querySelectorAll: (selector: string) =>
        selector === '.jqx-item' || selector === '*' ? [provinceItem] : [],
    }
    const doc = {
      querySelectorAll: (selector: string) => (selector.indexOf('.jqx-listbox') >= 0 ? [popup] : []),
    }
    const runner = new Function('document', 'window', `return ${buildPickCustomOptionScript('香港特别行政区')}`)
    const result = (await runner(doc, {})) as { ok: boolean; options?: string[] }

    expect(result.ok).toBe(false)
    expect(result.options).toEqual(['吉林省'])
  })
  test('Given 浮层内只有「文本包含目标」的聚合容器 When 匹配 Then 绝不点中容器误报成功（虚假成功回归）', async () => {
    // 真实事故：目标控件名是「请选择... 香港特别行政区」，其文本本身包含目标「香港特别行政区」，
    // 旧逻辑以子串匹配命中了这个容器并点击，回报「已选择 -> 香港特别行政区」，而控件毫无变化。
    const leaf = (text: string) => ({
      textContent: text,
      children: [],
      getAttribute: () => '',
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 60, height: 20 }),
      ownerDocument: {
        defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) },
      },
    })
    const leafA = leaf('吉林省')
    const leafB = leaf('贵州省')
    const container = {
      textContent: '吉林省 贵州省 香港特别行政区',
      children: [leafA, leafB],
      getAttribute: () => '',
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 220, height: 300 }),
      ownerDocument: {
        defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) },
      },
    }
    const popup = {
      ...container,
      querySelectorAll: (selector: string) =>
        selector === '.jqx-item' ? [container] : selector === '*' ? [container, leafA, leafB] : [],
    }
    const doc = {
      querySelectorAll: (selector: string) => (selector.indexOf('.jqx-listbox') >= 0 ? [popup] : []),
    }
    const runner = new Function('document', 'window', `return ${buildPickCustomOptionScript('香港特别行政区')}`)
    const result = (await runner(doc, {})) as { ok: boolean; options?: string[] }

    // 关键：不得返回成功（旧行为会点掉容器并误报「已选择」）
    expect(result.ok).toBe(false)
    // 回传清单只列叶子选项，聚合容器名不得出现（否则会再次误导模型）
    expect(result.options).toEqual(['吉林省', '贵州省'])
  })
})

/**
 * 只读控件的填写通道。
 *
 * 历史浪费：只读输入框（EMAP 日历 / 时间选择器 / 树选择的承载框）的值由页面自带控件驱动，
 * CDP 物理输入对它 100% 无效，但旧逻辑每次都先跑一遍「聚焦 + 输入 + 回读校验」才降级。
 */
describe('只读控件填写通道', () => {
  test('Given 目标是只读输入框 When 填写 Then 跳过物理输入，直接走 JS 原生 setter 通道并说明', async () => {
    const originalEval = yanhuExpressManager.evalInPage
    const originalAx = yanhuExpressManager.getFullAXTree
    const originalStable = yanhuExpressManager.awaitStable
    const originalTextInput = yanhuExpressManager.dispatchHumanTextInput
    const exprs: string[] = []
    let textInputCalls = 0
    try {
      const elements = [
        {
          tag: 'input',
          role: 'textbox',
          name: '请假开始时间',
          bounds: { x: 480, y: 300, width: 200, height: 30 },
          visible: true,
          ariaHidden: false,
          occluded: false,
          region: '业务表单',
          actionable: true,
        },
      ]
      yanhuExpressManager.evalInPage = async (_tabId: string | undefined, expr: string) => {
        exprs.push(expr)
        if (expr === buildYanhuCollectorScript()) {
          return { url: 'https://xgfw.cdut.edu.cn/x', title: '学生请假', elements }
        }
        if (expr.includes('editableInput')) {
          return { ok: true, editable: true, readOnly: true, tag: 'input', type: 'text', role: 'textbox' }
        }
        return { ok: true }
      }
      yanhuExpressManager.getFullAXTree = async () => []
      yanhuExpressManager.awaitStable = async () => ({
        settled: true,
        timedOut: false,
        elapsedMs: 0,
        inflight: 0,
        frames: 0,
        mutations: 0,
        lastActivityAt: 0,
      })
      yanhuExpressManager.dispatchHumanTextInput = async () => {
        textInputCalls += 1
      }

      const tools = buildYanhuBrowserTools(() => 'tab-fill-readonly')
      await tools.find((t) => t.definition.name === 'yanhu_read_page')!.execute({})
      const res = await tools.find((t) => t.definition.name === 'yanhu_fill')!.execute({
        bid: 1,
        value: '2026-10-17 08:00',
      })

      expect(res.isError).toBeFalsy()
      // 关键：不做注定失败的物理输入
      expect(textInputCalls).toBe(0)
      // 确实走了 JS 降级通道（脚本内含解封辅助）
      expect(exprs.some((expr) => expr.includes('__unseal'))).toBe(true)
      // 回执如实说明走了哪条通道，并给出「仍不生效时的替代路径」
      expect(res.content).toContain('只读控件')
    } finally {
      yanhuExpressManager.evalInPage = originalEval
      yanhuExpressManager.getFullAXTree = originalAx
      yanhuExpressManager.awaitStable = originalStable
      yanhuExpressManager.dispatchHumanTextInput = originalTextInput
    }
  })
})

/**
 * 选中后校验（杜绝「虚假成功」）。
 *
 * 真实事故：出校去向的树形选择器，工具连续多轮回报「已选择 -> 香港特别行政区」，
 * 而控件显示始终是「请选择...」——模型据此反复重试、最后撞熔断。根因是把
 * 「点中了文本相同的元素」当成了「目标控件的值被设置」。
 */
describe('yanhu_select 选中后校验', () => {
  test('Given 点选了选项但控件显示毫无变化 When 选择 Then 如实报错，绝不谎报成功', async () => {
    const originalEval = yanhuExpressManager.evalInPage
    const originalAx = yanhuExpressManager.getFullAXTree
    const originalStable = yanhuExpressManager.awaitStable
    try {
      const elements = [
        {
          tag: 'div',
          role: 'tree',
          name: '出校去向',
          bounds: { x: 10, y: 20, width: 200, height: 32 },
          visible: true,
          ariaHidden: false,
          occluded: false,
          region: '业务表单',
          actionable: true,
        },
      ]
      yanhuExpressManager.evalInPage = async (_tabId: string | undefined, expr: string) => {
        if (expr === buildYanhuCollectorScript()) return { url: 'https://x/y', title: 't', elements }
        if (expr.includes('isNativeSelect')) {
          return { ok: false, isNativeSelect: false, reason: 'not-native-select', tag: 'div' }
        }
        // 面板里确实匹配到了「香港特别行政区」并点击成功……
        if (expr.includes('selectors =')) return { ok: true, matched: 2, text: '香港特别行政区' }
        // ……但控件显示始终停在占位符（模拟树形选择器不接受模拟点选）
        if (expr.includes('__yanhuOwnText')) return { ok: true, text: '请选择...' }
        return { ok: true }
      }
      yanhuExpressManager.getFullAXTree = async () => []
      yanhuExpressManager.awaitStable = async () => ({
        settled: true,
        timedOut: false,
        elapsedMs: 0,
        inflight: 0,
        frames: 0,
        mutations: 0,
        lastActivityAt: 0,
      })

      const tools = buildYanhuBrowserTools(() => 'tab-select-verify')
      await tools.find((t) => t.definition.name === 'yanhu_read_page')!.execute({})
      const res = await tools.find((t) => t.definition.name === 'yanhu_select')!.execute({
        bid: 1,
        valueOrText: '香港特别行政区',
      })

      expect(res.isError).toBe(true)
      expect(res.content).toContain('目标控件显示未发生变化')
      expect(res.content).toContain('请选择...')
      // 明确告知模型不要反复重试同一路径
      expect(res.content).toContain('不要反复重试')
    } finally {
      yanhuExpressManager.evalInPage = originalEval
      yanhuExpressManager.getFullAXTree = originalAx
      yanhuExpressManager.awaitStable = originalStable
    }
  })
  test('Given 合成事件被控件拒绝 When 选择 Then 自动升级为 CDP 硬件级真实点击并如实说明', async () => {
    const originalEval = yanhuExpressManager.evalInPage
    const originalAx = yanhuExpressManager.getFullAXTree
    const originalStable = yanhuExpressManager.awaitStable
    const originalHumanClick = yanhuExpressManager.dispatchHumanClick
    let humanClicks = 0
    try {
      const elements = [
        {
          tag: 'div',
          role: 'tree',
          name: '出校去向',
          bounds: { x: 10, y: 20, width: 200, height: 32 },
          visible: true,
          ariaHidden: false,
          occluded: false,
          region: '业务表单',
          actionable: true,
        },
      ]
      yanhuExpressManager.evalInPage = async (_tabId: string | undefined, expr: string) => {
        if (expr === buildYanhuCollectorScript()) return { url: 'https://x/y', title: 't', elements }
        if (expr.includes('isNativeSelect')) {
          return { ok: false, isNativeSelect: false, reason: 'not-native-select', tag: 'div' }
        }
        if (expr.includes('selectors =')) {
          return { ok: true, matched: 2, text: '香港特别行政区', x: 480, y: 300 }
        }
        // 合成事件阶段控件毫无反应；只有 CDP 真实点击之后显示文本才更新
        if (expr.includes('__yanhuOwnText')) {
          return { ok: true, text: humanClicks > 0 ? '香港特别行政区' : '请选择...' }
        }
        return { ok: true }
      }
      yanhuExpressManager.getFullAXTree = async () => []
      yanhuExpressManager.awaitStable = async () => ({
        settled: true,
        timedOut: false,
        elapsedMs: 0,
        inflight: 0,
        frames: 0,
        mutations: 0,
        lastActivityAt: 0,
      })
      yanhuExpressManager.dispatchHumanClick = async () => {
        humanClicks += 1
      }

      const tools = buildYanhuBrowserTools(() => 'tab-select-escalate')
      await tools.find((t) => t.definition.name === 'yanhu_read_page')!.execute({})
      const res = await tools.find((t) => t.definition.name === 'yanhu_select')!.execute({
        bid: 1,
        valueOrText: '香港特别行政区',
      })

      expect(res.isError).toBeFalsy()
      expect(humanClicks).toBe(1)
      expect(res.content).toContain('香港特别行政区')
      expect(res.content).toContain('已自动升级至 CDP 硬件级点击')
    } finally {
      yanhuExpressManager.evalInPage = originalEval
      yanhuExpressManager.getFullAXTree = originalAx
      yanhuExpressManager.awaitStable = originalStable
      yanhuExpressManager.dispatchHumanClick = originalHumanClick
    }
  })
})

/**
 * EMAP / JQWidgets 树形 / 级联选择器极速通道。
 *
 * 历史事故：「出校去向」是 jqxDropDownButton + jqxTree，不属于单级 jqxDropDownList，
 * 旧实现只能退化为脆弱的 DOM 点选 —— 合成事件被忽略、CDP 点击也不生效，
 * 且即使点中也不会同步隐藏域与 EMAP 表单模型，校验始终报「出校去向不能为空」。
 */
describe('EMAP 树形选择器极速通道', () => {
  test('Given 树形选择器 When 生成极速通道脚本 Then 覆盖原生 API 全链路', () => {
    const record = {
      bid: 24,
      tag: 'div',
      role: 'combobox',
      name: '出校去向',
      bounds: { x: 10, y: 20, width: 200, height: 32 },
      visible: true,
      ariaHidden: false,
      occluded: false,
      region: '业务表单',
      actionable: true,
    } as unknown as YanhuBidNode
    const script = buildEmapTreeSelectScript(record, '香港特别行政区')
    expect(script).toContain("jqxTree('getItems')")
    expect(script).toContain("jqxTree('selectItem'")
    expect(script).toContain("jqxDropDownButton('setContent'")
    expect(script).toContain("jqxDropDownButton('close')")
    expect(script).toContain("emapForm('setValue'")
    expect(script).toContain('input[type="hidden"]')
    expect(script).toContain(JSON.stringify('香港特别行政区'))
    // 点击收口脚本同样必须触发 select 并收起浮层
    const commit = buildTreeItemCommitScript(record)
    expect(commit).toContain("trigger('select'")
    expect(commit).toContain("jqxDropDownButton('close')")
  })

  test('Given 树形选择器 When 选择 Then 走 EMAP 极速通道，且必须通过选中后校验才算成功', async () => {
    const originalEval = yanhuExpressManager.evalInPage
    const originalAx = yanhuExpressManager.getFullAXTree
    const originalStable = yanhuExpressManager.awaitStable
    let treeCalls = 0
    try {
      const elements = [
        {
          tag: 'div',
          role: 'combobox',
          name: '出校去向',
          bounds: { x: 10, y: 20, width: 200, height: 32 },
          visible: true,
          ariaHidden: false,
          occluded: false,
          region: '业务表单',
          actionable: true,
        },
      ]
      yanhuExpressManager.evalInPage = async (_tabId: string | undefined, expr: string) => {
        if (expr === buildYanhuCollectorScript()) return { url: 'https://x/y', title: 't', elements }
        if (expr.includes('isNativeSelect')) {
          return { ok: false, isNativeSelect: false, reason: 'not-native-select', tag: 'div' }
        }
        // 极速通道：走控件原生 API（必须显式回传 via 标记才算命中）
        if (expr.includes('emap-tree-api')) {
          treeCalls += 1
          return { ok: true, via: 'emap-tree-api', text: '香港特别行政区', value: 'HK' }
        }
        if (expr.includes('__yanhuOwnText')) {
          return { ok: true, text: treeCalls > 0 ? '香港特别行政区' : '请选择...' }
        }
        return { ok: true }
      }
      yanhuExpressManager.getFullAXTree = async () => []
      yanhuExpressManager.awaitStable = async () => ({
        settled: true,
        timedOut: false,
        elapsedMs: 0,
        inflight: 0,
        frames: 0,
        mutations: 0,
        lastActivityAt: 0,
      })

      const tools = buildYanhuBrowserTools(() => 'tab-tree-select')
      await tools.find((t) => t.definition.name === 'yanhu_read_page')!.execute({})
      const res = await tools.find((t) => t.definition.name === 'yanhu_select')!.execute({
        bid: 1,
        valueOrText: '香港特别行政区',
      })

      expect(treeCalls).toBe(1)
      expect(res.isError).toBeFalsy()
      expect(res.content).toContain('树形极速通道')
      expect(res.content).toContain('香港特别行政区')
    } finally {
      yanhuExpressManager.evalInPage = originalEval
      yanhuExpressManager.getFullAXTree = originalAx
      yanhuExpressManager.awaitStable = originalStable
    }
  })
})

describe('入参净化（stripDecorators / asInt）', () => {
  test('Given 整串被反引号包裹的 URL When 净化 Then 剥掉反引号与首尾空白', () => {
    expect(stripDecorators('`https://xgfw.cdut.edu.cn/xsfw/sys/emappagelog/index.do`')).toBe(
      'https://xgfw.cdut.edu.cn/xsfw/sys/emappagelog/index.do',
    )
    expect(stripDecorators('  https://a.cn/b  ')).toBe('https://a.cn/b')
  })

  test('Given 额外指定引号符号 When 净化 Then 成对的直引号 / 弯引号同样被剥离', () => {
    expect(stripDecorators('"https://a.cn/b"', URL_DECORATORS)).toBe('https://a.cn/b')
    expect(stripDecorators('“https://a.cn/b”', URL_DECORATORS)).toBe('https://a.cn/b')
  })

  test('Given 合法内容内部含引号 When 净化 Then 不做任何改动（绝不误伤）', () => {
    expect(stripDecorators('他说“好”', URL_DECORATORS)).toBe('他说“好”')
    expect(stripDecorators('a`b`c')).toBe('a`b`c')
  })

  test('Given 模型把 BID 写成带装饰符的字符串 When asInt Then 正确解析出整数', () => {
    expect(asInt('`87`')).toBe(87)
    expect(asInt('"88"')).toBe(88)
    expect(asInt(89)).toBe(89)
  })

  test('Given 缺参 When asInt Then 仍返回调用方给定的兜底值（不因净化而丢默认值）', () => {
    expect(asInt(undefined, 120)).toBe(120)
    expect(asInt(null, 120)).toBe(120)
    expect(asInt('', 120)).toBe(120)
    expect(asInt('abc', 120)).toBe(120)
  })
})

describe('BID 自愈重定位（relocateBySemantics）', () => {
  function collect(names: Array<{ name: string; role: string; tag: string; x: number }>): YanhuCollectedPage {
    return {
      url: 'https://xgfw.cdut.edu.cn/xsfw/sys/emappagelog/index.do',
      title: '学生请假',
      elements: names.map((item) => ({
        tag: item.tag,
        role: item.role,
        name: item.name,
        bounds: { x: item.x, y: 0, width: 40, height: 20 },
        visible: true,
        ariaHidden: false,
        occluded: false,
        region: '业务表单',
        actionable: true,
      })),
    }
  }

  test('Given 同名控件在新台账中已换号 When 重定位 Then 按旧坐标取最近者并返回新 BID', () => {
    const tabId = `tab-relocate-${Date.now()}`
    yanhuDomDistillationEngine.distill(
      tabId,
      collect([
        { name: '请假开始时间', role: 'textbox', tag: 'input', x: 0 },
        { name: '请假开始时间', role: 'textbox', tag: 'input', x: 500 },
        { name: '请假事由', role: 'textbox', tag: 'input', x: 0 },
      ]),
    )
    // 旧台账中位于页面右侧的那一个（模拟改版前的 BID 已失效）
    const relocated = relocateBySemantics(tabId, {
      bid: 9999,
      role: 'textbox',
      tag: 'input',
      name: '请假开始时间',
      bounds: { x: 490, y: 0, width: 40, height: 20 },
    })
    expect(relocated).not.toBeNull()
    expect(relocated?.bid).toBe(2)
  })

  test('Given 页面已无同名同角色控件 When 重定位 Then 返回 null 而非盲猜坐标最近者', () => {
    const tabId = `tab-relocate-none-${Date.now()}`
    yanhuDomDistillationEngine.distill(
      tabId,
      collect([{ name: '其它字段', role: 'textbox', tag: 'input', x: 10 }]),
    )
    const relocated = relocateBySemantics(tabId, {
      bid: 1,
      role: 'textbox',
      tag: 'input',
      name: '请假开始时间',
      bounds: { x: 10, y: 0, width: 40, height: 20 },
    })
    expect(relocated).toBeNull()
  })
});
