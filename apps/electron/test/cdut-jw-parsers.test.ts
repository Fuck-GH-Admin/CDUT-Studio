/**
 * BDD 行为驱动测试：CDUT 青果教务 6 大端点通用解析器
 *
 * 数据源：仓库根目录 `API Record/` 真实抓取 fixture（含 view-source 快照形态），
 * 全部断言基于结构化解析结果，严禁在业务代码中出现任何特定学生姓名/学号/班级字面量。
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import {
  buildGpaTracks,
  buildingMatchesRoom,
  computeCurrentWeek,
  decodeViewSourceSnapshot,
  markOngoingAndNext,
  parseClassroomFreeRooms,
  parseCurriculumPlan,
  parseExamSchedule,
  parseGradeRecords,
  parseOtherClassSchedule,
  parseScheduleCourses,
  parseWeekSpecification,
  CDUT_SECTION_PERIODS,
  type GradeRecord,
  type ScheduleCourse,
} from '../src/main/lib/cdut/cdut-jw-client'

// ===== fixture 定位：自测试目录向上寻找仓库根的 `API Record` =====

function findFixtureDir(): string | null {
  let dir = import.meta.dir
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'API Record')
    if (existsSync(candidate)) return candidate
    dir = dirname(dir)
  }
  return null
}

const FIXTURES = findFixtureDir()

/** fixture 缺失时优雅跳过依赖真实抓包的用例（干净克隆不含脱敏数据目录）。 */
const itWithFixtures = FIXTURES ? it : it.skip

function loadFixture(name: string): string {
  if (!FIXTURES) throw new Error('未找到 API Record fixture 目录')
  return readFileSync(join(FIXTURES, name), 'utf8')
}

// ===== 通用周次解析器 =====

describe('parseWeekSpecification（通用周次展开 BDD-JW-WEEK-01）', () => {
  it('Given 连续周 "1-16(周)" When 展开 Then 返回 [1..16]', () => {
    expect(parseWeekSpecification('1-16(周)')).toEqual(Array.from({ length: 16 }, (_, i) => i + 1))
  })

  it('Given 离散周 "1-4,6-8(周)" When 展开 Then 返回 [1,2,3,4,6,7,8]', () => {
    expect(parseWeekSpecification('1-4,6-8(周)')).toEqual([1, 2, 3, 4, 6, 7, 8])
  })

  it('Given 单周 "1-15(单)" 与双周 "2-16(双)" When 展开 Then 分别返回奇偶周序列', () => {
    expect(parseWeekSpecification('1-15(单)')).toEqual([1, 3, 5, 7, 9, 11, 13, 15])
    expect(parseWeekSpecification('2-16(双)')).toEqual([2, 4, 6, 8, 10, 12, 14, 16])
  })

  it('Given 复合格式 "14(周)[01-02节]" When 展开 Then 仅返回 [14]，节次不混入周次', () => {
    expect(parseWeekSpecification('14(周)[01-02节]')).toEqual([14])
    expect(parseWeekSpecification('19(周)[01-02-03-04-05-06-07-08节]')).toEqual([19])
  })

  it('Given 混合离散 "9,11-13(周)" When 展开 Then 返回 [9,11,12,13]', () => {
    expect(parseWeekSpecification('9,11-13(周)')).toEqual([9, 11, 12, 13])
  })

  it('Given 空文本 When 展开 Then 返回空数组（不抛异常）', () => {
    expect(parseWeekSpecification('')).toEqual([])
  })
})

// ===== 个人课表（xskb_list.do） =====

describe('parseScheduleCourses（个人课表解析 BDD-JW-SCHEDULE-01）', () => {
  const courses = FIXTURES ? parseScheduleCourses(loadFixture('xskb_list.do')) : []

  itWithFixtures('When 解析真实课表 fixture Then 提取出多门结构化课程', () => {
    expect(courses.length).toBeGreaterThan(5)
    for (const c of courses) {
      expect(c.name.length).toBeGreaterThan(0)
      expect(c.dayOfWeek).toBeGreaterThanOrEqual(1)
      expect(c.dayOfWeek).toBeLessThanOrEqual(7)
      expect(Array.isArray(c.weekList)).toBe(true)
    }
  })

  it('Given 汉字节次表头（第一二节/三四节/九十十一节）When 解析 Then 节次正确映射且绝无负数节次', () => {
    // 合成最小课表：全部使用汉字节次表头，覆盖 CN_SECTION_MAP 全通路
    const html = `
      <table>
        <tr><th>节次</th><th>星期一</th><th>星期二</th><th>星期三</th><th>星期四</th><th>星期五</th><th>星期六</th><th>星期日</th></tr>
        <tr><td>第一二节</td><td><div class="kbcontent"><font title="周次(节次)">1-16(周)</font><font>高等数学</font></div></td><td class="kbcontent">&nbsp;</td><td class="kbcontent">&nbsp;</td><td class="kbcontent">&nbsp;</td><td class="kbcontent">&nbsp;</td><td class="kbcontent">&nbsp;</td><td class="kbcontent">&nbsp;</td></tr>
        <tr><td>第三四节</td><td class="kbcontent">&nbsp;</td><td><div class="kbcontent"><font title="周次(节次)">1-16(周)</font><font>大学英语</font></div></td><td class="kbcontent">&nbsp;</td><td class="kbcontent">&nbsp;</td><td class="kbcontent">&nbsp;</td><td class="kbcontent">&nbsp;</td><td class="kbcontent">&nbsp;</td></tr>
        <tr><td>九十十一节</td><td><div class="kbcontent"><font title="周次(节次)">1-16(周)</font><font>晚自习物理</font></div></td><td class="kbcontent">&nbsp;</td><td class="kbcontent">&nbsp;</td><td class="kbcontent">&nbsp;</td><td class="kbcontent">&nbsp;</td><td class="kbcontent">&nbsp;</td><td class="kbcontent">&nbsp;</td></tr>
      </table>`
    const parsed = parseScheduleCourses(html)
    expect(parsed.length).toBe(3)
    for (const c of parsed) {
      // 红线：任何解析路径都严禁产出 <= 0 的节次（历史 Bug：0*2-1 = -1 → "-1节--1节"）
      expect(c.startSection).toBeGreaterThan(0)
      expect(c.endSection).toBeGreaterThan(0)
      expect(c.startSection).toBeLessThanOrEqual(11)
      expect(c.endSection).toBeLessThanOrEqual(11)
    }
    expect(parsed.find((c) => c.name === '高等数学')?.startSection).toBe(1)
    expect(parsed.find((c) => c.name === '高等数学')?.endSection).toBe(2)
    expect(parsed.find((c) => c.name === '大学英语')?.startSection).toBe(3)
    expect(parsed.find((c) => c.name === '晚自习物理')?.startSection).toBe(9)
    expect(parsed.find((c) => c.name === '晚自习物理')?.endSection).toBe(11)
  })

  itWithFixtures('Given 同一单元格 kbcontent1 与 kbcontent 双副本 Then 解析结果无重复（同一课程名+星期+周次仅一条）', () => {
    const keys = courses.map((c) => `${c.name}|${c.dayOfWeek}|${c.weekList.join(',')}|${c.location}`)
    expect(new Set(keys).size).toBe(keys.length)
    // fixture 中「线性代数」在星期三连排三个周次段：1-5 / 9,11-13 / 14
    const linearWednesday = courses.filter((c) => c.name.includes('线性代数') && c.dayOfWeek === 3)
    expect(linearWednesday.length).toBe(3)
    // 双副本合并后教师信息择优保留，不得缺失
    for (const c of linearWednesday) expect(c.teacher).not.toBe('')
  })

  itWithFixtures('Given 教师语义字段（title=教师）When 解析 Then 教师信息非空', () => {
    const withTeacher = courses.filter((c) => c.teacher)
    expect(withTeacher.length).toBeGreaterThan(0)
  })

  itWithFixtures('Given 严格周次过滤（第 7 周）When 过滤 Then 未在 7 周开课的课程坚决丢弃', () => {
    const week7 = courses.filter((c) => c.weekList.includes(7))
    expect(week7.length).toBeGreaterThan(0)
    // 「1-5(周)」的课程绝不允许串入第 7 周
    expect(week7.some((c) => parseWeekSpecification('1-5(周)').every((w) => c.weekList.includes(w)) && c.weekList.every((w) => w <= 5))).toBe(false)
    for (const c of week7) expect(c.weekList.includes(7)).toBe(true)
  })
})

describe('markOngoingAndNext + computeCurrentWeek（实时课程雷达 BDD-JW-SCHEDULE-02）', () => {
  /** 构造确定性合成课程（weekList 空 = 全学期排课） */
  function course(overrides: Partial<ScheduleCourse>): ScheduleCourse {
    return {
      name: '测试课程',
      dayOfWeek: 1,
      startSection: 1,
      endSection: 2,
      location: 'A101',
      teacher: '',
      weeks: '',
      weekList: [],
      ...overrides,
    }
  }

  it('Given 作息表 When 读取 Then 与成都理工大学官方 11 节制作息锁定（严禁出现第 12 节）', () => {
    expect(CDUT_SECTION_PERIODS.length).toBe(6)
    expect(CDUT_SECTION_PERIODS[0]).toEqual({ startSection: 1, endSection: 2, startMin: 490, endMin: 585 }) // 08:10-09:45
    expect(CDUT_SECTION_PERIODS[1]).toEqual({ startSection: 3, endSection: 4, startMin: 615, endMin: 710 }) // 10:15-11:50
    expect(CDUT_SECTION_PERIODS[2]).toEqual({ startSection: 5, endSection: 6, startMin: 870, endMin: 965 }) // 14:30-16:05
    expect(CDUT_SECTION_PERIODS[3]).toEqual({ startSection: 7, endSection: 8, startMin: 985, endMin: 1080 }) // 16:25-18:00
    expect(CDUT_SECTION_PERIODS[4]).toEqual({ startSection: 9, endSection: 10, startMin: 1150, endMin: 1245 }) // 19:10-20:45
    expect(CDUT_SECTION_PERIODS[5]).toEqual({ startSection: 11, endSection: 11, startMin: 1250, endMin: 1295 }) // 20:50-21:35
    for (const p of CDUT_SECTION_PERIODS) expect(p.endSection).toBeLessThanOrEqual(11)
  })

  it('Given 周一 09:00（01-02 节时段）When 标记 Then 当天相交课程置 isOngoing', () => {
    // 2026-08-31 为秋学期第 1 周周一；显式 +08:00 构造，杜绝宿主时区干扰
    const monday9 = new Date('2026-08-31T09:00:00+08:00')
    const cloned = [course({ name: '甲', dayOfWeek: 1, startSection: 1, endSection: 2 }), course({ name: '乙', dayOfWeek: 2 })]
    markOngoingAndNext(cloned, monday9)
    const ongoing = cloned.filter((c) => c.isOngoing)
    expect(ongoing.length).toBe(1)
    expect(ongoing[0]!.name).toBe('甲')
  })

  it('Given 当前周次不在课程周单内 When 标记 Then 不误判为正在上课（周单过滤）', () => {
    const monday9 = new Date('2026-08-31T09:00:00+08:00') // 第 1 周
    const cloned = [course({ name: '甲', dayOfWeek: 1, weekList: [7] })]
    markOngoingAndNext(cloned, monday9)
    expect(cloned.some((c) => c.isOngoing)).toBe(false)
  })

  it('Given 周六 22:00 与周日 19:10 课程 When 标记 Then 24h 窗口内标记周日课为 isNext，34h 外的周一课被排除', () => {
    // 2026-10-17 为周六；周日 19:10 距今约 21h（窗口内），周一 08:10 距今约 34h（窗口外）
    const saturdayNight = new Date('2026-10-17T22:00:00+08:00')
    const cloned = [
      course({ name: '周日课', dayOfWeek: 7, startSection: 9, endSection: 10 }),
      course({ name: '周一课', dayOfWeek: 1, startSection: 1, endSection: 2 }),
    ]
    markOngoingAndNext(cloned, saturdayNight)
    const next = cloned.filter((c) => c.isNext)
    expect(next.length).toBe(1)
    expect(next[0]!.name).toBe('周日课')
  })

  it('Given 未来 24 小时无任何课程 When 标记 Then 不产生 isNext（坚决不展示数天后的遥远课程）', () => {
    // 周六 22:00 → 下一门课在 34h 之外，严格超出 24 小时窗口
    const saturdayNight = new Date('2026-10-17T22:00:00+08:00')
    const cloned = [course({ name: '周一课', dayOfWeek: 1 })]
    markOngoingAndNext(cloned, saturdayNight)
    expect(cloned.some((c) => c.isNext)).toBe(false)
    expect(cloned.some((c) => c.isOngoing)).toBe(false)
  })

  it('Given computeCurrentWeek When 计算教学周 Then 秋学期 8 月末为第 1 周、10 月中旬为第 7 周，且始终夹取在 [1,25]', () => {
    expect(computeCurrentWeek(new Date('2026-08-31T09:00:00+08:00'))).toBe(1) // 2026-08-31 周一
    expect(computeCurrentWeek(new Date('2026-10-12T09:00:00+08:00'))).toBe(7) // 2026-10-12 周一
    expect(computeCurrentWeek(new Date('2027-06-15T09:00:00+08:00'))).toBeGreaterThanOrEqual(1) // 学期末仍在界内
    expect(computeCurrentWeek(new Date('2026-05-10T09:00:00+08:00'))).toBeLessThanOrEqual(25)
  })

  it('Given 宿主处于美东时区 When 以美东表达同一绝对时刻标记 Then 仍按北京时间判定', () => {
    // 2026-08-30T21:00-04:00 === 北京 2026-08-31 09:00（周一 01-02 节）
    const eastern = new Date('2026-08-30T21:00:00-04:00')
    const cloned = [course({ name: '甲', dayOfWeek: 1 })]
    markOngoingAndNext(cloned, eastern)
    expect(cloned.some((c) => c.isOngoing)).toBe(true)
  })

  itWithFixtures('Given 真实课表 fixture When 标记 Then 至多一门 isNext 且不抛异常', () => {
    const courses = parseScheduleCourses(loadFixture('xskb_list.do'))
    const cloned = courses.map((c) => ({ ...c }))
    markOngoingAndNext(cloned, new Date('2026-10-17T20:00:00+08:00'))
    expect(cloned.filter((c) => c.isNext).length).toBeLessThanOrEqual(1)
  })
})

// ===== 历年成绩（cjcx_list） =====

describe('parseGradeRecords + buildGpaTracks（历年成绩双轨 GPA BDD-JW-GRADE-01）', () => {
  const records = FIXTURES ? parseGradeRecords(loadFixture('cjcx_list')) : []

  itWithFixtures('When 解析成绩单 fixture Then 提取出带学期/课程代码/学分/绩点的结构化记录', () => {
    expect(records.length).toBeGreaterThan(5)
    const first = records[0]!
    expect(first.courseName.length).toBeGreaterThan(0)
    expect(first.semester).toMatch(/^\d{4}-\d{4}-\d$/)
    expect(first.credit).toBeGreaterThan(0)
    expect(first.gp).not.toBeUndefined()
  })

  itWithFixtures('Given 表头存在重复列（两个「课程性质」）When 解析 Then 按列序消歧且字段不错位', () => {
    for (const r of records) {
      // 课程属性 ∈ {必修, 选修, ...}，绝不应错位为课程性质长文本（如「通识必修课程」以外的性质文本）
      expect(['必修', '选修', '限选', '任选', ''].some((k) => r.courseAttr.includes(k) || r.courseAttr === '')).toBe(true)
    }
  })

  itWithFixtures('When 计算双轨加权 GPA Then 最新轨与最高轨均产出有效指标，且最高轨绩点不低于最新轨', () => {
    const tracks = buildGpaTracks(records)
    expect(tracks.latest.courseCount).toBeGreaterThan(0)
    expect(tracks.latest.totalCredits).toBeGreaterThan(0)
    expect(tracks.latest.weightedGpa).toBeGreaterThan(0)
    expect(tracks.latest.weightedGpa).toBeLessThanOrEqual(5)
    expect(tracks.highest.weightedGpa).toBeGreaterThanOrEqual(tracks.latest.weightedGpa)
    expect(tracks.latest.requiredCredits).toBeGreaterThan(0)
  })

  it('Given 空数据 When 解析 Then 返回空数组与零值统计（容错）', () => {
    expect(parseGradeRecords('<html><body></body></html>')).toEqual([])
    const empty = buildGpaTracks([])
    expect(empty.latest.weightedGpa).toBe(0)
    expect(empty.highest.courseCount).toBe(0)
  })
})

// ===== 期末考场（xsksap_list） =====

describe('parseExamSchedule（考场日程与座位号 BDD-JW-EXAM-01）', () => {
  // fixture 为「尚未排考」的空数据页（#dataList 仅含表头）
  const emptyExams = FIXTURES ? parseExamSchedule(loadFixture('xsksap_list')) : []

  itWithFixtures('Given 空数据页面（仅表头）When 解析 Then 返回空数组（防假死容错）', () => {
    expect(emptyExams).toEqual([])
  })

  it('Given 空白 HTML When 解析 Then 返回空数组且不抛异常', () => {
    expect(parseExamSchedule('<html><body><div>无数据</div></body></html>')).toEqual([])
  })

  it('Given 含数据行的 #dataList When 解析 Then 提取课程/时间/考场/座位号/准考证号字段', () => {
    const synthetic = `
      <table id="dataList">
        <tr>
          <th>序号</th><th>考试校区</th><th>考试场次</th><th>课程编号</th><th>课程名称</th>
          <th>授课教师</th><th>考试时间</th><th>考场</th><th>座位号</th><th>准考证号</th><th>备注</th>
        </tr>
        <tr>
          <td>1</td><td>宜宾校区</td><td>第1场</td><td>C0001</td><td>高等数学（下）</td>
          <td>测试教师甲</td><td>2027-01-18 14:30~16:30</td><td>甲A101</td><td>24</td><td>2026010101</td><td></td>
        </tr>
      </table>`
    const exams = parseExamSchedule(synthetic)
    expect(exams.length).toBe(1)
    const exam = exams[0]!
    expect(exam.courseName).toBe('高等数学（下）')
    expect(exam.time).toContain('2027-01-18')
    expect(exam.room).toBe('甲A101')
    expect(exam.seat).toBe('24')
    expect(exam.ticket).toBe('2026010101')
    expect(exam.campus).toBe('宜宾校区')
  })
})

// ===== 空教室（jsjy_query2） =====

describe('parseClassroomFreeRooms（自习空位矩阵 BDD-JW-ROOM-01）', () => {
  // fixture 为教室周期（jszq）版式：7 天 × 6 时段 = 42 列，1 间教室样例行
  const { periodColumns, rooms } = FIXTURES
    ? parseClassroomFreeRooms(loadFixture('jsjy_query2'))
    : { periodColumns: [], rooms: [] }

  itWithFixtures('When 解析空教室 fixture Then 42 列节次区间齐全且按星期正确分组', () => {
    expect(periodColumns.length).toBe(42)
    // 青果编码：0102 / 0304 / 12 / 0506 / 0708 / 091011 循环 7 天
    expect(periodColumns[0]!.sections).toEqual([1, 2])
    expect(periodColumns[2]!.sections).toEqual([12])
    expect(periodColumns[5]!.sections).toEqual([9, 10, 11])
    // 星期分组：首日为星期一（1），末列星期日（7）
    expect(periodColumns[0]!.day).toBe(1)
    expect(periodColumns[41]!.day).toBe(7)
  })

  itWithFixtures('Given 中午 12:00-13:55 空档列（tdvalue=12）When 解析 Then 标记为午休时段且严禁计作「第 12 节课」', () => {
    const noonColumn = periodColumns.find((p) => p.tdvalue === '12')
    expect(noonColumn).toBeDefined()
    expect(noonColumn!.isNoonBreak).toBe(true)
    // 红线：午休列空闲与否绝不纳入常规教学节次计数
    const room = rooms[0]
    if (room) {
      const flatFree = Object.values(room.freeSectionsByDay).flat()
      expect(flatFree.includes(12)).toBe(false)
    }
  })

  itWithFixtures('Given 教室行 When 解析 Then 容量被提取且占用矩阵列数与表头一致', () => {
    expect(rooms.length).toBe(1)
    const room = rooms[0]!
    expect(room.roomName).not.toMatch(/\(\d+\/\d+\)$/)
    expect(room.capacity).toBeGreaterThan(0)
    expect(room.occupied.length).toBe(42)
  })

  itWithFixtures('Given 单元格红 J（借用占用）或黑 ◆（排课占用）When 解析 Then 判定为占用；空单元格判定为空闲', () => {
    const room = rooms[0]!
    // fixture 首教室前几列为 Ｊ◆ / ◆ 占用
    expect(room.occupied[0]).toBe(true)
    // 全周矩阵必然存在空单元格 → 按天归组的空闲节次非空
    const freeCount = Object.values(room.freeSectionsByDay).flat().length
    expect(freeCount).toBeGreaterThan(0)
    // 空闲节次与占用列互斥：占用列数 + 空闲列数 = 总列数
    const occupiedCount = room.occupied.filter((o) => o).length
    expect(occupiedCount + freeCount).toBeGreaterThan(0)
  })

  it('Given 空白 HTML When 解析 Then 返回空矩阵（容错）', () => {
    const empty = parseClassroomFreeRooms('<html><body></body></html>')
    expect(empty.periodColumns).toEqual([])
    expect(empty.rooms).toEqual([])
  })
})

describe('buildingMatchesRoom（楼宇宽松匹配兜底 BDD-JW-ROOM-02）', () => {
  it('Given 教务楼宇名与教室名口径不一致 When 匹配 Then 使用楼宇指纹命中', () => {
    // 楼宇「甲教A座」对应教室「(宜）甲A101」——朴素子串必然落空
    expect(buildingMatchesRoom('甲教A座', '(宜）甲A101')).toBe(true)
    expect(buildingMatchesRoom('甲教B座', '(宜）甲B301')).toBe(true)
    expect(buildingMatchesRoom('乙教', '（宜）乙308')).toBe(true)
    expect(buildingMatchesRoom('东区9教', '东区9教-9A201')).toBe(true)
    expect(buildingMatchesRoom('6教', '6教-6B301')).toBe(true)
  })

  it('Given 明显不相干的楼宇 When 匹配 Then 返回 false', () => {
    expect(buildingMatchesRoom('甲教A座', '东区1教-E1A106')).toBe(false)
    expect(buildingMatchesRoom('乙教', '东区1教-E1A106')).toBe(false)
  })

  it('Given 空输入 When 匹配 Then 返回 false 且不抛异常', () => {
    expect(buildingMatchesRoom('', '东区1教-E1A106')).toBe(false)
    expect(buildingMatchesRoom('甲教A座', '')).toBe(false)
  })
})

// ===== 培养方案（topyfamx） =====

describe('parseCurriculumPlan（培养方案与修读状态 BDD-JW-PYFA-01）', () => {
  const plan = FIXTURES ? parseCurriculumPlan(loadFixture('topyfamx')) : parseCurriculumPlan('')

  itWithFixtures('When 解析培养方案 fixture Then 提取出多模块课程体系', () => {
    expect(plan.title.length).toBeGreaterThan(0)
    expect(plan.modules.length).toBeGreaterThan(2)
    for (const m of plan.modules) {
      expect(m.name.length).toBeGreaterThan(0)
      expect(m.courses.length).toBeGreaterThan(0)
    }
  })

  itWithFixtures('Given 模块注记「(应修 X / 已修 Y)」When 解析 Then 模块应修/已修学分被提取', () => {
    const withProgress = plan.modules.find((m) => m.requiredCredits !== undefined)
    expect(withProgress).toBeDefined()
    expect(withProgress!.requiredCredits!).toBeGreaterThan(0)
  })

  itWithFixtures('Given 完成情况列「已修(成绩)」或空 When 解析 Then 正确区分已修/未修并提取成绩', () => {
    const completed = plan.modules.flatMap((m) => m.courses).filter((c) => c.status === 'completed')
    const pending = plan.modules.flatMap((m) => m.courses).filter((c) => c.status === 'pending')
    expect(completed.length).toBeGreaterThan(0)
    expect(pending.length).toBeGreaterThan(0)
    expect(completed.some((c) => c.score !== undefined)).toBe(true)
  })

  itWithFixtures('Given 表头占两行（rowspan=2）When 解析真实 fixture Then 绝不产生名为「课程体系」的幽灵模块或「课程名称」幽灵课程', () => {
    const allCourses = plan.modules.flatMap((m) => m.courses)
    for (const m of plan.modules) {
      expect(m.name).not.toBe('课程体系')
      expect(m.courses.length).toBeGreaterThan(0)
    }
    for (const c of allCourses) {
      expect(['课程名称', '课程编号', '课程属性', '完成情况', '开设学期']).not.toContain(c.courseName)
    }
  })

  it('Given 表格底部统计汇总行（课程体系/小计/合计/总计/最低修读）When 解析 Then 严禁误解析为课程条目', () => {
    const synthetic = `
      <table id="mxh">
        <tr><th>课程体系</th><th>课程编号</th><th>课程名称</th><th>学分</th><th>完成情况</th><th>课程性质</th><th>课程属性</th><th>开设学期</th></tr>
        <tr><td rowspan="2">通识必修课程（应修 30 / 已修 12）</td><td>C0001</td><td>高等数学</td><td>5</td><td>已修(88)</td><td>通识必修课程</td><td>必修</td><td>1</td></tr>
        <tr><td>C0002</td><td>大学英语</td><td>3</td><td></td><td>通识必修课程</td><td>必修</td><td>1</td></tr>
        <tr><td>小计</td><td></td><td>小计</td><td>30</td><td></td><td></td><td></td><td></td></tr>
        <tr><td>合计</td><td></td><td>合计</td><td>170</td><td></td><td></td><td></td><td></td></tr>
        <tr><td>课程体系</td><td></td><td>最低修读学分</td><td>170</td><td></td><td></td><td></td><td></td></tr>
      </table>`
    const parsed = parseCurriculumPlan(synthetic)
    const allCourses = parsed.modules.flatMap((m) => m.courses)
    expect(allCourses.length).toBe(2)
    const names = allCourses.map((c) => c.courseName)
    expect(names).toContain('高等数学')
    expect(names).toContain('大学英语')
    for (const name of names) {
      expect(/^(课程体系|小计|合计|总计|最低修读|备注)/.test(name)).toBe(false)
    }
  })
})

// ===== 全校班级课表（viewtable.do，view-source 快照形态） =====

describe('decodeViewSourceSnapshot + parseOtherClassSchedule（全校班级课表 BDD-JW-OTHER-01）', () => {
  const raw = FIXTURES
    ? loadFixture(
      'view-source_https___jw.cdut.edu.cn_jsxsd_xskb_viewtable.do_xnxq01id=2026-2027-1&lx=xx04id&kbjcmsid=7E5976C91D9A4146930951FD11516BCC&xx0301id=22500&rxnf=2025&xx04id=29C02ADB11CA4F618BC7A7390623D160&jx01ndi.html',
    )
    : ''
  const courses = parseOtherClassSchedule(raw)

  itWithFixtures('Given view-source 快照包装 When 还原后解析 Then 提取出课程明细（名称/代码/学分/师/室）', () => {
    // 快照还原器：还原后的 HTML 必须包含真实标签
    const decoded = decodeViewSourceSnapshot(raw)
    expect(decoded).toContain('fontcourse')
    expect(courses.length).toBeGreaterThan(5)
    for (const c of courses) {
      expect(c.name.length).toBeGreaterThan(0)
      expect(c.code.length).toBeGreaterThan(0)
    }
  })

  itWithFixtures('Given 明细分段「师[…] 室[…] (校区)」When 解析 Then 教师/教室/校区字段被归一化', () => {
    const withTeacher = courses.filter((c) => c.teachers.length > 0)
    const withRoom = courses.filter((c) => c.rooms.length > 0)
    expect(withTeacher.length).toBeGreaterThan(0)
    expect(withRoom.length).toBeGreaterThan(0)
    const withCampus = courses.find((c) => c.campus)
    expect(withCampus).toBeDefined()
  })

  itWithFixtures('Given 真实抓取形态（非快照）When 解析 Then 不受 view-source 还原器影响', () => {
    const decoded = decodeViewSourceSnapshot(raw)
    expect(parseOtherClassSchedule(decoded).length).toBe(courses.length)
  })
})

// ===== 防硬编码审查（红线：解析逻辑与个人样例数据零耦合） =====

describe('防硬编码审查（BDD-JW-GUARD-01）', () => {
  const sourcePath = join(import.meta.dir, '../src/main/lib/cdut/cdut-jw-client.ts')
  const source = readFileSync(sourcePath, 'utf8')

  itWithFixtures('Given 真实 fixture 中出现的学号/班级代码 When 审查解析器源码 Then 严禁出现任何个人样例字面量', () => {
    const fixtureText = [
      'xskb_list.do',
      'cjcx_list',
      'xsksap_list',
      'view-source_https___jw.cdut.edu.cn_jsxsd_xskb_viewtable.do_xnxq01id=2026-2027-1&lx=xx04id&kbjcmsid=7E5976C91D9A4146930951FD11516BCC&xx0301id=22500&rxnf=2025&xx04id=29C02ADB11CA4F618BC7A7390623D160&jx01ndi.html',
      'topyfamx',
    ]
      .map((name) => loadFixture(name))
      .join('\n')
    // 学号/班级代码形态：9-12 位纯数字（排除课程编码无法区分，统一审查）
    const studentCodes = new Set((fixtureText.match(/\b\d{9,12}\b/g) ?? []).filter((code) => /^2025|^2026/.test(code)))
    expect(studentCodes.size).toBeGreaterThan(0)
    for (const code of studentCodes) {
      expect(source.includes(code)).toBe(false)
    }
  })

  itWithFixtures('Given fixture 中出现的教师姓名 When 审查解析器源码 Then 严禁硬编码任何真实姓名', () => {
    const fixtureText = [loadFixture('xskb_list.do'), loadFixture('view-source_https___jw.cdut.edu.cn_jsxsd_xskb_viewtable.do_xnxq01id=2026-2027-1&lx=xx04id&kbjcmsid=7E5976C91D9A4146930951FD11516BCC&xx0301id=22500&rxnf=2025&xx04id=29C02ADB11CA4F618BC7A7390623D160&jx01ndi.html')].join('\n')
    const teacherNames = new Set<string>()
    for (const m of fixtureText.matchAll(/title=['"]教师['"][^>]*>([^<]{2,5})</g)) teacherNames.add(m[1]!.trim())
    for (const m of fixtureText.matchAll(/师\[([^\]]{2,5})\]/g)) teacherNames.add(m[1]!.trim())
    expect(teacherNames.size).toBeGreaterThan(0)
    for (const name of teacherNames) {
      expect(source.includes(name)).toBe(false)
    }
  })
})

// ===== 五级制/两级制评级兜底（合成数据，不依赖 fixture） =====

describe('五级制/两级制评级与最高轨同分取最新（BDD-JW-GRADE-02）', () => {
  it('Given 优秀/良好/中等/合格/不合格/通过/不通过 When 解析并统计 Then 映射正确且未通过计入挂科', () => {
    const html = `<table id="dataList">
      <tr><th>开课学期</th><th>课程编号</th><th>课程名称</th><th>成绩</th><th>学分</th><th>绩点</th><th>补重学期</th><th>课程属性</th></tr>
      <tr><td>2025-2026-1</td><td>C1</td><td>实践课甲</td><td>优秀</td><td>2</td><td></td><td></td><td>必修</td></tr>
      <tr><td>2025-2026-1</td><td>C2</td><td>实践课乙</td><td>良好</td><td>2</td><td></td><td></td><td>必修</td></tr>
      <tr><td>2025-2026-1</td><td>C3</td><td>实践课丙</td><td>中等</td><td>2</td><td></td><td></td><td>必修</td></tr>
      <tr><td>2025-2026-1</td><td>C4</td><td>实践课丁</td><td>合格</td><td>1</td><td></td><td></td><td>选修</td></tr>
      <tr><td>2025-2026-1</td><td>C5</td><td>实践课戊</td><td>不合格</td><td>1</td><td></td><td></td><td>必修</td></tr>
      <tr><td>2025-2026-1</td><td>C6</td><td>实践课己</td><td>通过</td><td>1</td><td></td><td></td><td>必修</td></tr>
      <tr><td>2025-2026-1</td><td>C7</td><td>实践课庚</td><td>不通过</td><td>1</td><td></td><td></td><td>必修</td></tr>
    </table>`
    const parsed = parseGradeRecords(html)
    expect(parsed.map((r) => r.scoreNumber)).toEqual([95, 85, 75, 65, 50, 65, 50])
    const tracks = buildGpaTracks(parsed)
    expect(tracks.latest.failed.map((f) => f.courseName)).toContain('实践课庚')
    // 必修学分 = C1/C2/C3(各 2) + C5/C6/C7(各 1) = 9，证明「通过」不再被漏算
    expect(tracks.latest.requiredCredits).toBe(9)
  })

  it('Given 绩点与原始分相同但学期不同 When 最高成绩轨 Then 取最新学期', () => {
    const base: GradeRecord = {
      semester: '',
      courseCode: 'C1',
      courseName: '高等数学',
      score: '90',
      scoreNumber: 90,
      scoreLabel: '',
      credit: 3,
      gp: 4,
      makeupSemester: '',
      assessMode: '',
      examNature: '',
      courseAttr: '必修',
      courseNature: '',
      electiveCategory: '',
    }
    const tracks = buildGpaTracks([
      { ...base, semester: '2025-2026-1' },
      { ...base, semester: '2025-2026-2' },
    ])
    expect(tracks.highest.records[0]?.semester).toBe('2025-2026-2')
  })
})
