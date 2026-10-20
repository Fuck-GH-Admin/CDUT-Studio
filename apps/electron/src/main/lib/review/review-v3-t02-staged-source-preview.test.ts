import { describe, expect, test } from 'bun:test'
import { ReviewB2StagingService, type B2MainContext } from './review-intake-adapter-v3-b2'
import { previewT02StagedSource } from './review-v3-t02-staged-source-preview'

const ctx: B2MainContext = {
  senderId: 1, frameId: 2, ownerId: 'main-owner', ownerGeneration: 1,
  caseCandidateId: 'candidate-case',
}

function stage(staging: ReviewB2StagingService, fileName: string, bytes: Uint8Array, key: string) {
  const grant = staging.grant(ctx)
  return staging.stage(ctx, grant.token, {
    requestId: key, physicalSourceKey: key, fileName, bytes,
    role: 'supporting', subjectId: null,
  })
}

describe('T02 trusted staged material parsing', () => {
  test('quotes/newlines stay in the same physical CSV cell and previews are repeatable', async () => {
    const staging = new ReviewB2StagingService()
    const material = stage(staging, '报送清单.csv',
      Buffer.from('学号,内容\r\n00081,"一等\r\n奖"\r\n00082,二等奖'), 'main-file-A')
    const first = await previewT02StagedSource(ctx, staging, material.candidateId)
    const second = await previewT02StagedSource(ctx, staging, material.candidateId)
    expect(first).toMatchObject({
      checkpoint: 'staging-only', candidateOnly: true,
      documentVersionId: material.documentVersionId,
      parseStatus: 'parsed', blockCount: 6,
      imageBlocksAwaitingInspection: 0, sheets: ['CSV'],
    })
    expect(first.blocks.find((b) => b.table?.row === 2 && b.table?.column === 1)?.text).toBe('00081')
    expect(first.blocks.find((b) => b.table?.row === 2 && b.table?.column === 2)?.text).toBe('一等\r\n奖')
    expect(first.blocks.map((b) => b.sourceBlockKey)).toEqual(second.blocks.map((b) => b.sourceBlockKey))
  })

  test('two same-name physical originals retain separate source versions', async () => {
    const staging = new ReviewB2StagingService()
    const a = stage(staging, '证明.txt', Buffer.from('第一次'), 'main-file-1')
    const b = stage(staging, '证明.txt', Buffer.from('第二次'), 'main-file-2')
    const [first, second] = await Promise.all([
      previewT02StagedSource(ctx, staging, a.candidateId),
      previewT02StagedSource(ctx, staging, b.candidateId),
    ])
    expect(first.documentVersionId).not.toBe(second.documentVersionId)
    expect(first.blocks[0]?.sourceBlockKey).not.toBe(second.blocks[0]?.sourceBlockKey)
    expect(first.blocks[0]?.text).toBe('第一次')
    expect(second.blocks[0]?.text).toBe('第二次')
  })

  test('an image remains partial and awaiting inspection, not magically parsed as text', async () => {
    const staging = new ReviewB2StagingService()
    const image = stage(staging, '获奖证书.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'main-image')
    const result = await previewT02StagedSource(ctx, staging, image.candidateId)
    expect(result).toMatchObject({
      parseStatus: 'partial', imageBlocksAwaitingInspection: 1,
      blockCount: 1, indexedPages: [1],
    })
    expect(result.blocks[0]).toMatchObject({ kind: 'image', requiresVisualInspection: true })
  })

  test('unknown binary remains failed and never generates placeholder evidence', async () => {
    const staging = new ReviewB2StagingService()
    const item = stage(staging, '无法解析.bin', Buffer.from([1, 2, 3]), 'main-unknown')
    const result = await previewT02StagedSource(ctx, staging, item.candidateId)
    expect(result.parseStatus).toBe('failed')
    expect(result.blocks).toHaveLength(0)
    expect(result.parseError).toContain('暂不支持')
  })

  test('staging scope revoked before source read cannot yield a usable preview', async () => {
    const staging = new ReviewB2StagingService()
    const item = stage(staging, '证据.txt', Buffer.from('可读文本'), 'main-revoked')
    staging.revoke(ctx)
    await expect(previewT02StagedSource(ctx, staging, item.candidateId)).rejects.toThrow('B2_OWNER_INVALID_OR_REVOKED')
  })
})
