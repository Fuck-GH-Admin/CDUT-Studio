/** T09 桥接：签发 → 预览 → 导入（附件先登记原件）+ actionId 幂等。 */
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const configDir = mkdtempSync(join(tmpdir(), 't09-'))
process.env.PROFER_CONFIG_DIR = configDir
afterAll(() => rmSync(configDir, { recursive: true, force: true }))

const { issueT09StudentPackage, previewT09Package, importT09Package, t09AssetTempRoot, pruneT09AssetTempRoot } =
  await import('./review-v3-t09-main-service')
const { answerT09Task, packT09Asset } = await import('./review-v3-t09-offline-codec')

const caseId = 'case-t09-unit'
function aggregate(revision = 3, supplementStatus = 'open') {
  return {
    caseV2: {
      id: caseId, revision, templateId: 'tpl', templateVersion: 1, title: 'T09 案卷',
      caseFields: {}, documents: [], subjects: [], stage: 'awaiting-supplement',
    },
    supplements: [{ id: 'sup-1', status: supplementStatus, reason: '缺材料',
      requiredElements: ['补充证明'], responsibleRole: 'student', responses: [] }],
    decisions: [], observations: [], evidenceLinks: [], tasks: [], receiptLog: [],
  } as never
}

describe('T09 离线包桥接', () => {
  test('签发 → 应答 → 预览 ready', () => {
    const issued = issueT09StudentPackage({ aggregate: aggregate(), supplementId: 'sup-1', recipientId: 'local-student' })
    expect(issued.packageId).toBeTruthy()

    const task = JSON.parse(issued.json)
    const reply = answerT09Task(task, {
      kind: 'student-reply', supplementId: 'sup-1', note: '已补交',
      assets: [packT09Asset({ name: 'a.txt', mimeType: 'text/plain', bytes: Buffer.from('补交材料') })],
    })

    const { preview } = previewT09Package({ aggregate: aggregate(), packageJson: JSON.stringify(reply) })
    expect(preview.status).toBe('ready')
  })

  test('导入时附件先登记为原件，再答复补件', async () => {
    const issued = issueT09StudentPackage({ aggregate: aggregate(), supplementId: 'sup-1', recipientId: 'local-student' })
    const task = JSON.parse(issued.json)
    const reply = answerT09Task(task, {
      kind: 'student-reply', supplementId: 'sup-1', note: '已补交',
      assets: [packT09Asset({ name: 'a.txt', mimeType: 'text/plain', bytes: Buffer.from('补交材料') })],
    })

    const order: string[] = []
    const result = await importT09Package({
      caseId, packageJson: JSON.stringify(reply),
      deps: {
        readAggregate: () => aggregate(),
        registerAsset: async (_c, _n, _m, bytes) => { order.push('register:' + bytes.byteLength); return 'ver-1' },
        respondSupplement: async (_c, _s, _n, ids) => { order.push('respond:' + ids.join(',')); return { ok: true } },
      },
    })
    expect(result.status).toBe('accepted')
    // 顺序必须：先登记原件，后答复补件
    expect(order[0]).toStartWith('register:')
    expect(order[1]).toBe('respond:ver-1')
  })

  test('相同 actionId 重复导入返回 duplicate，不重复写业务', async () => {
    const issued = issueT09StudentPackage({ aggregate: aggregate(), supplementId: 'sup-1', recipientId: 'local-student' })
    const task = JSON.parse(issued.json)
    const reply = answerT09Task(task, { kind: 'student-reply', supplementId: 'sup-1', note: '已补交', assets: [] })
    let writes = 0
    const deps = {
      readAggregate: () => aggregate(),
      registerAsset: async () => { writes += 1; return 'ver-x' },
      respondSupplement: async () => { writes += 1; return { ok: true } },
    }
    const first = await importT09Package({ caseId, packageJson: JSON.stringify(reply), deps })
    const second = await importT09Package({ caseId, packageJson: JSON.stringify(reply), deps })
    expect(first.status).toBe('accepted')
    expect(second.status).toBe('duplicate')
    expect(writes).toBe(1)
  })

  test('补件已关闭时预览为 conflict', () => {
    const issued = issueT09StudentPackage({ aggregate: aggregate(), supplementId: 'sup-1', recipientId: 'local-student' })
    const task = JSON.parse(issued.json)
    const reply = answerT09Task(task, { kind: 'student-reply', supplementId: 'sup-1', note: '已补交', assets: [] })
    const { preview } = previewT09Package({ aggregate: aggregate(3, 'satisfied'), packageJson: JSON.stringify(reply) })
    expect(preview.status).toBe('conflict')
  })

  test('OFF-02：预览后案卷 revision 前进，导入拒绝且不写业务', async () => {
    const issued = issueT09StudentPackage({ aggregate: aggregate(), supplementId: 'sup-1', recipientId: 'local-student' })
    const task = JSON.parse(issued.json)
    const reply = answerT09Task(task, {
      kind: 'student-reply', supplementId: 'sup-1', note: '已补交',
      assets: [packT09Asset({ name: 'b.txt', mimeType: 'text/plain', bytes: Buffer.from('x') })],
    })
    const calls: string[] = []
    let reads = 0
    const result = await importT09Package({
      caseId, packageJson: JSON.stringify(reply),
      deps: {
        // 预览读取时是 revision 3；真正写入前案卷已被其他操作推进到 4
        readAggregate: () => { reads += 1; return reads === 1 ? aggregate(3) : aggregate(4) },
        registerAsset: async () => { calls.push('register'); return 'ver-new' },
        respondSupplement: async () => { calls.push('respond'); return { ok: true } },
      },
    })
    expect(result.status).toBe('rejected')
    expect(calls).toEqual([])
  })

  test('OFF-01/03：附件登记后补件失败，重试复用已登记版本，不重复登记', async () => {
    const issued = issueT09StudentPackage({ aggregate: aggregate(), supplementId: 'sup-1', recipientId: 'local-student' })
    const task = JSON.parse(issued.json)
    const reply = answerT09Task(task, {
      kind: 'student-reply', supplementId: 'sup-1', note: '已补交',
      assets: [
        packT09Asset({ name: 'c1.txt', mimeType: 'text/plain', bytes: Buffer.from('one') }),
        packT09Asset({ name: 'c2.txt', mimeType: 'text/plain', bytes: Buffer.from('two') }),
      ],
    })
    let registered = 0
    let attempt = 0
    const deps = {
      readAggregate: () => aggregate(),
      registerAsset: async () => { registered += 1; return `ver-${registered}` },
      respondSupplement: async () => {
        attempt += 1
        return attempt === 1 ? { ok: false, message: 'CAS 冲突' } : { ok: true }
      },
    }
    const first = await importT09Package({ caseId, packageJson: JSON.stringify(reply), deps })
    expect(first.status).toBe('rejected')
    expect(registered).toBe(2)
    const second = await importT09Package({ caseId, packageJson: JSON.stringify(reply), deps })
    expect(second.status).toBe('accepted')
    // 重试不得再登记副本
    expect(registered).toBe(2)
  })

  test('OFF-03：业务成功但 receipts.json 丢失，仍按 actionId 恢复 duplicate', async () => {
    const issued = issueT09StudentPackage({ aggregate: aggregate(), supplementId: 'sup-1', recipientId: 'local-student' })
    const task = JSON.parse(issued.json)
    const reply = answerT09Task(task, {
      kind: 'student-reply', supplementId: 'sup-1', note: '已补交',
      assets: [packT09Asset({ name: 'd.txt', mimeType: 'text/plain', bytes: Buffer.from('y') })],
    })
    let writes = 0
    const deps = {
      readAggregate: () => aggregate(),
      registerAsset: async () => { writes += 1; return 'ver-z' },
      respondSupplement: async () => { writes += 1; return { ok: true } },
    }
    const first = await importT09Package({ caseId, packageJson: JSON.stringify(reply), deps })
    expect(first.status).toBe('accepted')
    const receipts = join(process.env.PROFER_CONFIG_DIR!, 'review-offline', caseId, 'receipts.json')
    expect(existsSync(receipts)).toBe(true)
    rmSync(receipts) // 模拟回执落盘前崩溃/文件丢失
    const recovered = await importT09Package({ caseId, packageJson: JSON.stringify(reply), deps })
    expect(recovered.status).toBe('duplicate')
    expect(writes).toBe(2) // 未再登记材料、未再答复
  })

  test('OFF-06：过期临时附件被回收，新文件保留', () => {
    const root = t09AssetTempRoot()
    const oldFile = join(root, 'old-orphan.bin')
    writeFileSync(oldFile, 'x')
    const past = new Date(Date.now() - 3_600_000)
    utimesSync(oldFile, past, past)
    const freshFile = join(root, 'fresh-orphan.bin')
    writeFileSync(freshFile, 'y')
    const removed = pruneT09AssetTempRoot(60_000)
    expect(removed).toBeGreaterThanOrEqual(1)
    expect(existsSync(oldFile)).toBe(false)
    expect(existsSync(freshFile)).toBe(true)
  })
})
