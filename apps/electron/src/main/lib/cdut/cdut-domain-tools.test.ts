/**
 * BDD 行为驱动测试：CDUT 专区业务域工具集成、表格网格对齐与知识图谱停用词过滤
 */

import { describe, expect, it } from 'bun:test'
import { cdutDemoService } from './cdut-demo/demo-service'
import { DEMO_EXAMS, DEMO_GRADES } from './cdut-demo/demo-fixtures'

describe('CDUT 专区业务域工具与演示降级 (BDD-CDUT-DOMAIN-01)', () => {
  it('Given 处于离线或演示模式 When 请求 grades 业务域 Then 返回高保真成绩单与绩点', async () => {
    const result = await cdutDemoService.execute('grades', { action: 'query_grades' })
    expect(result.success).toBe(true)
    expect(result.isDemo).toBe(true)
    expect(result.markdown).toContain('加权平均绩点')

    const json = result.json as { courses: typeof DEMO_GRADES }
    expect(json.courses).toBeDefined()
    expect(json.courses.length).toBeGreaterThan(5)
    expect(json.courses[0]!.courseName).toBe('碳中和技术概论')
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

  it('Given 处于离线或演示模式 When 请求 classrooms 业务域 Then 返回空闲教室匹配项', async () => {
    const result = await cdutDemoService.execute('classrooms', {
      action: 'query_empty_classrooms',
      campus: 'chengdu',
    })
    expect(result.success).toBe(true)
    expect(result.isDemo).toBe(true)
    expect(result.markdown).toContain('东区1教-E1A106')
  })
})
