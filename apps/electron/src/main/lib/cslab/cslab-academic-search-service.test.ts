import { describe, expect, it } from 'bun:test'
import {
  fetchPaperPreview,
  searchAcademicPapers,
} from './cslab-academic-search-service'

describe('CSLab 学术文献检索与直链解析容错测试', () => {
  it('搜索 Attention Is All You Need 能够精准排在首位并具备有效 OA PDF 直链', async () => {
    const result = await searchAcademicPapers({
      query: 'attention is all you need',
      topK: 5,
    })

    expect(result.ok).toBe(true)
    expect(result.papers.length).toBeGreaterThan(0)

    const topPaper = result.papers[0]!
    expect(topPaper).toBeDefined()
    // 标题精准匹配：顶条文献应当是 Attention Is All You Need
    expect(topPaper.title.toLowerCase()).toContain('attention is all you need')

    // 谱系与 arXiv ID 提取应当完备
    expect(topPaper.arxivId || topPaper.lineage.versionSources.some((s) => s.includes('1706.03762'))).toBeTruthy()

    // 应当包含候选合法 OA PDF 直链且不为空
    expect(topPaper.isOpenAccess).toBe(true)
    expect(topPaper.openAccessPdfUrl).toBeDefined()
    expect(topPaper.openAccessPdfUrl).toMatch(/^https?:\/\//)
  }, 30_000)

  it('搜索 Attention Is All You Need 得到的卡片可直接成功预览 PDF', async () => {
    const result = await searchAcademicPapers({
      query: 'attention is all you need',
      topK: 1,
    })
    expect(result.ok).toBe(true)
    const paper = result.papers[0]!
    expect(paper).toBeDefined()

    const preview = await fetchPaperPreview({
      doi: paper.doi,
      arxivId: paper.arxivId,
      title: paper.title,
      openAccessPdfUrl: paper.openAccessPdfUrl,
      openAccessPdfUrls: paper.openAccessPdfUrls,
      landingPageUrl: paper.landingPageUrl,
    })

    expect(preview.ok).toBe(true)
    expect(preview.pdfDataUrl).toBeDefined()
    expect(preview.pdfDataUrl?.startsWith('data:application/pdf;base64,')).toBe(true)
  }, 45_000)

  it('fetchPaperPreview 在首选镜像 404 时能够自动回退至可用直链并成功就绪', async () => {
    // 模拟传入 OpenAlex 返回的失效 404 镜像链接，但附带真实可用候选直链与 arXiv ID
    const preview = await fetchPaperPreview({
      title: 'Attention Is All You Need',
      doi: '10.65215/2q58a426',
      arxivId: '1706.03762',
      openAccessPdfUrl: 'https://langtaosha.org.cn/index.php/lts/preprint/download/10/108',
      openAccessPdfUrls: [
        'https://langtaosha.org.cn/index.php/lts/preprint/download/10/108',
        'https://arxiv.org/pdf/1706.03762',
      ],
    })

    expect(preview.ok).toBe(true)
    expect(preview.pdfDataUrl).toBeDefined()
    expect(preview.pdfDataUrl?.startsWith('data:application/pdf;base64,')).toBe(true)
  }, 45_000)
})
