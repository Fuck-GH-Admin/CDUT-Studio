---
name: lark-delivery
description: >
  飞书/Lark 云端交付流程。用户要求把长报告、方案、会议纪要、项目文档、表格、多维表格或日程写入/更新飞书时触发；
  也适用于“同步到飞书”“生成飞书文档”“更新 Base/多维表格”“安排日程”“查我的日历”“给我飞书链接”等表达。先用官方 Lark CLI/MCP 的 --help 或工具发现确认当前可用命令，再查询目标、执行最小写入，并只回传真实生成的 URL。
group: profer
version: "1.1.1"
---

# Lark Delivery

You are responsible for reliably delivering to the cloud the content the user explicitly asked to persist into 飞书 (Feishu/Lark). Use the official Lark CLI or the official Lark OpenAPI MCP already configured in Profer; do not re-implement the Feishu OpenAPI, and do not treat the Bot message bridge as the user's cloud drive permission.

## Identity and Credential Boundaries

- A 飞书 (Feishu/Lark) Bot is only for sending/receiving messages, attachments, and streaming cards, and for replying the final summary/links into the chat; it is not equivalent to the user's cloud document permissions.
- Resources such as 云文档 (cloud docs), 多维表格 (Base), Sheets, calendar events, and free/busy information must use the user's OAuth or the configured official MCP identity.
- Never read, ask the user to paste in conversation, copy into logs/Skills/documents, or include in final replies any token, refresh token, App Secret, Cookie, or Authorization header.
- When the settings page or CLI diagnostics show “未登录” (not logged in) or “需重新授权” (re-authorization required), clearly prompt the user to log in via「飞书云端能力」(Feishu Cloud Capabilities) in Profer settings; never fake an available state.

## Delivery Decision

1. **Short results** (usually under about 1 screen, and the user did not ask for archiving): reply directly in the current chat; do not create an extra cloud document.
2. **Long results or collaboration-worthy records** (reports, proposals, research, meeting minutes, tutorials, task lists): prefer creating or updating a 飞书云文档 (Feishu cloud doc), and give a short summary plus the real link in chat.
3. **Structured data** (multi-row records, well-defined fields, needs filtering, status tracking, or ongoing multi-person maintenance): prefer 多维表格 (Base); use Sheets only when the user explicitly prefers spreadsheets or the data is naturally a two-dimensional calculation sheet.
4. **Existing target link/name**: query, resolve, and confirm the target first, then update; never create a duplicate same-name resource because the lookup failed.

## Workflow

### 1. Discover capabilities first; never guess commands

- Prefer the official Lark MCP tools already discovered in this session.
- With the CLI, first run `lark-cli --help`, then the target subcommand's `--help`; commands, parameters, and output formats may vary across CLI versions.
- Use only commands and parameters confirmed to exist in the help output; never assemble write commands from memory or internet snippets.
- Confirm the user's OAuth status before writing. When a command fails, keep the deliverable local Markdown/CSV/JSON result; never pretend it was written to the cloud.

### 2. Query first, then write minimally

- For existing docs/Base/Sheets: first read or query the title, URL, ID, and current content/fields, and confirm they match the user's goal.
- For calendar operations: first query the primary calendar and the target time range; before creating or updating an event, confirm the timezone, start/end times, recurrence rules, and attendees to avoid double booking.
- When updating, modify only the sections, records, or fields the user requested; preserve unrelated content.
- For new resources: use a clear title and a structured body/fields; avoid pasting raw chat text in unformatted.
- For Base, confirm the table and fields first; only add missing fields when necessary. Verify record counts before batch writes to avoid duplicate creation.

### 3. Verify and report back

- On success, extract the resource URL from the **actual CLI/MCP response**; you may perform one extra read to confirm the resource is truly accessible.
- When no real URL exists, explicitly state “已执行但未取得可验证链接” (executed but no verifiable link obtained) and give a recoverable next step; never fabricate `feishu.cn`/`larksuite.com` URLs.
- Final message format for long results: one-sentence summary + URL; short results continue to be replied directly.
- Final replies in the 飞书 (Feishu/Lark) Bot channel likewise keep the real URL, so the existing Bridge can write it back verbatim.

## Failure and Recovery

- Not logged in / authorization expired: explain that re-authorization on the settings page is required; never attempt to bypass OAuth.
- Insufficient permissions: explain the resource permissions or scopes the target operation needs; do not retry writes repeatedly.
- Network, CLI/MCP, or remote write failure: keep the local content, and report both the completed local part and the failed step.
- Cloud write succeeded but message delivery failed: do not create the resource again; save the real URL in the local result and wait for a recoverable delivery.
- When a calendar event was written successfully but no verifiable event ID/link was returned, never claim the booking is complete; keep the request parameters and error message for verification before retrying.

## Artifact Convention

When a long result has been successfully delivered to 飞书 (Feishu/Lark), attach the following machine-readable marker to the final result; the URL must be the actual returned value and must not contain sensitive parameters:

```text
<profer_artifacts>
- type: lark_document | lark_base | lark_sheet | lark_calendar_event
  title: <resource title>
  url: <verified URL>
</profer_artifacts>
```

If nothing was successfully written to the cloud, do not output this marker.
