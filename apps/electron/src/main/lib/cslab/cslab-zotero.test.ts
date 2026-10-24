/**
 * Zotero 增量同步与批注仿射投影测试
 *
 * 主 fixture 严格模拟真实 Zotero 7 数据库架构（实机验证）：
 * - items 表没有 deleted 列（只有 itemID/itemTypeID/dateAdded/dateModified/
 *   clientDateModified/libraryID/key/version/synced）；
 * - 删除项记录在独立的 deletedItems(itemID, dateDeleted) 表；
 * - 批注表为 itemAnnotations（annotationText/annotationColor/annotationPosition 等列名）。
 * 另含 legacy fixture（items.deleted 列 + annotations 表）验证降级兼容。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CsLabLab } from '@profer/shared'

let rootDir = ''
let zoteroDir = ''
let legacyDir = ''
let lab: CsLabLab
let legacyLab: CsLabLab

const PAGE = { width: 200, height: 300 }
const RECT: [number, number, number, number] = [10, 20, 110, 40]

interface TestDb {
  exec(sql: string): void
  close(): void
}

function openDb(dbPath: string): TestDb {
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => TestDb
  }
  return new DatabaseSync(dbPath)
}

/** 真实 Zotero 7 架构：items 无 deleted 列，独立 deletedItems + itemAnnotations。 */
function createRealZoteroDatabase(dbPath: string): void {
  const db = openDb(dbPath)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE itemTypes (itemTypeID INTEGER PRIMARY KEY, typeName TEXT NOT NULL);
    CREATE TABLE items (
      itemID INTEGER PRIMARY KEY, itemTypeID INTEGER NOT NULL,
      dateAdded TEXT, dateModified TEXT, clientDateModified TEXT,
      libraryID INTEGER NOT NULL DEFAULT 1, key TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0, synced INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE deletedItems (itemID INTEGER PRIMARY KEY, dateDeleted TEXT NOT NULL);
    CREATE TABLE itemDataVersions (itemID INTEGER PRIMARY KEY, version INTEGER NOT NULL);
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
    CREATE TABLE itemAnnotations (
      itemID INTEGER PRIMARY KEY, parentItemID INTEGER, type INTEGER,
      authorName TEXT, lastModifiedByUserID INTEGER, isAuthorCurrent INTEGER,
      dateModified TEXT, lastSyncedModificationTime TEXT,
      version INTEGER NOT NULL DEFAULT 0,
      annotationType INTEGER, annotationText TEXT, annotationComment TEXT,
      annotationColor TEXT, annotationPageID INTEGER, annotationSortIndex TEXT,
      annotationPosition TEXT
    );

    INSERT INTO itemTypes VALUES (1, 'journalArticle'), (2, 'attachment'), (3, 'annotation');
    INSERT INTO fields VALUES (1, 'title'), (2, 'DOI'), (3, 'date'), (4, 'publicationTitle'), (5, 'abstractNote');
    INSERT INTO itemDataValues VALUES
      (1, 'Solid State Battery Interfaces'),
      (2, '10.1000/cslab.2024.001'),
      (3, '2024-03-01'),
      (4, 'Journal of Energy Materials'),
      (5, 'Interfacial impedance study.');

    INSERT INTO items (itemID, itemTypeID, key, dateAdded, dateModified, clientDateModified, libraryID, version, synced) VALUES
      (1, 1, 'ABC123', '2024-03-01', '2024-03-01', '2024-03-01', 1, 10, 1),
      (2, 2, 'ATT999', '2024-03-01', '2024-03-01', '2024-03-01', 1, 10, 1),
      (3, 3, 'ANNO1', '2024-03-02', '2024-03-02', '2024-03-02', 1, 11, 1);

    INSERT INTO itemData VALUES (1, 1, 1), (1, 2, 2), (1, 3, 3), (1, 4, 4), (1, 5, 5);
    INSERT INTO creators VALUES (1, 'Ada', 'Lovelace');
    INSERT INTO itemCreators VALUES (1, 1, 1, 0);

    INSERT INTO collections VALUES (100, 'Research', NULL, 'C1', 1), (101, 'Battery', 100, 'C2', 1);
    INSERT INTO collectionItems VALUES (101, 1);

    INSERT INTO itemAttachments VALUES (2, 1, 0, 'application/pdf', 'storage:paper.pdf');

    INSERT INTO itemAnnotations (
      itemID, parentItemID, type, authorName, isAuthorCurrent,
      dateModified, version, annotationType, annotationText, annotationComment,
      annotationColor, annotationPageID, annotationSortIndex, annotationPosition
    ) VALUES (
      3, 2, 1, 'Ada', 1,
      '2024-03-02T10:00:00Z', 11, 1, 'SEI layer', 'Important',
      '#ffd400', 0, '00001|000010|00020',
      '{"pageIndex":0,"rects":[[10,20,110,40]],"rotation":90}'
    );
  `)
  db.close()
}

/** 旧 mock 架构（items.deleted 列 + annotations 表），验证降级兼容路径。 */
function createLegacyZoteroDatabase(dbPath: string): void {
  const db = openDb(dbPath)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE itemTypes (itemTypeID INTEGER PRIMARY KEY, typeName TEXT NOT NULL);
    CREATE TABLE items (
      itemID INTEGER PRIMARY KEY, itemTypeID INTEGER NOT NULL, key TEXT NOT NULL,
      dateModified TEXT, version INTEGER NOT NULL DEFAULT 0,
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

    INSERT INTO itemTypes VALUES (1, 'journalArticle'), (2, 'attachment');
    INSERT INTO fields VALUES (1, 'title');
    INSERT INTO itemDataValues VALUES (1, 'Legacy Schema Paper');
    INSERT INTO items (itemID, itemTypeID, key, dateModified, version, deleted) VALUES
      (1, 1, 'LEG001', '2024-01-01', 5, 0),
      (2, 2, 'LEGATT', '2024-01-01', 5, 0);
    INSERT INTO itemData VALUES (1, 1, 1);
    INSERT INTO itemAttachments VALUES (2, 1, 0, 'application/pdf', 'storage:legacy.pdf');
  `)
  db.close()
}

beforeAll(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'cslab-zotero-'))
  zoteroDir = join(rootDir, 'ZoteroData')
  legacyDir = join(rootDir, 'ZoteroLegacy')
  mkdirSync(join(zoteroDir, 'storage', 'ATT999'), { recursive: true })
  writeFileSync(join(zoteroDir, 'storage', 'ATT999', 'paper.pdf'), '%PDF-1.4\n%Cslab test\n')
  mkdirSync(join(legacyDir, 'storage', 'LEGATT'), { recursive: true })
  writeFileSync(join(legacyDir, 'storage', 'LEGATT', 'legacy.pdf'), '%PDF-1.4\n%legacy\n')
  createRealZoteroDatabase(join(zoteroDir, 'zotero.sqlite'))
  createLegacyZoteroDatabase(join(legacyDir, 'zotero.sqlite'))

  process.env.PROFER_CONFIG_DIR = rootDir
  const { createLab } = await import('./cslab-manager')
  lab = createLab({ name: 'Zotero 同步测试实验室' })
  legacyLab = createLab({ name: 'Zotero 旧架构兼容实验室' })
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

describe('Zotero 7 真实架构增量同步', () => {
  test('首次同步：无 i.deleted 崩溃，EAV 元数据、附件与 deletedItems 判定正确', async () => {
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

  test('批注解析：itemAnnotations 列名、类型数值映射与 ISO 时间', async () => {
    const { listLiteratureZoteroAnnotations, listZoteroLiterature } = await import('./cslab-zotero')
    const uri = listZoteroLiterature(lab.id)[0]!.uri
    const annotations = listLiteratureZoteroAnnotations(lab.id, uri)
    expect(annotations).toHaveLength(1)
    expect(annotations[0]?.type).toBe('highlight')
    expect(annotations[0]?.color).toBe('#ffd400')
    expect(annotations[0]?.text).toBe('SEI layer')
    expect(annotations[0]?.position.rotation).toBe(90)
    // dateModified（ISO 字符串）应被归一化为毫秒时间戳。
    expect(typeof annotations[0]?.modifiedAt).toBe('number')
  })

  test('高水位游标：无变化时增量同步为空', async () => {
    const { syncZoteroLibrary } = await import('./cslab-zotero')
    const result = await syncZoteroLibrary(lab.id, { dataDir: zoteroDir })
    expect(result.ok).toBe(true)
    expect(result.added).toBe(0)
    expect(result.updated).toBe(0)
    expect(result.removed).toBe(0)
  })

  test('删除条目：deletedItems 表驱动增量，标记 unsupported 不物理删除', async () => {
    const db = openDb(join(zoteroDir, 'zotero.sqlite'))
    db.exec(`
      UPDATE items SET version = 20 WHERE key = 'ABC123';
      INSERT INTO deletedItems (itemID, dateDeleted) VALUES (1, '2024-03-05T00:00:00Z');
    `)
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
    const db = openDb(join(zoteroDir, 'zotero.sqlite'))
    db.exec(`
      INSERT INTO items (itemID, itemTypeID, key, dateAdded, dateModified, clientDateModified, libraryID, version, synced)
        VALUES (4, 1, 'META01', '2024-03-03', '2024-03-03', '2024-03-03', 1, 21, 0);
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

  test('强制全量重建：游标归零重放，物理删除后的条目可被回收标记', async () => {
    const { syncZoteroLibrary } = await import('./cslab-zotero')
    const result = await syncZoteroLibrary(lab.id, { dataDir: zoteroDir, forceFull: true })
    // ABC123 已在 deletedItems 中，全量重放后仍保持删除态（不复活）。
    expect(result.ok).toBe(true)
    expect(result.added).toBe(0)

    const { listAssets } = await import('./cslab-iron-cage')
    const asset = listAssets(lab.id).find(
      (item) => item.layerType === 'lit' && item.title === 'Solid State Battery Interfaces',
    )
    expect(asset?.unsupported).toBe('Zotero 中已删除')
  })
})

describe('Legacy mock 架构降级兼容（items.deleted + annotations）', () => {
  test('deleted 列与 annotations 表路径仍然可用', async () => {
    const { syncZoteroLibrary, listZoteroLiterature } = await import('./cslab-zotero')
    const result = await syncZoteroLibrary(legacyLab.id, { dataDir: legacyDir })
    expect(result.ok).toBe(true)
    expect(result.added).toBe(1)

    const literature = listZoteroLiterature(legacyLab.id)
    expect(literature).toHaveLength(1)
    expect(literature[0]?.title).toBe('Legacy Schema Paper')
  })

  test('legacy 删除路径：items.deleted = 1 进入删除增量', async () => {
    const db = openDb(join(legacyDir, 'zotero.sqlite'))
    db.exec("UPDATE items SET deleted = 1, version = 9 WHERE key = 'LEG001'")
    db.close()

    const { syncZoteroLibrary } = await import('./cslab-zotero')
    const result = await syncZoteroLibrary(legacyLab.id, { dataDir: legacyDir })
    expect(result.ok).toBe(true)
    expect(result.removed).toBe(1)

    const { listAssets } = await import('./cslab-iron-cage')
    const asset = listAssets(legacyLab.id).find((item) => item.layerType === 'lit')
    expect(asset?.unsupported).toBe('Zotero 中已删除')
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
