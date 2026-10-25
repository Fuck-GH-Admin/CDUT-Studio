"""debris_flow_runout_distance — 泥石流危险区最大运移距离与爬高推求

科研算子契约（CDUT CSLab）：
- 顶层函数 + 完整类型注解 + docstring，会被自动装配为 Agent 工具；
- 仅依赖标准库，无第三方硬依赖。

模型依据：
- 简化 Voellmy 阻力模型：L = V^2 / (2 * g * ξ * h * (1 - μ_eff)) 的工程简化式，
  本文采用无因次经验式 L = α * V^(2/3) * (V0 / tanθ)（α 为规模修正指数，
  默认 2/3 参考 Iverson-Costa 经验拟合）；V0 为出沟体积尺度速度。
- 爬高经验式：H = V^2 / (2 * g) * (1 + λ)，λ 为迎面坡阻力修正（默认 0.4）。
- 以上为简化工程估算，正式勘察应以数值模拟 + 历史案例校核为准。
"""

import math
from typing import Any, Dict


def runout_distance(
    volume_m3: float,
    slope_deg: float,
    friction_coefficient: float = 0.1,
    exponent_alpha: float = 0.6667,
) -> Dict[str, Any]:
    """估算泥石流最大运移距离、最大爬高与危险区半径建议。

    Args:
        volume_m3: 一次泥石流总体积 V（m3）。
        slope_deg: 沟床纵坡降 θ（角度制，5~30 度常见）。
        friction_coefficient: Voellmy 摩擦系数 μ（0.05~0.25，黏性取低值）。
        exponent_alpha: 规模修正指数 α（默认 0.6667 ≈ 2/3）。

    Returns:
        dict: ok / velocity_m_s（特征速度）/ runout_distance_m（最大运移距离 L）/
        runup_height_m（最大爬高 H）/ hazard_radius_m（危险区半径建议）/
        message（模型说明）。
    """
    result: Dict[str, Any] = {'ok': False}

    if not all(
        isinstance(v, (int, float)) and not isinstance(v, bool)
        for v in (volume_m3, slope_deg, friction_coefficient, exponent_alpha)
    ):
        result['message'] = '参数必须为数值'
        return result
    if volume_m3 <= 0:
        result['message'] = '泥石流体积必须为正数'
        return result
    if not 0 < slope_deg < 90:
        result['message'] = '沟床纵坡降应为 0~90 度'
        return result
    if not 0 < friction_coefficient < 1:
        result['message'] = '摩擦系数 μ 应位于 (0, 1)'
        return result

    g = 9.81
    slope_rad = math.radians(slope_deg)

    # 特征速度：能量法 V = sqrt(2 * g * L_eq * (sinθ - μ·cosθ))，以等效沟长 L_eq ∝ V^(1/3) 自洽迭代一次
    # 工程简化：V0 = sqrt(2 * g * volume_m3 ** (1 / 3) * (sinθ - μ * cosθ))
    drive = math.sin(slope_rad) - friction_coefficient * math.cos(slope_rad)
    if drive <= 0:
        result['message'] = '摩擦系数过大：当前坡度下泥石流无法启动（sinθ ≤ μ·cosθ）'
        return result
    velocity = math.sqrt(2.0 * g * (volume_m3 ** (1.0 / 3.0)) * drive)

    # 最大运移距离：L = α * V^(2/3) * V0 / tanθ 的退化式（V0 已并入速度项）
    runout = exponent_alpha * (velocity ** (2.0 / 3.0)) * velocity / max(math.tan(slope_rad), 1e-6)
    # 最大爬高：H = V^2 / (2g) * (1 + λ)，λ = μ（与沟床阻力同源）
    runup = (velocity ** 2) / (2.0 * g) * (1.0 + friction_coefficient)
    # 危险区半径建议：运移距离 × 1.2 安全系数
    hazard_radius = runout * 1.2

    result.update(
        {
            'ok': True,
            'velocity_m_s': round(velocity, 3),
            'runout_distance_m': round(runout, 2),
            'runup_height_m': round(runup, 2),
            'hazard_radius_m': round(hazard_radius, 2),
            'message': (
                f'简化 Voellmy 模型：特征速度 {velocity:.2f} m/s；'
                f'最大运移距离 L ≈ {runout:.1f} m；最大爬高 H ≈ {runup:.2f} m；'
                f'建议危险区半径（含 1.2 安全系数）≈ {hazard_radius:.1f} m。'
                '正式勘察需结合数值模拟与历史案例校核。'
            ),
        }
    )
    return result
