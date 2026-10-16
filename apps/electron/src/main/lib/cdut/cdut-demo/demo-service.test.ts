/**
 * CDUT 演示特区账户服务单元测试
 *
 * 覆盖范围：
 *   1. 登录判定 —— 演示凭据命中进入演示态并返回完整画像，错误凭据返回 null 不生效；
 *   2. 演示态生命周期 —— reset 后立即回落未登录；
 *   3. 8 大业务域演示数据 —— 均返回非空 Markdown 与结构化 JSON；
 *   4. 写操作 —— 仅返回模拟执行结果（mutated 标记），不做真实提交。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import type { CdutToolDomain, CdutToolParamsMap } from '@profer/shared'
import { DEMO_CREDENTIALS } from './demo-account'
import { cdutDemoService } from './demo-service'

/** 便捷执行：以指定 action 调用演示数据分发 */
function run(domain: CdutToolDomain, action: string) {
  return cdutDemoService.execute(domain, { action } as CdutToolParamsMap[CdutToolDomain])
}

/** 每个用例后复位演示态，避免单例状态串扰 */
afterEach(() => {
  cdutDemoService.reset()
})

describe('CDUT 演示账户登录判定', () => {
  test('Given 演示凭据 When 尝试登录 Then 进入演示态并返回完整画像', () => {
    const result = cdutDemoService.tryLogin({
      username: DEMO_CREDENTIALS.studentId,
      password: DEMO_CREDENTIALS.password,
    })

    expect(result?.success).toBe(true)
    expect(result?.profile?.studentName).toBe('张澄一')
    expect(result?.profile?.studentId).toBe('202520260101')
    expect(result?.profile?.college).toBe('环境与土木工程')
    expect(result?.profile?.major).toBe('地下水科学与工程')
    expect(result?.profile?.classCode).toBe('2025202601')
    expect(result?.profile?.role).toBe('学生')
    expect(result?.profile?.status).toBe('active')
    // 头像为内置 Base64 DataURL，完全离线
    expect(result?.profile?.avatar?.startsWith('data:image/jpeg;base64,')).toBe(true)
    // 演示态仅内存，绝不记住密码
    expect(result?.profile?.rememberPassword).toBe(false)
    expect(cdutDemoService.isActive()).toBe(true)
  })

  test('Given 错误密码 When 尝试登录 Then 返回 null 且不进入演示态', () => {
    const result = cdutDemoService.tryLogin({
      username: DEMO_CREDENTIALS.studentId,
      password: 'wrong-password',
    })

    expect(result).toBeNull()
    expect(cdutDemoService.isActive()).toBe(false)
  })

  test('Given 演示态 When 复位 Then 立即回落未登录', () => {
    cdutDemoService.tryLogin({
      username: DEMO_CREDENTIALS.studentId,
      password: DEMO_CREDENTIALS.password,
    })
    expect(cdutDemoService.isActive()).toBe(true)

    cdutDemoService.reset()
    expect(cdutDemoService.isActive()).toBe(false)
  })
})

describe('CDUT 演示账户 8 大业务域数据', () => {
  const cases: Array<[CdutToolDomain, string]> = [
    ['profile', 'get_profile'],
    ['schedule', 'get_my_schedule'],
    ['grades', 'query_grades'],
    ['exams', 'query_exam_schedule'],
    ['classrooms', 'query_empty_classrooms'],
    ['curriculum', 'get_training_plan'],
    ['selection', 'query_selection_rounds'],
    ['notices', 'query_notices'],
  ]

  test('Given 8 大业务域 When 读取演示数据 Then 均返回非空 Markdown 与 JSON', () => {
    for (const [domain, action] of cases) {
      const res = run(domain, action)
      expect(res.success).toBe(true)
      expect(res.markdown.trim().length).toBeGreaterThan(0)
      expect(res.json).toBeDefined()
    }
  })

  test('Given 课表域 When 读取课表 Then 命中演示课程条目', () => {
    const res = run('schedule', 'get_my_schedule')
    expect(res.markdown).toContain('2026-2027-1')
    expect(res.markdown).toContain('线性代数')
  })

  test('Given 成绩域 When 读取成绩 Then 输出双轨加权绩点与课程明细', () => {
    const res = run('grades', 'query_grades')
    expect(res.markdown).toContain('加权绩点')
    expect(res.markdown).toContain('碳中和技术概论')
    const json = res.json as { latest?: { weightedGpa?: number }; records?: unknown[] }
    expect(Array.isArray(json.records)).toBe(true)
    expect(typeof json.latest?.weightedGpa).toBe('number')
  })

  test('Given 写操作 When 演示选课 Then 仅返回模拟执行结果', () => {
    const res = run('selection', 'select_course')
    expect(res.success).toBe(true)
    expect(res.mutated).toBe(true)
    expect(res.markdown).toContain('模拟执行')
  })
})
