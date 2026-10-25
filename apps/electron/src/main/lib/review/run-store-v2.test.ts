/**
 * V2 运行存储单测（P0-3：进程重启后 running 运行必须标记中断）
 * 隔离：PROFER_CONFIG_DIR 唯一临时目录。
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReviewRunV2 } from '@profer/shared'
import { getRunV2, recoverInterruptedRuns, saveRunV2 } from './run-store-v2'

const CONFIG_DIR = join(import.meta.dir, '../../../../../../work/tmp', `profer-test-runstorev2-${Date.now()}`)
process.env.PROFER_CONFIG_DIR = CONFIG_DIR
afterAll(() => rmSync(CONFIG_DIR, { recursive: true, force: true }))

const CASE_ID = 'case-recovery-1'

function makeRun(id: string, status: ReviewRunV2['status']): ReviewRunV2 {
  return {
    id,
    caseId: CASE_ID,
    templateId: 'document-checklist-v2',
    templateVersion: 1,
    inputManifest: {
      hash: 'hash-1',
      templateVersion: 1,
      policyVersions: [],
      documentVersions: [],
      observationIds: [],
      evidenceLinkIds: [],
    },
    status,
    checkpoints: [{ nodeId: 'node-auto-check-register', inputHash: 'node-hash', status: 'done', attempts: 1 }],
    checks: [],
    opinions: [],
    coverage: { documents: [], plannedChecks: 0, completedChecks: 0, effectiveVerdicts: 0, pendingChecks: 0 },
    diagnostics: [],
    startedAt: new Date().toISOString(),
  }
}

describe('recoverInterruptedRuns（启动恢复）', () => {
  test('Given 磁盘上 running 运行 When 启动恢复 Then 标记 failed 并写诊断', () => {
    saveRunV2(makeRun('run-interrupted', 'running'))
    saveRunV2(makeRun('run-finished', 'completed'))

    const recovered = recoverInterruptedRuns()
    expect(recovered).toBeGreaterThanOrEqual(1)

    const interrupted = getRunV2(CASE_ID, 'run-interrupted')!
    expect(interrupted.status).toBe('failed')
    expect(interrupted.error).toBe('应用重启，运行已中断')
    expect(interrupted.completedAt).toBeString()
    expect(interrupted.diagnostics).toContain('[recovery] 检测到进程重启，运行标记为中断')
    // 检查点保留（续跑依据，不重做已完成节点）
    expect(interrupted.checkpoints).toHaveLength(1)

    // 非 running 运行不受影响
    expect(getRunV2(CASE_ID, 'run-finished')!.status).toBe('completed')
    // 幂等：再次恢复已无 running 运行
    expect(recoverInterruptedRuns()).toBe(0)
  })

  test('Given 运行文件损坏 When 启动恢复 Then 跳过且不影响其他运行', () => {
    const dir = join(CONFIG_DIR, 'review-cases', 'case-broken', 'runs-v2')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'run-broken.json'), '{ 这不是 JSON', 'utf-8')

    expect(() => recoverInterruptedRuns()).not.toThrow()
    expect(recoverInterruptedRuns()).toBe(0)
  })
})
