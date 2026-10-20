/**
 * coach-tour-steps — 界面蒙层引导的步骤定义
 *
 * 每步给出按优先级排列的 CSS 选择器，引擎取第一个「可见且非零尺寸」
 * 的元素作为高亮锚点；全部找不到时气泡居中降级，不阻断流程。
 *
 * unionSelectors：锚点由多个分散容器组成（如技能页 = 头部 + 内容区两个并列
 * max-w-6xl 列，没有公共可见父级）时，对所有命中元素取外接矩形。
 *
 * view：进入该步前先把主内容区切到对应视图，保证锚点在正确的上下文里；
 * 引导退出时引擎会恢复用户原来的视图。
 *
 * advanceOn: 'click-anchor' 表示交互步骤——聚光灯镂空放行真实点击，
 * 等用户自己点击高亮区域（如侧栏入口）后才前进，让用户亲手走到目标页面；
 * 此时隐藏「下一步」按钮（锚点缺失时降级为手动下一步，不会卡住）。
 *
 * action：气泡内的专属快捷操作（仅渲染在引导气泡内，绝不入侵真实业务界面）：
 *  - 'fill-demo-account'：把演示特区账户填入 CDUT 专区登录表单（不代提交）；
 *  - 'fill-browser-prompt'：把内置浏览器演示指令注入会话输入框（不代发送）。
 *
 * 改动提示：增删步骤或大改文案时 +1 CURRENT_COACH_TOUR_VERSION，
 * 已看过的用户升级后会自动重播一次新版本。
 */

import type { ActiveView } from '@/atoms/active-view'
import type { CoachTourPlacement } from './coach-tour-position'

/** 演示特区账户（仅供新手引导气泡内的「一键填入」使用，不写入任何真实业务逻辑） */
export const DEMO_CDUT_ACCOUNT = {
  username: '202520260101',
  password: 'Nya315',
} as const

/** 演示指令：让大模型自主规划内置浏览器多站点浏览路线 */
export const DEMO_BROWSER_PROMPT =
  '请在内置浏览器中依次访问中国知网、哔哩哔哩和抖音，告诉我每个站点的特色与推荐内容'

/** 气泡内的专属快捷操作标识 */
export type CoachTourAction = 'fill-demo-account' | 'fill-browser-prompt'

export interface CoachTourStep {
  key: string
  title: string
  body: string
  /** 依次尝试的 CSS 选择器；第一个可见元素作为高亮目标 */
  selectors: string[]
  /** 气泡相对目标的偏好方位；空间不足时自动回退其他方位，auto 优先下方 */
  placement: CoachTourPlacement
  /** 进入该步前切换的主内容区视图；缺省不切 */
  view?: ActiveView
  /** 缺省为手动「下一步」；'click-anchor' 需用户亲自点击高亮锚点才前进 */
  advanceOn?: 'click-anchor'
  /** 提供时取代 selectors：对所有命中元素取外接矩形作为锚点 */
  unionSelectors?: string[]
  /** 气泡内渲染的专属快捷操作（演示账号填入 / 演示指令填入） */
  action?: CoachTourAction
}

export const COACH_TOUR_STEPS: CoachTourStep[] = [
  {
    key: 'welcome-chat',
    title: 'Agent 对话与任务',
    body: 'CDUT Studio 以 Pi Agent 为唯一内核：直接用自然语言描述目标，它会自己查资料、读文件、跑命令、上网。每个任务开一个会话，上下文干净、互不干扰，列表里随时切回继续。',
    selectors: ['[data-profer-navigation-item="new-session"]', '[data-tour="mode-switch"]'],
    placement: 'right',
    view: 'conversations',
  },
  {
    key: 'chat-syntax',
    title: '输入区与引用语法',
    body: '在这里用自然语言描述目标就好。四个引用让它基于真实上下文工作：@ 引用工作区文件，/ 调用 Skill，# 调用 MCP 工具，& 引用其他会话；支持直接粘贴图片，超长文本会自动转为附件。',
    selectors: ['[data-input-mode="agent"]', '[data-input-mode="chat"]'],
    placement: 'top',
    view: 'conversations',
  },
  {
    key: 'cdut-zone-enter',
    title: '进入 CDUT 校园特区',
    body: '这是专为成理师生打造的特区：登录特区账户后，Agent 就能调用校内 9 类事务工具——课表、成绩、空教室、考务、学籍档案等。点一下侧栏的【CDUT 专区】，我们进去看看。',
    selectors: [
      '[data-profer-navigation-region="mode-switcher-cdut"]',
      '[data-profer-navigation-region="mode-switcher-agent"]',
    ],
    placement: 'right',
    advanceOn: 'click-anchor',
  },
  {
    key: 'cdut-zone-login',
    title: '连接特区账户',
    body: '输入学工号与密码即可完成校内统一身份认证——密码只在后台提交给校内认证页，本地经操作系统加密存储。想先体验一下？点下面的按钮一键填入演示账号（学工号 202520260101，密码 Nya315），再点「一键连接特区账户」。',
    selectors: ['[data-tour="cdut-login-card"]'],
    placement: 'left',
    view: 'cdut-zone',
    action: 'fill-demo-account',
  },
  {
    key: 'cdut-zone-features',
    title: '课表、成绩与空教室',
    body: '登录后这里就是你的校园工作台：今日课表雷达、成绩与 GPA 透视、自习空教室检索、期末考场。可以在这里点开查看，也可以直接在会话里问 Agent，例如「查我这周还剩哪些空教室」。',
    selectors: ['[data-tour="cdut-quickbar"]'],
    placement: 'auto',
    view: 'cdut-zone',
  },
  {
    key: 'browser-tour',
    title: '让 Agent 自己上网',
    body: '智联万站是内置浏览器，Agent 能自主浏览网页、读页、点击与填表。点下面的按钮填入演示指令，它会依次访问中国知网、哔哩哔哩和抖音并汇总各站点特色——按 Enter 发送即可看到它自己规划浏览路线。',
    selectors: ['[data-input-mode="agent"]', '[data-input-mode="chat"]'],
    placement: 'top',
    view: 'conversations',
    action: 'fill-browser-prompt',
  },
  {
    key: 'review-enter',
    title: '材料审核专区',
    body: '三栏联动的工作台：左栏是审核依据与规则大纲，中栏是待审材料，右栏是 AI 研判出的问题卡。点击问题卡会同时高亮三栏的对应位置，跨文件矛盾两处同色标注，核对完成后可一键导出预审报告。',
    selectors: [
      '[data-tour="cdut-module-material-review"]',
      '[data-profer-navigation-region="mode-switcher-cdut"]',
    ],
    placement: 'auto',
    view: 'cdut-zone',
  },
  {
    key: 'planning-enter',
    title: '规划中心与自动化',
    body: '重复的活儿交给定时任务：每周一整理项目进展、每天早上汇总今日安排，到点自动执行并把结果写回会话。点这里，我们进去看看。',
    selectors: ['[data-profer-navigation-item="planning"]'],
    placement: 'right',
    advanceOn: 'click-anchor',
  },
  {
    key: 'skills-enter',
    title: '技能、记忆与预设',
    body: '把你的最佳实践沉淀成 Skill，一次写好、反复调用；这里还集中管理 MCP 工具、工作区记忆与岗位预设。点这里，我们进去看看。',
    selectors: ['[data-profer-navigation-item="agent-skills"]'],
    placement: 'right',
    advanceOn: 'click-anchor',
  },
  {
    key: 'outro',
    title: '开始你的第一个任务',
    body: '最能感受 CDUT Studio 的起点：让它「分析工作区里的一个文件并给出结论」，观察它如何自己规划和执行；登录特区账户后，还可以直接说「查我这周的空教室」。这段引导随时可从顶栏指南针按钮或设置里重播。',
    selectors: [],
    placement: 'auto',
  },
]

/** 引导内容版本：增删步骤/大改文案时 +1，老用户升级后自动重播一次新指引 */
export const CURRENT_COACH_TOUR_VERSION = 7
