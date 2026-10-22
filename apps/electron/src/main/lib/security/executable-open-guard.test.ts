import { describe, expect, test } from 'bun:test'

import { shouldConfirmExecutableOpen } from './executable-open-guard'

describe('Windows 可执行文件打开确认守卫（CVE-2026-96951）', () => {
  test('Given win32 且命中可执行后缀且未选择「不再提醒」When 判定 Then 需要弹窗确认', () => {
    expect(shouldConfirmExecutableOpen('C:\\Downloads\\setup.exe', 'win32', false, () => false)).toBe(true)
    expect(shouldConfirmExecutableOpen('C:\\Downloads\\run.bat', 'win32', false, () => undefined)).toBe(true)
    expect(shouldConfirmExecutableOpen('/tmp/payload.ps1', 'win32', false, () => undefined)).toBe(true)
  })

  test('Given 已勾选「不再提醒」When 判定 Then 直接放行不再弹窗（决策：持久化选择）', () => {
    expect(shouldConfirmExecutableOpen('C:\\Downloads\\setup.exe', 'win32', false, () => true)).toBe(false)
  })

  test('Given 非 Windows 平台 When 判定 Then 直通（决策：仅 Windows 生效）', () => {
    expect(shouldConfirmExecutableOpen('/tmp/payload.sh', 'darwin', false, () => false)).toBe(false)
    expect(shouldConfirmExecutableOpen('/tmp/payload.sh', 'linux', false, () => false)).toBe(false)
    expect(shouldConfirmExecutableOpen('C:\\Downloads\\setup.exe', 'darwin', false, () => false)).toBe(false)
  })

  test('Given 测试环境（BUN_TEST）When 判定 Then 无头拒止不弹窗（防自动化挂起）', () => {
    expect(shouldConfirmExecutableOpen('C:\\Downloads\\setup.exe', 'win32', true, () => false)).toBe(false)
  })

  test('Given 普通文档后缀 When 判定 Then 不弹窗', () => {
    expect(shouldConfirmExecutableOpen('C:\\work\\report.pdf', 'win32', false, () => false)).toBe(false)
    expect(shouldConfirmExecutableOpen('C:\\work\\notes.txt', 'win32', false, () => false)).toBe(false)
  })
})
