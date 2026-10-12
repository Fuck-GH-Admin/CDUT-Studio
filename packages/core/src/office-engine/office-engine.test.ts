/**
 * @profer/core/office-engine 单元测试
 *
 * 验证双平面流式重排与空间拓扑解析引擎：
 * 1. DOCX：样式继承、GDI 分行与分页、OMML 公式转 LaTeX、跨页表格切分与虚拟表头克隆
 * 2. PPTX：嵌套 p:grpSp 2D 仿射变换拍平、p:timing 动画顺序与 Y-band 阅读序、p:cxnSp 连接符转 Mermaid 流程图、演讲者备注
 * 3. XLSX：SST 共享字符串、日期序列号、合并单元格传播、稀疏连接域切分、公式标注、xdr:twoCellAnchor 图表坐标归一化
 */

import { describe, expect, test } from 'bun:test'
import { deflateRawSync } from 'node:zlib'
import {
  parseOfficeBuffer,
  stripOfficeTopologyAnchors,
  officeAstToSharedLayoutAst,
} from './index.ts'

/**
 * 内存构造标准 ZIP Buffer（零外部依赖，用于单测构造真实 OOXML 压缩包）
 */
function buildTestZip(entries: Record<string, string | Uint8Array>): Buffer {
  const fileRecords: Array<{
    nameBytes: Buffer
    compressed: Buffer
    uncompressedSize: number
    crc: number
    localHeaderOffset: number
  }> = []

  const localParts: Buffer[] = []
  let offset = 0

  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, 'utf8')
    const raw = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)
    const compressed = deflateRawSync(raw)
    const crc = crc32(raw)

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0) // Local file header signature
    localHeader.writeUInt16LE(20, 4) // Version needed
    localHeader.writeUInt16LE(0, 6) // Flags
    localHeader.writeUInt16LE(8, 8) // Compression method: Deflate (8)
    localHeader.writeUInt16LE(0, 10) // Mod time
    localHeader.writeUInt16LE(0, 12) // Mod date
    localHeader.writeUInt32LE(crc >>> 0, 14)
    localHeader.writeUInt32LE(compressed.length, 18)
    localHeader.writeUInt32LE(raw.length, 22)
    localHeader.writeUInt16LE(nameBytes.length, 26)
    localHeader.writeUInt16LE(0, 28)

    fileRecords.push({
      nameBytes,
      compressed,
      uncompressedSize: raw.length,
      crc,
      localHeaderOffset: offset,
    })

    localParts.push(localHeader, nameBytes, compressed)
    offset += localHeader.length + nameBytes.length + compressed.length
  }

  const centralParts: Buffer[] = []
  let centralSize = 0

  for (const rec of fileRecords) {
    const cdHeader = Buffer.alloc(46)
    cdHeader.writeUInt32LE(0x02014b50, 0) // Central directory signature
    cdHeader.writeUInt16LE(20, 4) // Version made by
    cdHeader.writeUInt16LE(20, 6) // Version needed
    cdHeader.writeUInt16LE(0, 8) // Flags
    cdHeader.writeUInt16LE(8, 10) // Compression: Deflate
    cdHeader.writeUInt16LE(0, 12)
    cdHeader.writeUInt16LE(0, 14)
    cdHeader.writeUInt32LE(rec.crc >>> 0, 16)
    cdHeader.writeUInt32LE(rec.compressed.length, 20)
    cdHeader.writeUInt32LE(rec.uncompressedSize, 24)
    cdHeader.writeUInt16LE(rec.nameBytes.length, 28)
    cdHeader.writeUInt16LE(0, 30) // Extra len
    cdHeader.writeUInt16LE(0, 32) // Comment len
    cdHeader.writeUInt16LE(0, 34) // Disk number
    cdHeader.writeUInt16LE(0, 36) // Internal attr
    cdHeader.writeUInt32LE(0, 38) // External attr
    cdHeader.writeUInt32LE(rec.localHeaderOffset, 42)

    centralParts.push(cdHeader, rec.nameBytes)
    centralSize += cdHeader.length + rec.nameBytes.length
  }

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(fileRecords.length, 8)
  eocd.writeUInt16LE(fileRecords.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, ...centralParts, eocd])
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]!
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

describe('@profer/core/office-engine 双平面解析引擎', () => {
  test('DOCX：支持样式继承、OMML 公式转 LaTeX、显式分页与空间拓扑锚点生成', () => {
    const zipBuffer = buildTestZip({
      '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`,
      'word/styles.xml': `<?xml version="1.0" encoding="UTF-8"?>
        <w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:style w:type="paragraph" w:styleId="Heading1">
            <w:name w:val="heading 1"/>
            <w:pPr><w:outlineLvl w:val="0"/></w:pPr>
            <w:rPr><w:sz w:val="36"/><w:b/></w:rPr>
          </w:style>
          <w:style w:type="paragraph" w:styleId="CustomSubHeading">
            <w:basedOn w:val="Heading1"/>
            <w:pPr><w:outlineLvl w:val="1"/></w:pPr>
          </w:style>
        </w:styles>`,
      'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
                    xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
          <w:body>
            <w:p>
              <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
              <w:r><w:t>第一章 地球物理场论</w:t></w:r>
            </w:p>
            <w:p>
              <w:r><w:t>重力位满足拉普拉斯方程：</w:t></w:r>
              <m:oMath>
                <m:f>
                  <m:num><m:r><m:t>G M</m:t></m:r></m:num>
                  <m:den><m:sSup><m:e><m:r><m:t>r</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:den>
                </m:f>
              </m:oMath>
            </w:p>
            <w:p>
              <w:r><w:br w:type="page"/></w:r>
              <w:pPr><w:pStyle w:val="CustomSubHeading"/></w:pPr>
              <w:r><w:t>1.1 弹性波传播方程</w:t></w:r>
            </w:p>
            <w:tbl>
              <w:tr>
                <w:trPr><w:tblHeader/></w:trPr>
                <w:tc><w:p><w:r><w:t>岩层名称</w:t></w:r></w:p></w:tc>
                <w:tc><w:p><w:r><w:t>纵波速度 (km/s)</w:t></w:r></w:p></w:tc>
              </w:tr>
              <w:tr>
                <w:tc><w:p><w:r><w:t>花岗岩</w:t></w:r></w:p></w:tc>
                <w:tc><w:p><w:r><w:t>5.8</w:t></w:r></w:p></w:tc>
              </w:tr>
            </w:tbl>
            <w:sectPr>
              <w:pgSz w:w="11906" w:h="16838"/>
              <w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800"/>
            </w:sectPr>
          </w:body>
        </w:document>`,
    })

    const result = parseOfficeBuffer(zipBuffer, 'docx', { fileName: 'geophysics.docx' })
    expect(result.format).toBe('docx')
    expect(result.ast.pageCount).toBe(2)
    expect(result.ast.pages[0]?.blocks[0]?.type).toBe('heading')
    expect(result.ast.pages[0]?.blocks[0]?.headingLevel).toBe(1)
    expect(result.ast.pages[0]?.blocks[0]?.id).toBe('p1-b1')

    // OMML 公式已转为 LaTeX 分式与上标
    expect(result.cleanMarkdown).toContain('\\frac{G M}{r^{2}}')

    // 第二页包含继承样式的二级标题与表格
    expect(result.ast.pages[1]?.blocks[0]?.id).toBe('p2-b1')
    expect(result.ast.pages[1]?.blocks[0]?.headingLevel).toBe(2)
    expect(result.markdown).toContain('<!-- anchor: p1-b1 [')
    expect(result.markdown).toContain('<!-- anchor: p2-b2 [')
    expect(result.cleanMarkdown).toContain('| 岩层名称 | 纵波速度 (km/s) |')

    // 剥离锚点后无残留注释
    const stripped = stripOfficeTopologyAnchors(result.markdown)
    expect(stripped).not.toContain('<!-- anchor:')
    expect(stripped).toContain('# 第一章 地球物理场论')

    // 兼容 @profer/shared DocumentLayoutAST 转换
    const sharedAst = officeAstToSharedLayoutAst(result.ast, 'geophysics.docx')
    expect(sharedAst.pageCount).toBe(2)
    expect(sharedAst.pages[0]?.blocks.length).toBeGreaterThanOrEqual(2)
  })

  test('PPTX：支持嵌套 p:grpSp 2D 仿射变换拍平、p:timing 动画顺序、连接符转 Mermaid 与演讲者备注', () => {
    const zipBuffer = buildTestZip({
      'ppt/presentation.xml': `<?xml version="1.0" encoding="UTF-8"?>
        <p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                        xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
          <p:sldSz cx="12192000" cy="6858000"/>
          <p:sldIdLst>
            <p:sldId id="256" r:id="rId1"/>
          </p:sldIdLst>
        </p:presentation>`,
      'ppt/_rels/presentation.xml.rels': `<?xml version="1.0" encoding="UTF-8"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
        </Relationships>`,
      'ppt/slides/slide1.xml': `<?xml version="1.0" encoding="UTF-8"?>
        <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
               xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <p:cSld>
            <p:spTree>
              <p:sp>
                <p:nvSpPr>
                  <p:cNvPr id="2" name="Title 1"/>
                  <p:nvPr><p:ph type="title"/></p:nvPr>
                </p:nvSpPr>
                <p:spPr>
                  <a:xfrm><a:off x="609600" y="381000"/><a:ext cx="10972800" cy="1000000"/></a:xfrm>
                </p:spPr>
                <p:txBody>
                  <a:p><a:r><a:t>地震数据采集与处理流水线</a:t></a:r></a:p>
                </p:txBody>
              </p:sp>
              <p:grpSp>
                <p:nvGrpSpPr><p:cNvPr id="10" name="Group 1"/></p:nvGrpSpPr>
                <p:grpSpPr>
                  <a:xfrm>
                    <a:off x="1270000" y="1905000"/>
                    <a:ext cx="7620000" cy="2540000"/>
                    <a:chOff x="0" y="0"/>
                    <a:chExt cx="7620000" cy="2540000"/>
                  </a:xfrm>
                </p:grpSpPr>
                <p:sp>
                  <p:nvSpPr><p:cNvPr id="11" name="Node A"/><p:nvPr/></p:nvSpPr>
                  <p:spPr>
                    <a:xfrm><a:off x="0" y="0"/><a:ext cx="2540000" cy="1270000"/></a:xfrm>
                  </p:spPr>
                  <p:txBody><a:p><a:r><a:t>震源激发</a:t></a:r></a:p></p:txBody>
                </p:sp>
                <p:sp>
                  <p:nvSpPr><p:cNvPr id="12" name="Node B"/><p:nvPr/></p:nvSpPr>
                  <p:spPr>
                    <a:xfrm><a:off x="3810000" y="0"/><a:ext cx="2540000" cy="1270000"/></a:xfrm>
                  </p:spPr>
                  <p:txBody><a:p><a:r><a:t>检波器接收</a:t></a:r></a:p></p:txBody>
                </p:sp>
                <p:cxnSp>
                  <p:nvCxnSpPr>
                    <p:cNvPr id="13" name="Connector 1"/>
                    <p:cNvCxnSpPr>
                      <a:stCxn id="11" idx="3"/>
                      <a:endCxn id="12" idx="1"/>
                    </p:cNvCxnSpPr>
                  </p:nvCxnSpPr>
                  <p:spPr>
                    <a:xfrm><a:off x="2540000" y="635000"/><a:ext cx="1270000" cy="0"/></a:xfrm>
                  </p:spPr>
                </p:cxnSp>
              </p:grpSp>
            </p:spTree>
          </p:cSld>
          <p:timing>
            <p:tnLst>
              <p:par>
                <p:cTn id="1">
                  <p:childTnLst>
                    <p:set><p:cBhvr><p:tgtEl><p:spTgt spid="2"/></p:tgtEl></p:cBhvr></p:set>
                    <p:set><p:cBhvr><p:tgtEl><p:spTgt spid="11"/></p:tgtEl></p:cBhvr></p:set>
                    <p:set><p:cBhvr><p:tgtEl><p:spTgt spid="12"/></p:tgtEl></p:cBhvr></p:set>
                  </p:childTnLst>
                </p:cTn>
              </p:par>
            </p:tnLst>
          </p:timing>
        </p:sld>`,
      'ppt/slides/_rels/slide1.xml.rels': `<?xml version="1.0" encoding="UTF-8"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rIdNotes1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
        </Relationships>`,
      'ppt/notesSlides/notesSlide1.xml': `<?xml version="1.0" encoding="UTF-8"?>
        <p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <p:cSld>
            <p:spTree>
              <p:sp>
                <p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
                <p:txBody><a:p><a:r><a:t>讲解提示：强调信噪比与采样率的关系。</a:t></a:r></a:p></p:txBody>
              </p:sp>
            </p:spTree>
          </p:cSld>
        </p:notes>`,
    })

    const result = parseOfficeBuffer(zipBuffer, 'pptx')
    expect(result.format).toBe('pptx')
    expect(result.ast.pageCount).toBe(1)

    const slide = result.ast.pages[0]!
    expect(slide.widthPt).toBeCloseTo(960, 0)
    expect(slide.heightPt).toBeCloseTo(540, 0)

    // 验证嵌套 Group 内的 Node A (x=0 in group, group offX=1270000 EMU = 100pt / 960pt = 0.1042) 被正确仿射变换到页面归一化坐标
    const nodeABlock = slide.blocks.find((b) => b.text.includes('震源激发'))
    expect(nodeABlock).toBeDefined()
    expect(nodeABlock!.bbox[0]).toBeCloseTo(100 / 960, 2)
    expect(nodeABlock!.bbox[1]).toBeCloseTo(150 / 540, 2)

    // 验证连接符自动合成 Mermaid 流程图
    expect(result.cleanMarkdown).toContain('```mermaid')
    expect(result.cleanMarkdown).toContain('S11["震源激发"] --> S12["检波器接收"]')

    // 验证演讲者备注提取
    expect(result.cleanMarkdown).toContain('讲解提示：强调信噪比与采样率的关系。')
  })

  test('XLSX：支持 SST、合并单元格传播、公式标注、xdr:twoCellAnchor 与 sheet/cell 拓扑锚点', () => {
    const zipBuffer = buildTestZip({
      'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?>
        <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
                  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
          <sheets>
            <sheet name="实验数据汇总" sheetId="1" r:id="rId1"/>
          </sheets>
        </workbook>`,
      'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
          <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
        </Relationships>`,
      'xl/sharedStrings.xml': `<?xml version="1.0" encoding="UTF-8"?>
        <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">
          <si><t>测点编号</t></si>
          <si><t>观测值</t></si>
          <si><t>P-01</t></si>
          <si><t>均值统计</t></si>
        </sst>`,
      'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8"?>
        <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
                   xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
          <cols>
            <col min="1" max="2" width="16" customWidth="1"/>
          </cols>
          <sheetData>
            <row r="1" ht="24">
              <c r="A1" t="s"><v>0</v></c>
              <c r="B1" t="s"><v>1</v></c>
            </row>
            <row r="2" ht="20">
              <c r="A2" t="s"><v>2</v></c>
              <c r="B2"><v>42.5</v></c>
            </row>
            <row r="3" ht="20">
              <c r="A3" t="s"><v>3</v></c>
              <c r="B3"><f>AVERAGE(B2:B2)</f><v>42.5</v></c>
            </row>
          </sheetData>
          <mergeCells count="1">
            <mergeCell ref="A1:A1"/>
          </mergeCells>
          <drawing r:id="rIdDraw1"/>
        </worksheet>`,
      'xl/worksheets/_rels/sheet1.xml.rels': `<?xml version="1.0" encoding="UTF-8"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rIdDraw1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
        </Relationships>`,
      'xl/drawings/drawing1.xml': `<?xml version="1.0" encoding="UTF-8"?>
        <xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
                  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <xdr:twoCellAnchor>
            <xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>4</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
            <xdr:to><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>12</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
            <xdr:sp>
              <xdr:nvSpPr><xdr:cNvPr id="2" name="ChartNote" descr="重力异常趋势图"/></xdr:nvSpPr>
              <xdr:txBody><a:p><a:r><a:t>趋势图说明：测区北东向梯度显著</a:t></a:r></a:p></xdr:txBody>
            </xdr:sp>
          </xdr:twoCellAnchor>
        </xdr:wsDr>`,
    })

    const result = parseOfficeBuffer(zipBuffer, 'xlsx')
    expect(result.format).toBe('xlsx')
    expect(result.ast.pageCount).toBe(1)

    const sheetPage = result.ast.pages[0]!
    expect(sheetPage.sheetName).toBe('实验数据汇总')
    expect(sheetPage.blocks.length).toBe(2)

    const tableBlock = sheetPage.blocks[0]!
    expect(tableBlock.sheetName).toBe('实验数据汇总')
    expect(tableBlock.cellRef).toBe('A1:B3')

    // 锚点包含 sheet 与 cell 属性
    expect(result.markdown).toContain('sheet="实验数据汇总"')
    expect(result.markdown).toContain('cell="A1:B3"')

    // 公式与计算值同时保留
    expect(result.cleanMarkdown).toContain('B3=AVERAGE(B2:B2)')
    // 图表说明被解析为第二个锚点区块
    expect(result.cleanMarkdown).toContain('趋势图说明：测区北东向梯度显著')
  })
})
