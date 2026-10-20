/**
 * BDD 行为驱动测试：CDUT 专区业务域工具集成、表格网格对齐与知识图谱停用词过滤
 */

import { describe, expect, it } from 'bun:test'
import { cdutDemoService } from './cdut-demo/demo-service'
import { DEMO_EXAMS, DEMO_GRADES, DEMO_NO_DATA_TEXT } from './cdut-demo/demo-fixtures'

describe('CDUT 专区业务域工具与演示降级 (BDD-CDUT-DOMAIN-01)', () => {
  it('Given 处于离线或演示模式 When 请求 grades 业务域 Then 返回双轨绩点与 records 课程明细', async () => {
    const result = await cdutDemoService.execute('grades', { action: 'query_grades' })
    expect(result.success).toBe(true)
    expect(result.isDemo).toBe(true)
    expect(result.markdown).toContain('加权绩点')

    // 契约对齐：与真实链路一致输出 latest / highest / records（前端 normalizeGrades 消费口径）
    const json = result.json as { latest: { weightedGpa: number }; highest: { weightedGpa: number }; records: typeof DEMO_GRADES }
    expect(Array.isArray(json.records)).toBe(true)
    expect(json.records.length).toBeGreaterThan(5)
    expect(json.records[0]!.courseName).toBe('碳中和技术概论')
    expect(typeof json.latest.weightedGpa).toBe('number')
    expect(json.highest.weightedGpa).toBeGreaterThanOrEqual(json.latest.weightedGpa)
  })

  it('Given 处于离线或演示模式 When 请求 exams 业务域 Then 返回包含座位号与考场的日程数据', async () => {
    const result = await cdutDemoService.execute('exams', { action: 'query_exam_schedule' })
    expect(result.success).toBe(true)
    expect(result.isDemo).toBe(true)
    expect(result.markdown).toContain('工程力学Ⅱ')

    const json = result.json as { exams: typeof DEMO_EXAMS }
    expect(json.exams).toBeDefined()
    expect(json.exams.length).toBe(3)
    expect(json.exams[0]!.seatNumber).toBe('24')
    expect(json.exams[0]!.classroom).toBe('（宜）甲A308')
  })

  it('Given 处于离线或演示模式 When 请求 classrooms 业务域 Then 如实返回无数据且绝不编造教室/楼宇', async () => {
    const result = await cdutDemoService.execute('classrooms', {
      action: 'query_empty_classrooms',
      campus: 'chengdu',
      building: '任意楼宇',
    })
    expect(result.success).toBe(true)
    expect(result.isDemo).toBe(true)
    // 演示态不得凭空捏造任何虚拟教室或楼宇（真实物理资源不可编造）
    const json = result.json as { buildings: unknown[]; emptyRooms: unknown[] }
    expect(json.buildings).toEqual([])
    expect(json.emptyRooms).toEqual([])
    // 必须如实告知用户当前无数据
    expect(result.markdown).toContain(DEMO_NO_DATA_TEXT)
  })

  it('Given 演示态查询个人课表 When 读取 JSON Then 契约与真实链路一致（courses / weekList / currentWeek）', async () => {
    const result = await cdutDemoService.execute('schedule', { action: 'get_my_schedule' })
    const json = result.json as {
      currentWeek: number
      courses: Array<{ name: string; weekList: number[]; dayOfWeek: number; startSection: number }>
    }
    expect(Array.isArray(json.courses)).toBe(true)
    expect(json.courses.length).toBeGreaterThan(5)
    expect(typeof json.currentWeek).toBe('number')
    for (const c of json.courses) {
      expect(Array.isArray(c.weekList)).toBe(true)
      expect(c.startSection).toBeGreaterThan(0)
      expect(c.dayOfWeek).toBeGreaterThanOrEqual(1)
    }
  })
})
