import { describe, expect, test } from 'bun:test'
import { bindLocalReviewerCommand, LOCAL_REVIEWER_ACTOR } from './review-ipc-actor-guard'

describe('审核业务命令 IPC 操作者身份边界', () => {
  test('渲染器不得声明系统、Agent、校方或模拟来源', () => {
    for (const actorSource of ['system', 'agent', 'school', 'mock']) {
      expect(() => bindLocalReviewerCommand({ actor: { actorId: 'forged', actorSource, role: 'reviewer' }, requestId: 'test' }))
        .toThrow('本地审核 IPC')
    }
  })
  test('没有经过机构验证的 teacher/admin/student 等角色不得进入 reviewer 审批入口', () => {
    for (const role of ['teacher', 'school-admin', 'student', 'system', 'template-owner']) {
      expect(() => bindLocalReviewerCommand({ actor: { actorId: 'forged', actorSource: 'local', role } })).toThrow('本地审核 IPC')
    }
  })
  test('未知或缺失操作者不能作为审批凭据', () => {
    expect(() => bindLocalReviewerCommand({})).toThrow()
    expect(() => bindLocalReviewerCommand({ actor: null })).toThrow()
    expect(() => bindLocalReviewerCommand({ actor: 'reviewer' })).toThrow()
  })
  test('本地 reviewer 也不得由前端自行填写审计身份', () => {
    const command = { requestId: 'r1', actor: { actorId: 'some-school-official', actorSource: 'local', role: 'reviewer' }, payload: { action: 'stage-pass' } }
    const result = bindLocalReviewerCommand(command)
    expect(result.actor).toEqual(LOCAL_REVIEWER_ACTOR)
    expect(result.requestId).toBe('r1')
    expect(command.actor.actorId).toBe('some-school-official') // input immutable
  })
})
