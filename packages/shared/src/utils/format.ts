/**
 * 共享字节大小格式化（CSLab 多面板统一显示）。
 *
 * 设计要求：
 * - 单位使用十进制前缀（KB/MB/GB/TB/PB），匹配既有面板既有视觉；
 * - 默认保留 1 位小数，调用方可按需传入更高精度；
 * - 非有限或非正值统一返回 '0 B'，避免各面板继续各自定义空值语义；
 *   若 UI 期望显示破折号（如 CsLabWorkspaceView），由调用方包裹本函数。
 */

const FORMAT_BYTES_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const
const FORMAT_BYTES_K = 1024

export function formatBytes(bytes: number | undefined | null, decimals = 1): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(FORMAT_BYTES_K)),
    FORMAT_BYTES_UNITS.length - 1,
  )
  const value = bytes / Math.pow(FORMAT_BYTES_K, unitIndex)
  return `${value.toFixed(decimals)} ${FORMAT_BYTES_UNITS[unitIndex]!}`
}
