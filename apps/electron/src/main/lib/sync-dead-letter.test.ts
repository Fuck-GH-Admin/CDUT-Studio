/**
 * 同步死信队列文件读写测试：写入 → 读取 → 原子重写 / 清空
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SyncEnvelope } from './sync-types'
import { getDeadLetterCount, readDeadLetters, rewriteDeadLetters, writeDeadLetterEnvelopes } from './sync-dead-letter'

let testDir: string | undefined
let previousConfigRoot: string | undefined

function makeEnvelope(id: string, retryCount = 6): SyncEnvelope {
  return {
    id,
    workspaceId: 'ws-1',
    entityType: 'workspace',
    entityId: 'ws-1',
    operation: 'update',
    payload: { name: id },
    occurredAt: 1_700_000_000_000,
    retryCount,
  }
}

beforeAll(() => {
  previousConfigRoot = process.env.PROFER_CONFIG_DIR
  testDir = mkdtempSync(join(tmpdir(), 'profer-sync-dead-letter-'))
  process.env.PROFER_CONFIG_DIR = testDir
})

beforeEach(() => {
  rewriteDeadLetters([])
})

afterAll(() => {
  if (previousConfigRoot === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = previousConfigRoot
  if (testDir) rmSync(testDir, { recursive: true, force: true })
})

describe('sync-dead-letter', () => {
  test('空队列时读取为空且计数为 0', () => {
    expect(readDeadLetters()).toEqual([])
    expect(getDeadLetterCount()).toBe(0)
  })

  test('写入后可读取全部死信并计入条数', () => {
    writeDeadLetterEnvelopes([makeEnvelope('a'), makeEnvelope('b')])

    const read = readDeadLetters()
    expect(read.map((env) => env.id)).toEqual(['a', 'b'])
    expect(read[0]?.retryCount).toBe(6)
    expect(getDeadLetterCount()).toBe(2)
  })

  test('rewriteDeadLetters 覆盖为指定内容', () => {
    writeDeadLetterEnvelopes([makeEnvelope('a'), makeEnvelope('b')])

    rewriteDeadLetters([makeEnvelope('c', 0)])

    const read = readDeadLetters()
    expect(read.map((env) => env.id)).toEqual(['c'])
    expect(read[0]?.retryCount).toBe(0)
    expect(getDeadLetterCount()).toBe(1)
  })

  test('rewriteDeadLetters 传空数组时清空文件', () => {
    writeDeadLetterEnvelopes([makeEnvelope('a')])

    rewriteDeadLetters([])

    expect(readDeadLetters()).toEqual([])
    expect(getDeadLetterCount()).toBe(0)
  })
})
