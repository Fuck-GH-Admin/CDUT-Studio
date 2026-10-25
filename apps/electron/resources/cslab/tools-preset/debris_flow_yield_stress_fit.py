"""debris_flow_yield_stress_fit — 泥石流浆体流变参数拟合（Herschel-Bulkley / Bingham）

科研算子契约（CDUT CSLab）：
- 顶层函数 + 完整类型注解 + docstring，会被自动装配为 Agent 工具；
- 仅依赖 numpy（缺失时友好降级，提示安装 plot 依赖）。

本构模型：
- Bingham：τ = τ_y + η_p * γ̇（屈服应力 + 塑性黏度，线性）。
- Herschel-Bulkley：τ = τ_y + K * γ̇^n（屈服应力 + 稠度系数 K + 流性指数 n）。
- 拟合策略：网格搜索 + 线性最小二乘（τ_y 候选 × log-log 回归），无需 scipy。
"""

from typing import Any, Dict, List


def fit_rheology(
    shear_rate_s1: List[float],
    shear_stress_pa: List[float],
    model: str = 'herschel_bulkley',
) -> Dict[str, Any]:
    """拟合泥石流浆体流变曲线参数。

    Args:
        shear_rate_s1: 剪切速率序列 γ̇（1/s，升序，≥3 组）。
        shear_stress_pa: 对应剪切应力序列 τ（Pa，与速率等长）。
        model: 'bingham' 或 'herschel_bulkley'（默认）。

    Returns:
        dict: ok / yield_stress_pa（屈服应力 τ_y）/ consistency_k（稠度系数）/
        flow_index_n（流性指数，Bingham 恒为 1）/ plastic_viscosity_pa_s（Bingham
        塑性黏度）/ r_squared（拟合优度 R²）/ message。
    """
    result: Dict[str, Any] = {'ok': False}

    try:
        import numpy as np  # noqa: PLC0415
    except Exception:
        result['message'] = '未安装 numpy（可在「科研算子」面板一键安装 plot 依赖）'
        return result

    if model not in ('bingham', 'herschel_bulkley'):
        result['message'] = "model 仅支持 'bingham' 或 'herschel_bulkley'"
        return result
    if len(shear_rate_s1) != len(shear_stress_pa):
        result['message'] = '剪切速率与剪切应力序列长度不一致'
        return result
    if len(shear_rate_s1) < 3:
        result['message'] = '至少需要 3 组流变数据点'
        return result

    gamma = np.asarray(shear_rate_s1, dtype=float)
    tau = np.asarray(shear_stress_pa, dtype=float)
    if np.any(~np.isfinite(gamma)) or np.any(~np.isfinite(tau)):
        result['message'] = '数据中存在非数值项'
        return result
    if np.any(gamma <= 0) or np.any(tau <= 0):
        result['message'] = '剪切速率与剪切应力必须为正数'
        return result

    # τ_y 候选网格：0 ~ min(τ) * 0.95
    tau_min = float(np.min(tau))
    candidates = np.linspace(0.0, tau_min * 0.95, 200)

    best: Dict[str, Any] | None = None
    for tau_y in candidates:
        excess = tau - tau_y
        mask = excess > 1e-9
        if int(mask.sum()) < 2:
            continue
        g_eff = gamma[mask]
        e_eff = excess[mask]
        if model == 'bingham':
            # τ - τ_y = η_p * γ̇ 线性回归（过原点）
            eta = float(np.dot(g_eff, e_eff) / np.dot(g_eff, g_eff))
            pred = tau_y + eta * gamma
            k_val: float | None = None
            n_val = 1.0
        else:
            # log(τ - τ_y) = log K + n * log γ̇
            log_g = np.log(g_eff)
            log_e = np.log(e_eff)
            n_val, log_k = np.polyfit(log_g, log_e, 1)
            k_val = float(np.exp(log_k))
            pred = tau_y + k_val * np.power(gamma, n_val)
        ss_res = float(np.sum((tau - pred) ** 2))
        ss_tot = float(np.sum((tau - np.mean(tau)) ** 2))
        r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0
        if best is None or r2 > best['r_squared']:
            best = {
                'yield_stress_pa': round(float(tau_y), 4),
                'consistency_k': round(k_val, 6) if k_val is not None else None,
                'flow_index_n': round(float(n_val), 4),
                'plastic_viscosity_pa_s': round(eta, 6) if model == 'bingham' else None,
                'r_squared': round(r2, 6),
            }

    if best is None:
        result['message'] = '有效数据点不足，无法完成拟合（请检查屈服前数据）'
        return result

    label = 'Bingham' if model == 'bingham' else 'Herschel-Bulkley'
    result.update(
        {
            'ok': True,
            'model': model,
            **best,
            'message': (
                f'{label} 拟合完成：τ_y={best["yield_stress_pa"]} Pa，'
                f'R²={best["r_squared"]}。'
                + (
                    f'塑性黏度 η_p={best["plastic_viscosity_pa_s"]} Pa·s。'
                    if model == 'bingham'
                    else f'稠度系数 K={best["consistency_k"]}，流性指数 n={best["flow_index_n"]}。'
                )
            ),
        }
    )
    return result
