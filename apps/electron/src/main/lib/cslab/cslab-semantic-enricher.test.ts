/**
 * cslab-semantic-enricher 测试：确定性回退 + LLM 严格解析降级
 *
 * 红线验证：LLM 未配置/调用失败/解析失败一律降级 deterministicEnrichment；
 * 绝不捏造概念/引用（解析不出 title 的引用条目直接丢弃）。
 * 所有用例注入 mock llmCall 或只测纯函数，不联网。
 */

import { describe, expect, test } from 'bun:test'
import {
  buildEnrichUserPrompt,
  deterministicEnrichment,
  enrichPaperSemantics,
  parseReferenceEntry,
  splitReferenceEntries,
  type EnrichPaperInput,
} from './cslab-semantic-enricher'

const baseInput: EnrichPaperInput = {
  title: 'Viscoacoustic Full Waveform Inversion for Seismic Imaging',
  abstract: 'We propose a viscoacoustic full waveform inversion method with attenuation compensation.',
  keywords: ['Seismic Imaging', 'Full Waveform Inversion', 'Attenuation', 'Wave Propagation'],
  sections: [
    { title: 'Introduction', level: 1, page: 1, text: 'Background text.' },
    { title: 'Methods', level: 1, page: 3, text: 'Method text.' },
    { title: 'Conclusions', level: 1, page: 9, text: 'Conclusion text.' },
  ],
}

describe('deterministicEnrichment — taxonomy', () => {
  test('keywords 优先：前 2-3 个关键词串成层级链，不编造学科名', () => {
    const result = deterministicEnrichment(baseInput)
    expect(result.taxonomy).toEqual([
      'Seismic Imaging',
      'Full Waveform Inversion',
      'Attenuation',
    ])
    expect(result.enrichmentSource).toBe('deterministic')
  })

  test('无 keywords 且只有标准 IMRaD 章节标题 → 保守为空，不从 Introduction/Methods 编造分类', () => {
    const result = deterministicEnrichment({ ...baseInput, keywords: [] })
    expect(result.taxonomy).toEqual([])
  })

  test('无 keywords 时用非标准一级章节标题保守兜底', () => {
    const result = deterministicEnrichment({
      ...baseInput,
      keywords: [],
      sections: [
        { title: 'Introduction', level: 1, page: 1, text: 'x' },
        { title: 'Full Waveform Inversion Theory', level: 1, page: 2, text: 'x' },
        { title: 'Conclusions', level: 1, page: 9, text: 'x' },
      ],
    })
    expect(result.taxonomy).toEqual(['Full Waveform Inversion Theory'])
  })
})

describe('deterministicEnrichment — concepts / methods / protocols', () => {
  test('keywords → concepts，definition 留空不编造', () => {
    const result = deterministicEnrichment(baseInput)
    expect(result.conceptGraph.concepts).toEqual([
      { id: 'concept-1', name: 'Seismic Imaging' },
      { id: 'concept-2', name: 'Full Waveform Inversion' },
      { id: 'concept-3', name: 'Attenuation' },
      { id: 'concept-4', name: 'Wave Propagation' },
    ])
    for (const concept of result.conceptGraph.concepts) {
      expect(concept.definition).toBeUndefined()
    }
  })

  test('methods / protocols 诚实为空，不伪造', () => {
    const result = deterministicEnrichment(baseInput)
    expect(result.conceptGraph.methods).toEqual([])
    expect(result.protocols).toEqual([])
  })
})

describe('确定性参考文献解析', () => {
  test('splitReferenceEntries：编号切条，续行并入', () => {
    const entries = splitReferenceEntries(
      '[1] A. Smith, B. Jones. Full waveform inversion for seismic imaging. Geophysics, 2019.\n' +
        '     doi:10.1190/geo2018-0001.1\n' +
        '[2] C. Wang et al. Attenuation compensation in wave propagation. 2021.',
    )
    expect(entries).toHaveLength(2)
    expect(entries[0]).toContain('Full waveform inversion')
    expect(entries[0]).toContain('10.1190/geo2018-0001.1')
    expect(entries[1]).toContain('Attenuation compensation')
  })

  test('splitReferenceEntries：无编号文本一行一条', () => {
    const entries = splitReferenceEntries(
      'A. Smith, B. Jones. Full waveform inversion for seismic imaging. 2019.\n' +
        'C. Wang, D. Li. Wave propagation in attenuating media. 2021.',
    )
    expect(entries).toHaveLength(2)
  })

  test('parseReferenceEntry：提取 title/year/doi，作者行不冒充标题', () => {
    const reference = parseReferenceEntry(
      '[1] A. Smith, B. Jones. Full waveform inversion for seismic imaging. Geophysics, 2019. doi:10.1190/geo2018-0001.1',
    )
    expect(reference).toEqual({
      title: 'Full waveform inversion for seismic imaging',
      year: '2019',
      doi: '10.1190/geo2018-0001.1',
    })
  })

  test('parseReferenceEntry：解析不出 title 的条目返回 null（丢弃，不编造）', () => {
    expect(parseReferenceEntry('[2] 2019. 10.5555/only-a-doi')).toBeNull()
    expect(parseReferenceEntry('[3] A. Smith, B. Jones. 2018.')).toBeNull()
    expect(parseReferenceEntry('[4]')).toBeNull()
  })

  test('deterministicEnrichment 汇总：references 上限 50 条', () => {
    const refs = Array.from(
      { length: 60 },
      (_, index) => `[${index + 1}] A. Author, B. Author. Study number ${index} on wave physics. 2020.`,
    ).join('\n')
    const result = deterministicEnrichment({ ...baseInput, referencesText: refs })
    expect(result.references).toHaveLength(50)
    expect(result.references[0]?.title).toBe('Study number 0 on wave physics')
    expect(result.references[0]?.year).toBe('2020')
    for (const reference of result.references) {
      expect(reference.title.length).toBeGreaterThan(0)
    }
  })
})

describe('enrichPaperSemantics — LLM 失败一律回退确定性解析', () => {
  test('llmCall 返回 null（未配置渠道）→ 回退 deterministic', async () => {
    let called = 0
    const result = await enrichPaperSemantics(baseInput, {
      llmCall: async () => {
        called += 1
        return null
      },
    })
    expect(called).toBe(1)
    expect(result.enrichmentSource).toBe('deterministic')
    expect(result).toEqual(deterministicEnrichment(baseInput))
  })

  test('llmCall 抛异常 → 不抛出，回退 deterministic', async () => {
    const result = await enrichPaperSemantics(baseInput, {
      llmCall: async () => {
        throw new Error('network boom')
      },
    })
    expect(result.enrichmentSource).toBe('deterministic')
  })

  test('返回非 JSON / 顶层字段类型不符 → 整体回退 deterministic', async () => {
    const badJson = await enrichPaperSemantics(baseInput, {
      llmCall: async () => '这不是 JSON',
    })
    expect(badJson.enrichmentSource).toBe('deterministic')
    const badType = await enrichPaperSemantics(baseInput, {
      llmCall: async () => JSON.stringify({ taxonomy: 'not-an-array' }),
    })
    expect(badType.enrichmentSource).toBe('deterministic')
    expect(badType).toEqual(deterministicEnrichment(baseInput))
  })
})

describe('enrichPaperSemantics — LLM 成功路径与逐条清洗', () => {
  const llmPayload = {
    taxonomy: ['Earth Sciences', 'Geophysics', 'Seismic Imaging', 'Wave Physics', 'Inversion', 'Noise'],
    concepts: [
      { id: 'c1', name: 'Full Waveform Inversion', definition: '正文定义', relatedConceptIds: ['c2'] },
      { id: 'c2', name: '' },
      'not-an-object',
    ],
    methods: [
      { id: 'm1', name: 'Viscoacoustic FWI', role: 'proposed', dependsOn: ['c1'] },
      { id: 'm2', name: 'Acoustic FWI', role: 'invented-role' },
    ],
    protocols: [
      {
        id: 'p1',
        name: '样品退火',
        category: 'synthesis',
        steps: ['升温', '保温'],
        parameters: { temperature: 800, rate: '5 K/min', bad: { nested: 1 } },
        instruments: ['XRD'],
      },
      { id: 'p2', name: 'Bad protocol', category: 'made-up', steps: ['x'] },
      { id: 'p3', name: 'No steps', category: 'measurement', steps: [] },
    ],
    references: [
      { title: 'A real cited paper', authors: ['A. Smith'], year: 2021, doi: '10.1190/x', venue: 'Geophysics' },
      { title: '', doi: '10.1190/no-title' },
      { doi: '10.1190/also-no-title' },
    ],
  }

  test('合法返回 → enrichmentSource=llm；非法条目逐条丢弃，不牵连整体', async () => {
    const result = await enrichPaperSemantics(baseInput, {
      llmCall: async () => JSON.stringify(llmPayload),
    })
    expect(result.enrichmentSource).toBe('llm')
    // taxonomy ≤ 5 级
    expect(result.taxonomy).toHaveLength(5)
    expect(result.taxonomy[0]).toBe('Earth Sciences')
    // 缺 name 的 concept / 非对象条目被丢弃
    expect(result.conceptGraph.concepts).toEqual([
      { id: 'c1', name: 'Full Waveform Inversion', definition: '正文定义', relatedConceptIds: ['c2'] },
    ])
    // role 非法的 method 被丢弃
    expect(result.conceptGraph.methods).toEqual([
      { id: 'm1', name: 'Viscoacoustic FWI', role: 'proposed', dependsOn: ['c1'] },
    ])
    // category/steps 非法的 protocol 被丢弃；非法参数键值被剔除而非编造
    expect(result.protocols).toHaveLength(1)
    expect(result.protocols[0]?.category).toBe('synthesis')
    expect(result.protocols[0]?.parameters).toEqual({ temperature: 800, rate: '5 K/min' })
    expect(result.protocols[0]?.instruments).toEqual(['XRD'])
    // 缺 title 的引用被丢弃，绝不保留裸 DOI
    expect(result.references).toEqual([
      { title: 'A real cited paper', authors: ['A. Smith'], year: '2021', doi: '10.1190/x', venue: 'Geophysics' },
    ])
  })

  test('数量硬上限：references ≤ 50 / concepts ≤ 60 / methods ≤ 30 / protocols ≤ 20', async () => {
    const bigPayload = {
      taxonomy: Array.from({ length: 8 }, (_, i) => `Level ${i}`),
      concepts: Array.from({ length: 70 }, (_, i) => ({ id: `c${i}`, name: `Concept ${i}` })),
      methods: Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, name: `Method ${i}`, role: 'general' })),
      protocols: Array.from({ length: 30 }, (_, i) => ({
        id: `p${i}`,
        name: `Protocol ${i}`,
        category: 'general',
        steps: ['step'],
      })),
      references: Array.from({ length: 60 }, (_, i) => ({ title: `Reference ${i}` })),
    }
    const result = await enrichPaperSemantics(baseInput, {
      llmCall: async () => JSON.stringify(bigPayload),
    })
    expect(result.enrichmentSource).toBe('llm')
    expect(result.taxonomy).toHaveLength(5)
    expect(result.conceptGraph.concepts).toHaveLength(60)
    expect(result.conceptGraph.methods).toHaveLength(30)
    expect(result.protocols).toHaveLength(20)
    expect(result.references).toHaveLength(50)
  })
})

describe('buildEnrichUserPrompt', () => {
  test('拼入标题等信息且总量截断 ≤ 20000 字符', () => {
    const prompt = buildEnrichUserPrompt(baseInput)
    expect(prompt).toContain(baseInput.title)
    expect(prompt).toContain('Seismic Imaging')
    expect(prompt.length).toBeLessThanOrEqual(20_000)

    const huge: EnrichPaperInput = {
      ...baseInput,
      sections: Array.from({ length: 40 }, (_, index) => ({
        title: `Section ${index}`,
        level: 1,
        page: index + 1,
        text: 'x'.repeat(8_000),
      })),
      referencesText: 'r'.repeat(50_000),
      tablesMarkdown: 't'.repeat(10_000),
    }
    expect(buildEnrichUserPrompt(huge).length).toBeLessThanOrEqual(20_000)
  })
})
