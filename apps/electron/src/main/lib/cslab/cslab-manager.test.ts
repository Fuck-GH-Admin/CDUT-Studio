/**
 * CSLab 实验室沙箱管理器测试
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

describe('实验室生命周期操作', () => {
  test('重命名实验室并校验名称边界', async () => {
    const { createLab, getLab, renameLab } = await import('./cslab-manager')
    const lab = createLab({ name: '重命名前实验室' })

    const renamed = renameLab(lab.id, '  重命名后实验室  ')
    expect(renamed.name).toBe('重命名后实验室')
    expect(getLab(lab.id)?.name).toBe('重命名后实验室')
    expect(() => renameLab(lab.id, '   ')).toThrow('不能为空')
    expect(() => renameLab(lab.id, 'x'.repeat(61))).toThrow('不能超过 60')
  })

  test('置顶优先排序与取消置顶', async () => {
    const { createLab, listLabs, togglePinLab } = await import('./cslab-manager')
    const older = createLab({ name: '置顶排序-较旧' })
    createLab({ name: '置顶排序-较新' })

    const pinned = togglePinLab(older.id)
    expect(pinned.pinned).toBe(true)
    expect(typeof pinned.pinnedAt).toBe('number')
    expect(listLabs()[0]?.id).toBe(older.id)

    const unpinned = togglePinLab(older.id)
    expect(unpinned.pinned).toBe(false)
    expect(unpinned.pinnedAt).toBeUndefined()
  })

  test('归档记录原状态并在解除归档时恢复', async () => {
    const { createLab, toggleArchiveLab } = await import('./cslab-manager')
    const { updateLabManifest } = await import('./cslab-paths')
    const lab = createLab({ name: '归档状态测试实验室' })
    updateLabManifest(lab.id, { status: '调试中' })

    const archived = toggleArchiveLab(lab.id)
    expect(archived.archived).toBe(true)
    expect(archived.status).toBe('已归档')
    expect(archived.statusBeforeArchive).toBe('调试中')

    const restored = toggleArchiveLab(lab.id)
    expect(restored.archived).toBe(false)
    expect(restored.status).toBe('调试中')
    expect(restored.archivedAt).toBeUndefined()
  })

  test('删除实验室物理清理沙箱并解绑历史会话', async () => {
    const { createLab, deleteLab, listLabs } = await import('./cslab-manager')
    const { createAgentSession, listAgentSessions, updateAgentSessionMeta } = await import(
      '../agent-session-manager'
    )
    const lab = createLab({ name: '删除测试实验室' })
    const session = createAgentSession('删除测试会话')
    updateAgentSessionMeta(session.id, { cslabLabId: lab.id })

    expect(existsSync(lab.rootPath)).toBe(true)
    await deleteLab(lab.id)

    expect(existsSync(lab.rootPath)).toBe(false)
    expect(listLabs().some((item) => item.id === lab.id)).toBe(false)
    const bound = listAgentSessions(true).find((item) => item.id === session.id)
    expect(bound?.cslabLabId).toBeUndefined()
  })

  test('重复删除保持幂等，并能清理只读文件', async () => {
    const { createLab, deleteLab, listLabs } = await import('./cslab-manager')
    const lab = createLab({ name: '幂等删除测试实验室' })
    const readonlyFile = join(lab.rootPath, 'vault', 'notes', 'readonly.md')
    writeFileSync(readonlyFile, '# 只读笔记\n', 'utf-8')
    chmodSync(readonlyFile, 0o444)

    await deleteLab(lab.id)
    expect(existsSync(lab.rootPath)).toBe(false)

    // 二次删除：清单已不存在，清理流程仍必须正常结束。
    await expect(deleteLab(lab.id)).resolves.toEqual([])
    expect(listLabs().some((item) => item.id === lab.id)).toBe(false)
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

  test.skipIf(process.platform !== 'win32')(
    'Windows 任意盘符根目录同样被拒止（不局限于主目录所在盘符）',
    async () => {
      const { assertSafeLabRootPath } = await import('./cslab-paths')
      expect(() => assertSafeLabRootPath('D:\\')).toThrow('安全拒止')
      expect(() => assertSafeLabRootPath('E:\\')).toThrow('安全拒止')
    },
  )

  test('createLab 拒绝把用户主目录作为根路径', async () => {
    const { createLab } = await import('./cslab-manager')
    expect(() => createLab({ name: '越权实验室', rootPath: homedir() })).toThrow('安全拒止')
  })
})
