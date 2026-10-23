/**
 * bulletin-startup 单元测试 — 公告栏启动弹出纯判定逻辑
 */
import { describe, expect, test } from 'bun:test'
import type { BulletinItem } from '@profer/shared'
import { pickLatestBulletin, shouldAutoOpenBulletin, sortBulletinsForDisplay } from './bulletin-startup'

/** 构造测试公告条目 */
function makeItem(overrides: Partial<BulletinItem> = {}): BulletinItem {
  return {
    id: 'bulletin-test',
    title: '测试公告',
    date: '2026-10-22',
    category: 'notice',
    content: '正文',
    ...overrides,
  }
}

/** 全部条件满足的基线 guard */
function makeGuard(overrides: Partial<Parameters<typeof shouldAutoOpenBulletin>[0]> = {}) {
  return {
    hasBulletins: true,
    hasUnreadLatest: true,
    sessionDismissed: false,
    coachTourActive: false,
    coachTourPending: false,
    welcomeReplayActive: false,
    ...overrides,
  }
}

describe('pickLatestBulletin', () => {
  test('空数组返回 null（文件缺失/损坏兜底）', () => {
    expect(pickLatestBulletin([])).toBeNull()
  })

  test('乱序日期取最新一条', () => {
    const items = [
      makeItem({ id: 'old', date: '2026-09-01' }),
      makeItem({ id: 'newest', date: '2026-10-22' }),
      makeItem({ id: 'middle', date: '2026-10-01' }),
    ]
    expect(pickLatestBulletin(items)?.id).toBe('newest')
  })

  test('pinned 不影响「最新」判定（仅影响展示排序）', () => {
    const items = [
      makeItem({ id: 'pinned-old', date: '2026-01-01', pinned: true }),
      makeItem({ id: 'plain-new', date: '2026-10-22' }),
    ]
    expect(pickLatestBulletin(items)?.id).toBe('plain-new')
  })
})

describe('sortBulletinsForDisplay', () => {
  test('置顶优先，同组内按日期倒序', () => {
    const items = [
      makeItem({ id: 'normal-new', date: '2026-10-22' }),
      makeItem({ id: 'pinned-old', date: '2026-01-01', pinned: true }),
      makeItem({ id: 'normal-old', date: '2026-09-01' }),
      makeItem({ id: 'pinned-new', date: '2026-05-01', pinned: true }),
    ]
    expect(sortBulletinsForDisplay(items).map((item) => item.id)).toEqual([
      'pinned-new',
      'pinned-old',
      'normal-new',
      'normal-old',
    ])
  })
})

describe('shouldAutoOpenBulletin', () => {
  test('全部条件满足时自动弹出', () => {
    expect(shouldAutoOpenBulletin(makeGuard())).toBe(true)
  })

  test('lastReadBulletinId 与最新公告一致（已读无新公告）时不弹', () => {
    expect(shouldAutoOpenBulletin(makeGuard({ hasUnreadLatest: false }))).toBe(false)
  })

  test('本次会话已关闭过则绝不重弹', () => {
    expect(shouldAutoOpenBulletin(makeGuard({ sessionDismissed: true }))).toBe(false)
  })

  test('CoachTour 蒙层导览进行中推迟', () => {
    expect(shouldAutoOpenBulletin(makeGuard({ coachTourActive: true }))).toBe(false)
  })

  test('CoachTour 已排定未播放（800ms 定时器竞态窗口）推迟', () => {
    expect(shouldAutoOpenBulletin(makeGuard({ coachTourPending: true }))).toBe(false)
  })

  test('首次欢迎导览重播进行中推迟', () => {
    expect(shouldAutoOpenBulletin(makeGuard({ welcomeReplayActive: true }))).toBe(false)
  })

  test('公告列表为空时静默', () => {
    expect(shouldAutoOpenBulletin(makeGuard({ hasBulletins: false }))).toBe(false)
  })
})
