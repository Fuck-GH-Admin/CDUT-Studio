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
})
