/**
 * Zotero 增量同步与批注仿射投影测试
 *
 * 使用合成 zotero.sqlite，覆盖：
 * - 递归 CTE 分类路径与 EAV 元数据；
 * - storage 附件路径重建；
 * - 高水位增量与删除标记；
 * - 0/90/180/270 四向批注坐标。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CsLabLab } from '@profer/shared'

let rootDir = ''
let zoteroDir = ''
let lab: CsLabLab

const PAGE = { width: 200, height: 300 }
const RECT: [number, number, number, number] = [10, 20, 110, 40]

function createZoteroDatabase(dbPath: string): void {
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => {
      exec(sql: string): void
      prepare(sql: string): { run(...params: unknown[]): void }
      close(): void
    }
  }
  const db = new DatabaseSync(dbPath)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE itemTypes (itemTypeID INTEGER PRIMARY KEY, typeName TEXT NOT NULL);
    CREATE TABLE items (
      itemID INTEGER PRIMARY KEY, itemTypeID INTEGER NOT NULL, key TEXT NOT NULL,
      dateAdded TEXT, dateModified TEXT, version INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE fields (fieldID INTEGER PRIMARY KEY, fieldName TEXT NOT NULL);
    CREATE TABLE itemData (itemID INTEGER NOT NULL, fieldID INTEGER NOT NULL, valueID INTEGER NOT NULL);
    CREATE TABLE itemDataValues (valueID INTEGER PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE creators (creatorID INTEGER PRIMARY KEY, firstName TEXT, lastName TEXT);
    CREATE TABLE itemCreators (
      itemID INTEGER NOT NULL, creatorID INTEGER NOT NULL,
      creatorTypeID INTEGER NOT NULL DEFAULT 1, orderIndex INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE collections (
      collectionID INTEGER PRIMARY KEY, collectionName TEXT NOT NULL,
      parentCollectionID INTEGER, key TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE collectionItems (collectionID INTEGER NOT NULL, itemID INTEGER NOT NULL);
    CREATE TABLE itemAttachments (
      itemID INTEGER PRIMARY KEY, parentItemID INTEGER, linkMode INTEGER,
      contentType TEXT, path TEXT
    );
    CREATE TABLE annotations (
      itemID INTEGER PRIMARY KEY, parentItemID INTEGER, type INTEGER,
      authorName TEXT, text TEXT, comment TEXT, color TEXT, pageLabel TEXT,
      sortIndex TEXT, position TEXT, isExternal INTEGER
    );

    INSERT INTO itemTypes VALUES (1, 'journalArticle'), (2, 'attachment'), (3, 'annotation');
    INSERT INTO fields VALUES (1, 'title'), (2, 'DOI'), (3, 'date'), (4, 'publicationTitle'), (5, 'abstractNote');
    INSERT INTO itemDataValues VALUES
      (1, 'Solid State Battery Interfaces'),
      (2, '10.1000/cslab.2024.001'),
      (3, '2024-03-01'),
      (4, 'Journal of Energy Materials'),
      (5, 'Interfacial impedance study.');

    INSERT INTO items (itemID, itemTypeID, key, dateModified, version, deleted) VALUES
      (1, 1, 'ABC123', '2024-03-01', 10, 0),
      (2, 2, 'ATT999', '2024-03-01', 10, 0),
      (3, 3, 'ANNO1', '2024-03-02', 11, 0);

    INSERT INTO itemData VALUES (1, 1, 1), (1, 2, 2), (1, 3, 3), (1, 4, 4), (1, 5, 5);
    INSERT INTO creators VALUES (1, 'Ada', 'Lovelace');
    INSERT INTO itemCreators VALUES (1, 1, 1, 0);

    INSERT INTO collections VALUES (100, 'Research', NULL, 'C1', 1), (101, 'Battery', 100, 'C2', 1);
    INSERT INTO collectionItems VALUES (101, 1);

    INSERT INTO itemAttachments VALUES (2, 1, 0, 'application/pdf', 'storage:paper.pdf');

    INSERT INTO annotations VALUES (
      3, 2, 1, 'Ada', 'SEI layer', 'Important', '#ffd400', '1',
      '00001|000010|00020',
      '{"pageIndex":0,"rects":[[10,20,110,40]],"rotation":90}',
      0
    );
  `)
  db.close()
}

beforeAll(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'cslab-zotero-'))
  zoteroDir = join(rootDir, 'ZoteroData')
  mkdirSync(join(zoteroDir, 'storage', 'ATT999'), { recursive: true })
  writeFileSync(join(zoteroDir, 'storage', 'ATT999', 'paper.pdf'), '%PDF-1.4\n%Cslab test\n')
  createZoteroDatabase(join(zoteroDir, 'zotero.sqlite'))

  process.env.PROFER_CONFIG_DIR = rootDir
  const { createLab } = await import('./cslab-manager')
  lab = createLab({ name: 'Zotero 同步测试实验室' })
})

afterAll(async () => {
  const { closeAllCsLabDatabases } = await import('./cslab-db')
  const { __resetZoteroWatchersForTest } = await import('./cslab-zotero')
  await __resetZoteroWatchersForTest()
  closeAllCsLabDatabases()
  try {
    rmSync(rootDir, { recursive: true, force: true })
  } catch {
    // Windows 句柄延迟释放时交给系统回收。
  }
})

describe('Zotero 增量同步', () => {
  test('首次同步：分类路径、EAV 元数据与附件路径', async () => {
    const { syncZoteroLibrary, listZoteroLiterature } = await import('./cslab-zotero')
    const result = await syncZoteroLibrary(lab.id, { dataDir: zoteroDir })

    expect(result.ok).toBe(true)
    expect(result.added).toBe(1)
    expect(result.annotationCount).toBe(1)
    expect(result.collectionCount).toBe(2)

    const literature = listZoteroLiterature(lab.id)
    expect(literature).toHaveLength(1)
    expect(literature[0]?.title).toBe('Solid State Battery Interfaces')
    expect(literature[0]?.authors).toEqual(['Ada Lovelace'])
    expect(literature[0]?.doi).toBe('10.1000/cslab.2024.001')
    expect(literature[0]?.collections).toEqual(['Research > Battery'])
    expect(literature[0]?.source).toBe('zotero')
    expect(literature[0]?.hasFile).toBe(true)
    expect(literature[0]?.annotationCount).toBe(1)
  })

  test('批注解析：类型、颜色与文本', async () => {
    const { listLiteratureZoteroAnnotations } = await import('./cslab-zotero')
    const { listZoteroLiterature } = await import('./cslab-zotero')
    const uri = listZoteroLiterature(lab.id)[0]!.uri
    const annotations = listLiteratureZoteroAnnotations(lab.id, uri)
    expect(annotations).toHaveLength(1)
    expect(annotations[0]?.type).toBe('highlight')
    expect(annotations[0]?.color).toBe('#ffd400')
    expect(annotations[0]?.text).toBe('SEI layer')
    expect(annotations[0]?.position.rotation).toBe(90)
  })

  test('高水位游标：无变化时增量同步为空', async () => {
    const { syncZoteroLibrary } = await import('./cslab-zotero')
    const result = await syncZoteroLibrary(lab.id, { dataDir: zoteroDir })
    expect(result.ok).toBe(true)
    expect(result.added).toBe(0)
    expect(result.updated).toBe(0)
    expect(result.removed).toBe(0)
  })

  test('删除条目：增量标记为 unsupported，不物理删除文献', async () => {
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void
        close(): void
      }
    }
    const db = new DatabaseSync(join(zoteroDir, 'zotero.sqlite'))
    db.exec("UPDATE items SET deleted = 1, version = 20 WHERE key = 'ABC123'")
    db.close()

    const { syncZoteroLibrary } = await import('./cslab-zotero')
    const result = await syncZoteroLibrary(lab.id, { dataDir: zoteroDir })
    expect(result.ok).toBe(true)
    expect(result.removed).toBe(1)

    const { listAssets } = await import('./cslab-iron-cage')
    const asset = listAssets(lab.id).find((item) => item.layerType === 'lit')
    expect(asset?.unsupported).toBe('Zotero 中已删除')
  })

  test('无本地 PDF 的条目仍登记元数据，中文作者姓前名后', async () => {
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void
        close(): void
      }
    }
    const db = new DatabaseSync(join(zoteroDir, 'zotero.sqlite'))
    db.exec(`
      INSERT INTO items (itemID, itemTypeID, key, dateModified, version, deleted)
        VALUES (4, 1, 'META01', '2024-03-03', 21, 0);
      INSERT INTO itemDataValues VALUES
        (6, '固态电池界面综述'),
        (7, '10.1000/cslab.2024.002');
      INSERT INTO itemData VALUES (4, 1, 6), (4, 2, 7);
      INSERT INTO creators VALUES (2, '三', '张');
      INSERT INTO itemCreators VALUES (4, 2, 1, 0);
    `)
    db.close()

    const { syncZoteroLibrary, listZoteroLiterature } = await import('./cslab-zotero')
    const result = await syncZoteroLibrary(lab.id, { dataDir: zoteroDir })
    expect(result.ok).toBe(true)
    expect(result.added).toBe(1)

    const item = listZoteroLiterature(lab.id).find((entry) => entry.title === '固态电池界面综述')
    expect(item).toBeTruthy()
    expect(item?.hasFile).toBe(false)
    expect(item?.authors).toEqual(['张三'])
    expect(item?.doi).toBe('10.1000/cslab.2024.002')
  })
})

describe('Zotero 批注四向仿射投影', () => {
  test('0°：Y 轴翻转', async () => {
    const { zoteroRectToViewport } = await import('./cslab-zotero-format')
    expect(zoteroRectToViewport(RECT, PAGE, 2, 0)).toEqual({
      left: 20,
      top: 520,
      width: 200,
      height: 40,
    })
  })

  test('90°：宽高互换', async () => {
    const { zoteroRectToViewport } = await import('./cslab-zotero-format')
    expect(zoteroRectToViewport(RECT, PAGE, 2, 90)).toEqual({
      left: 40,
      top: 20,
      width: 40,
      height: 200,
    })
  })

  test('180°：XY 双翻转', async () => {
    const { zoteroRectToViewport } = await import('./cslab-zotero-format')
    expect(zoteroRectToViewport(RECT, PAGE, 2, 180)).toEqual({
      left: 180,
      top: 40,
      width: 200,
      height: 40,
    })
  })

  test('270°：宽高互换', async () => {
    const { zoteroRectToViewport } = await import('./cslab-zotero-format')
    expect(zoteroRectToViewport(RECT, PAGE, 2, 270)).toEqual({
      left: 520,
      top: 180,
      width: 40,
      height: 200,
    })
  })

  test('无法解析的 position 返回 null', async () => {
    const { parseZoteroAnnotationPosition } = await import('./cslab-zotero-format')
    expect(parseZoteroAnnotationPosition('not-json')).toBeNull()
    expect(parseZoteroAnnotationPosition('{"pageIndex":0}')?.rects).toEqual([])
  })
})
