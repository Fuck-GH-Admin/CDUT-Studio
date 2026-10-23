import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { appendPiHarnessEvent, loadPiHarnessSnapshot } from './pi-harness/pi-harness-store'
import { PI_HARNESS_EVENT_VERSION, type PiHarnessEvent } from './pi-harness/types'
import { createPiFileCheckpoint, loadPiFileCheckpoint, restorePiFileCheckpoint } from './pi-file-checkpoint'
import { getPiCheckpointsDir } from './config-paths'

type AgentSessionManager = typeof import('./agent-session-manager')

let manager: AgentSessionManager
let tempHome: string
const originalHome = process.env.HOME
const originalPromaDev = process.env.PROMA_DEV
const originalProferConfigDir = process.env.PROFER_CONFIG_DIR
const appendedCustomMessages: Array<{ customType: string; content: string; display: boolean; details?: unknown }> = []
let forkArtifactGate: Promise<void> | undefined
let forkArtifactStarted: (() => void) | undefined
let releaseForkArtifact: (() => void) | undefined

// 分叉测试只替换本地 Pi 分叉边界，不能 mock 正式 Pi SDK 包：Bun 的 mock.module()
// 在非隔离调用中会污染后续 SDK smoke / model registry 测试。
mock.module('./pi-session-fork', () => ({
  forkPiSessionArtifact: async () => {
    forkArtifactStarted?.()
    if (forkArtifactGate) await forkArtifactGate
    const forkFile = join(tempHome, '.pi-fork.jsonl')
    writeFileSync(forkFile, '', 'utf-8')
    return {
      getSessionFile: () => forkFile,
      getSessionId: () => 'pi-fork-session',
      getEntry: (entryId: string) => entryId === 'entry-keep' ? { id: entryId } : undefined,
      appendCustomMessageEntry: (customType: string, content: string, display: boolean, details?: unknown) => {
        appendedCustomMessages.push({ customType, content, display, details })
        return 'interrupted-context'
      },
    }
  },
}))

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(process.env.HOME ?? tempHome, 'Library', 'Application Support'),
  },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: {},
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

function writeAgentSessionsIndex(sessions: Array<{
  id: string
  title: string
  workspaceId: string
  createdAt: number
  updatedAt: number
  agentRuntime?: string
  sdkSessionId?: string
  piSessionFile?: string
  piEntryBindings?: Record<string, string>
  piFileCheckpoints?: Record<string, string>
}>): void {
  const dir = join(tempHome, 'config')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent-sessions.json'), JSON.stringify({ version: 1, sessions }), 'utf-8')
}

function writeAgentWorkspacesIndex(workspaces: Array<{
  id: string
  name: string
  slug: string
  createdAt: number
  updatedAt: number
}>): void {
  const dir = join(tempHome, 'config')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent-workspaces.json'), JSON.stringify({ version: 3, workspaces: workspaces.map((w) => ({ ...w, type: 'personal' })) }), 'utf-8')
}

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'profer-pi-fork-test-'))
  process.env.HOME = tempHome
  process.env.PROMA_DEV = '0'
  process.env.PROFER_CONFIG_DIR = join(tempHome, 'config')
  manager = await import('./agent-session-manager')
})

afterAll(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalPromaDev === undefined) {
    delete process.env.PROMA_DEV
  } else {
    process.env.PROMA_DEV = originalPromaDev
  }
  if (originalProferConfigDir === undefined) {
    delete process.env.PROFER_CONFIG_DIR
  } else {
    process.env.PROFER_CONFIG_DIR = originalProferConfigDir
  }
  rmSync(tempHome, { recursive: true, force: true })
})

beforeEach(() => {
  appendedCustomMessages.length = 0
  forkArtifactGate = undefined
  forkArtifactStarted = undefined
  releaseForkArtifact = undefined
})

describe('Pi 会话分叉', () => {
  test('Given 源会话仍在运行 When 分叉 Then 在读取 artifact 前拒绝', async () => {
    const sessionId = 'pi-active-source'
    writeAgentSessionsIndex([{
      id: sessionId,
      title: '运行中的 Pi 会话',
      workspaceId: 'workspace-a',
      createdAt: 1,
      updatedAt: 1,
      agentRuntime: 'pi',
      sdkSessionId: 'pi-session-id',
      piSessionFile: join(tempHome, 'pi-active-session.jsonl'),
      piEntryBindings: { 'assistant-1': 'entry-keep' },
    }])
    writeFileSync(join(tempHome, 'pi-active-session.jsonl'), '', 'utf-8')
    manager.setAgentSessionActiveChecker(() => true)

    try {
      await expect(manager.forkAgentSession({ sessionId, upToMessageUuid: 'assistant-1' })).rejects.toThrow('Agent 正在运行')
      expect(manager.listAgentSessions(true).some((session) => session.id !== sessionId)).toBe(false)
    } finally {
      manager.setAgentSessionActiveChecker(undefined)
    }
  })

  test('Given 同一会话已有 fork When 再次 fork Then 第二次在 artifact 读取前拒绝', async () => {
    const sessionId = 'pi-concurrent-source'
    writeAgentWorkspacesIndex([
      { id: 'workspace-a', name: '工作区 A', slug: 'workspace-a', createdAt: 1, updatedAt: 1 },
    ])
    writeAgentSessionsIndex([{
      id: sessionId,
      title: '并发 Pi 会话',
      workspaceId: 'workspace-a',
      createdAt: 1,
      updatedAt: 1,
      agentRuntime: 'pi',
      sdkSessionId: 'pi-session-id',
      piSessionFile: join(tempHome, 'pi-concurrent-session.jsonl'),
      piEntryBindings: { 'assistant-1': 'entry-keep' },
    }])
    mkdirSync(join(tempHome, 'config', 'agent-workspaces', 'workspace-a', sessionId), { recursive: true })
    writeFileSync(join(tempHome, 'pi-concurrent-session.jsonl'), '', 'utf-8')
    let startFork!: () => void
    const started = new Promise<void>((resolve) => { startFork = resolve })
    forkArtifactStarted = startFork
    forkArtifactGate = new Promise<void>((resolve) => { releaseForkArtifact = resolve })

    const firstFork = manager.forkAgentSession({ sessionId, upToMessageUuid: 'assistant-1' })
    await started
    await expect(manager.forkAgentSession({ sessionId, upToMessageUuid: 'assistant-1' })).rejects.toThrow('正在创建分叉')
    releaseForkArtifact?.()
    await firstFork
  })

  test('Given Pi 会话有 entry bindings 和 artifact When 分叉 Then 创建新会话并持久化 branch 元数据', async () => {
    writeAgentWorkspacesIndex([
      { id: 'workspace-a', name: '工作区 A', slug: 'workspace-a', createdAt: 1, updatedAt: 1 },
    ])
    writeAgentSessionsIndex([{
      id: 'pi-source-session',
      title: 'Pi 源会话',
      workspaceId: 'workspace-a',
      createdAt: 1,
      updatedAt: 1,
      agentRuntime: 'pi',
      sdkSessionId: 'pi-session-id',
      piSessionFile: join(tempHome, 'pi-session.jsonl'),
      piEntryBindings: {
        'assistant-1': 'entry-keep',
        'assistant-2': 'entry-removed',
      },
    }])
    mkdirSync(join(tempHome, '.cdutai', 'agent-workspaces', 'workspace-a', 'pi-source-session'), { recursive: true })
    // 源 Pi session artifact 必须真实存在，forkPiAgentSession 会 existsSync 校验。
    writeFileSync(join(tempHome, 'pi-session.jsonl'), '', 'utf-8')

    const policy = { governorMode: 'shadow' as const, permissionMode: 'bypassPermissions' as const, maxFocusChars: 1200 }
    const settledHarnessEvents: PiHarnessEvent[] = [
      {
        version: PI_HARNESS_EVENT_VERSION, eventId: 'goal-created', timestamp: Date.now() - 3,
        sessionId: 'pi-source-session', goalId: 'source-settled-goal', type: 'goal_created', payload: { policy },
      },
      {
        version: PI_HARNESS_EVENT_VERSION, eventId: 'goal-settled', timestamp: Date.now() - 2,
        sessionId: 'pi-source-session', goalId: 'source-settled-goal', type: 'goal_settled', payload: { reason: 'done' },
      },
      {
        version: PI_HARNESS_EVENT_VERSION, eventId: 'active-created', timestamp: Date.now() - 1,
        sessionId: 'pi-source-session', goalId: 'source-active-goal', type: 'goal_created', payload: { policy },
      },
    ]
    for (const harnessEvent of settledHarnessEvents) appendPiHarnessEvent('pi-source-session', harnessEvent)

    const forked = await manager.forkAgentSession({
      sessionId: 'pi-source-session',
      upToMessageUuid: 'assistant-1',
      explorationSourceLabel: '方案 A 的探索',
    })

    expect(forked.id).not.toBe('pi-source-session')
    expect(forked.agentRuntime).toBe('pi')
    expect(forked.sdkSessionId).toBe('pi-fork-session')
    expect(forked.piSessionFile).toBe(join(tempHome, '.pi-fork.jsonl'))
    // 新 branch 只保留分叉点之前的 entry 映射。
    expect(forked.piEntryBindings).toEqual({ 'assistant-1': 'entry-keep' })
    expect(existsSync(forked.piSessionFile!)).toBe(true)
    const forkHarness = loadPiHarnessSnapshot(forked.id)
    expect(Object.keys(forkHarness.goals)).toHaveLength(1)
    expect(forkHarness.goals['source-settled-goal']).toBeUndefined()
    expect(Object.values(forkHarness.goals)[0]).toMatchObject({ sessionId: forked.id, state: 'settled' })

    const persisted = manager.getAgentSessionMeta(forked.id)
    expect(persisted).toMatchObject({
      sdkSessionId: 'pi-fork-session',
      piEntryBindings: { 'assistant-1': 'entry-keep' },
      forkSourceDir: join(tempHome, 'config', 'agent-workspaces', 'workspace-a', 'pi-source-session'),
      explorationParentSessionId: 'pi-source-session',
      explorationSourceMessageId: 'assistant-1',
      explorationSourceLabel: '方案 A 的探索',
    })
  })

  test('Given 源会话有文件检查点 When 分叉 Then 基线迁到分叉会话自己的目录且源会话删除后仍可回退', async () => {
    writeAgentWorkspacesIndex([
      { id: 'workspace-a', name: '工作区 A', slug: 'workspace-a', createdAt: 1, updatedAt: 1 },
    ])
    const sourceSessionId = 'pi-source-checkpoint'
    const sourceDir = join(tempHome, 'config', 'agent-workspaces', 'workspace-a', sourceSessionId)
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'file.txt'), '分叉点之前的基线')
    const checkpointRoot = getPiCheckpointsDir()
    const checkpoint = createPiFileCheckpoint(sourceSessionId, sourceDir, checkpointRoot)
    writeFileSync(join(sourceDir, 'file.txt'), '分叉点之后被改掉')

    writeAgentSessionsIndex([{
      id: sourceSessionId,
      title: 'Pi 带检查点源会话',
      workspaceId: 'workspace-a',
      createdAt: 1,
      updatedAt: 1,
      agentRuntime: 'pi',
      sdkSessionId: 'pi-session-id',
      piSessionFile: join(tempHome, 'pi-checkpoint-session.jsonl'),
      piEntryBindings: { 'assistant-1': 'entry-keep', 'assistant-2': 'entry-removed' },
      piFileCheckpoints: { 'entry-keep': checkpoint.path },
    }])
    writeFileSync(join(tempHome, 'pi-checkpoint-session.jsonl'), '', 'utf-8')

    const forked = await manager.forkAgentSession({ sessionId: sourceSessionId, upToMessageUuid: 'assistant-1' })

    // 基线被迁到分叉会话自己的目录，而不是跨会话引用源会话（否则源会话回收/删除会打掉分叉的回退点）
    const inheritedPath = forked.piFileCheckpoints?.['entry-keep']
    expect(inheritedPath).toBeTruthy()
    expect(inheritedPath!.startsWith(join(checkpointRoot, forked.id))).toBe(true)
    expect(existsSync(inheritedPath!)).toBe(true)
    // 分叉分支里不存在的 turn 不能把映射带过来
    expect(forked.piFileCheckpoints?.['entry-removed']).toBeUndefined()

    // 源会话连同它的检查点目录一起被删掉，分叉会话仍能独立回退到分叉点之前的状态
    // （分叉会话的工作区是源工作区的副本，回退目标用独立目录模拟，避免被源会话删除带走）
    const forkCwd = join(tempHome, 'fork-workspace')
    mkdirSync(forkCwd, { recursive: true })
    writeFileSync(join(forkCwd, 'file.txt'), '分叉会话里又被改了一轮')
    manager.deleteAgentSession(sourceSessionId)
    expect(existsSync(join(checkpointRoot, sourceSessionId))).toBe(false)
    expect(existsSync(sourceDir)).toBe(false)

    restorePiFileCheckpoint(loadPiFileCheckpoint(inheritedPath!), forkCwd)
    expect(readFileSync(join(forkCwd, 'file.txt'), 'utf-8')).toBe('分叉点之前的基线')
  })

  test('Given Pi 会话缺 piEntryBindings When 分叉 Then 拒绝并提示先继续一次对话', async () => {
    writeAgentSessionsIndex([{
      id: 'pi-no-bindings',
      title: 'Pi 无映射会话',
      workspaceId: 'workspace-a',
      createdAt: 1,
      updatedAt: 1,
      agentRuntime: 'pi',
      sdkSessionId: 'pi-session-id',
      piSessionFile: join(tempHome, 'pi-session.jsonl'),
    }])

    await expect(manager.forkAgentSession({
      sessionId: 'pi-no-bindings',
      upToMessageUuid: 'assistant-1',
    })).rejects.toThrow('尚无可用的 entry ID 映射，无法安全分叉；请在当前版本中继续一次 Pi 对话后再试')
  })

  test('Given Pi 会话缺 piSessionFile When 分叉 Then 拒绝', async () => {
    writeAgentSessionsIndex([{
      id: 'pi-no-artifact',
      title: 'Pi 无 artifact 会话',
      workspaceId: 'workspace-a',
      createdAt: 1,
      updatedAt: 1,
      agentRuntime: 'pi',
      sdkSessionId: 'pi-session-id',
      piEntryBindings: { 'assistant-1': 'entry-keep' },
    }])

    await expect(manager.forkAgentSession({
      sessionId: 'pi-no-artifact',
      upToMessageUuid: 'assistant-1',
    })).rejects.toThrow('未找到 Pi session artifact')
  })

  test('Given Pi 分叉未指定目标消息 When 分叉 Then 拒绝', async () => {
    writeAgentSessionsIndex([{
      id: 'pi-no-target',
      title: 'Pi 无目标会话',
      workspaceId: 'workspace-a',
      createdAt: 1,
      updatedAt: 1,
      agentRuntime: 'pi',
      sdkSessionId: 'pi-session-id',
      piSessionFile: join(tempHome, 'pi-session.jsonl'),
      piEntryBindings: { 'assistant-1': 'entry-keep' },
    }])

    await expect(manager.forkAgentSession({
      sessionId: 'pi-no-target',
    })).rejects.toThrow('需要指定一条已完成的 assistant 消息')
  })

  test('Given Pi 中断消息没有 entry binding When 分叉 Then 从上一个完整 entry 建分支并保留中断文本上下文', async () => {
    writeAgentSessionsIndex([{
      id: 'pi-interrupted-session',
      title: 'Pi 中断会话',
      workspaceId: 'workspace-a',
      createdAt: 1,
      updatedAt: 1,
      agentRuntime: 'pi',
      sdkSessionId: 'pi-session-id',
      piSessionFile: join(tempHome, 'pi-interrupted-session.jsonl'),
      piEntryBindings: { 'assistant-complete': 'entry-keep' },
    }])
    mkdirSync(join(tempHome, 'config', 'agent-workspaces', 'workspace-a', 'pi-interrupted-session'), { recursive: true })
    writeFileSync(join(tempHome, 'pi-interrupted-session.jsonl'), '', 'utf-8')
    mkdirSync(join(tempHome, 'config', 'agent-sessions'), { recursive: true })
    writeFileSync(join(tempHome, 'config', 'agent-sessions', 'pi-interrupted-session.jsonl'), [
      JSON.stringify({ type: 'assistant', uuid: 'assistant-complete', message: { content: [{ type: 'text', text: '完整回复' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'assistant-interrupted', message: { content: [{ type: 'text', text: '暂停前的部分回复' }] } }),
    ].join('\n') + '\n', 'utf-8')

    const forked = await manager.forkAgentSession({
      sessionId: 'pi-interrupted-session',
      upToMessageUuid: 'assistant-interrupted',
    })

    expect(forked.agentRuntime).toBe('pi')
    expect(appendedCustomMessages).toEqual([{
      customType: 'profer-interrupted-assistant-context',
      content: expect.stringContaining('暂停前的部分回复'),
      display: false,
      details: { sourceAssistantUuid: 'assistant-interrupted' },
    }])
  })

  test('Given 源会话没有 workspaceId When 分叉 Then 落到默认工作区沙箱并复制文件、重写路径', async () => {
    writeAgentWorkspacesIndex([])
    const sourceSessionId = 'pi-auto-workspace-source'
    const sourceDir = join(tempHome, 'config', 'agent-workspaces', 'default', sourceSessionId)
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'note.txt'), '自动分配工作区文件')
    mkdirSync(join(tempHome, 'config', 'agent-sessions'), { recursive: true })
    writeFileSync(join(tempHome, 'config', 'agent-sessions', `${sourceSessionId}.jsonl`), [
      JSON.stringify({ type: 'user', uuid: 'user-1', message: { content: [{ type: 'text', text: '第一轮提问' }] }, parent_tool_use_id: null }),
      JSON.stringify({ type: 'assistant', uuid: 'assistant-1', message: { content: [{ type: 'text', text: `工作目录 ${sourceDir}` }] }, parent_tool_use_id: null }),
    ].join('\n') + '\n', 'utf-8')
    // 历史会话元数据缺 workspaceId（早期版本或异常数据），分叉后必须自动落到默认沙箱。
    writeFileSync(join(tempHome, 'config', 'agent-sessions.json'), JSON.stringify({
      version: 1,
      sessions: [{
        id: sourceSessionId,
        title: '无工作区 Pi 会话',
        createdAt: 1,
        updatedAt: 1,
        agentRuntime: 'pi',
        sdkSessionId: 'pi-session-id',
        piSessionFile: join(tempHome, 'pi-auto-workspace.jsonl'),
        piEntryBindings: { 'assistant-1': 'entry-keep' },
      }],
    }), 'utf-8')
    writeFileSync(join(tempHome, 'pi-auto-workspace.jsonl'), '', 'utf-8')

    const forked = await manager.forkAgentSession({ sessionId: sourceSessionId, upToMessageUuid: 'assistant-1' })

    const workspacesIndex = JSON.parse(readFileSync(join(tempHome, 'config', 'agent-workspaces.json'), 'utf-8')) as {
      workspaces: Array<{ id: string; slug: string }>
    }
    const defaultWorkspace = workspacesIndex.workspaces.find((workspace) => workspace.slug === 'default')
    expect(defaultWorkspace).toBeTruthy()
    expect(forked.workspaceId).toBe(defaultWorkspace!.id)

    const destDir = join(tempHome, 'config', 'agent-workspaces', 'default', forked.id)
    expect(readFileSync(join(destDir, 'note.txt'), 'utf-8')).toBe('自动分配工作区文件')

    // 历史消息里的源绝对路径必须迁移到分叉会话自己的目录（JSON 中反斜杠会被转义）。
    const destMessages = readFileSync(join(tempHome, 'config', 'agent-sessions', `${forked.id}.jsonl`), 'utf-8')
    const normalized = destMessages.split('\\\\').join('\\')
    expect(normalized).toContain(destDir)
    expect(normalized).not.toContain(sourceDir)
  })

  test('Given 分叉点后面还有一轮且文件被改过 When 分叉 Then 工作区恢复到分叉点完成态', async () => {
    writeAgentWorkspacesIndex([
      { id: 'workspace-a', name: '工作区 A', slug: 'workspace-a', createdAt: 1, updatedAt: 1 },
    ])
    const sourceSessionId = 'pi-fork-baseline-source'
    const sourceDir = join(tempHome, 'config', 'agent-workspaces', 'workspace-a', sourceSessionId)
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'file.txt'), '分叉点完成态')
    // 每轮快照在提问发出前创建：这份基线代表第 2 轮开始前，也就是第 1 轮结束态。
    const baseline = createPiFileCheckpoint(sourceSessionId, sourceDir, getPiCheckpointsDir())
    writeFileSync(join(sourceDir, 'file.txt'), '后续轮次改动')
    writeFileSync(join(sourceDir, 'later.txt'), '后续轮次新增')

    mkdirSync(join(tempHome, 'config', 'agent-sessions'), { recursive: true })
    writeFileSync(join(tempHome, 'config', 'agent-sessions', `${sourceSessionId}.jsonl`), [
      JSON.stringify({ type: 'user', uuid: 'user-1', message: { content: [{ type: 'text', text: '第一轮' }] }, parent_tool_use_id: null }),
      JSON.stringify({ type: 'assistant', uuid: 'assistant-1', message: { content: [{ type: 'text', text: '第一轮回复' }] }, parent_tool_use_id: null }),
      JSON.stringify({ type: 'user', uuid: 'user-2', message: { content: [{ type: 'text', text: '第二轮' }] }, parent_tool_use_id: null }),
      JSON.stringify({ type: 'assistant', uuid: 'assistant-2', message: { content: [{ type: 'text', text: '第二轮回复' }] }, parent_tool_use_id: null }),
    ].join('\n') + '\n', 'utf-8')
    writeAgentSessionsIndex([{
      id: sourceSessionId,
      title: 'Pi 多轮源会话',
      workspaceId: 'workspace-a',
      createdAt: 1,
      updatedAt: 1,
      agentRuntime: 'pi',
      sdkSessionId: 'pi-session-id',
      piSessionFile: join(tempHome, 'pi-fork-baseline.jsonl'),
      piEntryBindings: { 'assistant-1': 'entry-keep', 'assistant-2': 'entry-later' },
      piFileCheckpoints: { 'entry-later': baseline.path },
    }])
    writeFileSync(join(tempHome, 'pi-fork-baseline.jsonl'), '', 'utf-8')

    // 从第 1 轮分叉：目标工作区应回到第 1 轮结束态，而不是当前（第 2 轮结束后）状态。
    const forkedAtFirstTurn = await manager.forkAgentSession({ sessionId: sourceSessionId, upToMessageUuid: 'assistant-1' })
    const firstTurnDir = join(tempHome, 'config', 'agent-workspaces', 'workspace-a', forkedAtFirstTurn.id)
    expect(readFileSync(join(firstTurnDir, 'file.txt'), 'utf-8')).toBe('分叉点完成态')
    expect(existsSync(join(firstTurnDir, 'later.txt'))).toBe(false)

    // 从最后一轮分叉：当前磁盘就是完成态，不应回退。
    const forkedAtLastTurn = await manager.forkAgentSession({ sessionId: sourceSessionId, upToMessageUuid: 'assistant-2' })
    const lastTurnDir = join(tempHome, 'config', 'agent-workspaces', 'workspace-a', forkedAtLastTurn.id)
    expect(readFileSync(join(lastTurnDir, 'file.txt'), 'utf-8')).toBe('后续轮次改动')
    expect(readFileSync(join(lastTurnDir, 'later.txt'), 'utf-8')).toBe('后续轮次新增')
  })

  test('Given 分叉点之后的下一轮被取消未产生 entry When 分叉 Then 保留当前副本而不误还原', async () => {
    writeAgentWorkspacesIndex([
      { id: 'workspace-a', name: '工作区 A', slug: 'workspace-a', createdAt: 1, updatedAt: 1 },
    ])
    const sourceSessionId = 'pi-fork-cancelled-next-turn'
    const sourceDir = join(tempHome, 'config', 'agent-workspaces', 'workspace-a', sourceSessionId)
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'file.txt'), '旧基线')
    const staleCheckpoint = createPiFileCheckpoint(sourceSessionId, sourceDir, getPiCheckpointsDir())
    writeFileSync(join(sourceDir, 'file.txt'), '当前现场')

    mkdirSync(join(tempHome, 'config', 'agent-sessions'), { recursive: true })
    writeFileSync(join(tempHome, 'config', 'agent-sessions', `${sourceSessionId}.jsonl`), [
      JSON.stringify({ type: 'user', uuid: 'user-1', message: { content: [{ type: 'text', text: '第一轮' }] }, parent_tool_use_id: null }),
      JSON.stringify({ type: 'assistant', uuid: 'assistant-1', message: { content: [{ type: 'text', text: '第一轮回复' }] }, parent_tool_use_id: null }),
      JSON.stringify({ type: 'user', uuid: 'user-2', message: { content: [{ type: 'text', text: '第二轮取消' }] }, parent_tool_use_id: null }),
    ].join('\n') + '\n', 'utf-8')
    writeAgentSessionsIndex([{
      id: sourceSessionId,
      title: 'Pi 取消下一轮会话',
      workspaceId: 'workspace-a',
      createdAt: 1,
      updatedAt: 1,
      agentRuntime: 'pi',
      sdkSessionId: 'pi-session-id',
      piSessionFile: join(tempHome, 'pi-fork-cancelled.jsonl'),
      piEntryBindings: { 'assistant-1': 'entry-keep' },
      piFileCheckpoints: { 'entry-keep': staleCheckpoint.path },
    }])
    writeFileSync(join(tempHome, 'pi-fork-cancelled.jsonl'), '', 'utf-8')

    const forked = await manager.forkAgentSession({ sessionId: sourceSessionId, upToMessageUuid: 'assistant-1' })
    const destDir = join(tempHome, 'config', 'agent-workspaces', 'workspace-a', forked.id)
    // 下一轮没有 entry 绑定，无法定位分叉点基线，保留当前副本而不是错误回退。
    expect(readFileSync(join(destDir, 'file.txt'), 'utf-8')).toBe('当前现场')
  })
})
