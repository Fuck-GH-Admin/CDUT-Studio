/**
 * CSLab SQLite 适配层测试
 *
 * 审计要求：先验证 WAL、显式事务提交/回滚与并发基础行为，再接业务逻辑。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let rootDir = ''

beforeAll(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'cslab-db-'))
  process.env.PROFER_CONFIG_DIR = rootDir
})

afterAll(async () => {
  const { closeAllCsLabDatabases } = await import('./cslab-db')
  closeAllCsLabDatabases()
  try {
    rmSync(rootDir, { recursive: true, force: true })
  } catch {
    // Bun 的 node:sqlite 在 Windows 上可能延迟释放文件句柄，临时目录交给系统回收。
  }
})

describe('CSLab SQLite 适配层', () => {
  test('打开数据库即启用 WAL 与 busy_timeout', async () => {
    const { getCsLabDatabase } = await import('./cslab-db')
    const db = getCsLabDatabase(join(rootDir, 'central_meta.sqlite'))
    const journal = db.raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
    const busy = db.raw.prepare('PRAGMA busy_timeout').get() as { timeout: number }
    expect(String(journal.journal_mode).toLowerCase()).toBe('wal')
    expect(Number(busy.timeout)).toBeGreaterThan(0)
  })

  test('显式事务提交后可读，回滚后不残留', async () => {
    const { getCsLabDatabase, getEntityByUri, upsertEntity, withTransaction } = await import(
      './cslab-db'
    )
    const db = getCsLabDatabase(join(rootDir, 'central_meta.sqlite'))
    const now = Date.now()

    withTransaction(db, () => {
      upsertEntity(db, {
        uri: 'cdut://lab-test/raw/raw-1',
        labId: 'lab-test',
        layerType: 'raw',
        entityUuid: 'raw-1',
        title: 'committed.csv',
        revision: 1,
        locked: true,
        createdAt: now,
        updatedAt: now,
      })
    })
    expect(getEntityByUri(db, 'cdut://lab-test/raw/raw-1')?.title).toBe('committed.csv')

    expect(() =>
      withTransaction(db, () => {
        upsertEntity(db, {
          uri: 'cdut://lab-test/raw/raw-2',
          labId: 'lab-test',
          layerType: 'raw',
          entityUuid: 'raw-2',
          title: 'rolled-back.csv',
          revision: 1,
          locked: true,
          createdAt: now,
          updatedAt: now,
        })
        throw new Error('模拟事务中断')
      }),
    ).toThrow('模拟事务中断')

    expect(getEntityByUri(db, 'cdut://lab-test/raw/raw-2')).toBeNull()
  })

  test('实验室级 revision 单调递增', async () => {
    const { getCsLabDatabase, nextLabRevision } = await import('./cslab-db')
    const db = getCsLabDatabase(join(rootDir, 'central_meta.sqlite'))
    const first = nextLabRevision(db)
    const second = nextLabRevision(db)
    expect(second).toBe(first + 1)
  })
})
