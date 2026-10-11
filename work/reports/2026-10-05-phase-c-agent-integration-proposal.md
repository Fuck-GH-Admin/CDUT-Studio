# 阶段 C 讨论稿：审核功能接入 Agent（宝宝决策用）

> 前置事实（本轮已验收的真实基础）：
> - 审核链路 V2 全部走通：模板→建案→材料登记→PDF 解析/图片 OCR（真实 tesseract）→真实模型审核→人工确认→补件闭环→三阶段决定→导出报告。
> - 链路入口全部是**结构化 IPC 通道**（`review-v2:*`），不是 UI 内部状态：`CREATE_CASE_V2 / PICK_REGISTER_MATERIAL_V2 / RUN_REVIEW_V2 / CORRECT_OBSERVATION_V2 / RESPOND_SUPPLEMENT_V2 / RESOLVE_SUPPLEMENT_V2 / RECORD_STAGE_DECISION_V2 / EXPORT_REPORT_V2 / GET_RUN_OBSERVATIONS_V2`。这是 Agent 可自动操作的根本原因——**Agent 不用点 UI，直接走同一层 IPC**。
> - 审核域已有工具层雏形：`review-tools.ts` 的 `buildReviewTools()`（read_subject_field / search_document_text / record_observation / link_evidence / submit_check）——但它是给"审核执行模型"用的，不是给通用 Agent 用的。

## 三个方案（从稳到激进）

### 方案一：审核技能包（Skill）——推荐先做
把审核链路做成一个全局 Skill（`skill-review-operator`，进 `global-skills` 目录，与 builtin-* 并列）。Skill 的 SKILL.md 写清楚操作手册，让通用 Agent 在会话里通过 **受控 IPC 桥** 逐步调用：

```
Agent 会话 → skill 指引 → review-operator IPC 桥 → review-v2:* handler → 真实链路
```

需要新增一个窄桥（`review-operator-bridge.ts`）：只暴露 8-10 个动词（create_case / register_material / run_review / get_observations / confirm_observation / request_supplement / resolve_supplement / pass_stage / export_report），每个动词带参数校验 + 审计日志（谁、何时、对哪个案卷做了什么）。

- 优点：不动 Agent 编排器；权限边界清晰（桥里白名单）；可审计；与现有"技能"心智一致。
- 缺点：Agent 每一步都要自己决定下一步（半自动），复杂案卷要 Agent 有较强规划。

### 方案二：审核工作流托管（Delegation/编排层）
在 agent-orchestrator 的 delegation 机制里加"审核预设"（agent-delegation-preset 已有 schema）：用户把案卷拖给 Agent，Agent 拿到**预设工作流**（登记→审核→汇总→等人工→按结果分支），自己按 preset 状态机推进，只在需要人工确认/补件时 ask-user。

- 优点：真正的"自动操作"，人工只在卡点出现；复用现有 delegation 基建。
- 缺点：工程量更大；工作流状态机与审核 stage 机（R1…）有双机对齐成本。

### 方案三：审核域工具注册进 Agent 工具表
把 `buildReviewTools` 扩展为通用 Agent 工具（record_observation、submit_check 等已有，补 run_review/export 等），挂在 agent 会话工具列表上。

- 优点：最灵活。
- 缺点：审核是**强状态机 + 不可冒认**域，散工具容易让 Agent 绕过阶段门控（比如跳过补件直接 pass）——不建议单独用，只作为方案一/二的底层。

## 我的建议
**先方案一，验收后升方案二**：方案一一两周内可用（桥 + 一个 Skill + 3 条真实旅程验收），方案二在桥之上包 preset 就顺理成章。方案三的工具收敛进桥内复用。

## 需要宝宝拍板的三个问题
1. **权限边界**：Agent 可以代替人工"判定满足/阶段通过"吗？还是这两类决定必须人工（Agent 只能准备到"待人工"状态）？我倾向：**Agent 可执行登记/审核/汇总/导出，但 stage 决定与补件判定必须人工**（责任链清晰，符合 A05 精神）。
2. **触发方式**：Agent 主动轮询（案卷 submitted 就开跑）还是用户显式指派（"帮我把这个案卷审了"）？显式指派更稳，成本也低。
3. **审计要求**：Agent 的每步操作要不要在案卷时间线里以"操作者=agent"单独可辨？（现在命令带 actor，天然支持，只需 UI 展示。）

——定了我就可以立阶段 C 的 goal 开工。
