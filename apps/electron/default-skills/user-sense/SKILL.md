---
name: user-sense
description: Profer 内置的"用户感知"默认 Skill，开箱即用。目标是通过首次扫描本地环境（系统信息、已安装应用、文件类型统计、最近打开文件、浏览器书签分类）构建"本地用户画像"，让 Profer 懂用户的工作性质、作息习惯与兴趣方向，从而提供个性化对话和主动服务（Proactive Center）。当用户是新工作区首次使用、画像文件不存在或明显过期（>30 天）、用户提到"更懂我""记住我的偏好/习惯/工作性质""Proactive Center""个性化推荐"，或对话语境需要理解用户身份（开发者/科研/办公/娱乐）时触发。触发后先检查画像是否存在，再决定是构建、更新还是仅消费画像；构建画像前必须向用户说明扫描范围并征得同意，未经同意不得扫描。
group: profer
version: "1.0.2"
---

# UserSense（用户感知 / User Perception）

A Profer default Skill shipped with the app, available out of the box to all users. Responsibility: **build, maintain, and consume the local 用户画像 (user profile)**.

用户画像 (user profile) = **inferred conclusions** about the user's work nature, routines, and interests (e.g. "活跃时段集中在凌晨" (active hours concentrated before dawn), "工具以开发类为主" (tooling dominated by development tools), "近期有论文阅读活动" (recent paper-reading activity)), stored in the workspace file `workspace-files/.context/memory-archive/user-profile.md`.

## Hard Privacy Constraints (Come Before Everything Else)

1. **Local processing**: all scanning happens on the user's machine; profile conclusions are **never uploaded to any server**.
2. **Store conclusions, never raw data**: the profile records only inferred conclusions; it **never records** concrete file paths, file names, or site URLs.
3. **Consent before scanning**: before building the profile for the first time, explain to the user the scope to be scanned (system info / installed apps / file-type statistics / recently opened files / browser bookmark categories), clarify that "no file contents are collected and nothing leaves this machine", and only execute after consent is granted.
4. **User in control**: inform the user that the profile can be viewed, edited, disabled per source, and wiped with one click in the 能力中心 (Capability Center); once a source is turned off, that source is no longer collected.
5. If the user explicitly declines, skip building the profile and go straight into the conversation; do not repeatedly persuade.

## Trigger and Decision Flow

After this Skill is triggered, decide in the following order:

1. Read the profile file (`workspace-files/.context/memory-archive/user-profile.md`; note the distinction between `manual` and `auto` blocks)
2. Profile missing → explain the scan scope to the user and obtain consent; after consent, run the "首次构建" (first-time build)
3. Profile exists but `updated` is older than 30 days → propose an incremental update (never forced)
4. Profile exists and is fresh → consume it directly (apply profile insights within the conversation; do not rescan)

## First-Time Profile Build Workflow

Execute in L0→L4 order; each layer only collects statistics and writes conclusions. The following are command references for the Windows platform:

### L0 System & Routine
```powershell
# 系统信息（OS/架构/语言/时区）
Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, OSLanguage, MUILanguages
Get-TimeZone | Select-Object Id
# 作息模式：统计本机 Agent 会话文件（~/.profer/agent-sessions/*.jsonl）创建时间的时段分布
Get-ChildItem "$env:USERPROFILE\.profer\agent-sessions" -Filter *.jsonl -ErrorAction SilentlyContinue |
  ForEach-Object { (Get-Date $_.CreationTime).Hour } | Group-Object | Sort-Object Count -Descending | Select-Object -First 3 Name, Count
```
Example conclusion: `活跃时段集中在凌晨 1-5 点（来源：系统/会话历史，置信度：中）` (active hours concentrated between 1–5 a.m.; source: system/session history; confidence: medium).

### L1 Installed Apps
```powershell
# 注册表 Uninstall 键（HKLM 64/32 位 + HKCU），去重后按 DisplayName 统计
Get-ItemProperty HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*, HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*, HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\* -ErrorAction SilentlyContinue |
  Where-Object DisplayName | Select-Object -ExpandProperty DisplayName | Sort-Object -Unique
```
Example conclusion: `安装有 VS Code/JetBrains 等开发工具，推断为开发者（来源：应用，置信度：高）` (development tools such as VS Code/JetBrains installed → inferred developer; source: apps; confidence: high). Category dimensions: 开发 (development) / 办公 (office) / 设计 (design) / 娱乐 (entertainment) / 游戏 (gaming) / 通讯 (communication).

### L2 File-Type Statistics
```powershell
# 统计用户目录下常见目录的扩展名分布（只数数量，不列文件名）
Get-ChildItem "$env:USERPROFILE\Downloads", "$env:USERPROFILE\Documents", "$env:USERPROFILE\Desktop" -File -Recurse -Depth 1 -ErrorAction SilentlyContinue |
  Group-Object Extension | Sort-Object Count -Descending | Select-Object -First 8 Name, Count
```
Example conclusion: `近期下载以 PDF 为主（30+），推断有论文/文档阅读活动（来源：文件，置信度：中）` (recent downloads dominated by PDFs (30+) → inferred paper/document reading activity; source: files; confidence: medium). **Never record any file name or path**.

### L3 Recently Opened Files
```powershell
# Windows Recent 目录（.lnk 快捷方式），只按扩展名统计，不解析目标路径
Get-ChildItem "$env:APPDATA\Microsoft\Windows\Recent" -Filter *.lnk -ErrorAction SilentlyContinue |
  ForEach-Object { $_.BaseName -replace '.*\.', '.' } | Group-Object | Sort-Object Count -Descending | Select-Object -First 6 Name, Count
```
Example conclusion: `近期频繁处理 .xlsx，推断为运营/数据场景（来源：最近文件，置信度：中）` (frequent .xlsx handling recently → inferred operations/data scenario; source: recent files; confidence: medium).

### L4 Browser Bookmark Categories (Enabled by Default)
```powershell
# Chrome/Edge 书签 JSON，只统计顶层文件夹 children 数量与名称分类，不输出站点 URL
$paths = @("$env:LOCALAPPDATA\Google\Chrome\User Data\Default\Bookmarks", "$env:LOCALAPPDATA\Microsoft\Edge\User Data\Default\Bookmarks")
foreach ($p in $paths) {
  if (Test-Path $p) {
    $bookmarks = Get-Content $p -Raw | ConvertFrom-Json
    $bookmarks.roots.bookmark_bar.children | Where-Object type -eq 'folder' | Select-Object -ExpandProperty name
  }
}
```
Example conclusion: `书签分类以视频/游戏/学习类为主，推断对娱乐内容有稳定兴趣（来源：书签，置信度：中）` (bookmark categories dominated by video/gaming/study → stable interest in entertainment content; source: bookmarks; confidence: medium). **Write only category proportions, never concrete sites**.

## Profile File Format Rules

When updating `workspace-files/.context/memory-archive/user-profile.md`, follow these rules:

1. Auto-derived conclusions go into the `## 自动画像（auto）` block; manual content (existing blocks such as `## 用户画像`) stays untouched and is marked as `manual`
2. Each conclusion follows the format: `- **<结论>**（来源：<系统/应用/文件/最近文件/书签>，置信度：<高/中/低>，时间：YYYY-MM-DD）` (i.e. `- **<conclusion>**（source: <system/apps/files/recent files/bookmarks>，confidence: <high/medium/low>，date: YYYY-MM-DD）`)
3. Update `updated: YYYY-MM-DD` in the frontmatter
4. Do not re-write an identical conclusion that already exists and is still fresh (<30 days)
5. Once the user has disabled a source in the Capability Center, that source is never scanned or written again
6. **Language rule**: reasoning inside this Skill is performed in English; persona files and user-facing output are written in the user's language

## How the Profile Is Consumed

- **Conversation personalization**: reference profile insights when task-relevant (e.g. recommend a paper close-reading workflow for research users, or assume a code-standard context by default for developer users), but **do not proactively output profile contents** unless the user asks
- **Proactive Center integration**: profile signals feed the Proactive Center (late-night activity → suggest a work mode; PDF backlog → remind to organize / close-read; frequent project switching → recommend quick switching); when a matching signal is found, a suggestion may be raised to the user
- **Stale / changed profile**: when user behavior changes noticeably (e.g. many new design tools installed), an incremental update may be proposed; never scan on your own initiative

## Boundaries

- Do not collect browser history, chat logs, passwords, or cookies; only perform bookmark **category** statistics
- No uploads of any kind and no remote analysis
- After the user declines or turns this off, respect the choice and do not ask again
- This Skill is a process definition; the main-process ProfileScanner (a faster, more comprehensive native scan) is a future enhancement that will automatically take over collection once implemented — the consumption and maintenance rules of this Skill remain unchanged
