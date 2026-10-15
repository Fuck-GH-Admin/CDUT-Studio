import { app, clipboard, Menu, shell, BrowserWindow } from 'electron'
import { DEFAULT_MAIN_WINDOW_ZOOM_FACTOR, resetWindowZoom } from './lib/mac-traffic-light'

export type TextContextMenuParams = Pick<
  Electron.ContextMenuParams,
  'isEditable' | 'selectionText' | 'editFlags'
>

/** 纯文本粘贴与「像输入一样粘贴」的实际动作，由调用方注入以便模板保持纯函数可测。 */
export interface TextContextMenuActions {
  /** 粘贴为纯文本：将剪贴板文本原样插入当前焦点元素。 */
  pastePlainText: () => void
  /** 像输入一样粘贴：逐字符插入，模拟人工敲击的视觉节奏。 */
  pasteLikeHuman: () => void
}

/**
 * 根据右键位置的编辑能力生成原生文本菜单。
 *
 * 非编辑区域只有存在文本选区时才返回菜单，避免盖住 Renderer 中已有的业务右键菜单。
 * 传入 actions 时，可编辑区域会额外提供「粘贴为纯文本」与「像输入一样粘贴」。
 */
export function createTextContextMenuTemplate(
  params: TextContextMenuParams,
  platform: NodeJS.Platform = process.platform,
  actions?: TextContextMenuActions,
): Electron.MenuItemConstructorOptions[] {
  const { editFlags } = params

  if (!params.isEditable) {
    if (params.selectionText.length === 0) return []
    return [{ role: 'copy', label: '复制', enabled: editFlags.canCopy }]
  }

  return [
    { role: 'undo', label: '撤销', enabled: editFlags.canUndo },
    { role: 'redo', label: '重做', enabled: editFlags.canRedo },
    { type: 'separator' },
    { role: 'cut', label: '剪切', enabled: editFlags.canCut },
    { role: 'copy', label: '复制', enabled: editFlags.canCopy },
    { role: 'paste', label: '粘贴', enabled: editFlags.canPaste },
    ...(actions
      ? [
          {
            label: '粘贴为纯文本',
            enabled: editFlags.canPaste,
            click: () => actions.pastePlainText(),
          },
          {
            label: '像输入一样粘贴',
            enabled: editFlags.canPaste,
            click: () => actions.pasteLikeHuman(),
          },
        ]
      : []),
    ...(platform === 'darwin'
      ? [{ role: 'pasteAndMatchStyle' as const, label: '粘贴并匹配样式', enabled: editFlags.canPaste }]
      : []),
    { role: 'delete', label: '删除', enabled: editFlags.canDelete },
    { type: 'separator' },
    { role: 'selectAll', label: '全选', enabled: editFlags.canSelectAll },
  ]
}

/** 逐字符敲入的间隔（毫秒），模拟人工输入节奏以规避前端粘贴检测。 */
const PASTE_LIKE_HUMAN_STEP_MS = 18

/** 记录每个 WebContents 当前正在进行的「像输入一样粘贴」任务号，用于打断上一次输入。 */
const humanPasteTaskIds = new WeakMap<Electron.WebContents, number>()

/**
 * 剪贴板文本插入前的安全化处理。
 *
 * 关键红线：`insertText` 会把 `\n` / `\r` 原样写入聚焦元素，而聊天输入框（TipTap 等）
 * 会把插入的换行当作「回车」语义处理，进而在粘贴过程中或粘贴后立即误发送消息。
 * 因此插入前必须折叠所有换行，并剔除可能被误判为按键语义的 C0 控制字符。
 *
 * @returns 安全化后的单行文本（原始内容不丢失，仅把换行折叠为空格）。
 */
export function sanitizeClipboardTextForInsertion(text: string): string {
  return text
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
}

/**
 * 像输入一样粘贴：对已安全化（无换行/控制字符）的纯文本逐字符插入，营造人工敲击效果。
 *
 * 使用 insertText 逐字写入可触发标准 input 事件，保证受控输入框正常更新。
 * 入参必须先经 `sanitizeClipboardTextForInsertion` 处理，否则中途插入的换行会触发误发送。
 */
function pasteLikeHuman(webContents: Electron.WebContents, text: string): void {
  const taskId = (humanPasteTaskIds.get(webContents) ?? 0) + 1
  humanPasteTaskIds.set(webContents, taskId)

  let index = 0
  const step = (): void => {
    if (webContents.isDestroyed() || humanPasteTaskIds.get(webContents) !== taskId) return
    if (index >= text.length) {
      humanPasteTaskIds.delete(webContents)
      return
    }
    webContents.insertText(text.charAt(index))
    index += 1
    setTimeout(step, PASTE_LIKE_HUMAN_STEP_MS)
  }
  step()
}

let textContextMenusInstalled = false

/** 为 Profer 创建的所有 WebContents 安装通用复制/粘贴右键菜单。 */
export function installTextContextMenus(): void {
  if (textContextMenusInstalled) return
  textContextMenusInstalled = true

  app.on('web-contents-created', (_event, webContents) => {
    webContents.on('context-menu', (_contextMenuEvent, params) => {
      const template = createTextContextMenuTemplate(params, process.platform, {
        // 菜单点击发生在原生菜单收起的过程中，延后一帧确保焦点已回到输入框。
        // 两者都必须先安全化剪贴板文本（折叠换行），否则插入的换行会被输入框当作回车误发送。
        pastePlainText: () => {
          setTimeout(() => {
            if (webContents.isDestroyed()) return
            const text = sanitizeClipboardTextForInsertion(clipboard.readText())
            if (text) webContents.insertText(text)
          }, 0)
        },
        pasteLikeHuman: () => {
          setTimeout(() => {
            if (webContents.isDestroyed()) return
            const text = sanitizeClipboardTextForInsertion(clipboard.readText())
            if (text) pasteLikeHuman(webContents, text)
          }, 0)
        },
      })
      if (template.length === 0) return

      const ownerWindow = BrowserWindow.fromWebContents(webContents) ?? BrowserWindow.getFocusedWindow()
      const popupOptions: Electron.PopupOptions = {
        sourceType: params.menuSourceType,
      }
      if (ownerWindow) popupOptions.window = ownerWindow
      if (params.frame) popupOptions.frame = params.frame

      Menu.buildFromTemplate(template).popup(popupOptions)
    })
  })
}

export function createApplicationMenu(): Menu {
  const isMac = process.platform === 'darwin'

  /**
   * 菜单快捷键说明：
   *
   * 大部分快捷键由渲染进程的 shortcut-registry 统一管理。
   * 但 Cmd+W 需要在菜单中拦截（否则 macOS 默认关闭窗口），
   * 改为通知渲染进程关闭当前标签页。
   */

  const template: Electron.MenuItemConstructorOptions[] = [
    // 应用菜单 (仅 macOS)
    ...(isMac
      ? [
          {
            label: 'CDUT Studio',
            submenu: [
              { role: 'about' as const, label: '关于 CDUT Studio' },
              { type: 'separator' as const },
              { role: 'services' as const, label: '服务' },
              { type: 'separator' as const },
              { role: 'hide' as const, label: '隐藏 CDUT Studio' },
              { role: 'hideOthers' as const, label: '隐藏其他' },
              { role: 'unhide' as const, label: '显示全部' },
              { type: 'separator' as const },
              { role: 'quit' as const, label: '退出 CDUT Studio' },
            ],
          },
        ]
      : []),

    // 文件菜单
    {
      label: '文件',
      submenu: [
        // Cmd+W / Ctrl+W：关闭当前标签页（而非关闭窗口）
        {
          label: '关闭标签页',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            const win = BrowserWindow.getFocusedWindow()
            if (win) {
              win.webContents.send('menu:close-tab')
            }
          },
        },
        ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const, label: '退出' }]),
      ],
    },

    // 编辑菜单
    {
      label: '编辑',
      submenu: [
        { role: 'undo' as const, label: '撤销' },
        { role: 'redo' as const, label: '重做' },
        { type: 'separator' as const },
        { role: 'cut' as const, label: '剪切' },
        { role: 'copy' as const, label: '复制' },
        { role: 'paste' as const, label: '粘贴' },
        ...(isMac
          ? [
              { role: 'pasteAndMatchStyle' as const, label: '粘贴并匹配样式' },
              { role: 'delete' as const, label: '删除' },
              { role: 'selectAll' as const, label: '全选' },
            ]
          : [{ role: 'delete' as const, label: '删除' }, { type: 'separator' as const }, { role: 'selectAll' as const, label: '全选' }]),
      ],
    },

    // 视图菜单
    {
      label: '视图',
      submenu: [
        { role: 'reload' as const, label: '重新加载' },
        { role: 'forceReload' as const, label: '强制重新加载' },
        { role: 'toggleDevTools' as const, label: '切换开发者工具' },
        { type: 'separator' as const },
        {
          label: '重置缩放',
          accelerator: 'CmdOrCtrl+0',
          click: () => {
            const win = BrowserWindow.getFocusedWindow()
            if (!win) return
            // Profer 的默认缩放是 110%，不沿用 Chromium resetZoom 的 100%。
            if (process.platform === 'darwin') resetWindowZoom(win)
            else win.webContents.setZoomFactor(DEFAULT_MAIN_WINDOW_ZOOM_FACTOR)
          },
        },
        { role: 'zoomIn' as const, label: '放大' },
        { role: 'zoomOut' as const, label: '缩小' },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const, label: '切换全屏' },
      ],
    },

    // 窗口菜单
    {
      label: '窗口',
      submenu: [
        { role: 'minimize' as const, label: '最小化' },
        { role: 'zoom' as const, label: '缩放' },
        ...(isMac
          ? [
              { type: 'separator' as const },
              { role: 'front' as const, label: '前置全部窗口' },
              { type: 'separator' as const },
              { role: 'window' as const, label: '窗口' },
            ]
          : [{ role: 'close' as const, label: '关闭' }]),
      ],
    },

    // 帮助菜单
    {
      label: '帮助',
      role: 'help' as const,
      submenu: [
        {
          label: '了解更多',
          click: async () => {
            await shell.openExternal('https://github.com/Nya-Angle/CDUT-Studio')
          },
        },
      ],
    },
  ]

  return Menu.buildFromTemplate(template)
}
