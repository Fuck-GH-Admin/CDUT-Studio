import { describe, expect, test } from 'bun:test'
import {
  hashKeyClient,
  CSLAB_TARGET_HASH,
} from './cslab-atoms'

describe('CSLab 客户端状态与散列安全测试', () => {
  test('客户端散列函数能够对空或有效 key 进行安全散列', async () => {
    const emptyHash = await hashKeyClient('')
    expect(emptyHash).toBe('')

    // 测试环境下 Node/Bun 的 window 模拟或兜底逻辑
    const hash = await hashKeyClient('MCC-Nya-520')
    expect(typeof hash).toBe('string')
    expect(hash.length).toBeGreaterThan(0)
  })

  test('目标密钥摘要常量符合 SHA-256 规格', () => {
    expect(CSLAB_TARGET_HASH).toBe('7f66de46bc03ed8e45acb8bb9b2a4d5f3c6881b085336bc84317396527bc51db')
    expect(CSLAB_TARGET_HASH.length).toBe(64)
  })
})
