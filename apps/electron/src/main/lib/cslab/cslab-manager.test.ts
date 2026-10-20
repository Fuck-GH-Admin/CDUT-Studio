/**
 * CSLab 实验室沙箱管理器测试
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, parse } from 'node:path'

let rootDir = ''

beforeAll(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'cslab-manager-'))
  process.env.PROFER_CONFIG_DIR = rootDir
})

afterAll(async () => {
  const { closeAllCsLabDatabases } = await import('./cslab-db')
  closeAllCsLabDatabases()
  try {
    rmSync(rootDir, { recursive: true, force: true })
  } catch {
    // Windows 下 SQLite 句柄可能延迟释放，临时目录交给系统回收。
  }
})

describe('实验室沙箱', () => {
  test('创建实验室会生成完整目录骨架与 SQLite 元数据库', async () => {
    const { createLab, listLabs, openLab } = await import('./cslab-manager')

    const lab = createLab({
      name: '固态电池界面测试',
      description: '界面阻抗与循环稳定性',
      tags: ['电化学', '界面'],
    })

    expect(lab.id).toMatch(/^[a-z0-9-]+$/)
    expect(lab.status).toBe('运行中')

    for (const dir of ['db', 'vault/lit', 'vault/notes', 'vault/raw', 'vault/tables', 'vault/figures', 'vault/manuscripts', 'runtime/tools', 'runtime/logs']) {
      expect(existsSync(join(lab.rootPath, dir))).toBe(true)
    }
    expect(existsSync(join(lab.rootPath, 'lab.manifest.json'))).toBe(true)
    expect(existsSync(join(lab.rootPath, 'db', 'central_meta.sqlite'))).toBe(true)

    expect(listLabs().some((item) => item.id === lab.id)).toBe(true)
    expect(openLab(lab.id).name).toBe('固态电池界面测试')
  })

  test('快照返回全部维度计数与 Python 能力说明', async () => {
    const { createLab, getLabSnapshot } = await import('./cslab-manager')
    const lab = createLab({ name: '快照测试实验室' })
    const snapshot = await getLabSnapshot(lab.id)

    expect(snapshot.lab.id).toBe(lab.id)
    expect(snapshot.counts.raw).toBe(0)
    expect(snapshot.counts.table).toBe(0)
    expect(typeof snapshot.python.available).toBe('boolean')
    expect(snapshot.python.note.length).toBeGreaterThan(0)
  })

  test('空名称与超长名称被拒绝', async () => {
    const { createLab } = await import('./cslab-manager')
    expect(() => createLab({ name: '   ' })).toThrow('实验室名称不能为空')
    expect(() => createLab({ name: 'x'.repeat(61) })).toThrow('不能超过 60')
  })
})

describe('实验室根路径安全边界', () => {
  test('主目录、盘符根与应用目录被拒止', async () => {
    const { assertSafeLabRootPath } = await import('./cslab-paths')
    expect(() => assertSafeLabRootPath(homedir())).toThrow('安全拒止')
    expect(() => assertSafeLabRootPath(parse(process.cwd()).root)).toThrow('安全拒止')
    expect(() => assertSafeLabRootPath(process.cwd())).toThrow('安全拒止')
  })

  test('默认沙箱子目录与普通自定义目录正常通过', async () => {
    const { assertSafeLabRootPath, getDefaultLabDir } = await import('./cslab-paths')
    expect(() => assertSafeLabRootPath(getDefaultLabDir('safe-lab-01'))).not.toThrow()
    expect(() => assertSafeLabRootPath(join(rootDir, 'custom-lab'))).not.toThrow()
  })

  test('createLab 拒绝把用户主目录作为根路径', async () => {
    const { createLab } = await import('./cslab-manager')
    expect(() => createLab({ name: '越权实验室', rootPath: homedir() })).toThrow('安全拒止')
  })
})
