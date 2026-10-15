/**
 * fim-engine.ts — FIM 潜伏认知能力评级共享工具
 *
 * 主进程与渲染进程共享的潜伏认知能力可读描述。
 */

/** 把连续 θ 映射为可读的能力等级标签（面向自测练习与成绩单结算展示） */
export function describeTheta(theta: number): string {
  if (theta >= 2) return '卓越（已显著超越课程要求）'
  if (theta >= 1) return '优秀（知识体系扎实）'
  if (theta >= 0) return '良好（基本掌握，仍有提升空间）'
  if (theta >= -1) return '及格（存在若干知识盲区）'
  if (theta >= -2) return '待提升（薄弱环节较多）'
  return '亟需巩固（建议系统重学）'
}
