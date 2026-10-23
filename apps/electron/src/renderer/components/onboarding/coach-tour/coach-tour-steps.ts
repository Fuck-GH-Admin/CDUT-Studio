/**
 * coach-tour-steps — 新用户操作指引的步骤定义（端到端沉浸式演示）
 *
 * 每步给出按优先级排列的 CSS 选择器，引擎取第一个「可见且非零尺寸」的元素作为锚点；
 * 全部找不到时气泡居中降级，不阻断流程。
 *
 * prepare：进入步骤后自动执行的业务动作（建会话 / 登录 / 建课堂 / 开实验室 / 打开资产等），
 *          并可指定 readySelector，等目标 UI 真正挂载后再允许等待或交互。
 * advanceOn：manual 手动下一步；click-anchor 用户点击高亮区；wait 等待业务状态。
 * waitFor：仅 advanceOn='wait' 时生效，支持 Agent 回合、特区登录、桌宠回合、CSLab 验密、选择器。
 * passthrough：为 true 时不铺整屏点击捕获层，允许用户聚焦输入框 / 输入密码 / 点击发送。
 *
 * 改动提示：增删步骤或大改文案时 +1 CURRENT_COACH_TOUR_VERSION，
 * 已看过的用户升级后会自动重播一次新版本。
 */

import type { ActiveView } from '@/atoms/active-view'
import type { CdutSubViewId } from '@profer/shared'
import type { CoachTourPlacement } from './coach-tour-position'

/** 演示特区账户（仅供新手引导气泡内的「一键填入」使用，不写入任何真实业务逻辑） */
export const DEMO_CDUT_ACCOUNT = {
  username: '202520260101',
  password: 'Nya315',
} as const

/** 演示提问：常规 Agent 的图示讲解 */
export const PROMPT_CALCULUS = '介绍微积分，并用图示让我理解'

/** 演示提问：《红楼梦》长文档多跳事实抽取 */
export const PROMPT_HONGLOU_Q1 =
  '书中贾宝玉总共挨了几次打？分别发生在哪些回目，每次由谁动手、动手的原因各是什么？'

/** 演示提问：《红楼梦》反虚构陷阱题 */
export const PROMPT_HONGLOU_Q2 =
  '请问薛宝钗在第八十五回之后，跟随贾政出任过哪里的知府学政？她在任期间处理过哪些具体案件？'

/** 演示指令：砚小龙自主浏览百度并进入成都理工大学官网 */
export const PROMPT_YANHU = '访问百度搜索成都理工大学官网并进入'

/** 演示课堂名称（主进程按标题幂等复用） */
export const DEMO_AI_CLASS_NAME = '演示课堂 · 红楼梦精读'

/** 演示资料 ASCII 文件名 */
export const DEMO_NOVEL_FILE_NAME = 'hongloumeng-quan-shu.txt'

/** 演示实验室中的石榴石晶胞文件名 */
export const DEMO_GARNET_FILE_NAME =
  '1792573114138-6ac8d0-石榴石_Y_Al_O____YAG____Ia-3d_完整立方晶胞.cif'

/** 首次启用 CDUT Science 时由引导自动设置的演示密码 */
export const DEMO_CSLAB_PASSWORD = '123456'

export type CoachTourTrigger =
  | 'ensure-draft-session'
  | 'fill-calculus'
  | 'login-demo'
  | 'ensure-demo-ai-class'
  | 'fill-honglou-q1'
  | 'fill-honglou-q2'
  | 'prepare-pet-demo'
  | 'apply-demo-cslab-password'
  | 'open-demo-lab'
  | 'open-table-1'
  | 'open-table-2'
  | 'open-digitizer-figure'
  | 'open-mol-gold'
  | 'open-mol-srtio3'
  | 'open-mol-garnet'
  | 'open-publication-plot'

export type CoachTourWait =
  | { kind: 'agent-idle'; timeoutMs?: number }
  | { kind: 'cdut-active'; timeoutMs?: number }
  | { kind: 'pet-idle'; timeoutMs?: number }
  | { kind: 'cslab-verified'; timeoutMs?: number }
  | { kind: 'selector'; selector: string; timeoutMs?: number }

export interface CoachTourPrepare {
  triggers?: CoachTourTrigger[]
  /** 触发完成后仍需等待该选择器出现，才认为「本步可交互」 */
  readySelector?: string
  /** 准备阶段超时，默认 60s */
  timeoutMs?: number
}

/** 气泡内的专属快捷操作 */
export type CoachTourAction = 'demo-digitize'

export interface CoachTourStep {
  key: string
  title: string
  body: string
  /** 依次尝试的 CSS 选择器；第一个可见元素作为高亮目标 */
  selectors: string[]
  /** 提供时取代 selectors：对所有命中元素取外接矩形作为锚点 */
  unionSelectors?: string[]
  /** 额外渲染呼吸光圈的锚点（如发送按钮），不参与气泡定位 */
  pulseSelectors?: string[]
  /** 气泡相对目标的偏好方位；空间不足时自动回退其他方位，auto 优先下方 */
  placement: CoachTourPlacement
  /** 进入该步前切换的主内容区视图；缺省不切 */
  view?: ActiveView
  /** 进入该步前切换的 CDUT 专区子页面；null 表示退出子页面 */
  cdutSubView?: CdutSubViewId
  /** 进入步骤后自动执行的准备动作 */
  prepare?: CoachTourPrepare
  /** manual：点气泡按钮；click-anchor：点高亮区；wait：等业务状态 */
  advanceOn?: 'manual' | 'click-anchor' | 'wait'
  waitFor?: CoachTourWait
  /** 准备完成后自动前进的停留时间（用于轮播观看） */
  autoAdvanceMs?: number
  /** click-anchor 命中后的沉降延时，默认 350ms */
  settleMs?: number
  /** 退出时是否恢复进入前视图，默认 true；收尾步骤设 false */
  restoreViewOnExit?: boolean
  /** 允许与真实 UI 交互（不铺整屏点击捕获层） */
  passthrough?: boolean
  /** 气泡内渲染的专属快捷操作 */
  action?: CoachTourAction
}

const SEND_BUTTON_PULSE = [
  '[data-input-mode="agent"] button[aria-label="发送消息（Enter）"]',
  '[data-tour="ai-class-chat"] button[aria-label="发送消息（Enter）"]',
]

export const COACH_TOUR_STEPS: CoachTourStep[] = [
  {
    key: 'welcome-agent',
    title: 'Agent 对话与任务',
    body: 'CDUT Studio 以 Pi Agent 为唯一内核：直接用自然语言描述目标，它会自己查资料、读文件、跑命令、上网。每个任务开一个会话，上下文干净、互不干扰。',
    selectors: ['[data-profer-navigation-item="new-session"]', '[data-tour="mode-switch"]'],
    placement: 'right',
    view: 'conversations',
  },
  {
    key: 'calculus',
    title: '让 Agent 用图示讲清楚',
    body: '我们先用一个短问题热身。下面的问题已自动填入输入框，请点击发送；引导会在模型完整输出图示与讲解后再继续。',
    selectors: ['[data-input-mode="agent"]'],
    pulseSelectors: SEND_BUTTON_PULSE,
    placement: 'top',
    view: 'conversations',
    prepare: {
      triggers: ['ensure-draft-session', 'fill-calculus'],
      readySelector: '[data-input-mode="agent"]',
    },
    advanceOn: 'wait',
    waitFor: { kind: 'agent-idle', timeoutMs: 240_000 },
  },
  {
    key: 'cdut-enter',
    title: '进入 CDUT 校园特区',
    body: '这是专为成理师生打造的特区：登录特区账户后，Agent 就能调用校内事务工具——课表、成绩、空教室、考务、学籍档案。点一下侧栏的【CDUT 专区】，我们进去看看。',
    selectors: [
      '[data-profer-navigation-region="mode-switcher-cdut"]',
      '[data-profer-navigation-region="mode-switcher-agent"]',
    ],
    placement: 'right',
    cdutSubView: null,
    advanceOn: 'click-anchor',
  },
  {
    key: 'cdut-login',
    title: '连接特区账户',
    body: '正在用演示账号完成校内统一身份认证。密码只在后台提交给校内认证页，本地经操作系统加密存储。',
    selectors: ['[data-tour="cdut-login-card"]', '[data-tour="cdut-quickbar"]'],
    placement: 'left',
    view: 'cdut-zone',
    cdutSubView: null,
    prepare: {
      triggers: ['login-demo'],
      readySelector: '[data-tour="cdut-login-card"], [data-tour="cdut-quickbar"]',
    },
    advanceOn: 'wait',
    waitFor: { kind: 'cdut-active', timeoutMs: 60_000 },
  },
  {
    key: 'ai-class-enter',
    title: 'AI 速课堂 · 红楼梦精读',
    body: '演示课堂已就绪，并已挂载《红楼梦》全书。右侧资料树出现《红楼梦》条目后再继续，接下来用两轮提问检验长文档抽取与知识边界。',
    selectors: ['[data-tour="ai-class-chat"]'],
    placement: 'left',
    view: 'cdut-zone',
    cdutSubView: 'ai-class',
    prepare: {
      triggers: ['ensure-demo-ai-class'],
      readySelector:
        '[data-tour="ai-class-documents"] [data-document-name="hongloumeng-quan-shu.txt"]',
      timeoutMs: 120_000,
    },
  },
  {
    key: 'ai-class-q1',
    title: '第 1 问 · 宝玉挨打',
    body: '问题已填入输入框，请点击发送。这一问需要跨回目串联人物、次数与原因，观察导师如何在大长篇里做精准多跳抽取。',
    selectors: ['[data-tour="ai-class-chat"]'],
    pulseSelectors: SEND_BUTTON_PULSE,
    placement: 'left',
    view: 'cdut-zone',
    cdutSubView: 'ai-class',
    prepare: {
      triggers: ['fill-honglou-q1'],
      readySelector: '[data-tour="ai-class-chat"] [data-input-mode="agent"]',
    },
    advanceOn: 'wait',
    waitFor: { kind: 'agent-idle', timeoutMs: 300_000 },
  },
  {
    key: 'ai-class-q2',
    title: '第 2 问 · 反虚构陷阱',
    body: '这一问在原著中并不存在。请点击发送，观察导师是否明确拒止虚构、说明知识边界，而不是编造知府学政与案件。',
    selectors: ['[data-tour="ai-class-chat"]'],
    pulseSelectors: SEND_BUTTON_PULSE,
    placement: 'left',
    view: 'cdut-zone',
    cdutSubView: 'ai-class',
    prepare: {
      triggers: ['fill-honglou-q2'],
      readySelector: '[data-tour="ai-class-chat"] [data-input-mode="agent"]',
    },
    advanceOn: 'wait',
    waitFor: { kind: 'agent-idle', timeoutMs: 300_000 },
  },
  {
    key: 'yanhu',
    title: '智联万站 · 砚小龙',
    body: '请看屏幕上方的砚小龙浮窗：指令已自动填入，请点击砚小龙卡片里的发送按钮。它会自主规划并调用浏览器工具，访问百度搜索成都理工大学官网并进入。',
    selectors: ['[data-tour="yanhu-express-stage"]'],
    placement: 'bottom',
    view: 'cdut-zone',
    cdutSubView: 'yanhu-express',
    prepare: {
      triggers: ['prepare-pet-demo'],
      readySelector: '[data-tour="yanhu-express-stage"]',
      timeoutMs: 30_000,
    },
    advanceOn: 'wait',
    waitFor: { kind: 'pet-idle', timeoutMs: 180_000 },
  },
  {
    key: 'material-review',
    title: '材料审核专区',
    body: '三栏联动的工作台：左栏是审核依据与规则大纲，中栏是待审材料，右栏是 AI 研判出的问题卡。点击问题卡会同时高亮三栏对应位置，跨文件矛盾两处同色标注。',
    selectors: [
      '[data-profer-navigation-region="content-review"]',
      '[data-tour="cdut-module-material-review"]',
    ],
    placement: 'bottom',
    view: 'cdut-zone',
    cdutSubView: 'material-review',
  },
  {
    key: 'science-enter',
    title: 'CDUT Science 科研工作台',
    body: '接下来进入科研智能工作台。首次使用需要先为本机设置访问密码；已设置过的设备请手动输入。',
    selectors: [
      '[data-tour="cslab-auth-gate"]',
      '[data-tour="cslab-workspace"]',
      '[data-tour="cslab-demo-lab"]',
    ],
    placement: 'top',
    view: 'cdut-science',
    prepare: { readySelector: '[data-tour="cslab-auth-gate"], [data-tour="cslab-workspace"]' },
  },
  {
    key: 'science-gate',
    title: '解锁本机门禁',
    body: '密码仅保存在本机，由操作系统安全存储或本地 AES-256-GCM 加密。首次启用时引导会自动填入演示密码 123456；已初始化设备请输入你自己的密码。',
    selectors: ['[data-tour="cslab-auth-gate"]', '[data-tour="cslab-workspace"]'],
    placement: 'top',
    view: 'cdut-science',
    prepare: {
      triggers: ['apply-demo-cslab-password'],
      readySelector:
        '[data-tour="cslab-auth-gate"], [data-tour="cslab-workspace"], [data-tour="cslab-demo-lab"]',
    },
    advanceOn: 'wait',
    waitFor: { kind: 'cslab-verified', timeoutMs: 180_000 },
  },
  {
    key: 'demo-lab',
    title: '演示实验室 · Origin × VESTA',
    body: '正在创建并打开演示实验室：内置 PXRD、拉曼、晶体结构、电荷密度与科研图表，任何机器首次进入都会自动解析入库。',
    selectors: ['[data-tour="cslab-workspace"]'],
    placement: 'bottom',
    view: 'cdut-science',
    prepare: {
      triggers: ['open-demo-lab'],
      readySelector: '[data-tour="cslab-workspace"]',
      timeoutMs: 120_000,
    },
  },
  {
    key: 'table-1',
    title: '第 1 张数据表',
    body: '左侧「数据铁笼」里是实验仪器产出的结构化数据。这里自动打开第一张 Parquet 数据表，可切换曲线谱图、数据表格与分屏联动。',
    selectors: ['[data-tour="cslab-dataset"]'],
    placement: 'bottom',
    view: 'cdut-science',
    prepare: { triggers: ['open-table-1'], readySelector: '[data-tour="cslab-dataset"]' },
    autoAdvanceMs: 3000,
  },
  {
    key: 'table-2',
    title: '第 2 张数据表',
    body: '继续打开第二张表，验证同一实验室内的多表切换与派生关系。',
    selectors: ['[data-tour="cslab-dataset-table"]'],
    placement: 'bottom',
    view: 'cdut-science',
    prepare: { triggers: ['open-table-2'], readySelector: '[data-tour="cslab-dataset-table"]' },
    autoAdvanceMs: 3000,
  },
  {
    key: 'digitize-open',
    title: '科研图表 · 逆向数字化',
    body: '这是一张光谱图。点击高亮的「逆向数字化」，把像素曲线还原成可计算的数据。',
    selectors: ['[data-tour="cslab-figure-digitize"]'],
    placement: 'bottom',
    view: 'cdut-science',
    prepare: {
      triggers: ['open-digitizer-figure'],
      readySelector: '[data-tour="cslab-figure-digitize"]',
    },
    advanceOn: 'click-anchor',
  },
  {
    key: 'digitize-extract',
    title: '一键标定并提取',
    body: '可直接点气泡里的「一键演示标定」，也可手动在图上打点并填写刻度值，再点「自动提取」。提取出曲线后会自动继续。',
    selectors: ['[data-tour="cslab-digitizer"]'],
    placement: 'left',
    view: 'cdut-science',
    action: 'demo-digitize',
    advanceOn: 'wait',
    waitFor: {
      kind: 'selector',
      selector: '[data-tour="cslab-digitizer"][data-series-count]:not([data-series-count="0"])',
      timeoutMs: 180_000,
    },
  },
  {
    key: 'digitize-save',
    title: '保存为图表与数据表',
    body: '点击「保存为图表与数据表」，系统会同时生成 PNG 图表、Parquet 数据表与血缘关系，后续可直接用于出版绘图。',
    selectors: ['[data-tour="cslab-digitizer-save"]'],
    placement: 'left',
    view: 'cdut-science',
    advanceOn: 'click-anchor',
    settleMs: 1200,
  },
  {
    key: 'mol-gold',
    title: '金 FCC 纳米颗粒',
    body: '自动轮播三种演示结构。第一件是金面心立方纳米颗粒，可在 3D 视图中拖拽旋转、缩放观察原子排布。',
    selectors: ['[data-tour="cslab-3d-viewport"]'],
    placement: 'left',
    view: 'cdut-science',
    prepare: { triggers: ['open-mol-gold'], readySelector: '[data-tour="cslab-3d-viewport"]' },
    autoAdvanceMs: 4000,
  },
  {
    key: 'mol-srtio3',
    title: 'SrTiO₃ 钙钛矿晶胞',
    body: '第二件是 SrTiO₃ 钙钛矿单胞，可在左侧调整超胞、Miller 晶面与配位多面体。',
    selectors: ['[data-tour="cslab-3d-viewport"]'],
    placement: 'left',
    view: 'cdut-science',
    prepare: { triggers: ['open-mol-srtio3'], readySelector: '[data-tour="cslab-3d-viewport"]' },
    autoAdvanceMs: 4000,
  },
  {
    key: 'mol-garnet',
    title: 'YAG 钇铝石榴石',
    body: '第三件是石榴石 YAG 完整立方晶胞。演示数据已随应用打包，换机器也能直接复现。',
    selectors: ['[data-tour="cslab-3d-viewport"]'],
    placement: 'left',
    view: 'cdut-science',
    prepare: { triggers: ['open-mol-garnet'], readySelector: '[data-tour="cslab-3d-viewport"]' },
    autoAdvanceMs: 4000,
  },
  {
    key: 'publication-plot',
    title: 'Nature 单栏出版图版',
    body: '最后查看演示实验室预置的 Nature 单栏图版：双 Y 轴叠加实验 Cu Kα 衍射与理论 PXRD，可继续调整期刊模板与导出。',
    selectors: ['[data-tour="cslab-origin-plot"]'],
    placement: 'left',
    view: 'cdut-science',
    prepare: {
      triggers: ['open-publication-plot'],
      readySelector: '[data-tour="cslab-origin-plot"]',
    },
  },
  {
    key: 'new-session',
    title: '回到清爽的新会话',
    body: '演示到这里结束。点一下侧栏的「新建会话」，回到干净的 Agent 首页，开始你自己的第一个任务。',
    selectors: ['[data-profer-navigation-item="new-session"]', '[data-tour="mode-switch"]'],
    placement: 'right',
    view: 'conversations',
    cdutSubView: null,
    advanceOn: 'click-anchor',
    restoreViewOnExit: false,
  },
  {
    key: 'outro',
    title: '开始你的第一个任务',
    body: '这段引导随时可从顶栏指南针按钮或设置里重播。建议从「分析工作区里的一个文件并给出结论」开始，观察 Agent 如何自己规划和执行。',
    selectors: [],
    placement: 'auto',
    view: 'conversations',
    restoreViewOnExit: false,
  },
]

/** 引导内容版本：增删步骤/大改文案时 +1，老用户升级后自动重播一次新指引 */
export const CURRENT_COACH_TOUR_VERSION = 8
