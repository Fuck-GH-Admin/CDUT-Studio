/**
 * 智联万站 · 确定性同步与高保真因果交互引擎（YanhuStabilization）
 *
 * 依据《Deterministic Synchronization and High-Fidelity Event Emulation in Autonomous Web Agents》
 * 技术报告，落地三大工业级算法基元，彻底根除「固定延时猜延迟」带来的假死与早熟断言：
 *
 *   1. StabilizationWatcher       —— 双平面静止算法（网络流在途清零 + 跨 Frame DOM 排空 + 滑动窗口静默确认）；
 *   2. MultiFrameCoordinateTransformer —— 嵌套 frameset 坐标递归投影（BoundingRect + 滚动偏移 + DPR）；
 *   3. HybridAdaptiveDispatcher   —— 两阶梯自适应分派状态机（合成事件注入 → 因果 DAG 探测 → CDP 硬件级升级）。
 *
 * 设计约束：本模块为纯逻辑编排，不直接依赖 Electron；所有对页面 / 网络的实际访问通过
 * 注入的 `StabilizationProbe` 与 `HybridDispatcherAdapter` 抽象完成，保证 100% 可单测。
 */

import type { YanhuBidNode } from '@profer/shared'

// ===== 常量契约 =====

/**
 * 因果 DAG 观察窗（毫秒）：该窗口内零因果边即判定 No-Op，触发 CDP 硬件级升级。
 *
 * 表单局部突变通常在 50ms 内即可被 MutationObserver 捕获，且派发时的同步突变捷径已覆盖
 * 「同步展开 / 纯状态切换」两类最常见场景，故观察窗从 2000ms 压缩至 300ms，彻底消除假死空等。
 */
export const YANHU_CAUSAL_OBSERVATION_MS = 300
/** 默认滑动窗口静默阈值 W_dynamic（毫秒）：纯前端局部刷新 150ms 足以沉淀 */
export const YANHU_STABILIZE_WINDOW_MS = 150
/** 导航级操作的拓宽静默阈值（毫秒） */
export const YANHU_STABILIZE_NAV_WINDOW_MS = 600
/** 双平面静止硬超时（毫秒）：无论如何不超过该上限，杜绝死等 */
export const YANHU_STABILIZE_TIMEOUT_MS = 10_000
/** 稳态轮询间隔（毫秒） */
export const YANHU_STABILIZE_POLL_MS = 80
/** 坐标投影默认设备像素比 */
export const YANHU_DEFAULT_DPR = 1

// ===== 跨 Frame DOM 排空 =====

/** 跨 Frame DOM 排空探测参数 */
export interface CrossFrameDrainOptions {
  /** 观察窗下限（毫秒）：至少观察该时长 */
  minMs?: number
  /** 观察窗硬上限（毫秒） */
  maxMs?: number
  /** 静默判定阈值（毫秒）：最后一次突变后静默该时长即视为静止 */
  quietMs?: number
  /** 首个突变即提前返回（因果探测专用） */
  resolveOnFirstMutation?: boolean
}

/** 跨 Frame DOM 排空探测结果 */
export interface CrossFrameDrainResult {
  /** 是否完成（恒为 true，异常降级时同样以静止语义返回） */
  settled: boolean
  /** 观察窗内是否发生 DOM 突变 */
  mutated: boolean
  /** 突变次数 */
  mutations: number
  /** 覆盖的文档（框架）数量 */
  frames: number
  /** 实际耗时（毫秒） */
  elapsedMs: number
}

/**
 * 生成注入页面主上下文的「跨 Frame 排空」脚本。
 *
 * - 递归收集顶层与全部子 frame / iframe 文档；
 * - 对每层文档安装 MutationObserver，统计局部重绘突变；
 * - 使用 MessageChannel 驱动即时 yielding（绕过 setTimeout 的 4ms 钳制）；
 * - 尾部链式 requestIdleCallback 确认布局计算与重绘彻底完结。
 */
export function buildCrossFrameDrainScript(options: CrossFrameDrainOptions = {}): string {
  const minMs = Math.max(0, Math.trunc(options.minMs ?? 0))
  const maxMs = Math.max(minMs, Math.trunc(options.maxMs ?? YANHU_STABILIZE_WINDOW_MS))
  const quietMs = Math.max(0, Math.trunc(options.quietMs ?? 0))
  const first = options.resolveOnFirstMutation === true
  return `(() => {
  return new Promise((resolve) => {
    const MIN = ${minMs}, MAX = ${maxMs}, QUIET = ${quietMs}, FIRST = ${first ? 'true' : 'false'};
    const started = Date.now();
    let done = false, mutations = 0, lastMutation = started;
    let channel = null;
    const observers = [], docs = [];
    const collectDocs = (doc, depth) => {
      if (!doc || depth > 6) return;
      for (let i = 0; i < docs.length; i++) { if (docs[i] === doc) return; }
      docs.push(doc);
      let frames = [];
      try { frames = doc.querySelectorAll ? Array.from(doc.querySelectorAll('frame, iframe')) : []; } catch (e) { frames = []; }
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        try {
          const sub = f.contentDocument || (f.contentWindow && f.contentWindow.document);
          if (sub) collectDocs(sub, depth + 1);
        } catch (e) {}
      }
    };
    collectDocs(document, 0);
    for (let i = 0; i < docs.length; i++) {
      try {
        const target = docs[i].documentElement || docs[i];
        if (!target || typeof MutationObserver !== 'function') continue;
        const obs = new MutationObserver(() => { mutations += 1; lastMutation = Date.now(); });
        obs.observe(target, { childList: true, subtree: true, attributes: true, characterData: true });
        observers.push(obs);
      } catch (e) {}
    }
    const cleanup = () => {
      for (let i = 0; i < observers.length; i++) { try { observers[i].disconnect(); } catch (e) {} }
      try { if (channel) { channel.port1.close(); channel.port2.close(); } } catch (e) {}
    };
    const finish = () => {
      if (done) return; done = true;
      const flush = () => { cleanup(); resolve({ settled: true, mutations: mutations, frames: docs.length, elapsedMs: Date.now() - started }); };
      try {
        if (typeof requestIdleCallback === 'function') requestIdleCallback(flush, { timeout: 200 });
        else flush();
      } catch (e) { flush(); }
    };
    const tick = () => {
      if (done) return;
      const now = Date.now();
      if (FIRST) {
        // 因果探测：首个突变即返回，否则持续观察到观察窗截止（MIN / QUIET 不参与）
        if (mutations > 0) return finish();
        if (now - started >= MAX) return finish();
        return schedule();
      }
      if (now - started >= MAX) return finish();
      if (now - started >= MIN && now - lastMutation >= QUIET) return finish();
      schedule();
    };
    const schedule = () => {
      // MessageChannel 实例本身没有 postMessage；必须由 port2 发送、port1 接收才能触发 tick。
      // 此前误用 channel.postMessage 会抛 TypeError 被吞掉，导致「即时 yielding」永久退化为 16ms 轮询。
      if (channel) { try { channel.port2.postMessage(0); return; } catch (e) {} }
      setTimeout(tick, 16);
    };
    try { channel = new MessageChannel(); channel.port1.onmessage = function () { tick(); }; } catch (e) { channel = null; }
    if (FIRST) schedule();
    else setTimeout(tick, Math.max(16, MIN));
  });
})()`
}

/** 防御式归一化排空结果（异常 / 空值一律降级为「静止且无突变」） */
export function normalizeCrossFrameDrain(raw: unknown): CrossFrameDrainResult {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const mutations =
    typeof record.mutations === 'number' && Number.isFinite(record.mutations)
      ? Math.max(0, Math.trunc(record.mutations))
      : 0
  const frames =
    typeof record.frames === 'number' && Number.isFinite(record.frames) ? Math.max(0, Math.trunc(record.frames)) : 0
  const elapsedMs =
    typeof record.elapsedMs === 'number' && Number.isFinite(record.elapsedMs) ? Math.max(0, Math.trunc(record.elapsedMs)) : 0
  return { settled: true, mutated: mutations > 0, mutations, frames, elapsedMs }
}

// ===== 双平面静止算法 =====

/** 页面探针抽象：网络平面 + DOM 平面（由主进程实现并注入） */
export interface StabilizationProbe {
  /** 网络平面：当前在途业务请求数 */
  inflightCount(): number
  /** 网络平面：最近一次网络活动时间戳（毫秒） */
  lastNetworkActivityAt(): number
  /** DOM 平面：跨 Frame 排空探测 */
  drainCrossFrame(options: CrossFrameDrainOptions): Promise<CrossFrameDrainResult>
}

/** 可注入时钟：便于单测用伪时钟确定性地验证滑动窗口 */
export interface StabilizationClock {
  now(): number
  sleep(ms: number): Promise<void>
}

/** 稳态等待参数 */
export interface QuiescenceOptions {
  /** 滑动窗口静默阈值（缺省按 navigation 自适应） */
  windowMs?: number
  /** 硬超时（毫秒） */
  timeoutMs?: number
  /** 是否导航级操作（拓宽静默窗口） */
  navigation?: boolean
  /** 轮询间隔（毫秒） */
  pollMs?: number
}

/** 稳态等待结果 */
export interface QuiescenceResult {
  settled: boolean
  timedOut: boolean
  elapsedMs: number
  inflight: number
  frames: number
  mutations: number
  lastActivityAt: number
}

const defaultClock: StabilizationClock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}

/**
 * 双平面静止监视器。
 *
 * 判定条件：$(N_{inflight} == 0) \land (\text{当前窗口 DOM 静默}) \land (T_{current} - T_{last\_activity} \ge W_{dynamic})$。
 * 网络与 DOM 任一平面活跃即延长观察，直至静默或触及硬超时。
 */
export class StabilizationWatcher {
  constructor(private readonly clock: StabilizationClock = defaultClock) {}

  public async waitForQuiescence(probe: StabilizationProbe, options: QuiescenceOptions = {}): Promise<QuiescenceResult> {
    const windowMs = Math.max(0, Math.trunc(options.windowMs ?? (options.navigation ? YANHU_STABILIZE_NAV_WINDOW_MS : YANHU_STABILIZE_WINDOW_MS)))
    const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? YANHU_STABILIZE_TIMEOUT_MS))
    const pollMs = Math.max(0, Math.trunc(options.pollMs ?? YANHU_STABILIZE_POLL_MS))
    const drainBound = Math.max(50, Math.min(timeoutMs, windowMs + 250))

    const start = this.clock.now()
    let frames = 0
    let totalMutations = 0

    for (;;) {
      const beforeActivity = probe.lastNetworkActivityAt()
      let drain: CrossFrameDrainResult
      try {
        drain = await probe.drainCrossFrame({ minMs: windowMs, maxMs: drainBound, quietMs: windowMs, resolveOnFirstMutation: false })
      } catch {
        drain = { settled: true, mutated: false, mutations: 0, frames, elapsedMs: 0 }
      }
      const now = this.clock.now()
      const inflight = probe.inflightCount()
      const afterActivity = probe.lastNetworkActivityAt()

      frames = Math.max(frames, drain.frames)
      totalMutations += drain.mutations

      // 最近活动时间 = max(网络活动, 若本轮有 DOM 突变则取当前时刻)
      let lastActivityAt = Math.max(start, beforeActivity, afterActivity)
      if (drain.mutations > 0) lastActivityAt = Math.max(lastActivityAt, now)

      const idleMs = now - lastActivityAt
      const settled = drain.mutations === 0 && inflight === 0 && idleMs >= windowMs
      if (settled) {
        return { settled: true, timedOut: false, elapsedMs: now - start, inflight, frames, mutations: totalMutations, lastActivityAt }
      }
      if (now - start >= timeoutMs) {
        return { settled: false, timedOut: true, elapsedMs: now - start, inflight, frames, mutations: totalMutations, lastActivityAt }
      }
      await this.clock.sleep(pollMs)
    }
  }
}

/** 全局单例（复用真实时钟） */
export const yanhuStabilizationWatcher = new StabilizationWatcher()

// ===== 嵌套框架坐标投影 =====

/** 单级框架投影链环（自外向内排列） */
export interface FrameProjectionLink {
  /** 框架元素在父级视口中的边界矩形 */
  rect: { x: number; y: number; width: number; height: number }
  /** 框架内容的水平滚动偏移 */
  scrollX?: number
  /** 框架内容的垂直滚动偏移 */
  scrollY?: number
}

/** 坐标投影入参 */
export interface FrameProjectionInput {
  /** 目标点在叶子框架文档坐标系中的位置 */
  point: { x: number; y: number }
  /** 框架链（自外向内），缺省为空表示无嵌套 */
  chain?: readonly FrameProjectionLink[]
  /** 设备像素比（缺省 1，返回 CSS 像素即 CDP Input 所需坐标系） */
  dpr?: number
}

/**
 * 跨嵌套框架坐标投影器。
 *
 * 依 `getBoundingClientRect()` 的视口语义，自内向外逐级减去子框架内容滚动偏移、累加框架元素在
 * 父级视口中的偏移，即可把叶子框架内的点映射到根视口坐标；再按需乘以设备像素比。
 */
export class MultiFrameCoordinateTransformer {
  public static project(input: FrameProjectionInput): { x: number; y: number } {
    const chain = input.chain ?? []
    let x = input.point.x
    let y = input.point.y
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const link = chain[i]
      if (!link) continue
      x -= link.scrollX ?? 0
      y -= link.scrollY ?? 0
      x += link.rect.x
      y += link.rect.y
    }
    const dpr = input.dpr && input.dpr > 0 ? input.dpr : YANHU_DEFAULT_DPR
    return { x: Math.round(x * dpr), y: Math.round(y * dpr) }
  }
}

// ===== 因果 DAG 与两阶梯自适应分派 =====

/** 交互动作派发选项 */
export interface DispatchOptions {
  doubleClick?: boolean
  waitForNavigation?: boolean
}

/** 因果基线快照 */
export interface CausalSnapshot {
  url: string
  inflight: number
  networkActivityAt: number
  tabCount: number
}

/** 因果 DAG 探测结论 */
export interface CausalObservation {
  /** 跨 Frame DOM 发生突变 */
  mutated: boolean
  /** 网络请求发起 / 在途 */
  networkStarted: boolean
  /** 主框架 URL 变更 */
  urlChanged: boolean
  /** 检测到新标签页创建 */
  newTab: boolean
  /** 人类可读的因果摘要 */
  evidence: string[]
}

/** 第一阶梯合成事件派发回执：除命中与否外，携带派发期间同步捕获的 DOM 突变数与控件状态变更 */
export interface SyntheticDispatchResult {
  ok: boolean
  /** 派发期间（含 el.click() 同步链路）捕获到的 DOM 突变数量，用于秒级因果确认 */
  syncMutations: number
  /**
   * 控件自身状态签名是否发生变更（checked / selectedIndex / value / aria-* / className）。
   *
   * 专门覆盖「原生勾选框 / 开关」这类**不产生属性突变**的纯状态切换：若缺失该信号，
   * 会被误判为 No-Op 而升级 CDP 硬件级二次点击，导致勾选被反向切回（双提交 / 双切换）。
   */
  stateChanged?: boolean
}

/** 分派器宿主抽象（真实实现由主进程装配，单测注入伪实现） */
export interface HybridDispatcherAdapter {
  /** 第一阶梯：页面内快速合成事件注入（返回命中与否及同步突变数） */
  dispatchSynthetic(tabId: string, record: YanhuBidNode, options: DispatchOptions): Promise<SyntheticDispatchResult>
  /** 第二阶梯：CDP 硬件级点击（isTrusted = true） */
  dispatchHardware(tabId: string, record: YanhuBidNode, options: DispatchOptions): Promise<boolean>
  /** 采集因果基线 */
  snapshot(tabId: string): CausalSnapshot
  /** 在观察窗内探测因果边 */
  observeCausality(tabId: string, baseline: CausalSnapshot, windowMs: number): Promise<CausalObservation>
  /** 双平面静止等待 */
  awaitQuiescence(tabId: string, options: QuiescenceOptions): Promise<QuiescenceResult>
  /** 读取当前激活标签 ID（新标签页接管用） */
  resolveActiveTabId(): string
}

/** 分派终态 */
export type DispatchOutcome = 'verified-success' | 'escalated-success' | 'terminal-failed'

/** 分派结果（含因果证据摘要，供工具层透传给模型） */
export interface DispatchResult {
  outcome: DispatchOutcome
  /** 实际生效的交互方式描述 */
  method: string
  /** 是否触发过 CDP 硬件级升级 */
  escalated: boolean
  /** 是否命中新标签页 */
  newTab: boolean
  /** 决算后的观察上下文标签 ID */
  activeTabId: string
  /** 因果证据链 */
  evidence: string[]
  /** 双平面静止结论（终端失败时为 null） */
  quiescence: QuiescenceResult | null
}

/**
 * 两阶梯自适应分派状态机。
 *
 * 流程：合成事件注入 → 因果探测；命中因果边即进入双平面静止决算；
 * 观察窗内零因果边判定 No-Op，自动升级至 CDP 硬件级点击并二次探测，
 * 仍无因果则抛出明确阻断原因（TERMINAL_FAILED）。
 */
export class HybridAdaptiveDispatcher {
  constructor(
    private readonly adapter: HybridDispatcherAdapter,
    private readonly observationMs: number = YANHU_CAUSAL_OBSERVATION_MS,
  ) {}

  private hasCausalEdge(observation: CausalObservation): boolean {
    return observation.mutated || observation.networkStarted || observation.urlChanged || observation.newTab
  }

  private async safeObserve(tabId: string, baseline: CausalSnapshot): Promise<CausalObservation> {
    try {
      return await this.adapter.observeCausality(tabId, baseline, this.observationMs)
    } catch {
      return { mutated: false, networkStarted: false, urlChanged: false, newTab: false, evidence: ['因果探测异常，按无因果边处理'] }
    }
  }

  private async settle(
    outcome: DispatchOutcome,
    method: string,
    escalated: boolean,
    tabId: string,
    observation: CausalObservation,
    evidence: string[],
    options: DispatchOptions,
  ): Promise<DispatchResult> {
    const activeTabId = observation.newTab ? this.adapter.resolveActiveTabId() || tabId : tabId
    let quiescence: QuiescenceResult | null = null
    try {
      quiescence = await this.adapter.awaitQuiescence(activeTabId, {
        navigation: options.waitForNavigation === true,
        windowMs: options.waitForNavigation === true ? YANHU_STABILIZE_NAV_WINDOW_MS : undefined,
      })
    } catch {
      quiescence = null
    }
    return { outcome, method, escalated, newTab: observation.newTab, activeTabId, evidence, quiescence }
  }

  public async dispatch(tabId: string, record: YanhuBidNode, options: DispatchOptions = {}): Promise<DispatchResult> {
    const baseline = this.adapter.snapshot(tabId)
    const evidence: string[] = ['因果基线已锁定：URL / 在途请求 / 标签拓扑']

    // ===== 第一阶梯：页面内快速合成事件注入（带同步突变捕获，根除时序盲区） =====
    let synthetic: SyntheticDispatchResult = { ok: false, syncMutations: 0 }
    try {
      synthetic = await this.adapter.dispatchSynthetic(tabId, record, options)
    } catch {
      synthetic = { ok: false, syncMutations: 0 }
    }
    const syntheticOk = synthetic.ok
    evidence.push(syntheticOk ? '第一阶梯：页面内合成事件已注入' : '第一阶梯：合成注入未能命中目标')

    // 派发期间同步捕获到 DOM 突变或控件状态变更 → 直接判定因果边命中，免去 2000ms 观察窗空等
    // 与 No-Op 误判。前者覆盖「el.click() 同步展开菜单 / 局部重绘」，后者覆盖「原生勾选框 /
    // 开关的纯状态切换」，二者共同根除时序盲区与二次点击反切风险。
    const stateChanged = synthetic.stateChanged === true
    let observation: CausalObservation
    if (synthetic.syncMutations > 0 || stateChanged) {
      // 关键补漏：同步捷径也必须复查标签拓扑——window.open → setWindowOpenHandler → createTab
      // 在 click 处理器内同步完成，若此处不复查就会出现「明明开了新标签，却未告知模型」的信息缺口。
      let newTab = false
      try {
        newTab = this.adapter.snapshot(tabId).tabCount > baseline.tabCount
      } catch {
        newTab = false
      }
      const evidence = [
        synthetic.syncMutations > 0
          ? `因果边命中：派发时同步捕获 ${synthetic.syncMutations} 处 DOM 突变（免观察窗等待）`
          : '因果边命中：控件状态同步变更（勾选 / 折叠等），免观察窗等待',
      ]
      if (newTab) evidence.push('因果边命中：同步检测到新标签页创建')
      observation = { mutated: true, networkStarted: false, urlChanged: false, newTab, evidence }
    } else {
      observation = await this.safeObserve(tabId, baseline)
    }
    evidence.push(...observation.evidence)
    if (this.hasCausalEdge(observation)) {
      return this.settle(
        'verified-success',
        syntheticOk ? '强触达：解封 + 合成事件' : '合成事件（部分命中）',
        false,
        tabId,
        observation,
        evidence,
        options,
      )
    }

    // ===== No-Op：升级至第二阶梯 CDP 硬件级仿真 =====
    let hardwareOk = false
    try {
      hardwareOk = await this.adapter.dispatchHardware(tabId, record, options)
    } catch {
      hardwareOk = false
    }
    evidence.push(hardwareOk ? '第二阶梯：升级至 CDP 硬件级点击 (isTrusted=true)' : '第二阶梯：CDP 硬件级点击派发失败')

    if (!hardwareOk && !syntheticOk) {
      evidence.push('两阶梯均未能定位并派发交互，判定为终端失败')
      return { outcome: 'terminal-failed', method: '定位失败', escalated: true, newTab: false, activeTabId: tabId, evidence, quiescence: null }
    }

    observation = await this.safeObserve(tabId, baseline)
    evidence.push(...observation.evidence)
    if (this.hasCausalEdge(observation)) {
      return this.settle('escalated-success', 'CDP 硬件级点击', true, tabId, observation, evidence, options)
    }

    evidence.push('升级后观察窗内仍无因果边，判定为终端失败（疑似页面无响应或被静默吞没）')
    return {
      outcome: 'terminal-failed',
      method: 'CDP 硬件级点击',
      escalated: true,
      newTab: observation.newTab,
      activeTabId: this.adapter.resolveActiveTabId() || tabId,
      evidence,
      quiescence: null,
    }
  }
}

// ===== 振荡死锁防护与动作空间动态遮罩（WebRollback / DeadlockGuard） =====

/** 单步交互动作记录（状态指纹 + 动作签名 + 目标 BID + 时间戳） */
export interface DeadlockStepRecord {
  stateHash: string
  actionSignature: string
  bid: number
  at: number
}

/**
 * 单一标签的振荡历史保留深度。
 *
 * Period-2 判定仅需要最近 4 步，保留一整个短窗即可兼顾 Period-K 扩展与内存有界。
 */
export const YANHU_DEADLOCK_HISTORY_DEPTH = 64

/** 死锁检测结论 */
export interface DeadlockVerdict {
  deadlock: boolean
  /** 命中的振荡周期描述（如 `click:22 ⇄ click:61`） */
  cyclePattern?: string
  /** 面向大模型的可读熔断原因 */
  reason?: string
}

/**
 * 乒乓振荡死锁防护器（DeadlockGuard）。
 *
 * 依据 WebRollback 范式，将「环境状态指纹 + 动作签名」按标签分别记入滑窗历史，检测
 * Period-2（$A \to B \to A \to B$）交替振荡：当动作签名交替 **且** 环境状态被反复拉回
 * 完全相同的两个状态时，判定为乒乓死锁，并把引起振荡的动作纳入**动作空间动态遮罩**
 * （Action Masking）——此后模型再尝试执行同一动作会被直接拦截，终止 20 轮空转与 Token 爆炸。
 *
 * 关键设计：以「状态指纹」参与判定，避免把正常的菜单 A/B 交替点击误判为死锁；
 * 历史按 tabId 隔离，杜绝多标签之间相互污染。
 */
export class YanhuDeadlockGuard {
  private readonly histories = new Map<string, DeadlockStepRecord[]>()
  private readonly maskedActions = new Map<string, Set<string>>()

  /**
   * 记录一次交互动作并检测周期死锁。
   *
   * @param tabId 目标标签（历史按标签隔离）
   * @param stateHash 动作执行前归一化的环境状态指纹（供「环境被反复拉回相同」判定）
   * @param bid 目标控件 BID
   * @param actionName 动作名（如 click / select）
   */
  public evaluate(tabId: string, stateHash: string, bid: number, actionName: string): DeadlockVerdict {
    const key = tabId || '__yanhu_global__'
    const actionSignature = `${actionName}:${bid}`

    const masked = this.maskedActions.get(key)
    if (masked && masked.has(actionSignature)) {
      return {
        deadlock: true,
        reason: `【动作空间已遮罩】动作 ${actionSignature} 此前已引发死锁振荡，已被策略屏蔽。请停止盲目点击，先 yanhu_read_page 复查表单项准确名称后再操作。`,
      }
    }

    let history = this.histories.get(key)
    if (!history) {
      history = []
      this.histories.set(key, history)
    }
    history.push({ stateHash: stateHash || '', actionSignature, bid, at: Date.now() })
    if (history.length > YANHU_DEADLOCK_HISTORY_DEPTH) {
      history.splice(0, history.length - YANHU_DEADLOCK_HISTORY_DEPTH)
    }

    const len = history.length
    if (len >= 4) {
      const h0 = history[len - 4]!
      const h1 = history[len - 3]!
      const h2 = history[len - 2]!
      const h3 = history[len - 1]!
      const s0 = h0.actionSignature
      const s1 = h1.actionSignature
      const s2 = h2.actionSignature
      const s3 = h3.actionSignature
      // Period-2 振荡：动作签名交替（A→B→A→B）且环境状态被反复拉回相同两个状态
      if (
        s0 === s2 &&
        s1 === s3 &&
        s0 !== s1 &&
        h0.stateHash === h2.stateHash &&
        h1.stateHash === h3.stateHash
      ) {
        let maskSet = this.maskedActions.get(key)
        if (!maskSet) {
          maskSet = new Set<string>()
          this.maskedActions.set(key, maskSet)
        }
        maskSet.add(s1)
        maskSet.add(s3)
        return {
          deadlock: true,
          cyclePattern: `${s0} ⇄ ${s1}`,
          reason: `【乒乓振荡死锁熔断】检测到系统正在反复交替执行 ${s0} 与 ${s1}，且页面状态被反复拉回相同，已自动阻断并屏蔽该循环动作。请停止盲目点击，检查表单项准确名称。`,
        }
      }
    }
    return { deadlock: false }
  }

  /** 重置全部标签的振荡历史与动作遮罩 */
  public reset(): void {
    this.histories.clear()
    this.maskedActions.clear()
  }
}

/** 全局单例（工具层共享） */
export const yanhuDeadlockGuard = new YanhuDeadlockGuard()
