/**
 * CDUT 演示账户业务数据（8 大教务业务域离线假数据）
 *
 * 数据来源：产品演示预设内容，完全离线，不对接任何教务系统。
 * 仅供演示态消费，请勿用于任何真实业务判定。
 */

/** 学籍档案（profile 域 get_profile） */
export const DEMO_STUDENT_INFO = {
  name: '张澄一',
  studentId: '202520260101',
  gender: '女',
  nation: '汉族',
  politicalStatus: '共青团员',
  college: '环境与土木工程',
  major: '地下水科学与工程',
  className: '2025202601',
  educationSystem: '四年',
  trainingLevel: '本科',
  enrollmentDate: '2025年9月',
  graduationDate: '2029年6月',
} as const

/** 联系方式（profile 域 get_contact_info） */
export const DEMO_CONTACT_INFO = {
  phone: '123-0315-1956',
  email: '无',
  address: '北京市东城区',
} as const

/** 课表条目（schedule 域） */
export interface DemoScheduleEntry {
  /** 星期（1=周一 … 7=周日） */
  weekday: number
  /** 节次 */
  period: number
  courseName: string
  teacher: string
  classroom: string
  /** 上课周次描述，如「第19周」「1-5周」 */
  weeks: string
}

/** 演示课表学期代号 */
export const DEMO_SCHEDULE_SEMESTER = '2026-2027-1'

/** 演示课表（按 星期 × 节次 展开） */
export const DEMO_SCHEDULE: DemoScheduleEntry[] = [
  { weekday: 1, period: 2, courseName: '房屋建筑学课程设计', teacher: '高涌涛', classroom: '(宜）甲A101', weeks: '第19周' },
  { weekday: 2, period: 2, courseName: '房屋建筑学课程设计', teacher: '高涌涛', classroom: '(宜）甲A101', weeks: '第19周' },
  { weekday: 3, period: 2, courseName: '线性代数', teacher: '潘浪', classroom: '（宜）乙308', weeks: '1-5周' },
  { weekday: 4, period: 2, courseName: '房屋建筑学', teacher: '高涌涛', classroom: '(宜）甲A202', weeks: '1-4,6-8周' },
  { weekday: 5, period: 2, courseName: '经济学', teacher: '陈艺', classroom: '(宜）甲A111', weeks: '1-3,6-10周' },
  { weekday: 6, period: 2, courseName: '线性代数', teacher: '潘浪', classroom: '（宜）乙308', weeks: '第6周' },

  { weekday: 1, period: 3, courseName: '工程力学Ⅱ', teacher: '杨东旭', classroom: '(宜）甲A308', weeks: '9-17周' },
  { weekday: 2, period: 3, courseName: 'Python 语言程序设计', teacher: '鲁红英', classroom: '（宜）基A423（计算机）', weeks: '3-5,7-8周' },
  { weekday: 3, period: 3, courseName: '高级英语', teacher: '兰红梅', classroom: '（宜）乙502', weeks: '1-5,7-9,11-12周' },
  { weekday: 4, period: 3, courseName: '大学体育（3）足球1', teacher: '', classroom: '(足球1)', weeks: '1-4周' },
  { weekday: 5, period: 3, courseName: '经济法', teacher: '徐涛', classroom: '(宜）甲A212', weeks: '第1周' },
  { weekday: 6, period: 3, courseName: '高级英语', teacher: '兰红梅', classroom: '（宜）乙502', weeks: '第6周' },
  { weekday: 7, period: 3, courseName: 'Python 语言程序设计', teacher: '鲁红英', classroom: '（宜）基A423', weeks: '第3周' },

  { weekday: 1, period: 4, courseName: '房屋建筑学课程设计', teacher: '高涌涛', classroom: '(宜）甲A101', weeks: '第19周' },
  { weekday: 2, period: 4, courseName: '房屋建筑学课程设计', teacher: '高涌涛', classroom: '(宜）甲A101', weeks: '第19周' },
  { weekday: 3, period: 4, courseName: '房屋建筑学课程设计', teacher: '高涌涛', classroom: '(宜）甲A101', weeks: '第19周' },
  { weekday: 4, period: 4, courseName: '房屋建筑学课程设计', teacher: '高涌涛', classroom: '(宜）甲A101', weeks: '第19周' },
  { weekday: 5, period: 4, courseName: '房屋建筑学课程设计', teacher: '高涌涛', classroom: '(宜）甲A101', weeks: '第19周' },

  { weekday: 1, period: 5, courseName: '艺术鉴赏与实践1', teacher: '段文静', classroom: '(宜）甲A204', weeks: '1-5周' },
  { weekday: 2, period: 5, courseName: '大学生心理健康教育（实践）', teacher: '敖翔', classroom: '(宜）甲A104', weeks: '第2周' },
  { weekday: 3, period: 5, courseName: '房屋建筑学课程设计', teacher: '高涌涛', classroom: '(宜）甲A101', weeks: '第19周' },
  { weekday: 4, period: 5, courseName: '线性代数', teacher: '潘浪', classroom: '（宜）乙308', weeks: '1-4,6,9-12周' },
  { weekday: 5, period: 5, courseName: '房屋建筑学课程设计', teacher: '高涌涛', classroom: '(宜）甲A101', weeks: '第19周' },

  { weekday: 1, period: 6, courseName: '大学物理学III（2）', teacher: '张洁', classroom: '(宜）甲A204', weeks: '1-5,7-18周' },
  { weekday: 2, period: 6, courseName: '房屋建筑学', teacher: '高涌涛', classroom: '(宜）甲A202', weeks: '1-5,7-9周' },
  { weekday: 3, period: 6, courseName: '房屋建筑学课程设计', teacher: '高涌涛', classroom: '(宜）甲A101', weeks: '第19周' },
  { weekday: 4, period: 6, courseName: '房屋建筑学课程设计', teacher: '高涌涛', classroom: '(宜）甲A101', weeks: '第19周' },
  { weekday: 5, period: 6, courseName: '房屋建筑学课程设计', teacher: '高涌涛', classroom: '(宜）甲A101', weeks: '第19周' },
  { weekday: 6, period: 6, courseName: '工程力学Ⅱ', teacher: '李建军', classroom: '（宜）综A102（工程力学）', weeks: '12-14周' },

  { weekday: 1, period: 7, courseName: 'Python 语言程序设计', teacher: '鲁红英', classroom: '（宜）乙408', weeks: '2-5,7-9周' },
  { weekday: 2, period: 7, courseName: '大学物理学III（2）', teacher: '张洁', classroom: '(宜）甲A204', weeks: '1-5周' },
  { weekday: 3, period: 7, courseName: '中国文化概论', teacher: '罗璞', classroom: '(宜）甲A111', weeks: '1-4,7-11周' },
  { weekday: 4, period: 7, courseName: '经济学', teacher: '陈艺', classroom: '(宜）甲A211', weeks: '1-3,6-9周' },
  { weekday: 5, period: 7, courseName: '大学生心理健康教育（实践）', teacher: '敖翔', classroom: '（宜）校内03', weeks: '6-12周' },
  { weekday: 6, period: 7, courseName: '中国文化概论', teacher: '罗璞', classroom: '(宜）甲A111', weeks: '第6周' },
  { weekday: 7, period: 7, courseName: '大学物理学III（2）', teacher: '张洁', classroom: '(宜）甲A204', weeks: '第3周' },
]

/** 成绩条目（grades 域 query_grades） */
export interface DemoGradeEntry {
  courseName: string
  courseType: string
  credit: number
  score: number
  gradePoint: number
}

/** 演示成绩单 */
export const DEMO_GRADES: DemoGradeEntry[] = [
  { courseName: '碳中和技术概论', courseType: '正常考试', credit: 2, score: 95, gradePoint: 4.5 },
  { courseName: '工程测量', courseType: '正常考试', credit: 2, score: 91, gradePoint: 4.1 },
  { courseName: '形势与政策（2）', courseType: '正常考试', credit: 0, score: 91, gradePoint: 4.1 },
  { courseName: '国家安全教育', courseType: '正常考试', credit: 1, score: 82, gradePoint: 3.2 },
  { courseName: '管理学', courseType: '正常考试', credit: 2, score: 81, gradePoint: 3.1 },
  { courseName: '土木工程材料', courseType: '正常考试', credit: 2, score: 81, gradePoint: 3.1 },
  { courseName: '思想道德与法治', courseType: '正常考试', credit: 2.5, score: 80, gradePoint: 3.0 },
  { courseName: '大学生心理健康教育', courseType: '正常考试', credit: 1, score: 76, gradePoint: 2.6 },
  { courseName: '大学体育（2）', courseType: '正常考试', credit: 1, score: 71, gradePoint: 2.1 },
  { courseName: '大学英语II', courseType: '正常考试', credit: 2, score: 71, gradePoint: 2.1 },
  { courseName: '高等数学（B）（2）', courseType: '正常考试', credit: 5, score: 71, gradePoint: 2.1 },
  { courseName: '大学物理学Ⅲ（1）', courseType: '正常考试', credit: 3.5, score: 63, gradePoint: 1.3 },
  { courseName: '工程制图Ⅲ', courseType: '正常考试', credit: 2.5, score: 80, gradePoint: 3.0 },
]

/** 等级考试（grades 域 query_level_exams） */
export const DEMO_LEVEL_EXAMS = [
  { examName: '大学英语四级（CET-4）', score: 600, passed: true },
] as const

/** 演示全校班级课表（query_other_schedule，对齐 OtherClassCourse 契约） */
export interface DemoOtherClassCourse {
  name: string
  code: string
  credit: string
  teachers: string[]
  rooms: string[]
  classNames: string[]
  campus: string
  remark: string
}

export const DEMO_OTHER_CLASS_COURSES: DemoOtherClassCourse[] = [
  { name: '房屋建筑学', code: 'B0500101', credit: '3', teachers: ['高涌涛'], rooms: ['(宜）甲A202'], classNames: ['2025191101'], campus: '宜宾校区', remark: '' },
  { name: '线性代数', code: 'B0300202', credit: '2.5', teachers: ['潘浪'], rooms: ['（宜）乙308'], classNames: ['2025191101'], campus: '宜宾校区', remark: '' },
  { name: '工程力学Ⅱ', code: 'B0400303', credit: '3', teachers: ['杨东旭'], rooms: ['(宜）甲A308'], classNames: ['2025191101'], campus: '宜宾校区', remark: '' },
]

/** 演示态无数据时的统一提示语 */
export const DEMO_NO_DATA_TEXT = '演示账户暂无此项数据。'

/** 教务通知（notices 域） */
export const DEMO_NOTICES = [
  { title: '系统通知', summary: 'CDUT Studio产品将于2026年10月正式发布。' },
] as const

/** 考试日程条目（exams 域 query_exam_schedule） */
export interface DemoExamEntry {
  courseName: string
  examTime: string
  classroom: string
  seatNumber: string
  ticketNumber: string
  examType: string
}

/** 演示考试日程 */
export const DEMO_EXAMS: DemoExamEntry[] = [
  { courseName: '工程力学Ⅱ', examTime: '2026-11-20 09:00-11:00', classroom: '（宜）甲A308', seatNumber: '24', ticketNumber: '20252026010101', examType: '期末统考' },
  { courseName: '线性代数', examTime: '2026-11-24 14:30-16:30', classroom: '（宜）乙308', seatNumber: '15', ticketNumber: '20252026010102', examType: '期末统考' },
  { courseName: '大学物理学III（2）', examTime: '2026-12-02 09:00-11:00', classroom: '（宜）甲A204', seatNumber: '32', ticketNumber: '20252026010103', examType: '期末统考' },
]
