import { describe, expect, test } from 'bun:test'
import { createTextContextMenuTemplate, sanitizeClipboardTextForInsertion, type TextContextMenuParams } from './menu'

function makeParams(overrides: Partial<TextContextMenuParams> = {}): TextContextMenuParams {
  return {
    isEditable: false,
    selectionText: '',
    editFlags: {
      canUndo: false,
      canRedo: false,
      canCut: false,
      canCopy: false,
      canPaste: false,
      canDelete: false,
      canSelectAll: false,
      canEditRichly: false,
    },
    ...overrides,
  }
}

describe('文本右键菜单', () => {
  test('Given 可编辑输入框 When 剪贴板可粘贴 Then 显示且启用粘贴菜单', () => {
    const template = createTextContextMenuTemplate(makeParams({
      isEditable: true,
      editFlags: {
        ...makeParams().editFlags,
        canPaste: true,
        canSelectAll: true,
      },
    }), 'win32')

    expect(template.find((item) => item.role === 'paste')).toMatchObject({
      label: '粘贴',
      enabled: true,
    })
  })

  test('Given 普通页面有文本选区 When 用户右键 Then 只提供可用的复制操作', () => {
    const template = createTextContextMenuTemplate(makeParams({
      selectionText: '要复制的文字',
      editFlags: {
        ...makeParams().editFlags,
        canCopy: true,
        canSelectAll: true,
      },
    }), 'win32')

    expect(template).toEqual([{ role: 'copy', label: '复制', enabled: true }])
  })

  test('Given 非编辑区域且没有选区 When 用户右键 Then 不创建菜单以保留业务右键行为', () => {
    expect(createTextContextMenuTemplate(makeParams(), 'win32')).toEqual([])
  })

  test('Given macOS 可编辑输入框 When 用户右键 Then 提供粘贴并匹配样式', () => {
    const template = createTextContextMenuTemplate(makeParams({
      isEditable: true,
      editFlags: {
        ...makeParams().editFlags,
        canPaste: true,
      },
    }), 'darwin')

    expect(template.find((item) => item.role === 'pasteAndMatchStyle')).toMatchObject({
      label: '粘贴并匹配样式',
      enabled: true,
    })
  })

  test('Given 可编辑输入框且注入动作 When 用户右键 Then 提供纯文本粘贴与像输入一样粘贴', () => {
    const template = createTextContextMenuTemplate(makeParams({
      isEditable: true,
      editFlags: {
        ...makeParams().editFlags,
        canPaste: true,
      },
    }), 'win32', {
      pastePlainText: () => {},
      pasteLikeHuman: () => {},
    })

    expect(template.find((item) => item.label === '粘贴为纯文本')).toMatchObject({
      label: '粘贴为纯文本',
      enabled: true,
    })
    expect(template.find((item) => item.label === '像输入一样粘贴')).toMatchObject({
      label: '像输入一样粘贴',
      enabled: true,
    })
  })

  test('Given 可编辑输入框但剪贴板不可粘贴 When 用户右键 Then 两个粘贴菜单均禁用', () => {
    const template = createTextContextMenuTemplate(makeParams({
      isEditable: true,
    }), 'win32', {
      pastePlainText: () => {},
      pasteLikeHuman: () => {},
    })

    expect(template.find((item) => item.label === '粘贴为纯文本')?.enabled).toBe(false)
    expect(template.find((item) => item.label === '像输入一样粘贴')?.enabled).toBe(false)
  })

  test('Given 未注入动作 When 用户右键可编辑输入框 Then 不追加自定义粘贴菜单', () => {
    const template = createTextContextMenuTemplate(makeParams({
      isEditable: true,
    }), 'win32')

    expect(template.find((item) => item.label === '粘贴为纯文本')).toBeUndefined()
    expect(template.find((item) => item.label === '像输入一样粘贴')).toBeUndefined()
  })
})

describe('剪贴板文本安全化（防粘贴误发送）', () => {
  test('Given 含换行的文本 When 安全化 Then 换行折叠为单个空格（不误触回车发送）', () => {
    expect(sanitizeClipboardTextForInsertion('第一行\n第二行\r\n第三行')).toBe('第一行 第二行 第三行')
    expect(sanitizeClipboardTextForInsertion('code();\n\nnext()')).toBe('code(); next()')
  })

  test('Given 含 C0 控制字符的文本 When 安全化 Then 控制字符被剔除且保留制表符', () => {
    expect(sanitizeClipboardTextForInsertion('a\u0000b\u0007c')).toBe('abc')
    expect(sanitizeClipboardTextForInsertion('列1\t列2')).toBe('列1\t列2')
  })

  test('Given 纯空白文本 When 安全化 Then 返回空串（调用方随即跳过插入）', () => {
    expect(sanitizeClipboardTextForInsertion('  \n\r\n  ')).toBe('')
    expect(sanitizeClipboardTextForInsertion('')).toBe('')
  })
})
