import { describe, expect, test } from 'bun:test'
import { buildAgentPlatformPrompt } from './agent-platform-prompt'

describe('agent platform prompt overlay', () => {
  const candidates = [{
    rootPath: '/Users/mac/profer/profer-main',
    name: 'proma',
    type: 'git-repository',
    packageName: 'proma',
    gitRemote: 'https://github.com/Yuan-lai-ru-ci/ProferAI.git',
  }]

  test('macOS overlay describes the real POSIX shell and rejects Windows-only commands', () => {
    const prompt = buildAgentPlatformPrompt({
      platform: 'darwin',
      shellPath: '/bin/zsh',
      agentCwd: '/Users/mac/.cdutai/agent-workspaces/profer/session-1',
      projectCandidates: candidates,
      isPiRuntime: true,
    })

    expect(prompt).toContain('Current platform: macOS (darwin)')
    expect(prompt).toContain('Current agent shell: /bin/zsh')
    expect(prompt).toContain('The current execution environment is a POSIX shell')
    expect(prompt).toContain('from other operating systems')
    expect(prompt).toContain('/Users/mac/profer/profer-main')
    expect(prompt).toContain('do not assume `src` exists at the repo root')
    expect(prompt).toContain('path + edits[].oldText/newText')
    expect(prompt).toContain('never chain multiple checks into one compound command with `;`')
    expect(prompt).not.toContain('Current platform: Windows')
  })

  test('Pi macOS overlay reports shell_not_found instead of claiming zsh when Bash is unavailable', () => {
    const prompt = buildAgentPlatformPrompt({
      platform: 'darwin',
      agentCwd: '/Users/mac/session-1',
      isPiRuntime: true,
    })

    expect(prompt).toContain('Current agent shell: Bash unavailable (shell_not_found)')
    expect(prompt).toContain('do not guess-run via zsh/sh')
    expect(prompt).not.toContain('Current agent shell: /bin/zsh')
  })

  test('Windows overlay describes detected shell choices and rejects macOS assumptions', () => {
    const prompt = buildAgentPlatformPrompt({
      platform: 'win32',
      shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
      agentCwd: 'C:\\Users\\alice\\session-1',
      projectCandidates: [{ rootPath: 'D:\\repo', name: 'repo', type: 'git-repository' }],
      isPiRuntime: false,
    })

    expect(prompt).toContain('Current platform: Windows (win32)')
    expect(prompt).toContain('C:\\Program Files\\Git\\bin\\bash.exe')
    expect(prompt).toContain('Use only the Windows shell and path format actually provided by the runtime')
    expect(prompt).toContain('strictly follow its returned values')
    expect(prompt).toContain('file_path + old_string/new_string')
    expect(prompt).not.toContain('Current platform: macOS')
  })

  // 回归：cwd 是空沙箱而非 Git 仓库，缺少边界说明会导致模型在 cwd 里 git init。
  test('三个平台都注入会话沙箱与项目根边界规则', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const prompt = buildAgentPlatformPrompt({
        platform,
        agentCwd: '/tmp/.cdutai/agent-workspaces/default/session-1',
        projectCandidates: candidates,
      })

      expect(prompt).toContain('## Working Directory vs. Project Root')
      expect(prompt).toContain('It is usually empty and is NOT a Git repository')
      expect(prompt).toContain('Never run `git init`')
      expect(prompt).toContain('git -C <project_root> status')
    }
  })

  test('仅一个项目候选时标记 Primary Active Project Root', () => {
    const prompt = buildAgentPlatformPrompt({
      platform: 'win32',
      agentCwd: 'C:\\Users\\alice\\.cdutai\\agent-workspaces\\default\\s1',
      projectCandidates: candidates,
    })

    expect(prompt).toContain('**Primary Active Project Root**: /Users/mac/profer/profer-main')
    expect(prompt).toContain('Do NOT probe the empty session sandbox first')
    expect(prompt).toContain('never run `git status`, builds, or tests in the session cwd first')
  })

  test('多个或零个项目候选时不强行指定主项目', () => {
    const multiple = buildAgentPlatformPrompt({
      platform: 'darwin',
      projectCandidates: [
        ...candidates,
        { rootPath: '/Users/mac/second', name: 'second', type: 'node-project' },
      ],
    })
    expect(multiple).not.toContain('Primary Active Project Root')

    const none = buildAgentPlatformPrompt({ platform: 'darwin' })
    expect(none).not.toContain('Primary Active Project Root')
    expect(none).toContain('No project candidates are currently detected')
  })
})
