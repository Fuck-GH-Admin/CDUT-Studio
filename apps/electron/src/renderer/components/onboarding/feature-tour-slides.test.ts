import { describe, expect, test } from 'bun:test'
import { FEATURE_TOUR_SLIDES } from './FeatureTour'

describe('FEATURE_TOUR_SLIDES 数据合法性与完整性', () => {
  test('导览必须包含 8 组完整的核心特性演示', () => {
    expect(FEATURE_TOUR_SLIDES.length).toBe(8)
  })

  test('所有 slide 的 id 唯一且不为空', () => {
    const ids = FEATURE_TOUR_SLIDES.map((s) => s.id)
    expect(new Set(ids).size).toBe(FEATURE_TOUR_SLIDES.length)
    for (const id of ids) {
      expect(typeof id).toBe('string')
      expect(id.trim().length).toBeGreaterThan(0)
    }
  })

  test('每项演示均具备完整的文案、副标题、摘要、指令示例与专有标签', () => {
    for (const slide of FEATURE_TOUR_SLIDES) {
      expect(slide.badge.trim().length).toBeGreaterThan(0)
      expect(slide.title.trim().length).toBeGreaterThan(0)
      expect(slide.subtitle.trim().length).toBeGreaterThan(0)
      expect(slide.summary.trim().length).toBeGreaterThan(0)
      expect(slide.example.trim().length).toBeGreaterThan(0)
      expect(Array.isArray(slide.tags)).toBe(true)
      expect(slide.tags.length).toBeGreaterThanOrEqual(3)
      for (const tag of slide.tags) {
        expect(tag.trim().length).toBeGreaterThan(0)
      }
    }
  })

  test('覆盖 CDUT Studio 全部核心领域模块', () => {
    const ids = FEATURE_TOUR_SLIDES.map((s) => s.id)
    expect(ids).toContain('pi-agent')
    expect(ids).toContain('cdut-zone')
    expect(ids).toContain('ai-class')
    expect(ids).toContain('yanhu-web')
    expect(ids).toContain('material-review')
    expect(ids).toContain('cdut-science')
    expect(ids).toContain('automation')
    expect(ids).toContain('skills-ecosystem')
  })
})
