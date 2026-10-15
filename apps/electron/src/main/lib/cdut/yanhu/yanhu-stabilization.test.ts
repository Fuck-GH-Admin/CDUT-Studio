/**
 * 智联万站 · 确定性同步与高保真因果交互引擎（yanhu-stabilization）单元测试
 *
 * 采用 BDD 行为驱动，覆盖：
 *   - 双平面静止算法（网络流在途清零 + 跨 Frame DOM 排空 + 滑动窗口静默确认）；
 *   - 跨嵌套框架坐标递归投影（BoundingRect + 滚动偏移 + DPR）；
 *   - 两阶梯自适应分派状态机（因果命中 / No-Op 升级 / 终端失败 / 新标签页接管）；
 *   - 因果排空脚本与结果归一化的防御式契约。
 */

import { describe, expect, test } from 'bun:test'
import type { YanhuBidNode } from '@profer/shared'
import {
  buildCrossFrameDrainScript,
  HybridAdaptiveDispatcher,
  MultiFrameCoordinateTransformer,
  normalizeCrossFrameDrain,
  StabilizationWatcher,
  type CausalObservation,
  type CausalSnapshot,
  type CrossFrameDrainOptions,
  type HybridDispatcherAdapter,
  type QuiescenceResult,
  type StabilizationProbe,
} from './yanhu-stabilization'

// ===== 测试替身 =====

/** 可控伪时钟：sleep / advance 直接推进逻辑时间，保证窗口判定确定性 */
function createFakeClock(start = 0): { now: () => number; sleep: (ms: number) => Promise<void>; advance: (ms: number) => void } {
  let t = start
  return {
    now: () => t,
    sleep: async (ms: number) => void (t += Math.max(0, ms)),
    advance: (ms: number) => void (t += Math.max(0, ms)),
  }
}

/** 伪探针：drainCrossFrame 阻塞 minMs 并推进时钟，返回脚本化突变数 */
function createFakeProbe(config: {
  clock: { advance: (ms: number) => void }
  drain: (options: CrossFrameDrainOptions) => { mutations: number; frames?: number }
  inflight?: () => number
  networkAt?: () => number
}): StabilizationProbe {
  return {
    inflightCount: config.inflight ?? (() => 0),
    lastNetworkActivityAt: config.networkAt ?? (() => 0),
    drainCrossFrame: async (options) => {
      const result = config.drain(options)
      config.clock.advance(options.minMs ?? 0)
      const mutations = Math.max(0, result.mutations)
      return { settled: true, mutated: mutations > 0, mutations, frames: result.frames ?? 1, elapsedMs: options.minMs ?? 0 }
    },
  }
}

const TEST_RECORD: YanhuBidNode = {
  bid: 172,
  role: 'link',
  name: '课程成绩查询',
  tag: 'a',
  bounds: { x: 10, y: 20, width: 80, height: 24 },
}

const NO_EDGE: CausalObservation = {
  mutated: false,
  networkStarted: false,
  urlChanged: false,
  newTab: false,
  evidence: ['观察窗 2000ms 内零因果边（判定 No-Op）'],
}

const QUIESCENT: QuiescenceResult = {
  settled: true,
  timedOut: false,
  elapsedMs: 12,
  inflight: 0,
  frames: 3,
  mutations: 0,
  lastActivityAt: 0,
}

/** 伪分派宿主：默认返回单标签、无因果、双阶梯均可派发 */
function createFakeAdapter(overrides: Partial<HybridDispatcherAdapter> = {}): HybridDispatcherAdapter {
  const base: HybridDispatcherAdapter = {
    dispatchSynthetic: async () => ({ ok: true, syncMutations: 0 }),
    dispatchHardware: async () => true,
    snapshot: (): CausalSnapshot => ({ url: 'https://jw.cdut.edu.cn/jsxsd/framework/xsMainV.htmlx', inflight: 0, networkActivityAt: 0, tabCount: 1 }),
    observeCausality: async () => NO_EDGE,
    awaitQuiescence: async () => QUIESCENT,
    resolveActiveTabId: () => 'tab-new',
  }
  return { ...base, ...overrides }
}

// ===== 双平面静止算法 =====

describe('StabilizationWatcher（双平面静止算法）', () => {
  test('网络清零且跨 Frame DOM 静默达滑动窗口即结算，无需任何固定延时配置', async () => {
    const clock = createFakeClock()
    const probe = createFakeProbe({ clock, drain: () => ({ mutations: 0 }) })
    const result = await new StabilizationWatcher(clock).waitForQuiescence(probe, { windowMs: 500, timeoutMs: 5000 })
    expect(result.settled).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(result.inflight).toBe(0)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(500)
  })

  test('在途请求未清零期间绝不结算，网络清零后方才结算', async () => {
    const clock = createFakeClock()
    let inflightCalls = 0
    const probe = createFakeProbe({
      clock,
      drain: () => ({ mutations: 0 }),
      inflight: () => (inflightCalls++ < 1 ? 2 : 0),
    })
    const result = await new StabilizationWatcher(clock).waitForQuiescence(probe, { windowMs: 500, timeoutMs: 5000 })
    expect(result.settled).toBe(true)
    expect(inflightCalls).toBeGreaterThanOrEqual(2)
  })

  test('DOM 突变刷新活动时间并重新计时，随后静默窗口重新满足后结算', async () => {
    const clock = createFakeClock()
    let drains = 0
    const probe = createFakeProbe({ clock, drain: () => ({ mutations: drains++ === 0 ? 1 : 0 }) })
    const result = await new StabilizationWatcher(clock).waitForQuiescence(probe, { windowMs: 500, timeoutMs: 5000 })
    expect(result.settled).toBe(true)
    expect(result.mutations).toBe(1)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(1000)
  })

  test('持续活跃时触发硬超时，blocking 风险被明确标记而非死等', async () => {
    const clock = createFakeClock()
    const probe = createFakeProbe({ clock, drain: () => ({ mutations: 0 }), inflight: () => 3 })
    const result = await new StabilizationWatcher(clock).waitForQuiescence(probe, { windowMs: 500, timeoutMs: 2000 })
    expect(result.settled).toBe(false)
    expect(result.timedOut).toBe(true)
  })
})

// ===== 跨嵌套框架坐标投影 =====

describe('MultiFrameCoordinateTransformer（跨嵌套框架坐标投影）', () => {
  test('递归累加各级 Frame BoundingRect 并扣除子框架滚动偏移', () => {
    const projected = MultiFrameCoordinateTransformer.project({
      point: { x: 50, y: 60 },
      chain: [
        { rect: { x: 100, y: 50, width: 900, height: 600 } },
        { rect: { x: 10, y: 20, width: 200, height: 100 }, scrollX: 5, scrollY: 7 },
      ],
    })
    expect(projected).toEqual({ x: 155, y: 123 })
  })

  test('无嵌套框架时保持原点，且支持按设备像素比缩放', () => {
    expect(MultiFrameCoordinateTransformer.project({ point: { x: 10.4, y: 20.6 } })).toEqual({ x: 10, y: 21 })
    expect(MultiFrameCoordinateTransformer.project({ point: { x: 10, y: 20 }, dpr: 2 })).toEqual({ x: 20, y: 40 })
  })
})

// ===== 脚本与归一化契约 =====

describe('跨 Frame 排空脚本与结果归一化', () => {
  test('排空脚本具备 MessageChannel 零延迟排空与 requestIdleCallback 确认能力', () => {
    const script = buildCrossFrameDrainScript({ minMs: 100, maxMs: 200, quietMs: 150, resolveOnFirstMutation: true })
    expect(script).toContain('MessageChannel')
    expect(script).toContain('requestIdleCallback')
    expect(script).toContain('MutationObserver')
    expect(script).toContain('FIRST = true')
  })

  test('异常 / 空值一律降级为「静止且无突变」，不抛出到调用方', () => {
    expect(normalizeCrossFrameDrain(null)).toEqual({ settled: true, mutated: false, mutations: 0, frames: 0, elapsedMs: 0 })
    const normalized = normalizeCrossFrameDrain({ settled: true, mutations: 3, frames: 2, elapsedMs: 42 })
    expect(normalized.mutated).toBe(true)
    expect(normalized.mutations).toBe(3)
    expect(normalized.frames).toBe(2)
  })
})

// ===== 两阶梯自适应分派状态机 =====

describe('HybridAdaptiveDispatcher（两阶梯自适应分派状态机）', () => {
  test('合成事件命中因果边：直接静默结算，绝不升级 CDP 硬件级', async () => {
    let hardwareCalls = 0
    const edge: CausalObservation = {
      mutated: true,
      networkStarted: false,
      urlChanged: false,
      newTab: false,
      evidence: ['因果边命中：跨 Frame DOM 发生突变'],
    }
    const adapter = createFakeAdapter({
      observeCausality: async () => edge,
      dispatchHardware: async () => {
        hardwareCalls += 1
        return true
      },
    })
    const result = await new HybridAdaptiveDispatcher(adapter, 2000).dispatch('tab-1', TEST_RECORD, {})
    expect(result.outcome).toBe('verified-success')
    expect(result.escalated).toBe(false)
    expect(hardwareCalls).toBe(0)
    expect(result.evidence.join(' ')).toContain('跨 Frame DOM 发生突变')
    expect(result.quiescence?.settled).toBe(true)
  })

  test('合成事件 No-Op：自动升级至 CDP 硬件级并二次探测，命中因果后结算', async () => {
    let observations = 0
    let hardwareCalls = 0
    const adapter = createFakeAdapter({
      observeCausality: async () => {
        observations += 1
        if (observations === 1) return NO_EDGE
        return {
          mutated: false,
          networkStarted: true,
          urlChanged: false,
          newTab: false,
          evidence: ['因果边命中：网络请求在途 / 新增'],
        }
      },
      dispatchHardware: async () => {
        hardwareCalls += 1
        return true
      },
    })
    const result = await new HybridAdaptiveDispatcher(adapter, 2000).dispatch('tab-1', TEST_RECORD, {})
    expect(result.outcome).toBe('escalated-success')
    expect(result.escalated).toBe(true)
    expect(hardwareCalls).toBe(1)
    expect(observations).toBe(2)
    expect(result.evidence.join(' ')).toContain('第二阶梯')
  })

  test('两阶梯均无因果边：明确判定终端失败并回传完整因果链', async () => {
    const adapter = createFakeAdapter({ observeCausality: async () => NO_EDGE })
    const result = await new HybridAdaptiveDispatcher(adapter, 2000).dispatch('tab-1', TEST_RECORD, {})
    expect(result.outcome).toBe('terminal-failed')
    expect(result.escalated).toBe(true)
    expect(result.quiescence).toBeNull()
    expect(result.evidence.join(' ')).toContain('零因果边')
  })

  test('新标签页因果贯通：自动接管新标签并等待其稳态', async () => {
    let waitedTabId = ''
    const adapter = createFakeAdapter({
      observeCausality: async () => ({
        mutated: false,
        networkStarted: false,
        urlChanged: false,
        newTab: true,
        evidence: ['因果边命中：检测到新标签页创建'],
      }),
      awaitQuiescence: async (tabId) => {
        waitedTabId = tabId
        return QUIESCENT
      },
      resolveActiveTabId: () => 'tab-new-opened',
    })
    const result = await new HybridAdaptiveDispatcher(adapter, 2000).dispatch('tab-1', TEST_RECORD, {})
    expect(result.outcome).toBe('verified-success')
    expect(result.newTab).toBe(true)
    expect(result.activeTabId).toBe('tab-new-opened')
    expect(waitedTabId).toBe('tab-new-opened')
  })

  test('两阶梯均无法派发（元素彻底失联）：直接终端失败，不做无效二次探测', async () => {
    let observations = 0
    const adapter = createFakeAdapter({
      dispatchSynthetic: async () => ({ ok: false, syncMutations: 0 }),
      dispatchHardware: async () => false,
      observeCausality: async () => {
        observations += 1
        return NO_EDGE
      },
    })
    const result = await new HybridAdaptiveDispatcher(adapter, 2000).dispatch('tab-1', TEST_RECORD, {})
    expect(result.outcome).toBe('terminal-failed')
    expect(result.method).toBe('定位失败')
    expect(observations).toBe(1)
  })

  test('派发时同步捕获 DOM 突变：秒级命中因果边，跳过 2000ms 观察窗且绝不升级', async () => {
    let observations = 0
    let hardwareCalls = 0
    const adapter = createFakeAdapter({
      dispatchSynthetic: async () => ({ ok: true, syncMutations: 3 }),
      observeCausality: async () => {
        observations += 1
        return NO_EDGE
      },
      dispatchHardware: async () => {
        hardwareCalls += 1
        return true
      },
    })
    const result = await new HybridAdaptiveDispatcher(adapter, 2000).dispatch('tab-1', TEST_RECORD, {})
    expect(result.outcome).toBe('verified-success')
    expect(result.escalated).toBe(false)
    // 关键：完全跳过观察窗与二次探测，消除时序盲区导致的 No-Op 误判
    expect(observations).toBe(0)
    expect(hardwareCalls).toBe(0)
    expect(result.evidence.join(' ')).toContain('同步捕获 3 处 DOM 突变')
  })

  test('控件状态同步变更（原生勾选 / 开关）即命中因果边，免观察窗且绝不升级（防二次点击反切）', async () => {
    let observations = 0
    let hardwareCalls = 0
    const adapter = createFakeAdapter({
      // 纯状态切换：无任何属性突变（syncMutations=0），但 checked 值已翻转
      dispatchSynthetic: async () => ({ ok: true, syncMutations: 0, stateChanged: true }),
      observeCausality: async () => {
        observations += 1
        return NO_EDGE
      },
      dispatchHardware: async () => {
        hardwareCalls += 1
        return true
      },
    })
    const result = await new HybridAdaptiveDispatcher(adapter, 2000).dispatch('tab-1', TEST_RECORD, {})
    expect(result.outcome).toBe('verified-success')
    expect(result.escalated).toBe(false)
    expect(observations).toBe(0)
    expect(hardwareCalls).toBe(0)
    expect(result.evidence.join(' ')).toContain('控件状态同步变更')
  })

  test('同步突变捷径下仍识别新标签页创建并接管（信息缺口补漏）', async () => {
    let snapshotCalls = 0
    let waitedTabId = ''
    const adapter = createFakeAdapter({
      dispatchSynthetic: async () => ({ ok: true, syncMutations: 2 }),
      snapshot: (): CausalSnapshot => {
        snapshotCalls += 1
        return {
          url: 'https://jw.cdut.edu.cn/jsxsd/framework/xsMainV.htmlx',
          inflight: 0,
          networkActivityAt: 0,
          tabCount: snapshotCalls === 1 ? 1 : 2,
        }
      },
      awaitQuiescence: async (tabId) => {
        waitedTabId = tabId
        return QUIESCENT
      },
      resolveActiveTabId: () => 'tab-new-opened',
    })
    const result = await new HybridAdaptiveDispatcher(adapter, 2000).dispatch('tab-1', TEST_RECORD, {})
    expect(result.outcome).toBe('verified-success')
    expect(result.newTab).toBe(true)
    expect(result.activeTabId).toBe('tab-new-opened')
    expect(waitedTabId).toBe('tab-new-opened')
    expect(result.evidence.join(' ')).toContain('新标签页创建')
  })
})
