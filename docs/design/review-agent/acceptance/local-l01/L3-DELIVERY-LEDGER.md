# L3｜主线接收台账

**主线基线**：`main` @ `566ea893f`
**集成工作树**：`/home/miku/Bot/CDUTStudio/wt/integration-l01`（分支 `integration/local-l01`）

## 本线已完成（Local-L01）

| 提交 | 内容 | 验证 |
|---|---|---|
| `30f8597ff` | 通用建案解除全局学年强制（按领域判定） | 单元 4 项 + 真机 `verify-academic-year` |
| `88566f00f` | 看门狗首字节只认内容事件；失败原因透出到界面 | 针对性 35 项 |
| `4cbab30f7` | 切换领域到按学年组织评审业务时校验学年一致性 | 单元 2 项 |
| `5fc6dd846` | L0 基线核验结论 | — |
| `681a7df54` | L2 十条线共享入口现状与缺口 | — |
| `81565b33e` | E2E 新增学年解耦真机场景 | 真机 3 项 + flow-core 无回归 |
| `4cbab30f7` | 切换领域到按学年组织评审业务时校验学年一致性 | 单元 2 项 |
| `566ea893f` | 提示词事前告知合法 FieldSpec（从历史定向移植字段契约） | 单元 3 项 + 真机确认已进入下发 prompt |

## 十条线接收记录（Local-L04）

**集成基线**：`main` @ `4bf3d4404`（B1+B2+B3 全部合入后）
**来源固定 SHA 与分支头核对**：十条均同步，无追加提交。

| 线 | 来源固定 SHA | 合入方式 | 状态 | 生产消费者 / 缺口 |
|---|---|---|---|---|
| T01 | `ac2947fc6` | `ecc00e66b` | **WIRED** | `TemplateWizardPanel`（条件编辑、试跑、导入导出） |
| T02 | `36687a952` | `1babad8e7` | **BLOCKED_BRIDGE** | `ReviewV3T02MaterialCoveragePanel` 无生产引用；缺 Main 派生 `B2MainContext` 的只读 IPC（`previewT02StagedSource/Inventory` 需要 staging 服务单例 + 按 sender 派生 ctx） |
| T03 | `28528b02b` | `fae977a17` + 接线 `4bf3d4404` | **WIRED** | `V2CasePanel` → `ReviewV3T03FactWorkbench`（与观察项面板同案卷上下文） |
| T04 | `54678e8ee` | `5df23c6da` | **BLOCKED_BRIDGE** | `evaluateT04Plan` 仅文件内自用；缺「冻结 Plan binding + 已确认事实/政策选择」的 Main 调用入口 |
| T05 | `41c3f2fa9` | B2 合入 | **WIRED** | `V2CasePanel` → `ReviewV3T05HumanWorkflow` + `RunDecision`（替换旧 `BusinessFlowSection`） |
| T06 | `9ac93052f` | B2 合入 | **WIRED** | `BatchPanel` → `ReviewV3T06BatchIntakePreview` |
| T07 | `37c6d3212` | B2 合入 + 桥接 `e4e4d50f3` | **JOURNEY_VERIFIED** | `BatchPanel` 区 → `ReviewV3T07Workbench` → `ReviewV3T07JudgePanel`；桥接新增 `review-v3-t07-state-store`（原子写 + revision 乐观锁）、`review-v3-t07-main-service`（Main 派生 actor / 投影 / 动作）、IPC `T07_GET_VIEW`/`T07_APPLY_ACTION`/`T07_INIT_STATE` |
| T08 | `d83b4be32` | B3 合入 | **WIRED** | `AssistantDrawer` → `ReviewV3T08ReportPanel` |
| T09 | `474cf5f84` | B2 合入 | **BLOCKED_BRIDGE** | `offline-codec` 仅被 `offline-issuer` 使用，issuer 无入口；缺任务签发/回件导入的 Main IPC 与附件登记桥接 |
| T10 | `3679cc4e3` | B3 合入 | **WIRED** | `ContentReviewView` → `ReviewV3T10WorkspaceOverview` |

**T05 × T10 交叠文件 `V2CasePanel.tsx`**：git 自动三方合并，已逐项核对双方内容均在——
T05 的 `ReviewV3T05HumanWorkflow`/`RunDecision` 在（4 处引用）、旧 `BusinessFlowSection` 已删；
T10 的 `onCaseOpened`（7 处）、「案卷办理」标题、折叠区、条件化姓名字段均在。未整文件覆盖。

## 真机验证

| 旅程 | 结果 | 证据 |
|---|---|---|
| A15 起点（T01 模板 → 无学年绑案） | **PASS** | `saveDraft` → `publish` → `createCase`（contract-review 领域、无学年）→ 学年为空、`templateBound=e2e-t01-lab-request` |
| A15 完整（初审/终审/决定/报告） | NOT_RUN | 依赖 T04 规则执行入口与 T05 阶段决定在真实案卷上的联调 |
| A09 补件/复审 | NOT_RUN | T05 已接线，但需真实材料往返与申诉复核联测 |
| A12+A14 批次/评委 | **PASS（评委链路）** | `flow-t07-judging` 真机：2 案 → 批次 → 轮次 rev1 → 4 次分配 rev5 → 双评委各 2 项评分 rev9 → 组织者排名（各 2 有效评委、total 5）→ 定稿 rev10 |
| 冷重启恢复 | NOT_RUN | 待 T 线状态持久化后复验 |
| 原基线不回归 | **PASS** | `bun test --isolate` 4747 pass / 0 fail / 5 skip；D4 50 套、学年解耦、看门狗用例均在 |

## 接收流程（每次）

1. 拿到固定 commit + 交付说明。
2. `git fetch` 后查重：新能力是否与 main 等价实现重复（用导出名 + 调用链比对，不整分支 diff）。
3. 复用其功能模块，只补共享 Main / IPC / Preload 桥接。
4. 解决类型冲突、调用错误、持久化不兼容。
5. **按修改范围选验证**：只改 Main 用针对性单元；改 IPC/持久化加 `verify-*` 真机场景；重要集成节点跑 `flow-full`。
6. 合入 main，并在上表记录「可操作程度」（如：可建案但无 UI / 可跑审核无报告）。
7. 若产物缺它自身的业务实现而无法运行 → 标 `WAITING_FOR_OWNER`，继续其他线。

## 回滚点

每个接收 commit 独立提交，回滚只需 revert 对应 sha；不 squash 多条线。
