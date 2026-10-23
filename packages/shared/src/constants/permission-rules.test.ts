import { describe, expect, test } from 'bun:test'
import {
  SAFE_TOOLS,
  hasDangerousPowerShellStructure,
  isCsLabExecutionTool,
  isPotentiallyExecutableFile,
  isSafePowerShellCommand,
} from './permission-rules'

describe('PowerShell permission rules', () => {
  test('Given simple metadata queries When classified Then they are auto-allowable', () => {
    expect(isSafePowerShellCommand('Get-Location')).toBe(true)
    expect(isSafePowerShellCommand('Get-Date')).toBe(true)
    expect(isSafePowerShellCommand('Get-Process -Name explorer')).toBe(true)
    expect(isSafePowerShellCommand('Get-Command git')).toBe(true)
    expect(isSafePowerShellCommand('Test-Path C:\\Windows')).toBe(true)
  })

  test('Given data reads, mutation, or composed scripts When classified Then they require approval', () => {
    expect(isSafePowerShellCommand('Get-Content $HOME\\.ssh\\id_rsa')).toBe(false)
    expect(isSafePowerShellCommand('Remove-Item C:\\temp\\x')).toBe(false)
    expect(isSafePowerShellCommand('Get-Location; Remove-Item C:\\temp\\x')).toBe(false)
    expect(isSafePowerShellCommand('Get-Process | Stop-Process')).toBe(false)
  })

  test('Given PowerShell-only composition syntax When checking structure Then it is considered dangerous', () => {
    expect(hasDangerousPowerShellStructure('Get-Location; Get-Date')).toBe(true)
    expect(hasDangerousPowerShellStructure('Get-Process | Select-Object Name')).toBe(true)
    expect(hasDangerousPowerShellStructure('Get-Item $(Get-Location)')).toBe(true)
    expect(hasDangerousPowerShellStructure('Get-ChildItem > out.txt')).toBe(true)
  })
})

describe('CSLab 科学工具权限分级', () => {
  test('Given 只读科学计算工具 When 判定 Then 免逐次审批且进入安全白名单', () => {
    for (const toolName of ['cslab_analyze_crystal', 'cslab_simulate_pxrd', 'cslab_fit_peaks']) {
      expect(isCsLabExecutionTool(toolName)).toBe(false)
      expect(SAFE_TOOLS).toContain(toolName)
    }
    expect(isCsLabExecutionTool('cslab_list_lab_tools')).toBe(false)
  })

  test('Given 会写文件或改画板的工具 When 判定 Then 仍视为执行类工具', () => {
    expect(isCsLabExecutionTool('cslab_render_plot')).toBe(true)
    expect(isCsLabExecutionTool('cslab_export_figure')).toBe(true)
    expect(SAFE_TOOLS).not.toContain('cslab_render_plot')
    expect(SAFE_TOOLS).not.toContain('cslab_export_figure')
  })
})

describe('潜在可执行文件后缀判定（CVE-2026-96951 防御）', () => {
  test('Given Windows 可执行与脚本后缀 When 判定 Then 一律命中', () => {
    expect(isPotentiallyExecutableFile('C:\\Users\\x\\Downloads\\setup.exe')).toBe(true)
    expect(isPotentiallyExecutableFile('/tmp/run.bat')).toBe(true)
    expect(isPotentiallyExecutableFile('D:\\scripts\\deploy.ps1')).toBe(true)
    expect(isPotentiallyExecutableFile('~/evil.vbs')).toBe(true)
    expect(isPotentiallyExecutableFile('package.msi')).toBe(true)
    expect(isPotentiallyExecutableFile('macro.hta')).toBe(true)
  })

  test('Given 大小写混合后缀 When 判定 Then 不区分大小写命中', () => {
    expect(isPotentiallyExecutableFile('VIRUS.EXE')).toBe(true)
    expect(isPotentiallyExecutableFile('run.Cmd')).toBe(true)
  })

  test('Given 普通文档与目录路径 When 判定 Then 不命中', () => {
    expect(isPotentiallyExecutableFile('C:\\work\\report.docx')).toBe(false)
    expect(isPotentiallyExecutableFile('/home/u/notes.txt')).toBe(false)
    expect(isPotentiallyExecutableFile('C:\\work\\data.json')).toBe(false)
    expect(isPotentiallyExecutableFile('C:\\Users\\u\\Documents')).toBe(false)
    expect(isPotentiallyExecutableFile('')).toBe(false)
  })

  test('Given 无扩展名或点开头的隐藏文件 When 判定 Then 不命中', () => {
    expect(isPotentiallyExecutableFile('.exe')).toBe(false)
    expect(isPotentiallyExecutableFile('.bashrc')).toBe(false)
    expect(isPotentiallyExecutableFile('README')).toBe(false)
  })
})
