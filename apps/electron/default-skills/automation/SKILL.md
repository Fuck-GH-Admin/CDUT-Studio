---
name: automation
description: Profer 内嵌自动任务与定时任务 Skill，属于 Profer 自带能力而不是用户临时安装的外部 Skill。触发要非常宽泛、非常冗余：只要用户的话里出现任何“未来还要做”“以后继续看”“重复做”“再跑一次也有价值”“定期/周期/每天/每周/每月/每隔一段时间”“持续关注/持续观察/长期跟进/长期监控”“自动检查/自动汇总/自动生成/自动复盘/自动维护”“无人值守”“有变化告诉我”“异常时提醒我”“结果不好就调整”“查看运行记录”“优化已有任务”“暂停/恢复/删除/立即运行任务”等迹象，就应该触发此 Skill，先判断是否适合 Profer 定时任务。模糊场景也可以触发：例行报告、日报周报、项目状态、GitHub/邮件/飞书/文件/发布/CI/价格/竞品/数据源的反复检查，重复研究流程，定期整理知识，自动化工作流维护。高频触发不代表必须创建任务；一次性任务、短期提醒、纯日历闹钟、需要用户实时判断或没有长期价值的事，要明确说明不推荐创建 Profer 定时任务，并给出替代做法。
group: profer
version: "1.0.12"
---

# Profer Automation

You help the user judge, create, and maintain Profer's 定时任务 (Automation, scheduled tasks). This is a Profer built-in 技能 (Skill), distributed together with Profer into the default Skills and 工作区 (workspace) Skills; it does not depend on any extra user installation. Automations suit long-term recurring, unattended work with stable value; they do not suit temporary reminders or one-off tasks.

Profer ships built-in `automation` MCP tools. You must operate Automations through these tools; do not use `TaskCreate`, `CronCreate`, Bash `cron`, the system calendar, or hidden-comment protocols to create Profer Automations.

## Trigger Strategy

This Skill's trigger strategy is broad: **better to trigger frequently and then judge "not recommended to create" than to miss a potential automation opportunity**.

Whenever the user's request contains any of the signals below, use this Skill to judge first:

- Temporal signals (时间信号): 定期 (regularly), 每天 (every day), 每周 (every week), 每月 (every month), 每隔一段时间 (every once in a while), 长期 (long-term), 以后 (from now on), 下次 (next time), 持续 (continuously).
- Recurrence signals (重复信号): 经常 (often), 反复 (repeatedly), 例行 (routine), 固定流程 (fixed workflow), 每次都要 (have to do it every time), 还会再做 (will do it again).
- Observation signals (观察信号): 关注 (keep an eye on), 跟进 (follow up), 监控 (monitor), 检查 (check), 发现变化 (notice changes), 异常提醒 (alert on anomalies), 状态更新 (status updates).
- Output signals (产出信号): 日报 (daily report), 周报 (weekly report), 报告 (report), 汇总 (summary), 复盘 (retrospective), 提醒我看结果 (remind me to check the results), 整理进展 (organize progress).
- Automation signals (自动化信号): 自动跑 (run automatically), 无人值守 (unattended), 后台执行 (run in the background), 到点执行 (run on schedule), 帮我维护 (maintain it for me).
- Maintenance signals (维护信号): 查看任务 (view tasks), 运行记录 (run history), 效果不好 (results are poor), 修改频率 (change the frequency), 暂停 (pause), 恢复 (resume), 删除 (delete), 立即运行 (run now).

Triggering this Skill only enters the judgment flow; it does not mean a Profer Automation must be created. You must proactively distinguish "suited to long-term automation" from "only suited to run once right now".

## First Judge Whether Creation Is Worthwhile

Scenarios where Automations are recommended first:

- Long-term recurrence: done every day, every week, or at intervals, and expected to keep existing.
- Unattended: the Agent can complete the main work without the user's real-time participation.
- Stable goal: each run's input sources, judgment criteria, and deliverables are relatively stable.
- Compounding value: periodic reports, continuous monitoring, automatic summaries, status tracking, routine retrospectives.
- Verifiable: after each run, success, failure, omissions, or quality problems are visible.

Scenarios where creating an Automation is NOT recommended:

- One-off tasks, or something that only needs to run once right now.
- Short-term reminders, life alarms, simple countdowns.
- Requires real-time user judgment, approval, or a large amount of context.
- The execution goal is not yet stable; frequency and deliverables are unclear.
- The result has no long-term value and exists only so you "don't forget".

When not recommending, state the reason directly and offer a more suitable alternative: run it once now, persist the workflow as a 技能 (Skill), write it into the project plan, or have the user set a reminder in a calendar/reminder tool.

## Think It Through Before Creating

Before creating an Automation, clarify at minimum:

- `name`: a short name describing the long-term goal; do not write it as a one-off action.
- `scheduleType` + the corresponding fields: keep the frequency restrained unless the task genuinely needs high-frequency monitoring. See the table below for the selection strategy.
- `prompt`: the complete instruction sent to the Agent on each automatic run.
- Permission mode: the default `bypassPermissions` suits unattended runs; high-risk scenarios can set `auto`, but the run may hang because it needs approval.
- Session mode (`sessionMode`): default `daily` — triggers within the same calendar day reuse the same sub-session, and a new one is created automatically when the day changes; `reuse` always reuses the same sub-session to preserve long-term context. See below for the selection strategy.
- Agent preset (预设) (`presetId`, optional): the built-in `standard`/`code`/`minimal` or a custom preset of the task's 工作区 (workspace); it determines the sub-session's prompt segments, tool trimming, and reasoning strength. If omitted at creation, the current session's preset is inherited; tasks without an assignment follow the workspace default preset. A preset's permission settings do not override the task's permission mode — unattended safety comes first.

### How to Choose the Schedule Type

| scheduleType | Suitable scenarios | Required fields |
|---|---|---|
| `interval` | High-frequency monitoring (CI status, prices, inventory, chat reminders), minute-level response | `intervalMinutes` |
| `daily` | Daily morning briefings, daily reports, morning summaries | `timeOfDay` |
| `weekly` | Weekly reports, weekly retrospectives, preparation before weekly meetings | `dayOfWeek` + `timeOfDay` |
| `monthly` | Monthly reports, start-of-month reconciliation, end-of-month settlement, monthly retrospectives | `dayOfMonth` + `timeOfDay` |

`timeOfDay` uses 24-hour `HH:MM` (e.g., `09:30`, `22:00`). `dayOfWeek`: 0=Sunday, 1=Monday … 6=Saturday. `dayOfMonth`: 1-31.

### Short-Month Fallback Behavior of `monthly` (Important)

When `dayOfMonth` is 29/30/31, February (28/29 days) and the 30-day months April/June/September/November **automatically fall on the last day of that month** instead of being skipped. This means:

- Choosing 31 → actually triggers only 7 times a year (Jan/Mar/May/Jul/Aug/Oct/Dec); other months fall at month end.
- Choosing 29 → falls on Feb 28 in common years and Feb 29 in leap years.

When the user says "每月底" ("at the end of every month"), proactively suggest **the 28th** instead of the 31st; otherwise the user may assume it runs every month when it actually does not. Alternatively, explicitly explain this fallback behavior and let the user decide.

### How to Choose sessionMode

- `daily` (default): all triggers within the same calendar day write into the same sub-session; a new one is created automatically when the day changes. **Use this for the vast majority of Automations** — multiple runs within one day share context (fewer tabs in the left sidebar), and it resets automatically every day to avoid long-term token accumulation. For low-frequency tasks (interval ≥ 24 hours) the actual behavior is equivalent to "create new every time"; no separate configuration is needed.
- `reuse`: always reuse the same sub-session, preserving the long-term conversation history. Fits tasks that **genuinely need cross-day memory and knowingly accept the token cost** — continuously tracking the same long-lived issue, iteratively refining the same document.

The cost of `reuse`: context grows without bound as runs accumulate, and long tasks may face rising costs or automatic compaction from token buildup. If each run's output is independent (e.g., "看一下今天有什么新 PR" ("see what new PRs exist today")), use the default `daily`, not `reuse`.

If the user only says "帮我定期做 X" ("help me do X regularly") but the frequency or deliverable is unclear, use `AskUserQuestion` at most once to converge the missing pieces into an executable configuration. Do not make the user fill in long form-style text.

## How to Write the Prompt

An Automation's `prompt` must read like "task instructions that can run independently on every future run"; do not rely on implicit context from the current conversation.

A high-quality prompt includes:

- Goal: what this automatic run should accomplish.
- Scope: which repositories, files, systems, group chats, mailboxes, documents, or data sources to check.
- Judgment criteria: what counts as anomalous, important, or worth reporting.
- Output format: what the user finally receives — e.g., a summary, a list, a report, action suggestions.
- Failure handling: how to record and degrade when access fails, information is insufficient, or tools fail.
- Cross-run memory (strongly recommended): maintain `.context/automation/<task-slug>/notes.md` in the 工作区 (workspace) so each run accumulates on previous findings instead of starting from zero. **This section must be written into the prompt itself**, so the Agent actually executes it at runtime:
  - On trigger, first `Read` the file (skip if it does not exist on the first run), carrying over the observations, judgments, and todos from previous runs.
  - At the end of the run, `Edit` the same file: prepend a `## YYYY-MM-DD` entry recording this run's new findings; at the same time **proactively clean up old entries that are resolved, outdated, or no longer applicable** — the file is a rolling working memory, not an append-only log. Whenever this run touches related information (checked a repository, looked at CI status, read a document), judge on the spot whether old entries still hold and delete whatever can be deleted, so notes.md does not bloat into a new context burden.
- Self-iteration requirement: on consecutive failures, low-value output, or an unsuitable frequency, first `Read` the notes and the run history via `get_automation`, then use `update_automation` to modify the current task (prompt, frequency, `sessionMode`), pausing it if necessary.

`<task-slug>` is decided by you at creation time and written into the prompt: convert the task name to kebab-case (lowercase, spaces and punctuation → `-`, keep alphanumerics only), e.g., task name "每月 GitHub PR 汇总" ("monthly GitHub PR summary") → slug `monthly-github-pr-summary`. Once set, never change it, or the notes path breaks.

Do not write "请创建定时任务" ("please create a scheduled task") into the prompt. The prompt is the work to execute on each trigger, not a creation instruction.

### Prompt Template Example

A model prompt for a monthly report Automation (follow this structure when creating a task; copy the cross-run memory section verbatim):

    Goal: summarize the PRs merged into the Yuan-lai-ru-ci/ProferAI repository this month, grouped by category with impact noted.
    Scope: read the closed PR list of Yuan-lai-ru-ci/ProferAI and filter to those merged this month.
    Judgment criteria: for each PR, whether it introduces breaking changes, affects user configuration, or requires documentation updates.
    Output format: a Markdown report grouped into four sections: 「重大变更」(Major changes), 「新功能」(New features), 「修复」(Fixes), 「文档」(Documentation).

    Cross-run memory:
    - Before starting, Read .context/automation/monthly-pr-summary/notes.md (skip if it does not exist on the first run), carrying over previous judgments and todos
    - When done, Edit the same file and prepend a ## YYYY-MM-DD entry; while at it, clean up resolved/outdated old entries and keep notes.md lean

    Self-iteration: after 2 consecutive failures or low-value output, use get_automation to read the current task and adjust the prompt or frequency.

Tasks unsuited to cross-run memory: each run's output is fully independent and needs no accumulated context (e.g., "看一下今天有什么新 PR" ("see what new PRs exist today")). Such prompts do not need a cross-run memory section.

## Tool Usage

Call the `automation` MCP tools according to the scenario. Tool names depend on the runtime: on the Claude runtime use the bare names (as listed below); on the Pi Runtime the same tools carry the `mcp__automation__` prefix (e.g., `mcp__automation__list_automations`).

- `list_automations`: view existing tasks, avoid duplicate creation, and learn enabled/paused states.
- `get_automation`: view a single task's details and run history; while an Automation is executing, `id` may be omitted to read the current task.
- `create_automation`: create a new Profer Automation (定时任务); use it only for scenarios confirmed to be worth long-term recurrence.
- `update_automation`: modify any field — `name`, `prompt`, `scheduleType`/`intervalMinutes`/`timeOfDay`/`dayOfWeek`/`dayOfMonth` (frequency), `permissionMode` (permission mode), `sessionMode` (session mode), `presetId` (Agent preset/预设), `active` (enable/pause). Changing schedule-related fields automatically recomputes the next run time. While an Automation is executing, `id` may be omitted to update the current task.
- `delete_automation`: delete a task. Confirm before deleting unless the user explicitly asked.
- `run_automation_now`: use when the user asks for immediate verification, or when you need a trial run right after modifying a task. Do not trigger self re-entry while an Automation is executing.

Before creating, use `list_automations` to check whether an identical or similar task already exists. If an existing task can be edited, edit it; do not duplicate.

## Maintenance and Self-Iteration

When the user reviews or complains that an Automation is underperforming:

1. Use `get_automation` to view the prompt, frequency, permission mode, and recent run history.
2. Classify the problem: unsuitable frequency, prompt too vague, unclear scope, insufficient tool permissions, external system unavailable, or the task itself is unsuited to automation.
3. If it can be fixed directly, use `update_automation` to modify the prompt, frequency, or paused state.
4. If verification is needed, trial-run with `run_automation_now`.
5. Tell the user what changed and how the next trigger will differ.

When you yourself are the Agent auto-triggered by an Automation:

- Do not create new Automations.
- Execute the current round's task first.
- If you find the current task failing consecutively, producing low-value output, running too frequently, or carrying an incomplete prompt, call `get_automation` to read the current task, then use `update_automation` to modify it, pausing it if necessary.
- After modifying your own task, explain the reason and the changes in your final reply.

## Response Style

- After creating, modifying, pausing, or deleting, tell the user the concrete result in natural language.
- **Output language rule**: All user-facing output must be written in the user's language (e.g., Simplified Chinese when the user writes in Chinese).
- After creating a new task, remind the user: they can click the 「自动任务」 (Automation tasks) entry at the top left, find the newly created task, and set the model used when the task runs (models differ in cost and capability; choose one that matches the task's complexity).
- Do not expose internal tool-call JSON.
- When an Automation is not recommended, state explicitly that creating a Profer Automation (定时任务) is not recommended, and explain the more suitable way to handle it.
- For long-term recurring tasks, proactively suggest that the user can later check run history and adjust configuration from the Automation (定时任务) entry in the sidebar.
