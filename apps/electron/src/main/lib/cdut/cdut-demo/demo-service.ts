/**
 * CDUT 演示特区账户服务
 *
 * 职责：
 *   - 命中演示凭据时旁路真实 CAS，直接进入离线演示态（仅内存，不保活、不落盘）；
 *   - 为 8 大教务业务域工具提供离线演示数据（Markdown + JSON 双模）；
 *   - 提供统一的演示态判定 `isActive()`，供登录入口与工具层共用。
 *
 * 安全边界：演示态仅存在于内存；登出或进程退出即失效，绝不写入任何凭据文件。
 */

import type {
  CdutDomainToolResult,
  CdutLoginInput,
  CdutLoginResult,
  CdutToolDomain,
  CdutToolParamsMap,
} from '@profer/shared'
import { buildDemoProfile, DEMO_CREDENTIALS } from './demo-account'
import {
  DEMO_CLASSROOM_QUERY,
  DEMO_CONTACT_INFO,
  DEMO_EMPTY_CLASSROOMS,
  DEMO_EXAMS,
  DEMO_GRADES,
  DEMO_LEVEL_EXAMS,
  DEMO_NO_DATA_TEXT,
  DEMO_NOTICES,
  DEMO_SCHEDULE,
  DEMO_SCHEDULE_SEMESTER,
  DEMO_STUDENT_INFO,
} from './demo-fixtures'

/** 星期标签（索引 1-7，0 占位） */
const WEEKDAY_LABELS = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'] as const

/** 转义 Markdown 表格单元格内的竖线 */
function mdCell(value: string): string {
  return (value ?? '').replace(/\|/g, '\\|').trim()
}

/** 构造 Markdown 表格 */
function mdTable(headers: string[], rows: string[][]): string {
  if (headers.length === 0) return ''
  const head = `| ${headers.map(mdCell).join(' | ')} |`
  const sep = `| ${headers.map(() => ':---').join(' | ')} |`
  const body = rows.map((r) => `| ${r.map(mdCell).join(' | ')} |`).join('\n')
  return body ? `${head}\n${sep}\n${body}` : `${head}\n${sep}`
}

/** 成功结果：Markdown 正文 + 结构化 JSON 代码块（与真实链路输出风格保持一致，标注 isDemo: true） */
function buildResult(markdown: string, json?: unknown, mutated = false): CdutDomainToolResult {
  const jsonBlock =
    json === undefined ? '' : '\n\n```json\n' + JSON.stringify(json, null, 2) + '\n```'
  return { success: true, markdown: `${markdown}${jsonBlock}`, json, mutated, isDemo: true }
}

class CdutDemoService {
  /** 演示态标志：命中演示凭据后置真，登出或复位后置假 */
  private active = false

  /**
   * 尝试以演示凭据登录。
   * @returns 命中演示凭据时返回演示登录结果；未命中返回 null，交由真实 CAS 流程处理。
   */
  tryLogin(input: CdutLoginInput): CdutLoginResult | null {
    const username = (input.username ?? '').trim()
    const password = input.password ?? ''
    if (username !== DEMO_CREDENTIALS.studentId || password !== DEMO_CREDENTIALS.password) {
      return null
    }
    this.active = true
    console.log('[CdutDemo] 命中演示账户，进入离线演示态（不保活、不落盘）')
    return { success: true, profile: buildDemoProfile() }
  }

  /** 当前是否处于演示态（登录入口与工具层的统一判定真源） */
  isActive(): boolean {
    return this.active
  }

  /** 复位演示态（登出 / 启动清理时调用） */
  reset(): void {
    this.active = false
  }

  /** 执行 8 大业务域演示数据分发 */
  execute(
    domain: CdutToolDomain,
    params: CdutToolParamsMap[CdutToolDomain],
  ): CdutDomainToolResult {
    const rawAction = (params as { action?: unknown }).action
    const action = typeof rawAction === 'string' ? rawAction : ''
    switch (domain) {
      case 'profile':
        return this.executeProfile(action)
      case 'schedule':
        return this.executeSchedule(action)
      case 'grades':
        return this.executeGrades(action)
      case 'exams':
        return this.executeExams(action)
      case 'classrooms':
        return this.executeClassrooms(action)
      case 'curriculum':
        return this.executeCurriculum(action)
      case 'selection':
        return this.executeSelection(action)
      case 'notices':
        return this.executeNotices(action)
      default:
        return buildResult(DEMO_NO_DATA_TEXT)
    }
  }

  /** 写操作演示：不做任何真实提交，仅返回模拟成功 */
  private simulatedMutation(label: string): CdutDomainToolResult {
    return buildResult(
      `> ✅ 演示态：已模拟执行「${label}」，不会向教务系统提交任何真实操作。`,
      { simulated: true },
      true,
    )
  }

  private executeProfile(action: string): CdutDomainToolResult {
    if (action === 'get_profile') {
      const s = DEMO_STUDENT_INFO
      const table = mdTable(
        ['字段', '内容', '字段', '内容'],
        [
          ['姓名', s.name, '学号', s.studentId],
          ['性别', s.gender, '民族', s.nation],
          ['政治面貌', s.politicalStatus, '培养层次', s.trainingLevel],
          ['学院', s.college, '专业', s.major],
          ['班级', s.className, '学制', s.educationSystem],
          ['入学日期', s.enrollmentDate, '预计毕业', s.graduationDate],
        ],
      )
      return buildResult(`### 学籍与个人档案\n\n${table}`, s)
    }
    if (action === 'get_contact_info') {
      const c = DEMO_CONTACT_INFO
      const table = mdTable(
        ['联系方式', '内容'],
        [
          ['手机', c.phone],
          ['邮箱', c.email],
          ['家庭住址', c.address],
        ],
      )
      return buildResult(`### 联系方式\n\n${table}`, c)
    }
    if (action === 'query_status_changes') {
      return buildResult('暂无学籍异动记录。', { records: [] })
    }
    if (action === 'query_major_split' || action === 'query_minor_signup') {
      return buildResult(DEMO_NO_DATA_TEXT, { records: [] })
    }
    if (action === 'submit_major_preference') {
      return this.simulatedMutation('提交大类专业分流志愿')
    }
    if (action === 'apply_minor') {
      return this.simulatedMutation('报名辅修专业')
    }
    return buildResult(DEMO_NO_DATA_TEXT)
  }

  private executeSchedule(action: string): CdutDomainToolResult {
    const rows = DEMO_SCHEDULE
      .slice()
      .sort((a, b) => a.weekday - b.weekday || a.period - b.period)
      .map((e) => [
        WEEKDAY_LABELS[e.weekday] ?? String(e.weekday),
        `第${e.period}节`,
        e.courseName,
        e.teacher || '—',
        e.classroom,
        e.weeks,
      ])
    const table = mdTable(['星期', '节次', '课程', '教师', '教室', '上课周次'], rows)
    const header =
      action === 'query_other_schedule'
        ? `### 课表查询（演示态仅提供本人课表）\n\n**学期：${DEMO_SCHEDULE_SEMESTER}**`
        : `### 本学期课表\n\n**学期：${DEMO_SCHEDULE_SEMESTER}**`
    return buildResult(`${header}\n\n${table}`, { semester: DEMO_SCHEDULE_SEMESTER, entries: DEMO_SCHEDULE })
  }

  private executeGrades(action: string): CdutDomainToolResult {
    if (action === 'query_grades') {
      const rows = DEMO_GRADES.map((g) => [
        g.courseName,
        g.courseType,
        String(g.credit),
        String(g.score),
        String(g.gradePoint),
      ])
      const table = mdTable(['课程名称', '课程性质', '学分', '综合分', '绩点'], rows)
      const graded = DEMO_GRADES.filter((g) => g.credit > 0)
      const totalCredit = graded.reduce((sum, g) => sum + g.credit, 0)
      const weighted = graded.reduce((sum, g) => sum + g.credit * g.gradePoint, 0)
      const gpa = totalCredit > 0 ? weighted / totalCredit : 0
      const summary = `**已修学分：${totalCredit}** ｜ **加权平均绩点：${gpa.toFixed(2)}**`
      return buildResult(`${summary}\n\n${table}`, { gpa: Number(gpa.toFixed(2)), totalCredit, courses: DEMO_GRADES })
    }
    if (action === 'query_level_exams') {
      const rows = DEMO_LEVEL_EXAMS.map((e) => [e.examName, String(e.score), e.passed ? '通过' : '未通过'])
      const table = mdTable(['考试名称', '分数', '结果'], rows)
      return buildResult(`### 等级考试成绩\n\n${table}`, { exams: DEMO_LEVEL_EXAMS })
    }
    if (action === 'query_social_exam_replace' || action === 'query_grade_review') {
      return buildResult(DEMO_NO_DATA_TEXT, { records: [] })
    }
    if (action === 'apply_social_exam_replace') {
      return this.simulatedMutation('提交社考成绩认定申请')
    }
    if (action === 'apply_grade_review') {
      return this.simulatedMutation('提交查卷成绩复核申请')
    }
    return buildResult(DEMO_NO_DATA_TEXT)
  }

  private executeExams(action: string): CdutDomainToolResult {
    if (action === 'query_exam_schedule') {
      const rows = DEMO_EXAMS.map((e) => [
        e.courseName,
        e.examTime,
        e.classroom,
        e.seatNumber,
        e.ticketNumber,
        e.examType,
      ])
      const table = mdTable(['课程名称', '考试时间', '考场教室', '座位号', '准考证号', '类别'], rows)
      return buildResult(`### 期末考试日程安排\n\n${table}`, { exams: DEMO_EXAMS })
    }
    if (action === 'query_makeup_exams' || action === 'query_retake_courses' || action === 'query_deferral_status') {
      return buildResult(DEMO_NO_DATA_TEXT, { records: [] })
    }
    if (action === 'signup_makeup_exam') {
      return this.simulatedMutation('报名补考科目')
    }
    if (action === 'signup_retake_course') {
      return this.simulatedMutation('报名重修选课')
    }
    if (action === 'apply_exam_deferral') {
      return this.simulatedMutation('提交缓考申请')
    }
    return buildResult('近期无考试安排。', { exams: [] })
  }

  private executeClassrooms(action: string): CdutDomainToolResult {
    if (action === 'query_empty_classrooms') {
      const q = DEMO_CLASSROOM_QUERY
      const summary = `**校区：${q.campus}** ｜ 教学楼：${q.building} ｜ 第${q.week}周 ${WEEKDAY_LABELS[q.dayOfWeek] ?? ''} ${q.timeSlots} ｜ 最少座位数：${q.minSeats}`
      const table = mdTable(['空闲教室'], DEMO_EMPTY_CLASSROOMS.map((r) => [r]))
      return buildResult(`### 空闲自习教室\n\n${summary}\n\n${table}`, {
        query: q,
        classrooms: DEMO_EMPTY_CLASSROOMS,
      })
    }
    if (action === 'query_room_occupancy') {
      return buildResult('演示账户暂无教室占用详情。', { rooms: [] })
    }
    return buildResult(DEMO_NO_DATA_TEXT)
  }

  private executeCurriculum(action: string): CdutDomainToolResult {
    if (action === 'get_training_plan' || action === 'check_graduation_requirements') {
      return buildResult(DEMO_NO_DATA_TEXT, { modules: [] })
    }
    if (action === 'query_degree_application' || action === 'query_delay_graduation') {
      return buildResult(DEMO_NO_DATA_TEXT, { records: [] })
    }
    if (action === 'apply_degree') {
      return this.simulatedMutation('提交学士学位申请')
    }
    if (action === 'apply_delay_graduation') {
      return this.simulatedMutation('提交延后毕业申请')
    }
    return buildResult(DEMO_NO_DATA_TEXT)
  }

  private executeSelection(action: string): CdutDomainToolResult {
    if (action === 'select_course') {
      return this.simulatedMutation('提交选课请求')
    }
    if (action === 'drop_course') {
      return this.simulatedMutation('提交退课请求')
    }
    return buildResult('当前不在选课时间段内。', { rounds: [], courses: [], selected: [] })
  }

  private executeNotices(action: string): CdutDomainToolResult {
    if (action === 'query_notices' || action === 'query_bulletins' || action === 'query_messages') {
      const rows = DEMO_NOTICES.map((n) => [n.title, n.summary])
      const table = mdTable(['标题', '内容'], rows)
      return buildResult(`### 教务通知\n\n${table}`, { notices: DEMO_NOTICES })
    }
    if (action === 'get_quick_identity') {
      return buildResult(
        `**${DEMO_STUDENT_INFO.name}**（${DEMO_STUDENT_INFO.studentId}）｜ ${DEMO_STUDENT_INFO.college} ｜ ${DEMO_STUDENT_INFO.major}`,
        DEMO_STUDENT_INFO,
      )
    }
    if (action === 'post_question') {
      return this.simulatedMutation('发起在线问答提问')
    }
    if (action === 'change_password') {
      return this.simulatedMutation('修改教务系统登录密码')
    }
    return buildResult(DEMO_NO_DATA_TEXT, { records: [] })
  }
}

export const cdutDemoService = new CdutDemoService()
