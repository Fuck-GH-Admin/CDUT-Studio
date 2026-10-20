/**
 * CSLab 局域网共享盘监听器测试
 *
 * 覆盖：
 * - 路径规范化（UNC / smb:// / \\?\UNC / WebDAV / 本地）；
 * - 静默期未满不捕获、静默期满足后捕获并落库；
 * - 捕获证据等级如实标注（node-stream-stability）；
 * - 同一 SHA-256 幂等，不重复入库。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CsLabLab } from '@profer/shared'

const FORCE_NODE = '1'

let rootDir = ''
let lab: CsLabLab

const CSV = ['# CHI760E export', 'Potential / V,Current / mA', '0.1,1.25', '0.2,1.30', '0.3,1.35'].join('\n')

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeShareDir(name: string): string {
  const dir = join(rootDir, `share-${name}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

beforeAll(async () => {
  process.env.PROFER_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'cslab-share-config-'))
  process.env.CSLAB_SHARE_FORCE_NODE_STREAM = FORCE_NODE
  rootDir = process.env.PROFER_CONFIG_DIR
  const { createLab } = await import('./cslab-manager')
  lab = createLab({ name: '共享盘测试实验室', description: '自动化测试' })
})

afterAll(async () => {
  const { stopAllShareWatchers, __setShareTuningForTest } = await import('./cslab-share-watcher')
  await stopAllShareWatchers()
  __setShareTuningForTest(null)
  const { resolveLabDir } = await import('./cslab-paths')
  const { unlockFile } = await import('./cslab-hash')
  const { closeAllCsLabDatabases } = await import('./cslab-db')
  const { closeAllShareDatabases } = await import('./cslab-share-db')
  try {
    const rawDir = join(resolveLabDir(lab.id), 'vault', 'raw')
    for (const entry of readdirSync(rawDir)) await unlockFile(join(rawDir, entry))
  } catch {
    // 目录可能不存在。
  }
  await stopAllShareWatchers()
  closeAllShareDatabases()
  closeAllCsLabDatabases()
  delete process.env.CSLAB_SHARE_FORCE_NODE_STREAM
  try {
    rmSync(rootDir, { recursive: true, force: true })
  } catch {
    // Windows 句柄延迟释放，交给系统回收。
  }
})

describe('共享路径规范化', () => {
  test('UNC / smb:// / \\\\?\\UNC / WebDAV / 本地', async () => {
    const { normalizeSharePath } = await import('./cslab-share-watcher')

    const unc = normalizeSharePath('\\\\lab-pc\\XRD\\data')
    expect(unc.kind).toBe('unc')
    expect(unc.normalized).toBe('\\\\lab-pc\\XRD\\data')
    expect(unc.host).toBe('lab-pc')
    expect(unc.share).toBe('XRD')

    const smb = normalizeSharePath('smb://lab-pc/XRD/data')
    expect(smb.kind).toBe('unc')
    expect(smb.normalized).toBe('\\\\lab-pc\\XRD\\data')

    const longUnc = normalizeSharePath('\\\\?\\UNC\\lab-pc\\XRD\\data')
    expect(longUnc.normalized).toBe('\\\\lab-pc\\XRD\\data')

    const webdav = normalizeSharePath('https://dav.example.edu/lab/data/')
    expect(webdav.kind).toBe('webdav')
    expect(webdav.normalized).toBe('https://dav.example.edu/lab/data')

    const local = normalizeSharePath(rootDir)
    expect(local.kind).toBe('local')
    expect(local.normalized).toBe(rootDir.replace(/[\\/]+$/, ''))
  })

  test('非法 UNC 明确报错', async () => {
    const { normalizeSharePath } = await import('./cslab-share-watcher')
    expect(() => normalizeSharePath('\\\\only-server')).toThrow()
    expect(() => normalizeSharePath('')).toThrow()
  })

  test('Windows IPv6 字面量 UNC 别名被拦截', async () => {
    const { normalizeSharePath } = await import('./cslab-share-watcher')
    expect(() => normalizeSharePath('\\\\fe80--1.ipv6-literal.net\\share')).toThrow('安全拦截')
    expect(() => normalizeSharePath('\\\\::1.ipv6-literal.net\\share')).toThrow('安全拦截')
  })
})

describe('WebDAV 源安全边界', () => {
  test('云元数据、链路本地与回环地址被拒绝', async () => {
    const { normalizeSharePath } = await import('./cslab-share-watcher')
    const blocked = [
      'webdav://169.254.169.254/latest/meta-data/',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://100.100.100.200/latest/meta-data/',
      'http://127.0.0.1:2375/containers/json',
      'http://[::1]/dav',
    ]
    for (const value of blocked) {
      expect(() => normalizeSharePath(value)).toThrow('安全拦截')
    }
  })

  test('局域网 NAS 与公网 WebDAV 正常通过', async () => {
    const { normalizeSharePath } = await import('./cslab-share-watcher')
    expect(normalizeSharePath('https://dav.example.edu/lab/data').kind).toBe('webdav')
    expect(normalizeSharePath('http://192.168.1.10/dav').kind).toBe('webdav')
    expect(normalizeSharePath('http://10.0.0.8:5005/dav').kind).toBe('webdav')
  })

  test('UNC/SMB 路径对云元数据与回环地址同样执行安全拦截', async () => {
    const { normalizeSharePath } = await import('./cslab-share-watcher')
    const blockedUnc = [
      '\\\\169.254.169.254\\share\\data',
      '\\\\localhost\\share',
      '\\\\127.0.0.1\\share',
      '\\\\metadata.google.internal\\share',
      'smb://169.254.169.254/share',
      'smb://localhost/share',
    ]
    for (const value of blockedUnc) {
      expect(() => normalizeSharePath(value)).toThrow('安全拦截')
    }
    expect(normalizeSharePath('\\\\lab-pc\\XRD\\data').kind).toBe('unc')
    expect(normalizeSharePath('\\\\192.168.1.10\\share').kind).toBe('unc')
  })

  test('单标签保留主机名 WPAD/ISATAP 被拦截，实验室主机名保持可用', async () => {
    const { normalizeSharePath } = await import('./cslab-share-watcher')
    expect(() => normalizeSharePath('\\\\wpad\\share')).toThrow('安全拦截')
    expect(() => normalizeSharePath('smb://isatap/share')).toThrow('安全拦截')
    expect(normalizeSharePath('\\\\lab-pc\\XRD\\data').kind).toBe('unc')
  })
})

describe('内联 PowerShell 参数安全', () => {
  test('普通路径与反引号字面量允许通过', async () => {
    const { assertInlinePowerShellSafe } = await import('./cslab-share-watcher')
    expect(() => assertInlinePowerShellSafe('D:\\实验室\\XRD\\a.csv')).not.toThrow()
    expect(() => assertInlinePowerShellSafe('C:\\data\\a`b.csv')).not.toThrow()
  })

  test('控制字符被拒绝', async () => {
    const { assertInlinePowerShellSafe } = await import('./cslab-share-watcher')
    for (const value of ['a\nb', 'a\u0000b', 'a\u007Fb']) {
      expect(() => assertInlinePowerShellSafe(value)).toThrow('控制字符')
    }
  })
})

describe('共享盘静默期与捕获', () => {
  test('静默期未满不捕获，满足后才入库并标注流式校验', async () => {
    const { addShareSource, scanShareSource, listShareCandidates } = await import('./cslab-share-watcher')
    const { listAssets } = await import('./cslab-iron-cage')

    const fileName = 'CV_run_001.csv'
    const shareDir = makeShareDir('cv')
    const filePath = join(shareDir, fileName)
    writeFileSync(filePath, CSV, 'utf-8')
    const expectedSha = createHash('sha256').update(readFileSync(filePath)).digest('hex')

    const source = addShareSource({
      labId: lab.id,
      label: 'CHI 共享盘',
      rootPath: shareDir,
      quietSeconds: 1,
      pollSeconds: 1,
    })
    expect(source.kind).toBe('local')

    const first = await scanShareSource(lab.id, source.id)
    expect(first.ok).toBe(true)
    expect(first.discovered).toBe(1)
    expect(first.captured).toBe(0)

    let candidates = listShareCandidates(lab.id, source.id)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.state).toBe('debouncing')

    await sleep(1150)

    const second = await scanShareSource(lab.id, source.id)
    expect(second.captured).toBe(1)

    candidates = listShareCandidates(lab.id, source.id)
    expect(candidates[0]?.state).toBe('published')
    expect(candidates[0]?.sha256).toBe(expectedSha)
    expect(candidates[0]?.leaseType).toBe('node-stream-stability')
    expect(candidates[0]?.evidence).toBe('quiet-interval')
    expect(candidates[0]?.assetUri).toContain('/table/')

    const assets = listAssets(lab.id)
    expect(assets.some((asset) => asset.sha256 === expectedSha)).toBe(true)
  })

  test('文件持续追加时重置静默期；稳定后才捕获最终版本', async () => {
    const { addShareSource, scanShareSource, listShareCandidates } = await import('./cslab-share-watcher')

    const fileName = 'growth_scan.csv'
    const shareDir = makeShareDir('growth')
    const filePath = join(shareDir, fileName)
    writeFileSync(filePath, 'x,y\n0,0\n1,1\n', 'utf-8')

    const source = addShareSource({
      labId: lab.id,
      label: '生长中的扫描',
      rootPath: shareDir,
      quietSeconds: 1,
      pollSeconds: 1,
    })

    await scanShareSource(lab.id, source.id)
    const before = listShareCandidates(lab.id, source.id).find((item) => item.relPath === fileName)
    expect(before?.state).toBe('debouncing')
    const firstFingerprint = before?.fingerprint

    appendFileSync(filePath, '2,4\n3,9\n', 'utf-8')
    await scanShareSource(lab.id, source.id)
    const afterAppend = listShareCandidates(lab.id, source.id).find((item) => item.relPath === fileName)
    expect(afterAppend?.state).toBe('debouncing')
    expect(afterAppend?.fingerprint).not.toBe(firstFingerprint)

    await sleep(1150)
    const finalScan = await scanShareSource(lab.id, source.id)
    expect(finalScan.captured).toBe(1)

    const published = listShareCandidates(lab.id, source.id).find((item) => item.relPath === fileName)
    expect(published?.state).toBe('published')
    expect(published?.sha256).toBe(
      createHash('sha256').update(readFileSync(filePath)).digest('hex'),
    )
  })

  test('同一内容重复出现不会二次入库', async () => {
    const { addShareSource, scanShareSource, listShareCandidates } = await import('./cslab-share-watcher')

    const content = 'x,y\n10,20\n20,40\n'
    const shareDir = makeShareDir('idempotent')
    const firstPath = join(shareDir, 'idempotent_a.csv')
    const secondPath = join(shareDir, 'idempotent_b.csv')
    writeFileSync(firstPath, content, 'utf-8')
    writeFileSync(secondPath, content, 'utf-8')

    const source = addShareSource({
      labId: lab.id,
      label: '幂等验证',
      rootPath: shareDir,
      quietSeconds: 1,
      pollSeconds: 1,
    })

    await scanShareSource(lab.id, source.id)
    await sleep(1150)
    await scanShareSource(lab.id, source.id)

    const candidates = listShareCandidates(lab.id, source.id).filter((item) =>
      item.relPath.startsWith('idempotent_'),
    )
    const published = candidates.filter((item) => item.state === 'published')
    expect(published.length).toBeGreaterThanOrEqual(1)
    // 两个候选最终指向同一资产 URI（第二个复用既有 SHA）。
    const uris = new Set(published.map((item) => item.assetUri))
    expect(uris.size).toBe(1)
  })
})

describe('监听生命周期', () => {
  test('启动 / 停止不留下计时器句柄', async () => {
    const { addShareSource, startShareWatcher, stopShareWatcher, isShareWatching } = await import(
      './cslab-share-watcher'
    )
    const shareDir = makeShareDir('lifecycle')
    const source = addShareSource({
      labId: lab.id,
      label: '生命周期',
      rootPath: shareDir,
      quietSeconds: 2,
      pollSeconds: 2,
    })

    const started = await startShareWatcher(lab.id, source.id)
    expect(started.watching).toBe(true)
    expect(isShareWatching(lab.id, source.id)).toBe(true)

    const stopped = await stopShareWatcher(lab.id, source.id)
    expect(stopped.watching).toBe(false)
    expect(isShareWatching(lab.id, source.id)).toBe(false)
  })

  test('租约链路不可用/受限时自动降级且不抛未捕获异常', async () => {
    const { addShareSource, scanShareSource, listShareCandidates } = await import(
      './cslab-share-watcher'
    )
    const shareDir = makeShareDir('lease-fallback')
    writeFileSync(join(shareDir, 'fallback.csv'), 'x,y\n1,2\n3,4\n', 'utf-8')

    // 允许真实走 Windows 租赁链路；若被策略拦截，实现必须降级而不是中断。
    delete process.env.CSLAB_SHARE_FORCE_NODE_STREAM
    try {
      const source = addShareSource({
        labId: lab.id,
        label: '租约降级',
        rootPath: shareDir,
        quietSeconds: 1,
        pollSeconds: 1,
      })
      await scanShareSource(lab.id, source.id)
      await sleep(1150)
      const result = await scanShareSource(lab.id, source.id)
      expect(result.ok).toBe(true)

      const published = listShareCandidates(lab.id, source.id).find(
        (item) => item.relPath === 'fallback.csv',
      )
      expect(published?.state).toBe('published')
      expect(['protected-lease', 'inline-command-lease', 'node-stream-stability']).toContain(
        published!.leaseType,
      )
    } finally {
      process.env.CSLAB_SHARE_FORCE_NODE_STREAM = FORCE_NODE
    }
  }, 30_000)
})
