/**
 * 元素 -> 拉曼/红外特征伸缩振动参考区间（cm⁻¹）
 *
 * 红线：以下区间来自公开文献的常见范围，仅用于「点原子后粗略定位谱带」，
 * 不代表本样品的实测峰位。UI 必须标注为「内置参考区间（启发式）」。
 */

export interface CsLabVibrationalBand {
  from: number
  to: number
  label: string
  note: string
}

const REFERENCE_NOTE = '内置参考区间（启发式），非本样品实测'

export const VIBRATIONAL_REFERENCE_BANDS: Record<string, CsLabVibrationalBand[]> = {
  ti: [{ from: 400, to: 700, label: 'Ti–O 伸缩', note: REFERENCE_NOTE }],
  fe: [{ from: 200, to: 600, label: 'Fe–O 伸缩', note: REFERENCE_NOTE }],
  si: [{ from: 400, to: 1100, label: 'Si–O 伸缩', note: REFERENCE_NOTE }],
  al: [{ from: 500, to: 900, label: 'Al–O 伸缩', note: REFERENCE_NOTE }],
  zn: [{ from: 300, to: 650, label: 'Zn–O 伸缩', note: REFERENCE_NOTE }],
  cu: [{ from: 300, to: 650, label: 'Cu–O 伸缩', note: REFERENCE_NOTE }],
  c: [
    { from: 1000, to: 1300, label: 'C–O 伸缩', note: REFERENCE_NOTE },
    { from: 1350, to: 1600, label: 'C=C / C–C 骨架', note: REFERENCE_NOTE },
  ],
  o: [{ from: 3000, to: 3700, label: 'O–H 伸缩', note: REFERENCE_NOTE }],
  n: [{ from: 3100, to: 3500, label: 'N–H 伸缩', note: REFERENCE_NOTE }],
}

/** 按元素符号（大小写不敏感）取参考带；未收录返回空数组。 */
export function findVibrationalBands(element: string): CsLabVibrationalBand[] {
  const key = (element ?? '').trim().toLowerCase()
  if (!key) return []
  return VIBRATIONAL_REFERENCE_BANDS[key] ?? []
}
