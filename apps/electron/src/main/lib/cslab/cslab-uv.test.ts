/**
 * CSLab uv 自举纯函数测试
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let rootDir = ''

beforeAll(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'cslab-uv-'))
  process.env.PROFER_CONFIG_DIR = rootDir
})

afterAll(() => {
  try {
    rmSync(rootDir, { recursive: true, force: true })
  } catch {
    // Windows 句柄延迟释放。
  }
})

describe('uv 目标映射', () => {
  test('六种平台/架构映射到官方资产', async () => {
    const { resolveUvTarget } = await import('./cslab-uv')
    expect(resolveUvTarget('win32', 'x64')?.asset).toBe('uv-x86_64-pc-windows-msvc.zip')
    expect(resolveUvTarget('win32', 'arm64')?.asset).toBe('uv-aarch64-pc-windows-msvc.zip')
    expect(resolveUvTarget('darwin', 'arm64')?.asset).toBe('uv-aarch64-apple-darwin.tar.gz')
    expect(resolveUvTarget('darwin', 'x64')?.asset).toBe('uv-x86_64-apple-darwin.tar.gz')
    expect(resolveUvTarget('linux', 'x64')?.asset).toBe('uv-x86_64-unknown-linux-gnu.tar.gz')
    expect(resolveUvTarget('linux', 'arm64')?.asset).toBe('uv-aarch64-unknown-linux-gnu.tar.gz')
  })

  test('未知平台返回 null', async () => {
    const { resolveUvTarget } = await import('./cslab-uv')
    expect(resolveUvTarget('freebsd', 'x64')).toBeNull()
  })
})

describe('校验与安装路径', () => {
  test('解析 .sha256 文本', async () => {
    const { parseUvChecksum } = await import('./cslab-uv')
    const checksum = 'A'.repeat(64)
    expect(parseUvChecksum(`${checksum}  uv-x86_64-pc-windows-msvc.zip`)).toBe('a'.repeat(64))
    expect(parseUvChecksum('not-a-checksum')).toBeNull()
  })

  test('安装目录位于配置目录 tools/uv 下', async () => {
    const { getUvInstallDir, getUvBinaryName } = await import('./cslab-uv')
    const dir = getUvInstallDir('x86_64-pc-windows-msvc')
    expect(dir).toBe(join(rootDir, 'tools', 'uv', 'x86_64-pc-windows-msvc'))
    expect(getUvBinaryName('win32')).toBe('uv.exe')
    expect(getUvBinaryName('darwin')).toBe('uv')
  })

  test('venv Python 路径平台感知', async () => {
    const { getVenvPythonPath } = await import('./cslab-python-runtime')
    expect(getVenvPythonPath('/lab/.venv', 'win32')).toBe(join('/lab/.venv', 'Scripts', 'python.exe'))
    expect(getVenvPythonPath('/lab/.venv', 'linux')).toBe(join('/lab/.venv', 'bin', 'python'))
  })
})

describe('uv 校验分级判定', () => {
  const actual = 'a'.repeat(64)
  const other = 'b'.repeat(64)

  test('官方指纹是权威：相符放行，不符直接拒绝', async () => {
    const { classifyUvChecksum } = await import('./cslab-uv')
    expect(classifyUvChecksum({ actual, official: actual })).toBe('official')
    expect(classifyUvChecksum({ actual, official: other })).toBe('reject')
    // 官方不符时即使镜像与内嵌都相符，也不得降级放行
    expect(
      classifyUvChecksum({ actual, official: other, pinned: actual, mirror: actual }),
    ).toBe('reject')
  })

  test('内嵌固定哈希命中即强信任', async () => {
    const { classifyUvChecksum } = await import('./cslab-uv')
    expect(classifyUvChecksum({ actual, pinned: actual })).toBe('pinned')
  })

  test('内嵌未命中时退到镜像自证，只能走用户确认', async () => {
    const { classifyUvChecksum } = await import('./cslab-uv')
    expect(classifyUvChecksum({ actual, pinned: other, mirror: actual })).toBe('mirror-consent')
    expect(classifyUvChecksum({ actual, mirror: other })).toBe('reject')
  })

  test('没有任何指纹时拒绝安装', async () => {
    const { classifyUvChecksum } = await import('./cslab-uv')
    expect(classifyUvChecksum({ actual })).toBe('reject')
    expect(classifyUvChecksum({ actual, mirror: null })).toBe('reject')
  })
})
