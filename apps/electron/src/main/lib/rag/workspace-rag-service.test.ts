/**
 * 工作区静默 RAG 供给服务单测
 *
 * 验证：从 `.context/artifacts/*.index.json` 构建内存切片索引、BM25 检索精准度，
 * 以及 `<document_evidence>` 组装是否携带真实物理锚点。
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { MaterializedDocumentIndex } from '../document-parse-tools'
import {
  buildDocumentEvidenceForMessage,
  hasWorkspaceDocuments,
  invalidateWorkspaceRag,
  searchWorkspaceRag,
} from './workspace-rag-service'

let root: string

function writeIndex(index: MaterializedDocumentIndex): void {
  const artifactsDir = join(root, '.context', 'artifacts')
  mkdirSync(artifactsDir, { recursive: true })
  writeFileSync(join(artifactsDir, `${index.artifactId}.index.json`), JSON.stringify(index, null, 2))
}

const rosterIndex: MaterializedDocumentIndex = {
  fileId: 'f3',
  artifactId: 'roster',
  sourcePath: 'C:/docs/2025级工管、环科专业-大二学年花名册.xlsx',
  sourceName: '2025级工管、环科专业-大二学年花名册.xlsx',
  revision: 'sha256:test',
  format: 'xlsx',
  pageCount: 3,
  totalChars: 120,
  cleanMarkdownPath: 'C:/docs/roster.md',
  anchoredMarkdownPath: 'C:/docs/.context/artifacts/roster.anchored.md',
  outline: [],
  pages: [
    {
      pageNumber: 3,
      columnCount: 1,
      blockCount: 22,
      charCount: 120,
      firstBlockId: 'f3:p3-b1',
      lastBlockId: 'f3:p3-b22',
      isFigureHeavy: false,
      headings: ['工管2班'],
      anchoredText: '',
      cleanText:
        '| 学号 | 姓名 | 性别 | 班级 |\n| --- | --- | --- | --- |\n' +
        '| 202519110211 | 马晨超 | 男 | 工程管理2025-02班 |\n' +
        '| 202519110212 | 李思远 | 女 | 工程管理2025-02班 |',
    },
  ],
  blocks: {
    'p3-b1': {
      blockId: 'p3-b1',
      scopedId: 'f3:p3-b1',
      pageNumber: 3,
      bbox: [0, 0, 1, 1],
      loc: '工管2班·A1:B22',
      sheetName: '工管2班',
      cellRef: 'A1:B22',
    },
  },
}

const dormIndex: MaterializedDocumentIndex = {
  fileId: 'f2',
  artifactId: 'dorm',
  sourcePath: 'C:/docs/寝室长任职证明.docx',
  sourceName: '寝室长任职证明.docx',
  revision: 'sha256:dorm',
  format: 'docx',
  pageCount: 2,
  totalChars: 80,
  cleanMarkdownPath: 'C:/docs/dorm.md',
  anchoredMarkdownPath: 'C:/docs/.context/artifacts/dorm.anchored.md',
  outline: [],
  pages: [
    {
      pageNumber: 1,
      columnCount: 1,
      blockCount: 3,
      charCount: 40,
      firstBlockId: 'f2:p1-b1',
      lastBlockId: 'f2:p1-b3',
      isFigureHeavy: false,
      headings: ['任职名单'],
      anchoredText: '',
      cleanText: '寝室长任职名单：寝室长 202519110211 马晨超',
    },
    {
      pageNumber: 2,
      columnCount: 1,
      blockCount: 2,
      charCount: 30,
      firstBlockId: 'f2:p2-b1',
      lastBlockId: 'f2:p2-b2',
      isFigureHeavy: false,
      headings: [],
      anchoredText: '',
      cleanText: '普通组员 202519110212 李思远',
    },
  ],
  blocks: {
    'p1-b1': { blockId: 'p1-b1', scopedId: 'f2:p1-b1', pageNumber: 1, bbox: [0, 0, 1, 1], loc: '第1页' },
    'p2-b1': { blockId: 'p2-b1', scopedId: 'f2:p2-b1', pageNumber: 2, bbox: [0, 0, 1, 1], loc: '第2页' },
  },
}

describe('工作区静默 RAG 供给服务', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'profer-rag-'))
    invalidateWorkspaceRag()
  })

  afterEach(() => {
    invalidateWorkspaceRag()
    rmSync(root, { recursive: true, force: true })
  })

  test('无落盘产物时判定为不可用且不注入证据', () => {
    expect(hasWorkspaceDocuments(root)).toBe(false)
    expect(buildDocumentEvidenceForMessage(root, '马晨超在哪')).toBe('')
  })

  test('Given 花名册已落盘 When 检索姓名 Then 命中带真实锚点的切片', () => {
    writeIndex(rosterIndex)
    expect(hasWorkspaceDocuments(root)).toBe(true)

    const hits = searchWorkspaceRag(root, '马晨超同学在哪个位置')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.chunk.fileId).toBe('f3')
    expect(hits[0]!.chunk.anchorId).toBe('f3:p3-b1')
    expect(hits[0]!.chunk.locLabel).toContain('工管2班')
    expect(hits[0]!.chunk.sheetName).toBe('工管2班')

    const block = buildDocumentEvidenceForMessage(root, '马晨超同学在哪个位置')
    expect(block).toContain('<document_evidence>')
    expect(block).toContain('马晨超')
    expect(block).toContain('#f3:p3-b1')
    expect(block).toContain('</document_evidence>')
  })

  test('Given 花名册已落盘 When 提问与文档无关 Then 不注入任何证据', () => {
    writeIndex(rosterIndex)
    expect(buildDocumentEvidenceForMessage(root, 'zzzz-完全无关的检索词-9999')).toBe('')
  })

  test('Given 索引文件更新 When 再次检索 Then 缓存按指纹自动失效', () => {
    writeIndex(rosterIndex)
    expect(searchWorkspaceRag(root, '马晨超').length).toBeGreaterThan(0)

    const updated: MaterializedDocumentIndex = {
      ...rosterIndex,
      pages: [{ ...rosterIndex.pages[0]!, cleanText: '| 学号 | 姓名 |\n| --- | --- |\n| 202519110299 | 赵一鸣 |' }],
    }
    writeIndex(updated)
    const hits = searchWorkspaceRag(root, '赵一鸣')
    expect(hits.length).toBeGreaterThan(0)
  })

  test('Given 花名册与任职名单分属两份文档 When 多维筛选提问 Then 注入跨文档联合证据', () => {
    writeIndex(rosterIndex)
    writeIndex(dormIndex)

    const block = buildDocumentEvidenceForMessage(root, '工管2班宿舍寝室长在表格中的位置')
    expect(block).toContain('<document_evidence>')
    expect(block).toContain('Cross-document entity linkage')
    expect(block).toContain('花名册')
    expect(block).toContain('寝室长任职证明')
  })
})
