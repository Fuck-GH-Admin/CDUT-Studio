/** T05 可信阶段事务：身份派生、准备度判定、原子写入与角色边界。 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const configDir = mkdtempSync(join(tmpdir(), 't05m-'))
process.env.PROFER_CONFIG_DIR = configDir
afterAll(() => rmSync(configDir, { recursive: true, force: true }))

const { deriveT05LocalActor, t05DecisionReadiness, isLocalBusinessCase } =
  await import('./review-v3-t05-main-service')

function aggregate(overrides: Record<string, unknown> = {}) {
  return {
    caseV2: { id: 'case-t05', revision: 3, templateId: 'tpl', templateVersion: 1, stage: 'submitted', documents: [] },
    tasks: [], decisions: [], supplements: [], receiptLog: [],
    ...overrides,
  } as never
}

describe('T05 可信阶段边界', () => {
  test('渲染层只能声明角色，actor 由 Main 派生', () => {
    expect(deriveT05LocalActor(undefined).actorId).toBe('local-reviewer')
    expect(deriveT05LocalActor({ role: 'teacher' }).role).toBe('teacher')
    // 非法角色降级为本地审核员，绝不按渲染层自称提权
    expect(deriveT05LocalActor({ role: 'superadmin' }).role).toBe('reviewer')
  })

  test('技术预审与 CanonicalPlan 案卷不得走业务阶段', () => {
    expect(isLocalBusinessCase(aggregate())).toBe(true)
    expect(isLocalBusinessCase(aggregate({ d2RuntimePlan: { id: 'p' } }))).toBe(false)
    expect(isLocalBusinessCase(aggregate({ canonicalPlan: { planId: 'p' } }))).toBe(false)
  })

  test('没有有效 Run 时准备度为 blocked', () => {
    expect(t05DecisionReadiness(aggregate(), undefined)).toMatchObject({ readiness: 'blocked' })
  })

  test('检查待确认或执行失败时准备度为 blocked', () => {
    const run = { id: 'run-1', status: 'completed', checks: [
      { checkId: 'c1', status: 'compliant' },
      { checkId: 'c2', status: 'awaiting-confirmation' },
      { checkId: 'c3', status: 'execution-failed' },
    ] }
    const r = t05DecisionReadiness(aggregate(), run as never)
    expect(r.readiness).toBe('blocked')
    // 必须同时报出两类阻断，不能只看一个
    expect(r.blockers.length).toBeGreaterThanOrEqual(2)
  })

  test('未结束的补件请求阻断定稿', () => {
    const run = { id: 'run-1', status: 'completed', checks: [{ checkId: 'c1', status: 'compliant' }] }
    const r = t05DecisionReadiness(
      aggregate({ supplements: [{ id: 's1', status: 'responded' }] }) as never, run as never)
    expect(r.readiness).toBe('blocked')
    expect(r.blockers.join()).toContain('补件')
  })

  test('全部检查通过且无未结束补件时准备度为 ready', () => {
    const run = { id: 'run-1', status: 'completed', checks: [{ checkId: 'c1', status: 'compliant' }] }
    expect(t05DecisionReadiness(aggregate() as never, run as never).readiness).toBe('ready')
  })
})
