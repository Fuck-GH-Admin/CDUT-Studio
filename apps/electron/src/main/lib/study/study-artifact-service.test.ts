/**
 * study-artifact-service 输出额度分配单测
 *
 * 验证不同工件类型与题量下不会复用图谱的 3000 小额度，
 * 避免思考模型把输出预算消耗在思考链后正文为空或被截断。
 */

import { describe, expect, it } from 'bun:test'
import type { StudyGenerateArtifactInput } from '@profer/shared'
import { resolveArtifactMaxTokens } from './study-artifact-service'

function input(overrides: Partial<StudyGenerateArtifactInput>): StudyGenerateArtifactInput {
  return { sessionId: 'test-session', kind: 'quiz', ...overrides }
}

describe('resolveArtifactMaxTokens 工件输出额度', () => {
  it('Given 思维导图 When 计算额度 Then 固定 8192', () => {
    expect(resolveArtifactMaxTokens(input({ kind: 'mindmap' }))).toBe(8_192)
  })

  it('Given 抽认卡三种模式 When 计算额度 Then 按模式递增', () => {
    expect(resolveArtifactMaxTokens(input({ kind: 'flashcard', cardMode: 'concise' }))).toBe(6_144)
    expect(resolveArtifactMaxTokens(input({ kind: 'flashcard', cardMode: 'standard' }))).toBe(8_192)
    expect(resolveArtifactMaxTokens(input({ kind: 'flashcard', cardMode: 'in_depth' }))).toBe(16_384)
  })

  it('Given 默认 5 题测验 When 计算额度 Then 不低于 8192', () => {
    expect(resolveArtifactMaxTokens(input({ kind: 'quiz' }))).toBe(8_192)
    expect(resolveArtifactMaxTokens(input({ kind: 'quiz', questionCount: 5 }))).toBe(8_192)
  })

  it('Given 10 题测验 When 计算额度 Then 按题量线性增加', () => {
    expect(resolveArtifactMaxTokens(input({ kind: 'quiz', questionCount: 10 }))).toBe(10_096)
  })

  it('Given 20 题及以上测验 When 计算额度 Then 封顶 16384', () => {
    expect(resolveArtifactMaxTokens(input({ kind: 'quiz', questionCount: 20 }))).toBe(16_384)
    expect(resolveArtifactMaxTokens(input({ kind: 'quiz', questionCount: 50 }))).toBe(16_384)
    expect(resolveArtifactMaxTokens(input({ kind: 'quiz', questionCount: 200 }))).toBe(16_384)
  })
})
