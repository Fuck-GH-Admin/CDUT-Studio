---
name: pdf
description: "Use this skill whenever the user mentions a PDF file or asks to inspect, summarize, query, modify or create one. CRITICAL KERNEL CONTRACT: Attached PDFs are pre-parsed by CDUT Studio's high-precision kernel engine into dual-state workspace artifacts (<attached_documents>): (1) clean_markdown_path in the working directory is an already-materialized, zero-HTML-anchor clean Markdown file ready for direct user delivery; (2) the workspace is indexed by silent RAG, which auto-retrieves the most relevant slices with real citation anchors ([第X页·位置](#blockId)) and injects them into <document_evidence> before your turn. Answer and cite directly from that evidence; never call discover_tools for PDF parsing and never run Python/CLI scripts to extract text from pre-ingested PDFs."
license: Proprietary. LICENSE.txt has complete terms
version: "1.2.2"
---

# PDF Processing Guide

## Overview

This guide defines how to handle PDF files in CDUT Studio.

## Read-Only & Markdown Export Operations (Dual-State Kernel Artifacts)

Use this section for requests like "read this PDF", "summarize this PDF", "answer questions from this PDF", "extract the main points", or "parse to Markdown in workspace".

1. **Dual-State Kernel Pre-Ingestion (`<attached_documents>`)**:
   - Before your turn starts, CDUT Studio's non-autoregressive kernel engine automatically parses attached PDFs and materializes two artifacts on disk:
     - **`clean_markdown_path` (`<cwd>/<stem>.md`)**: A clean, deliverables-ready Markdown file in the working directory with multi-column reading order, GFM tables, and LaTeX display equations (no HTML comment anchors).
     - **`anchored_markdown_path` (`<cwd>/.context/artifacts/<stem>.anchored.md`)**: An anchored index with dual-parallel interactive citation markers (`[第X页·位置](#blockId)`). The system also auto-retrieves the most relevant slices into `<document_evidence>` before each turn.
   - **There is NO `parse_document` external tool**. Do NOT call `discover_tools` to look for PDF parsers, and do NOT run Python or CLI scripts (`pdfplumber`, `pypdf`, `pypdfium2`, `pymupdf`, `fitz`, `pdftotext`) to extract text.

2. **Immediate Task Execution**:
   - **When asked to "parse/convert PDF to Markdown in workspace"**: The file at `clean_markdown_path` is ALREADY written in the working directory! Report its path and summary directly (or refine it with `Edit`/`Write` if the user requested custom formatting).
   - **When asked to summarize, analyze, or answer questions**: Trust the auto-injected `<document_evidence>` slices (they already contain the most relevant source text with real anchors). For full text beyond the evidence, Read `clean_markdown_path` directly. Cite sources using `[第X页·位置/图表名](#blockId)`.

3. **Visual Preview**:
   - Use `inspect_preview` / `open_file_preview` only when you need visual output (rendered page images or user-visible viewer), not for extracting plain text.

4. **Scanned Documents (Fallback Only)**:
   - If the attached document explicitly states it has no text layer, treat it as a scanned document and follow the OCR section below.

5. **Output Language**: All user-facing output — summaries, answers, and any delivered or refined Markdown files — must be written in the user's language (e.g., Simplified Chinese when the user writes in Chinese).

## Modification and Advanced Processing

Use the sections below when the user asks to modify PDFs, create PDFs, fill forms, extract images, OCR scanned pages, or perform precise table extraction that the built-in Read tool cannot handle.

## Python Libraries

### pypdf - Basic Operations

#### Merge PDFs
```python
from pypdf import PdfWriter, PdfReader

writer = PdfWriter()
for pdf_file in ["doc1.pdf", "doc2.pdf", "doc3.pdf"]:
    reader = PdfReader(pdf_file)
    for page in reader.pages:
        writer.add_page(page)

with open("merged.pdf", "wb") as output:
    writer.write(output)
```

#### Split PDF
```python
reader = PdfReader("input.pdf")
for i, page in enumerate(reader.pages):
    writer = PdfWriter()
    writer.add_page(page)
    with open(f"page_{i+1}.pdf", "wb") as output:
        writer.write(output)
```

#### Extract Metadata
```python
reader = PdfReader("document.pdf")
meta = reader.metadata
print(f"Title: {meta.title}")
print(f"Author: {meta.author}")
print(f"Subject: {meta.subject}")
print(f"Creator: {meta.creator}")
```

#### Rotate Pages
```python
reader = PdfReader("input.pdf")
writer = PdfWriter()

page = reader.pages[0]
page.rotate(90)  # Rotate 90 degrees clockwise
writer.add_page(page)

with open("rotated.pdf", "wb") as output:
    writer.write(output)
```

### reportlab - Create PDFs

#### Basic PDF Creation
```python
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

c = canvas.Canvas("hello.pdf", pagesize=letter)
width, height = letter

# Add text
c.drawString(100, height - 100, "Hello World!")
c.drawString(100, height - 120, "This is a PDF created with reportlab")

# Add a line
c.line(100, height - 140, 400, height - 140)

# Save
c.save()
```

#### Create PDF with Multiple Pages
```python
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak
from reportlab.lib.styles import getSampleStyleSheet

doc = SimpleDocTemplate("report.pdf", pagesize=letter)
styles = getSampleStyleSheet()
story = []

# Add content
title = Paragraph("Report Title", styles['Title'])
story.append(title)
story.append(Spacer(1, 12))

body = Paragraph("This is the body of the report. " * 20, styles['Normal'])
story.append(body)
story.append(PageBreak())

# Page 2
story.append(Paragraph("Page 2", styles['Heading1']))
story.append(Paragraph("Content for page 2", styles['Normal']))

# Build PDF
doc.build(story)
```

#### Subscripts and Superscripts

**IMPORTANT**: Never use Unicode subscript/superscript characters (₀₁₂₃₄₅₆₇₈₉, ⁰¹²³⁴⁵⁶⁷⁸⁹) in ReportLab PDFs. The built-in fonts do not include these glyphs, causing them to render as solid black boxes.

Instead, use ReportLab's XML markup tags in Paragraph objects:
```python
from reportlab.platypus import Paragraph
from reportlab.lib.styles import getSampleStyleSheet

styles = getSampleStyleSheet()

# Subscripts: use <sub> tag
chemical = Paragraph("H<sub>2</sub>O", styles['Normal'])

# Superscripts: use <super> tag
squared = Paragraph("x<super>2</super> + y<super>2</super>", styles['Normal'])
```

For canvas-drawn text (not Paragraph objects), manually adjust font the size and position rather than using Unicode subscripts/superscripts.

## Command-Line Tools

### qpdf
```bash
# Merge PDFs
qpdf --empty --pages file1.pdf file2.pdf -- merged.pdf

# Split pages
qpdf input.pdf --pages . 1-5 -- pages1-5.pdf
qpdf input.pdf --pages . 6-10 -- pages6-10.pdf

# Rotate pages
qpdf input.pdf output.pdf --rotate=+90:1  # Rotate page 1 by 90 degrees

# Remove password
qpdf --password=mypassword --decrypt encrypted.pdf decrypted.pdf
```

### pdftk (if available)
```bash
# Merge
pdftk file1.pdf file2.pdf cat output merged.pdf

# Split
pdftk input.pdf burst

# Rotate
pdftk input.pdf rotate 1east output rotated.pdf
```

## Common Tasks

### Extract Text from Scanned PDFs
```python
# Requires: pip install pytesseract pdf2image
import pytesseract
from pdf2image import convert_from_path

# Convert PDF to images
images = convert_from_path('scanned.pdf')

# OCR each page
text = ""
for i, image in enumerate(images):
    text += f"Page {i+1}:\n"
    text += pytesseract.image_to_string(image)
    text += "\n\n"

print(text)
```

### Add Watermark
```python
from pypdf import PdfReader, PdfWriter

# Create watermark (or load existing)
watermark = PdfReader("watermark.pdf").pages[0]

# Apply to all pages
reader = PdfReader("document.pdf")
writer = PdfWriter()

for page in reader.pages:
    page.merge_page(watermark)
    writer.add_page(page)

with open("watermarked.pdf", "wb") as output:
    writer.write(output)
```

### Extract Images
```bash
# Using pdfimages (poppler-utils)
pdfimages -j input.pdf output_prefix

# This extracts all images as output_prefix-000.jpg, output_prefix-001.jpg, etc.
```

### Password Protection
```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("input.pdf")
writer = PdfWriter()

for page in reader.pages:
    writer.add_page(page)

# Add password
writer.encrypt("userpassword", "ownerpassword")

with open("encrypted.pdf", "wb") as output:
    writer.write(output)
```

## Quick Reference

| Task | Best Tool | Command/Code |
|------|-----------|--------------|
| Merge PDFs | pypdf | `writer.add_page(page)` |
| Split PDFs | pypdf | One page per file |
| Export PDF to Markdown | Kernel clean artifact | Already written at `clean_markdown_path` in `<attached_documents>` |
| Read, summarize, or query PDFs | `<document_evidence>` / Read `clean_markdown_path` | Auto-injected relevant slices; Read full clean Markdown |
| Get page count or outline | `<attached_documents>` | Present in `<attached_document>` attributes and `<outline>` |
| Create PDFs | reportlab | Canvas or Platypus |
| Command line merge | qpdf | `qpdf --empty --pages ...` |
| OCR scanned PDFs | pytesseract | Convert to image first |
| Fill PDF forms | pdf-lib or pypdf (see FORMS.md) | See FORMS.md |

## Next Steps

- For advanced pypdfium2 usage, see REFERENCE.md
- For JavaScript libraries (pdf-lib), see REFERENCE.md
- If you need to fill out a PDF form, follow the instructions in FORMS.md
- For troubleshooting guides, see REFERENCE.md
