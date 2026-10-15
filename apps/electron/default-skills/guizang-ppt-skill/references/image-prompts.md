# GPT-M 2.0 Image Prompts

Used to generate PPT images for this skill in the Codex environment. Prompts only set the tone; don't write them into long essays. First judge the image slot and ratio, then choose the type.

## General rules

- First judge the current deck style: Style A = 电子杂志 × 电子墨水 (E-Magazine × E-Ink); Style B = 瑞士国际主义 / Swiss Style
- Style A tone: E-Magazine × E-Ink; restrained, real, generous whitespace; fits horizontal web PPTs
- Style B tone: Swiss International Typographic Style; 12/16-column grids, Helvetica/Inter temperament, one highly saturated accent, square-cornered solid colors, hairlines, extreme whitespace
- Text language inside infographics, charts and screenshot redesigns must follow the user's language: Chinese deck uses Chinese, English deck uses English
- Do not generate cartoons, 3D, neon-tech looks, SaaS-template looks, over-decoration or fake logos
- Images must leave overlay space for titles or body copy; don't pile details edge to edge
- Images on the same page or in the same group must share ratio, visual scale and margin density
- Images are material embedded into the PPT, not standalone slides: do not generate headers, footers, page numbers, title bars, corner marks, signatures, decorative borders or slide chrome
- After generating, save into `images/`, named `{页号}-{语义}.{ext}` (page-number–semantic-name)

## Ratio selection

| Use | Recommended ratio | HTML slot |
|------|---------|-----------|
| Section cover / full-screen hero visual | 16:9 | `.frame-img.r-16x9` or hero background reference |
| Swiss top banner / Image Hero | 16:9 or 21:9 | P22 top image cover / `.frame-img.r-21x9` |
| Quote+image main image | 16:10 or 4:3 | `.frame-img.r-16x10` / `.frame-img.r-4x3` |
| Infographic / system-relation diagram | 16:9 or 16:10 | Original screenshots use `.fit-contain`; slot-regenerated ones fill with `.frame-img.r-16x9` / `.frame-img.r-16x10` |
| Screenshot redesign / UI scene | 16:10 or 21:9 | Original screenshots use `.fit-contain`; regenerated into S15/S16 fill with `.frame-img.r-21x9` |
| Mixed-layout small images | 3:2 or 3:4 | `.frame-img.r-3x2` / `.frame-img.r-3x4` |
| Image grid | Uniform landscape | `.frame-img.h-22` / `.frame-img.h-26` |
| Small panel groups | Uniform landscape | `.frame-img.h-16` / `.frame-img.h-18` |

For infographics and screenshot redesigns coming from uncontrollable original material, prefer `fit-contain` to avoid cropping text; if GPT-M 2.0 regenerates them for a slot, they must be generated at the slot's ratio and fill the container — never let a small image float in a white frame. Documentary photos prefer the default `cover` to keep visual tension.

## Image standardization strategy

### A. Choose the target slot first

Never generate images first and then force them into the page. Decide the placement first:

1. Hero visual: 16:9
2. Quote+image: 16:10 or 4:3
3. Infographic/screenshot redesign: 16:9 or 16:10, using `fit-contain`
4. Multi-image grids/panel groups: uniform height classes; mixing heights within one group is forbidden

### B. Handling the user's original images/screenshots

Original screenshot ratios are usually uncontrollable; don't treat them as the final visual standard. Handle in this order:

1. If the original ratio is close to the target slot, put it directly into a uniform `.frame-img` with `cover` or `fit-contain`
2. If the original is too tall, too narrow or too long, prefer regenerating a "screenshot redesign / UI scene" at the target ratio
3. If one UI image got stretched into a giant strip, split it into 2-3 same-size partial panels; each panel uses the same height class
4. If the original must be kept, put it into a uniform frame with `fit-contain`, accept the whitespace, and never crop key text

### C. Prompt suffix

Every image prompt ends with this spec constraint:

```text
The output must be a [16:9/16:10/4:3/3:2] landscape composition with the subject centered but margins preserved, medium visual density, matching the same group's visual scale and margins. Keep only the core graphic/scene itself; do not generate headers, footers, titles, page numbers, corner marks, signatures, decorative borders, ultra-long strips, portrait images or irregular ratios.
```

When one page needs multiple images, add:

```text
This is one image of a group; keep the same aspect ratio, element sizes, margins, line weights and annotation density as the other images in the group.
```

## Type 1: Documentary photo

For adding presence, emotion and real-world anchors.

```text
Generate a landscape documentary photograph about: [page concept]. Style like Fujifilm / Leica editorial documentary: natural light, low saturation, slight film grain, a real working or living scene, restrained and human. Suits an E-Magazine × E-Ink PPT, leaving room for the title. No commercial staging, sci-fi interfaces, AI robots, logos or watermarks. The output must be a [16:9/16:10/4:3] landscape composition with the subject centered but margins preserved, medium density. Keep only the core photograph itself; do not generate headers, footers, titles, page numbers, corner marks, signatures, decorative borders, ultra-long strips, portrait images or irregular ratios.
```

## Type 2: Magazine-style infographic

For explaining concepts, flows, comparisons, system relations.

```text
Generate a landscape magazine-style infographic explaining: [concept/flow/relation]. E-Ink style, mostly black/white/grey, a little low-saturation accent color, thin lines, grids, numbering, short labels, generous whitespace. Text inside the image uses [Chinese/English], kept short and readable. No cartoons, 3D, neon tech looks or template looks. The output must be a [16:9/16:10] landscape composition with the subject centered but margins preserved, medium density. Keep only the core infographic itself; do not generate headers, footers, titles, page numbers, corner marks, signatures, decorative borders, ultra-long strips, portrait images or irregular ratios.
```

## Type 3: Flow / pipeline diagram

For clarifying an A → B → C process.

```text
Generate a landscape flow infographic showing: [step 1] → [step 2] → [step 3] → [result]. Style: E-Magazine × E-Ink, thin arrows, segmented numbering, short annotations, restrained whitespace. Text inside the image uses [Chinese/English]. Keep only the core flow diagram itself; no headers, footers, titles, page numbers, corner marks, signatures or decorative borders. Ratio: 16:9.
```

## Type 4: Comparison diagram

For before/after, old vs new modes, two collaboration styles.

```text
Generate a landscape comparison infographic: the left side is [old mode], the right side is [new mode]. Style like an analysis graphic in a high-end indie magazine: black/white/grey plus one low-saturation accent, thin column dividers, short labels, clear hierarchy. Text inside the image uses [Chinese/English]. Keep only the core comparison itself; no headers, footers, titles, page numbers, corner marks, signatures or decorative borders. Ratio: 16:9.
```

## Type 5: System-relation diagram

For relations among roles, tools and modules.

```text
Generate a landscape system-relation diagram showing how [roles/tools/modules] connect. E-Ink magazine style: nodes, thin lines, arrows, numbering and a few short annotations, clear structure, generous whitespace. Text inside the image uses [Chinese/English]. Keep only the core relation diagram itself; no headers, footers, titles, page numbers, corner marks, signatures or decorative borders. Ratio: 16:9.
```

## Type 6: Screenshot redesign / UI scene

For turning real screenshots, code, design drafts and workspaces into unified visual material.

```text
Generate a landscape UI scene that redesigns [screenshot/interface/workspace content] into a magazine-style visual. Keep the feel of a real product workflow: paper base color, thin line frames, grids, a few annotations and restrained shadows. Text inside the image uses [Chinese/English], short and clear. No real brand logos, flashy dashboards, neon gradients or heavy skeuomorphism. The output must be a 16:10 landscape composition with the subject centered but margins preserved, medium density. Keep only the core UI scene itself; do not generate headers, footers, titles, page numbers, corner marks, signatures, decorative borders, ultra-long strips, portrait images or irregular ratios.
```

## Type 7: Big-number visual

For highlighting one key number or a few metrics.

```text
Generate a landscape big-number visual. The core number is: [number]; its meaning is: [meaning]. Style: E-Ink magazine layout, oversized serif numbers, a few short annotations, thin lines, whitespace and paper texture. Text inside the image uses [Chinese/English]. Keep only the core data visual itself; no headers, footers, titles, page numbers, corner marks, signatures or decorative borders. Ratio: 16:9.
```

---

## Style B: Swiss International image rules

When the deck uses `assets/template-swiss.html` / `layouts-swiss.md`, prefer the prompts below. They pair with GPT-M 2.0 and aim to generate images that drop straight into the original registered layout slots, especially the S22 top banner and the S15/S16 multi-image grids.

### Swiss image hard rules

- Visual anchors: International Typographic Style / Swiss modernism / Helvetica / Josef Müller-Brockmann / Massimo Vignelli
- Composition: strict 12/16-column grid, asymmetric whitespace, left-aligned, hairlines, square-cornered modules
- Color: only black, white, grey and **one** theme accent (IKB blue by default; if the user picked lemon yellow/green/safety orange, substitute that accent)
- Forbidden: gradients, shadows, rounded corners, glassmorphism, neon, 3D, cartoons, SaaS-template looks, fake logos, decorative borders
- Do not generate a PPT shell inside the image: no headers, footers, page numbers, title bars, corner marks, signatures or outer frames
- UI / infographic text must be short and language-consistent in Chinese/English; real photos should avoid text entirely
- Settle the layout slot before generating: single large image → `s22-hero-21x9`; multi-image grids → `s15-grid-21x9` or `s16-brief-21x9`
- 21:9 images must keep the core subject within the central 70% safe area with surrounding whitespace; never butt faces, key nodes or UI text against the edges

### Swiss Type 1: Documentary photo / case hero

For S22 Image Hero, adding a real-scene anchor.

```text
Generate a 21:9 ultra-wide landscape documentary photograph about: [page concept]. Style: Swiss editorial documentary — high contrast, low saturation, calm and restrained, a real office/city/product-in-use scene, a composition with lots of negative space, the subject within the central 70% safe area, suited to the top banner of a Swiss International Style PPT. No AI robots, sci-fi interfaces, commercial staging, logos, watermarks or text. Keep only the core photograph itself; no headers, footers, titles, page numbers, corner marks, signatures, decorative borders or PPT shells.
```

### Swiss Type 2: Infographic / system-relation diagram

For explaining concepts, architecture, flows, and the separation of data from presentation.

```text
Generate a landscape Swiss Style infographic explaining: [concept/flow/system relation]. Use Helvetica/Inter-style sans-serif short labels, a 12/16-column grid, square-cornered modules, 1px hairlines, black/white/grey and one [IKB blue/lemon yellow/lemon green/safety orange] accent. Text inside the image uses [Chinese/English], each label ≤ 8 characters/words. No gradients, shadows, rounded corners, 3D, cartoons, neon or SaaS-template looks. Output ratio [21:9/16:10], subject centered with generous whitespace. Keep only the core infographic itself; no headers, footers, titles, page numbers, corner marks, signatures, decorative borders or PPT shells.
```

### Swiss Type 3: Screenshot redesign / UI scene

For redrawing screenshots, workspaces, code and dashboards into a unified Swiss-style visual.

```text
Generate a landscape UI scene that redesigns [screenshot/interface/workspace content] into Swiss International Typographic Style. Use a minimal dashboard / workspace structure: square-cornered panels, hairlines, a 12-column grid, a little [IKB blue/lemon yellow/lemon green/safety orange] accent, no shadows or rounded corners. Text inside the image uses [Chinese/English], short and clear, no real brand logos. The output must be a 16:10 landscape composition, medium visual density, suited to `.frame-img.r-16x10.fit-contain`. Keep only the core UI scene itself; no headers, footers, titles, page numbers, corner marks, signatures, decorative borders or PPT shells.
```

### Swiss Type 4: Multi-image grid single asset

For S15/S16 image-cell adaptations; generate one by one when a group of 2-6 images sits side by side.

```text
Generate a landscape evidence image about: [evidence A/B/C]. This is one image of a Swiss Style group; keep square-cornered modules, black/white/grey, a single [IKB blue/lemon yellow/lemon green/safety orange] accent, identical margins, identical line weights and identical visual scale. Text inside the image uses [Chinese/English], short labels only. The output must be a [21:9/16:10] landscape composition suited to the unified S15/S16 image cells. Keep only the core image itself; no headers, footers, titles, page numbers, corner marks, signatures, decorative borders or PPT shells.
```

### Swiss Type 5: Minimal chart / data block

For small data-explanation images inside S21 or S15/S16 image cells.

```text
Generate a landscape Swiss Style data graphic. The core data is: [number/comparison/ranking]; the meaning is: [explanation]. Use oversized sans-serif numbers, 1px hairlines, square-cornered color blocks, black/white/grey and one [IKB blue/lemon yellow/lemon green/safety orange] accent, like the data layouts of Swiss posters. Text inside the image uses [Chinese/English], keeping only necessary labels. No gradients, shadows, rounded corners, 3D or decorative borders. Ratio: [16:9/16:10]. Keep only the core data graphic itself; no headers, footers, titles, page numbers, corner marks, signatures or PPT shells.
```
