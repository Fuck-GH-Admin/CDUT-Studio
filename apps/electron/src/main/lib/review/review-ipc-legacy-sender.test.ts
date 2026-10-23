/**
 * AUTH-06: every legacy high-impact V2 write must pass the same trusted Main
 * window + main-frame check as the C0/T05/F13 channels before any domain write.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { REVIEW_IPC_CHANNELS } from '@profer/shared'
import { setMainWindow } from '../main-window-state'
import { registerReviewIpc } from './review-ipc'

const root = join(import.meta.dir, '../../../../../../work/tmp', `review-ipc-legacy-sender-${Date.now()}`)
process.env.PROFER_CONFIG_DIR = root
afterAll(() => { setMainWindow(null); rmSync(root, { recursive: true, force: true }) })

const handlers = (globalThis.__proferElectronTestHooks as typeof globalThis.__proferElectronTestHooks & {
  ipcMainHandlers: Map<string, (...args: unknown[]) => unknown>
}).ipcMainHandlers
const frame = { id: 1 }
const sender = { id: 901, mainFrame: frame, isDestroyed: () => false }
const trusted = { sender, senderFrame: frame }

const LEGACY_WRITES = [
  REVIEW_IPC_CHANNELS.RECORD_WORKSPACE_DISPOSITION_V2,
  REVIEW_IPC_CHANNELS.OPEN_WORKSPACE_SUPPLEMENT_V2,
  REVIEW_IPC_CHANNELS.ACKNOWLEDGE_WORKSPACE_MATERIAL_V2,
  REVIEW_IPC_CHANNELS.DECIDE_WORKSPACE_CASE_V2,
  REVIEW_IPC_CHANNELS.RECORD_WORKSPACE_SUBJECT_ADJUDICATION_V2,
  REVIEW_IPC_CHANNELS.RECORD_STAGE_DECISION_V2,
  REVIEW_IPC_CHANNELS.RESOLVE_SUPPLEMENT_V2,
  REVIEW_IPC_CHANNELS.CAST_RATING_V2,
  REVIEW_IPC_CHANNELS.RESOLVE_APPEAL_V2,
] as const

function invoke(channel: string, event: unknown): unknown {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`Missing IPC test handler: ${channel}`)
  return handler(event, {
    caseId: 'legacy-sender-case',
    command: { requestId: 'r1', actor: { actorId: 'forged', actorSource: 'local', role: 'reviewer' }, expectedRevision: 0, payload: {} },
    templateId: 't', version: 1,
  })
}

describe('AUTH-06 legacy write sender boundary', () => {
  test('all legacy high-impact writes reject a forged window and a subframe before writing', () => {
    handlers.clear()
    setMainWindow({ isDestroyed: () => false, webContents: sender } as never)
    registerReviewIpc()
    for (const channel of LEGACY_WRITES) {
      expect(() => invoke(channel, { sender: { ...sender }, senderFrame: frame })).toThrow('SENDER_UNTRUSTED')
      expect(() => invoke(channel, { sender, senderFrame: { id: 2 } })).toThrow('SENDER_UNTRUSTED')
    }
  })
})

describe('T07 评分权威：批次案卷拒绝旧 CAST_RATING', () => {
  test('已进入批次的案卷不能再用旧 CAST_RATING 平行记分', () => {
    handlers.clear()
    setMainWindow({ isDestroyed: () => false, webContents: sender } as never)
    registerReviewIpc()
    const { createBatchV2 } = require('./batch-store') as typeof import('./batch-store')
    createBatchV2({
      id: 'batch-cast-guard', name: '批次评分', templateId: 't', templateVersion: 1,
      policyVersionLock: [], caseIds: ['batched-cast-case'], createdAt: new Date().toISOString(),
    })
    const handler = handlers.get(REVIEW_IPC_CHANNELS.CAST_RATING_V2)
    expect(handler).toBeDefined()
    expect(() => handler!(trusted, {
      caseId: 'batched-cast-case',
      command: { requestId: 'r1', actor: { actorId: 'local', actorSource: 'local', role: 'judge' },
        expectedRevision: 0, payload: {} },
    })).toThrow('评分必须走 T07 评分通道')
  })
})

describe('RUN-43 续交确认走真实 IPC 入参校验', () => {
  test('非法 resumeInterrupted 在启动任何执行前被拒绝', async () => {
    handlers.clear()
    setMainWindow({ isDestroyed: () => false, webContents: sender } as never)
    registerReviewIpc()
    const handler = handlers.get(REVIEW_IPC_CHANNELS.START_BACKGROUND_PI_REVIEW_V2)
    expect(handler).toBeDefined()
    await expect(Promise.resolve(handler!(trusted, { caseId: 'resume-flag-case', resumeInterrupted: 'yes' })))
      .rejects.toThrow('审核续交确认参数非法')
  })
})
