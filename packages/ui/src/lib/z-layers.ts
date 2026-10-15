/**
 * 客户端全局渲染图层规范（z-index 标准阶梯）
 *
 * 依据《CDUT Studio 审计缺陷修复与前沿特性落地极详方案》§4.2：
 * 原生 `WebContentsView`（Windows HWND）恒定凌驾于 Chromium DOM 图层之上，
 * 因此客户端**必须**以统一、语义化、可审计的 z-index 阶梯管理 DOM 图层，
 * 杜绝散落的魔法数字导致的层级错乱与遮挡。
 *
 * 阶梯（语义 → 取值）：
 *
 *   0      画布       底层工作区：文本编辑器 / 会话列表 / 知识图谱 / 背景水印
 *   10     工具条     局部悬浮工具条与控制区：导图缩放工具栏 / 浮动复制按钮
 *   30     顶栏       顶栏与布局分界线：窗口控制按钮宿主 / 分栏拖拽手柄
 *   40     抽屉       局部覆盖面板：局部浮动检查器 / 审核助手抽屉
 *   60~80  应用外壳   侧栏 / 主内容 / 面板与命中区
 *   100    对话框     全局核心模态：设置面板 / 课堂选择器 / 思维导图 Modal
 *   110    二次确认   高特权阻断性确认：写操作二次确认 / 退课·删除确认
 *   150    全屏模态   对话流思维导图展开大图（高于普通对话框）
 *   200    灯箱       图片灯箱（最高常规模态层）
 *   9999   下拉菜单   一切被 Portal 到 body 的下拉 / 气泡 / 选择器 / 右键菜单
 *                     （须盖过应用外壳 60~80 与对话框 100，故使用扩展档）
 *   9999   应用浮层   拖拽预览 / 全局浮层（同层，按 DOM 打开顺序叠放）
 *   10050  提示      全局 Tooltip（须盖过一切浮层）
 *
 * 说明：应用外壳实际占用 60~80，故「下拉菜单 / 应用浮层 / 提示」等须盖过外壳的层次
 * 使用扩展档（9999 / 10050）；系统级 Toast 由 Sonner 库内置更高层级承载，不在本阶梯内。
 * 数值与语义一一对应，业务代码一律引用 {@link Z_LAYER} 常量，禁止再写魔法数字。
 */

/** 图层取值（数值，供 style={{ zIndex }} 或程序化计算使用） */
export const Z_INDEX = {
  canvas: 0,
  toolbar: 10,
  chrome: 30,
  drawer: 40,
  shellContent: 60,
  shellRail: 62,
  shell: 70,
  shellResizer: 80,
  dialog: 100,
  confirm: 110,
  fullscreen: 150,
  lightbox: 200,
  menu: 9999,
  overlay: 9999,
  tooltip: 10050,
} as const

/**
 * 图层 Tailwind 类名（供 className 直接使用）。
 *
 * 这些字符串集中声明于本文件，会被 Tailwind content 扫描（见 apps/electron/tailwind.config.js
 * 已包含 `../../packages/ui/src/**`）并生成对应 CSS。
 */
export const Z_LAYER = {
  canvas: 'z-0',
  toolbar: 'z-10',
  chrome: 'z-30',
  drawer: 'z-40',
  shellTopDrag: 'z-50',
  shellContent: 'z-[60]',
  shellRail: 'z-[62]',
  shell: 'z-[70]',
  shellResizer: 'z-[80]',
  dialog: 'z-[100]',
  confirm: 'z-[110]',
  fullscreen: 'z-[150]',
  lightbox: 'z-[200]',
  /** 局部下拉与气泡卡片（Portal 到 body，须盖过外壳与对话框） */
  menu: 'z-[9999]',
  /** 应用级浮层（拖拽预览 / 全局浮层） */
  overlay: 'z-[9999]',
  tooltip: 'z-[10050]',
} as const

export type ZLayerName = keyof typeof Z_LAYER
