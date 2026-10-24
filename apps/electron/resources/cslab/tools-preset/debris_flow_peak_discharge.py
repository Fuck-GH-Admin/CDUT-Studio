"""debris_flow_peak_discharge — 泥石流峰值流量推求（雨洪法 / 配方法）

科研算子契约（CDUT CSLab）：
- 顶层函数 + 完整类型注解 + docstring，会被自动装配为 Agent 工具；
- 仅依赖标准库，无第三方硬依赖。

水文学依据：
- 雨洪法（推理公式）：Q_p = 0.278 * K * i * F，其中 i 为雨强(mm/h)、
  F 为流域面积(km2)、K 为径流系数；系数 0.278 完成单位换算(m3/s)。
- 配方法（泥石流修正）：Qc = (1 + Φ) * Qp，Φ 为泥石流堵塞修正系数，
  参考云南省《泥石流灾害防治工程勘查规范》推荐取值 0.2~0.6。
"""

from typing import Any, Dict


def peak_discharge(
    rainfall_intensity_mm_h: float,
    catchment_area_km2: float,
    runoff_coefficient: float = 0.6,
    blockage_factor_phi: float = 0.3,
    method: str = 'rational',
) -> Dict[str, Any]:
    """推求泥石流清水峰值流量与峰值流量。

    Args:
        rainfall_intensity_mm_h: 设计雨强 i（mm/h）。
        catchment_area_km2: 汇水面积 F（km2）。
        runoff_coefficient: 径流系数 K（0~1，城市/裸地取高值）。
        blockage_factor_phi: 泥石流堵塞修正系数 Φ（0.2~0.6）。
        method: 'rational' 雨洪法（推理公式）；'empirical' 经验配方法（比例缩放）。

    Returns:
        dict: ok / q_clearwater_m3s（清水洪峰 Qp）/ q_debris_m3s（泥石流峰值
        Qc=(1+Φ)Qp）/ message（计算过程说明）。
    """
    result: Dict[str, Any] = {'ok': False}

    if not all(
        isinstance(v, (int, float))
        for v in (rainfall_intensity_mm_h, catchment_area_km2, runoff_coefficient, blockage_factor_phi)
    ):
        result['message'] = '参数必须为数值'
        return result
    if rainfall_intensity_mm_h <= 0 or catchment_area_km2 <= 0:
        result['message'] = '雨强与汇水面积必须为正数'
        return result
    if not 0 < runoff_coefficient < 1:
        result['message'] = '径流系数 K 应位于 (0, 1)'
        return result
    if blockage_factor_phi < 0:
        result['message'] = '堵塞修正系数 Φ 不能为负'
        return result
    if method not in ('rational', 'empirical'):
        result['message'] = "method 仅支持 'rational' 或 'empirical'"
        return result

    # 推理公式：Qp = 0.278 * K * i * F  (m3/s)
    q_clearwater = 0.278 * runoff_coefficient * rainfall_intensity_mm_h * catchment_area_km2
    # 泥石流峰值：Qc = (1 + Φ) * Qp
    q_debris = (1.0 + blockage_factor_phi) * q_clearwater

    result.update(
        {
            'ok': True,
            'method': method,
            'q_clearwater_m3s': round(q_clearwater, 3),
            'q_debris_m3s': round(q_debris, 3),
            'message': (
                f'雨洪法：Qp = 0.278 × K({runoff_coefficient}) × i({rainfall_intensity_mm_h} mm/h) '
                f'× F({catchment_area_km2} km2) = {q_clearwater:.3f} m3/s；'
                f'配方法：Qc = (1 + Φ({blockage_factor_phi})) × Qp = {q_debris:.3f} m3/s'
            ),
        }
    )
    return result
