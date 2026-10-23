export interface AgentPlatformProjectCandidate {
  rootPath: string
  name: string
  type: string
  packageName?: string
  gitRemote?: string
}

export interface AgentPlatformPromptOptions {
  platform: NodeJS.Platform
  shellPath?: string
  agentCwd?: string
  projectCandidates?: AgentPlatformProjectCandidate[]
  isPiRuntime?: boolean
}

function escapePromptText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function projectRootsBlock(candidates: AgentPlatformProjectCandidate[]): string {
  if (candidates.length === 0) {
    return '- No project candidates are currently detected by CDUT Studio; inspect the actual directory tree first, then decide which root to operate on.'
  }
  if (candidates.length === 1) {
    const candidate = candidates[0]!
    return `- CDUT Studio detected exactly one project candidate; treat it as the primary active project root:
  - **Primary Active Project Root**: ${escapePromptText(candidate.rootPath)}
  - ${candidate.name} (${candidate.type})${candidate.packageName ? `, package=${escapePromptText(candidate.packageName)}` : ''}${candidate.gitRemote ? `, remote=${escapePromptText(candidate.gitRemote)}` : ''}
- Run project inspection, git, build, and test commands directly in this root. Do NOT probe the empty session sandbox first.`
  }
  return `- CDUT Studio detected the following project candidates. Disambiguate by project name, directory name, package name, Git remote, or type; use the corresponding absolute root directly only on a unique match:\n${candidates.map((candidate) => `  - ${candidate.name} (${candidate.type}): ${escapePromptText(candidate.rootPath)}${candidate.packageName ? `, package=${escapePromptText(candidate.packageName)}` : ''}${candidate.gitRemote ? `, remote=${escapePromptText(candidate.gitRemote)}` : ''}`).join('\n')}`
}

function commonToolingRules(isPiRuntime: boolean | undefined): string {
  const editShape = isPiRuntime
    ? '`path + edits[].oldText/newText`'
    : '`file_path + old_string/new_string`'
  return `- Edit is exact text replacement: if the tool reports oldText/old_string not found, immediately re-Read the relevant region of the current file, check spacing, indentation, and line endings, then retry; never reuse a stale snapshot from a failed call.\n- Use the actual tool parameter shape ${editShape}; never mix the other runtime's parameter names into the current call.\n- Run directory checks, git diff --check, typecheck, and tests as separate commands; never chain multiple checks into one compound command with \`;\`, which can mask the real failing step.`
}

/**
 * 会话沙箱 cwd 与用户项目根的边界说明。
 *
 * `agentCwd` 是 CDUT Studio 的隔离工作区，通常为空且不是 Git 仓库；
 * 用户真实代码位于附加目录 / 项目候选中。缺少这段说明时，模型容易在 cwd
 * 里执行 `git status` 失败后误判项目损坏，甚至尝试 `git init` 破坏隔离。
 */
const DIRECTORY_GROUNDING_RULES = `## Working Directory vs. Project Root

- The current agent cwd is a CDUT Studio session sandbox. It is usually empty and is NOT a Git repository.
- User project code lives in the attached directories and detected project candidates above (when present). Resolve project reads, edits, greps, and test commands against those absolute roots.
- When exactly one project candidate is listed above, treat it as the primary project root and run project commands there immediately; never run \`git status\`, builds, or tests in the session cwd first.
- Never run \`git init\`, create package manifests, or install dependencies in the session cwd to "make it work"; if no project root is available, ask the user or inspect the authorized directories.
- Run project commands with the project root as the working directory (for example \`git -C <project_root> status\`); never assume the cwd is the repository.
- Write generated artifacts to the session cwd unless the user explicitly asks for a project path.`

/**
 * 构造平台运行时 overlay。核心安全规则和工作区规则仍由 agent-prompt-builder 单一注入，
 * 本模块只描述当前 OS、shell 和路径事实，避免复制两套完整系统提示词。
 */
export function buildAgentPlatformPrompt(options: AgentPlatformPromptOptions): string {
  const shellPath = options.shellPath
    ?? (options.isPiRuntime
      ? 'Bash unavailable (shell_not_found)'
      : options.platform === 'win32'
        ? 'PowerShell (detected by the runtime)'
        : options.platform === 'darwin'
          ? '/bin/zsh'
          : '/bin/sh')
  const shellExecutionDescription = options.isPiRuntime && !options.shellPath
    ? 'The Bash tool is currently not executable; do not guess-run via zsh/sh—report shell_not_found to the user first.'
    : "POSIX commands run via that shell's non-interactive `-c`."
  const candidateBlock = projectRootsBlock(options.projectCandidates ?? [])

  if (options.platform === 'win32') {
    return `## Current Platform & Project Paths (Windows)

- Current platform: Windows (win32). Current agent shell: ${escapePromptText(shellPath)}.
- Use only the Windows shell and path format actually provided by the runtime; if the runtime provides path conversion, strictly follow its returned values—never mix path syntaxes yourself.
- Current agent cwd: ${escapePromptText(options.agentCwd ?? 'not provided')}. The cwd is not the project root; do not guess \`src\` or test file locations just because a cwd exists.
${candidateBlock}
- The current shell's command syntax and path rules follow the shell actually provided by the runtime; never copy commands over from a different shell.
${commonToolingRules(options.isPiRuntime)}

${DIRECTORY_GROUNDING_RULES}`
  }

  if (options.platform === 'darwin') {
    return `## Current Platform & Project Paths (macOS)

- Current platform: macOS (darwin). Current agent shell: ${escapePromptText(shellPath)}; ${shellExecutionDescription}
- The current execution environment is a POSIX shell; use only the commands and path formats it actually supports—never treat commands, paths, or environment variables from other operating systems as current facts.
- Current agent cwd: ${escapePromptText(options.agentCwd ?? 'not provided')}. The cwd is not the project root; do not assume \`src\` exists at the repo root—inspect the actual directory tree first.
${candidateBlock}
- A macOS GUI process's PATH may be shorter than a terminal's; prefer absolute paths provided by CDUT Studio, \`git -C <root> ...\`, and bun/node/git actually probed from the current shell—never guess from the environment.
${commonToolingRules(options.isPiRuntime)}

${DIRECTORY_GROUNDING_RULES}`
  }

  return `## Current Platform & Project Paths (POSIX)

- Current platform: ${escapePromptText(options.platform)}. Current agent shell: ${escapePromptText(shellPath)}.
- Current agent cwd: ${escapePromptText(options.agentCwd ?? 'not provided')}; confirm the actual project root first—never assume a root-level \`src\` exists.
${candidateBlock}
${commonToolingRules(options.isPiRuntime)}

${DIRECTORY_GROUNDING_RULES}`
}
