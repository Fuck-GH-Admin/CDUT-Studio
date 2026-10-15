---
name: guizang-ppt-skill
description: 生成横向翻页网页 PPT（单 HTML 文件），含 WebGL 背景、章节幕封、数据大字报、图片网格等模板。提供两种风格：① "电子杂志 × 电子墨水"（衬线 + 流体背景 + 暖色） ② "瑞士国际主义"（无衬线 + 网格点阵 + IKB/柠檬黄/柠檬绿/安全橙高亮）。当用户需要制作分享 / 演讲 / 发布会风格的网页 PPT，或提到"杂志风 PPT"、"瑞士风 PPT"、"Swiss Style"、"horizontal swipe deck"时使用。
version: "1.0.1"
---

# Magazine Web Ppt

## What This Skill Does

Generates a **single-file HTML** 横向翻页 PPT (horizontal-swipe web PPT) with two selectable visual tones:

### Style A · 电子杂志 × 电子墨水 (E-Magazine × E-Ink, Default)

- **WebGL fluid / contour-line / dispersion background** (visible on hero pages)
- **Serif display headings (Noto Serif SC + Playfair Display) + sans-serif body + monospace metadata**
- Best for: humanities talks, industry observation, business launches, talks that need a "magazine feel"
- Template: `assets/template.html` · Theme colors: `references/themes.md` · Layouts: `references/layouts.md`
- Aesthetic anchor: like *Monocle* magazine with code applied

### Style B · 瑞士国际主义 (Swiss International Style)

- **WebGL ultra-fine grid + dot-matrix background** (information-driven design)
- **Sans-serif throughout (Inter + Helvetica + Noto Sans SC) + extreme type-size contrast**
- **High-contrast functional colors**: Klein Blue IKB / Lemon Yellow / Lemon Green / Safety Orange (choose one of four)
- Best for: tech products, data reports, design/engineering talks, annual reviews
- Template: `assets/template-swiss.html` · Theme colors: `references/themes-swiss.md` · Layouts: `references/layouts-swiss.md`
- Aesthetic anchor: like Massimo Vignelli + Helvetica Forever

**Shared by both styles**: horizontal page flipping (keyboard ← →, mouse wheel, touch, ESC index), Lucide icons, Motion One entrance animations (local + CDN double fallback).

## When to Use

**Good fits**:
- In-person talks / internal industry briefings / private salons
- AI product launches / demo days
- Talks with a strong personal style
- Web-based slides where you want to "produce it in one pass, no slide software"

**Poor fits**:
- Large tables of data, stacked charts (use a conventional PPT)
- Training courseware (information density too low)
- Multi-person collaborative editing (this is static HTML)

## Workflow

### Step 1 · Requirement clarification (must do before building)

**If the user has already provided a complete outline + images**, skip ahead to Step 2.

**If the user only gave a topic or a vague idea**, align on the 6 questions below one by one before starting. Do not begin writing slides based on guesses—once the structure is wrong, late-stage rework is very costly:

#### Runtime environment adaptation

- **In Codex**: ask the user directly in plain conversation; do not invoke Claude Code's `ask question` / `ask_question` mechanism, and do not assume those tools are available. Ask at most 1-3 of the most critical questions at a time; if a missing detail does not block starting work, make a reasonable assumption and state it in your reply.
- **In Claude Code**: you may keep using the existing `ask question` interaction to clarify item by item.

#### 7-question clarification checklist

| # | Question | Why ask |
|---|------|-----------|
| 1 | **Style A or B?** (E-Magazine style / Swiss International style) | **Must ask first**; decides which template + layouts + themes file to use |
| 2 | **Who is the audience? What is the occasion?** (internal industry / commercial launch / demo day / private salon) | Decides language style and depth |
| 3 | **How long is the talk?** | 15 minutes ≈ 10 pages, 30 minutes ≈ 20 pages, 45 minutes ≈ 25-30 pages |
| 4 | **Any raw material?** (documents / data / old PPT / article links) | Build on material when present; otherwise scaffold it for them |
| 5 | **Any images? Where?** | See "Image conventions" below |
| 6 | **Which theme palette?** | Magazine style: 5 presets (`themes.md`) / Swiss style: 4 presets (`themes-swiss.md`); pick one |
| 7 | **Any hard constraints?** (must include XX data / must not mention YY) | Avoid rework |

#### Style selection guide (question 1)

| If the user says... | Recommended style |
|---|---|
| "杂志感 (magazine feel)" / "人文 (humanities)" / "Monocle 风" / unspecified | **A · E-Magazine** |
| "瑞士风 (Swiss)" / "Swiss Style" / "Helvetica" / "极简 (minimal)" / "网格 (grid)" / "信息图 (infographic)" / "data-driven" | **B · Swiss International** |
| Content is an AI product / technology / engineering / data report | B fits better |
| Content is industry observation / humanities / story / culture | A fits better |
| The user supplied lots of KPI numbers / roadmaps / processes | B fits better (the `Data Hero` layout is a Swiss specialty) |
| The user supplied lots of documentary photos / humanities images | A fits better (image grids and quote+image are magazine specialties) |
| The user needs GPT-M 2.0 screenshot redesigns / infographics / evidence walls | B also fits well (P23/P24 are Swiss image-specific layouts) |

#### Outline assistance (if the user has no outline)

Use the "narrative arc" template to build the skeleton, then fill in content:

```
Hook            → 1 page   : open with a contrast / question / hard number that makes people stop
Context         → 1-2 pages: explain the background / who you are / why this topic
Core            → 3-5 pages: the core content, alternating Layouts 4/5/6/9/10
Shift           → 1 page   : break expectations / propose a new viewpoint
Takeaway        → 1-2 pages: a punchline / an open question / a call to action
```

Narrative arc + page-count plan + theme rhythm table (see `layouts.md`): **align all three tables** before moving to Step 2.

Suggest saving the outline as `项目记录.md` (project notes) or `大纲-v1.md` (outline v1) for later iteration.

#### Image conventions (tell the user)

Before starting, make the following clear to the user:

- **Folder location**: under `项目/XXX/ppt/images/` (same level as `index.html`)
- **Naming convention**: `{页号}-{语义}.{ext}` (page-number–semantic-name), e.g. `01-cover.jpg` / `03-figma.jpg` / `05-dashboard.png`
  - Zero-pad page numbers for sorting
  - Semantic part in English, short, specific, matching the content
- **Spec advice**:
  - Each image ≥ 1600px wide (avoids blur on large screens)
  - JPG for photos/screenshots, PNG for transparent UI/charts
  - Keep total size under 10MB (affects flip smoothness)
- **How to replace**: keeping **the same filename and overwriting** is safest (no path changes in HTML); if a filename changes, globally search `images/旧名` (old name) and replace with the new name
- **No images?**: align with the user; you can generate the structure with placeholder color blocks first and add images later, but warn that image-mixed pages such as layouts 4/5/10 cannot be visually verified without images

#### Codex image generation (optional)

If the current runtime is **Codex**, after finishing the first draft of the deck, proactively ask the user whether to generate images with GPT-M 2.0 and insert them into the PPT. Do not generate by default.

Suggested way to ask (user-facing example):

> 要不要为这份 PPT 生成几张配图?可以做成人文纪实照片、杂志风信息图、流程/对比/系统关系图,或把截图再设计成统一的杂志风视觉。

If the user confirms generation, then ask which image type or style they want; if the user has no preference, recommend 1-3 of the most worthwhile images based on the page content.

When generating images, follow:

- Keep prompts short; only frame the subject, usage, style and aspect ratio; do not write long photography direction
- Image style must match the current deck style: Style A uses "电子杂志 × 电子墨水 (E-Magazine × E-Ink)"; Style B uses "瑞士国际主义 / Swiss Style"
- Text language inside infographics, charts and screenshot redesigns must follow the user's current language: Chinese deck uses Chinese, English deck uses English
- First read `references/image-prompts.md` to choose image types and base prompts
- Image aspect ratios must match the final slot: hero visual 16:9, quote+image 16:10 / 4:3, infographic 16:9 / 16:10, screenshot redesign 16:10, mixed-layout small images 3:2 / 3:4, grid images uniformly height-cropped
- Save generated images into `images/`, named `{页号}-{语义}.{ext}` (page-number–semantic-name)

### Step 2 · Copy the template

**Based on the style chosen in Step 1, copy the corresponding template** to the target location (usually `项目/XXX/ppt/index.html`), and create a sibling `images/` folder to receive images.

```bash
mkdir -p "项目/XXX/ppt/images"

# 风格 A · 电子杂志风
cp "<SKILL_ROOT>/assets/template.html" "项目/XXX/ppt/index.html"

# 或 风格 B · 瑞士国际主义风
cp "<SKILL_ROOT>/assets/template-swiss.html" "项目/XXX/ppt/index.html"
```

Both `template*.html` files are **fully runnable**—CSS, WebGL shaders, flip JS, font/icon CDNs are all preconfigured; only the `<!-- SLIDES_HERE -->` placeholder awaits your slide content.

**Note**: Styles A and B **cannot be mixed**. The classes in layouts.md (e.g. `.h-hero` serif display heading, `.display-zh`, etc.) are defined only in template.html; the classes in layouts-swiss.md (e.g. `.kpi-hero`, `.accent-block`, `.span-N`, `.dots`, etc.) are defined only in template-swiss.html. One deck uses exactly one set.

#### 2.1 · Required placeholder replacements (easy to miss)

Right after copying, replace the following placeholder, otherwise the browser tab will show the embarrassing text "[必填] 替换为 PPT 标题" (user-facing placeholder: "[REQUIRED] replace with PPT title"):

| Location | Original | Change to |
|------|------|--------|
| `<title>` | `[必填] 替换为 PPT 标题 · Deck Title` | The actual deck title (e.g. `一种新的工作方式 · Luke Wroblewski`, a user-facing example) |

After each template.html copy, the first thing to do: grep for "[必填]" to confirm everything was replaced.

#### 2.2 · Choose a theme palette (5 presets · customization not allowed)

This skill **only allows choosing one of 5 carefully tuned presets**; user-defined hex values are not accepted—a wrong color pairing makes the deck instantly ugly; protecting the aesthetics matters more than giving freedom.

| # | Theme | Fits |
|---|------|------|
| 1 | 🖋 墨水经典 (Ink Classic) | General / business launches / the default when unsure |
| 2 | 🌊 靛蓝瓷 (Indigo Porcelain) | Tech / research / data / tech launches |
| 3 | 🌿 森林墨 (Forest Ink) | Nature / sustainability / culture / non-fiction |
| 4 | 🍂 牛皮纸 (Kraft Paper) | Nostalgia / humanities / literature / indie magazines |
| 5 | 🌙 沙丘 (Dune) | Art / design / creative / galleries |

**Procedure**:
1. Recommend one based on the content theme, or directly ask the user to pick
2. Open `references/themes.md` and find the `:root` block of the corresponding theme
3. **Replace wholesale** the lines marked with the "主题色" (theme color) comment in the `:root{` block at the top of the copied `assets/template.html` (`--ink` / `--ink-rgb` / `--paper` / `--paper-rgb` / `--paper-tint` / `--ink-tint`)
4. All other CSS goes through `var(--...)`; no other changes needed

**Hard rules**:
- One deck uses one theme only; do not switch colors midway
- Do not accept arbitrary hex values from the user—politely decline and show the 5 presets
- Do not mix (e.g. ink from Ink Classic, paper from Dune)—it becomes thoroughly incoherent

### Step 3 · Fill content

**Content language (hard rule)**: All user-facing slide content (titles, body copy, captions) must be written in the user's language (e.g., Simplified Chinese when the user writes in Chinese).

#### 3.0 · Pre-flight: class names must be defined in the template's `<style>` (most important)

**This is the root of all generation problems**. The layout skeletons use many class names; if the template's `<style>` lacks their definitions, the browser falls back to default styles—wrong display-heading font, cards squeezed together, pipeline collapsed into one line, images piled at the page bottom.

**The two styles' class names are not interchangeable** (stressed again):
- Style A template has `h-hero` (serif), `stat-card`, `grid-2-7-5`, `frame`, etc.
- Style B template has `h-hero` (sans), `kpi-hero`, `accent-block`, `span-N`, `dots`, `grid-12`, etc.
- Same-named classes look **completely different** in the two templates (e.g. Style A's `h-hero` is Noto Serif SC serif, Style B's `h-hero` is Inter sans)

**Before writing any slide code:**

1. **First Read the template you will use** (at least through the end of the `<style>` block):
   - Style A → `assets/template.html`
   - Style B → `assets/template-swiss.html`
2. **Cross-check the Pre-flight list in the corresponding layouts file** and confirm every class you plan to use exists in `<style>`
3. If a class is missing: **add it to the template's `<style>`**; do not inline-redefine it in every slide
4. **The template is the single source of class names**—do not invent new class names; for one-off custom styling use `style="..."` inline

**Style A classes most commonly missed**:
`h-hero` / `h-xl` / `h-sub` / `h-md` / `lead` / `kicker` / `meta-row` / `stat-card` / `stat-label` / `stat-nb` / `stat-unit` / `stat-note` / `pipeline-section` / `pipeline-label` / `pipeline` / `step` / `step-nb` / `step-title` / `step-desc` / `grid-2-7-5` / `grid-2-6-6` / `grid-2-8-4` / `grid-3-3` / `grid-6` / `grid-3` / `grid-4` / `frame` / `frame-img` / `img-cap` / `callout` / `callout-src` / `chrome` / `foot`

**Style B classes most commonly missed** (after the 2026-05 refactor):
- Canvas: `canvas-card` / `chrome-min`
- Typography: `h-hero` (sans 7.4vw weight 200) / `h-statement` (9.6vw) / `h-xl` / `h-md` / `t-cat` (SemiBold 600 small heading) / `t-meta` (mono uppercase) / `lead` / `num-mega` / `mono`
- Cards (four mutually exclusive types): `card-ink` / `card-accent` / `card-fill` / `card-outlined`
- Grids: `grid-12` / `grid-2-9` / `grid-2-9-5` / `span-N`
- Timelines: `timeline-v` + `tl-node` + `tl-axis` + `dot` / `timeline-h` + `tl-h-node` + `tl-h-axis`
- Charts: `kpi-tower-row` + `bar-tower` / `h-bar-chart` + `bar-row` + `bar-fill` / `spec-bars` + `bar-vert`
- Decorations: `dot-mat` (SVG-mask solid dots) / `ring-mat` (outlined circles) / `cross-mat` (× grid) / `hr-hairline`
- Layout-specific: `cover-split` / `closing-split` / `duo-compare` + `vrule` / `manifesto-top` + `ink-banner-full` / `three-forces` / `loop-diagram` / `matrix-fill` + `matrix-cell` / `brief-grid` + `brief-card` / `system-diagram` / `why-now-grid` / `four-cards` / `stacked-ledger` + `ledger-row` / `tech-spec` / `image-hero` + `hero-img-wrap` + `hero-overlay-block` + `hero-stats`
- Image mixing: `frame-img` / `fit-contain` / `r-21x9` / `r-16x9` / `r-16x10` / `h-22` / `h-26` / `swiss-img-split` / `swiss-img-grid` / `swiss-img-caption` / `swiss-keyline` / `swiss-lined`
- Spacing tokens: `--sp-3`...`--sp-13` (8/12/16/24/32/40/48/64/80/96/160 px)

#### 3.0.5 · Plan the theme rhythm (as important as the class pre-flight)

**Before picking layouts**, first list each page's theme class (`hero dark` / `hero light` / `light` / `dark`) and write it into a doc or draft for alignment. Detailed rules are in the "Theme rhythm planning" section at the top of `references/layouts.md`.

**Mandatory rules**:

- Every page's section must carry one of `light` / `dark` / `hero light` / `hero dark`; never write a bare `hero`
- 3+ consecutive pages of the same theme = visual fatigue, not allowed
- 8+ pages must include ≥1 `hero dark` + ≥1 `hero light`
- The whole deck must not be only `light` body pages; there must be `dark` body pages to create breathing room
- Insert 1 hero page (cover / act divider / question / big quote) every 3-4 pages

**Self-check after generation**: `grep 'class="slide' index.html` to list all themes; manually confirm the rhythm is reasonable before delivery.

#### 3.1 · Pick layouts

**Do not write slides from scratch**. Open the corresponding layouts file; it contains 10 ready-made layout skeletons, each a complete, paste-ready `<section>` code block.

**Style A** → `references/layouts.md`:

| Layout | Use |
|---|---|
| 1. Opening cover (Hero Cover) | Page 1 |
| 2. Act divider (章节幕封) | Start of each act |
| 3. Big-numbers grid (数据大字报) | Throw out hard data |
| 4. Quote + Image (左文右图) | Identity contrast / story |
| 5. Image grid | Multi-image comparison / screenshot evidence |
| 6. Two-column pipeline (Pipeline) | Workflows |
| 7. Suspense closing / question page | End of act / closing |
| 8. Big quote | Serif punchline / takeaway |
| 9. Side-by-side comparison (Before / After) | Old mode vs new mode |
| 10. Lead Image + Side Text (图文混排) | Information-dense text+image page |

**Style B** → first read `references/swiss-layout-lock.md`, then `references/layouts-swiss.md`.

The Swiss theme enters **Swiss locked mode** by default:

- Body pages may only use the 22 registered layouts `S01-S22` from the original reference PPT; new cover/closing pages may only use the Skill-provided `SWISS-COVER-ASCII` / `SWISS-CLOSING-ASCII`.
- Every `<section class="slide">` must carry `data-layout="Sxx"`. Without `data-layout` it counts as an unregistered layout.
- Do not improvise body structures beyond the original 22P such as `P23/P24`, `Swiss Image Split`, `Evidence Grid`, unless the user explicitly requests experimental layouts.
- Top Chinese headings are left-aligned by default, on the top-left content axis. Do not put the small heading in the left column and the big heading in the right column, creating visual centering; only the original statement/split layouts allow a strong central narrative.
- SVG handles geometry only. Do not write text labels inside SVG; render all labels with HTML grids/cards/captions.
- Geography / history / city routes / place-relation pages use `S08 + Swiss Map Component`: first read `references/swiss-map-component.md`, keeping `data-layout="S08"`.

The original 22 body layouts:

| Layout | Use |
|---|---|
| S01 Index Cover | Original index cover |
| S02 Vertical Timeline + KPI | Evolution comparison / era changes |
| S03 Split Statement | Core thesis / left-right split |
| S04 Six Cells | 6 concept definitions |
| S05 Three Layers | Three-tier architecture |
| S06 KPI Tower | Visualized height contrast of 4 data points |
| S07 H-Bar Chart | Ranking comparison of 5-10 items |
| S08 Duo Compare | Before/After contrast |
| S09 Dot Matrix Statement | Big quote / statement |
| S10 Split Closing | Closing page |
| S11 Horizontal Timeline | 4-7 step processes |
| S12 Manifesto + Ink Banner | Interim conclusions |
| S13 Three Forces | Deep dive into 3 equal concepts |
| S14 Loop Form | Self-learning loop / automation |
| S15 Matrix + Hero Stat | 8-12 item matrix + aggregate number |
| S16 Multi-card Brief | 6 brief mini cards |
| S17 System Diagram | Three-tier architecture / ecosystem map |
| S18 Why Now | Three arguments + data support |
| S19 Four Cards | 4 equal-weight features |
| S20 Stacked KPI Ledger | Vertical ledger-style data |
| S21 Tech Spec Sheet | Product specs / benchmark |
| S22 Image Hero | 21:9 top image + title block + three-column KPI |

**Registered extension**: `S08 + Swiss Map Component` is for places, residences, routes, city relations. It is not a new layout but a MapLibre map component in S08's right slot; it must implement pins, connection lines, cards, and the top-right zoom/drag controls per `references/swiss-map-component.md`.

Pick the matching layout, paste it, adjust copy and image paths. **Always complete the 3.0 pre-flight first**.

**Style B layout-diversity hard rules**:
- A 7-8 page deck must use at least **6 different S-numbered layouts**; 10+ pages must use at least 8 different layouts.
- If the user says "test the template / show me how it looks / more layout variety", you must cover: one cover, one closing, at least 1 comparison or timeline (S08/S11/S02), at least 1 structure diagram (S14/S17/S15), and at least 1 image layout (S22 or an S15/S16 image-grid adaptation).
- Never use the same body structure on 3 consecutive pages, e.g. three consecutive `head + grid + card` pages.
- Do not lazily invent new structures for image pages. For 2-3 images, adapt the original S15/S16 grid skeletons into image cells; for a single large image use S22.
- Before writing HTML, draft a `page → data-layout → why chosen → image slot` table; before delivery run `node <SKILL_ROOT>/scripts/validate-swiss-deck.mjs index.html`.

#### 3.2 · Image aspect-ratio rules

Always use **standard ratios**, never the original image's odd ratios (e.g. `2592/1798`):

| Scenario | Recommended ratio |
|------|---------|
| S22 top hero image | **21:9**; keep the photo's key subject in the central safe area |
| S15/S16 multi-image grids | Uniform 21:9 or uniform 16:10; do not mix |
| Quote+image main image (Style A) | 16:10 or 4:3 + `max-height:56vh` |
| Image grid (Style A) | **Fixed `height:26vh`**, not aspect-ratio |
| Small image left + text right | 1:1 or 3:2 |
| Full-screen hero visual | 16:9 + `max-height:64vh` |
| Mixed-layout small illustrations | 3:2 or 3:4 |

**By default never give images `align-self:end`**—they slide to the page bottom and easily collide with the pagination component. Use a grid container + `align-items:start` (preconfigured in the template) so images hug the top; only Style B's P23 may use `.swiss-img-split.align-image-bottom`, because the template has built in a `--nav-safe-bottom` safe area for it.

**Style B Swiss extra rules**:
- Single large image → S22; multi-image tests → adapt the original S15/S16 card grids; do not use the unregistered P23/P24
- Before generating images, write the `data-image-slot`: e.g. `s22-hero-21x9` / `s15-grid-21x9` / `s16-brief-21x9`
- S22 images are generated at 21:9 by default; the prompt must include `subject centered in the safe middle area`; photo containers use `object-position:center 35%`, not `top center`
- Image containers must be square-cornered, shadowless, radius-free; the default background is white `var(--paper)`; do not wrap white-background infographics in a grey base
- White-background GPT infographics / flowcharts / UI images get no outer frame stroke by default; do not casually apply `.swiss-keyline`; for emphasis use only the top accent line of `.swiss-lined`
- For UI/infographic images that are the user's original screenshots or text-dense images, use `.fit-contain`; if regenerated for S15/S16 slots, they must fill the container with `.frame-img.r-21x9` / `.frame-img.r-16x10`, not be shrunk into a fixed `height:18vh`
- Multiple images in one group must share slots, ratios and heights; do not mix
- GPT-M 2.0 generated images use image-prompts.md's "Style B: Swiss image rules"
- The lowest edge of any image, caption, timeline label or footnote must not enter the bottom pagination area; when bottom-hugging is needed use `.nav-safe-bottom` / `.nav-safe-bottom-tight`, never hand-written `bottom:2vh`

#### 3.2.1 · Chinese display-heading size tiers (mandatory for Style B)

Chinese block characters have a large visual footprint; you cannot directly reuse the English hero sizes of 6.8-7vw. Before writing a Chinese display heading, tier by length:

| Heading shape | Recommended size |
|---|---|
| 1 line, ≤ 8 Chinese characters | `min(6.4vw,11.2vh)` |
| 2 lines, each ≤ 8 Chinese characters | `min(5.8vw,10.2vh)` |
| 2 lines, any line 9-12 Chinese characters | `min(5.2vw,9.2vh)` |
| 3 lines or longer | Rewrite the heading first; if unavoidable use `min(4.6vw,8.2vh)` |

If the heading crowds the image or body area, first tighten the heading copy, then lower the size; do not force it by pushing the content below to the bottom.

Component details (fonts, colors, grids, icons, callouts, stat cards, etc.) are in `references/components.md`.

### Step 4 · Self-check against the checklist

After generating, always open `references/checklist.md` and check item by item. It summarizes **all pitfalls from real iterations**; P0-level issues (emoji, image overflow, heading wrapping, font division of labor) must all pass.

#### 4.0 · Not just code: you must open the page and visually verify

Code only proves class names and structure exist, not that the layout is comfortable. After generating, open the page and inspect page by page:

1. Open the original reference PPT, the current template or generated page, and the test PPT side by side; the original reference is `/Users/guohao/Documents/op7418的仓库/项目/Thin-Harness-Fat-Skills/ppt/index.html`.
2. Wait for entrance animations to settle (about 1-2 seconds) before screenshotting; do not mistake animation mid-states for layout problems.
3. Look at visuals first: display-heading weight, spacing between heading and content, whether images align with the body, whether images/captions touch the bottom pagination component.
4. Then look at code: confirm the chosen layout matches the content shape, data-specific layouts are not used to explain concepts, and optional components are not piled up as decoration.
5. When comparing against the original reference template, defer to actual page usage, not just CSS helper definitions; the original pages' display type is mostly weight 200/300—do not be misled by the 700/800/900 in raw CSS.
6. If a page feels off, first judge whether it is a wrong layout choice, a missing required component, optional-component abuse, or a spacing/safe-area problem; do not just patch it with margins.

#### Style A · E-Magazine must-checks

1. **Display headings must be serif**—if they render sans-serif, 99% the Step 3.0 pre-flight was skipped and `h-hero` is missing in template.html
2. **Image grids use only `height:Nvh`, never `aspect-ratio`** (it overflows)
3. **Images must not pile up at the page bottom**—never use `align-self:end`; use grid + `align-items:start` (see Step 3.2)
4. **Images use standard ratios only** (16:10 / 4:3 / 3:2 / 1:1 / 16:9); never copy the original's odd ratios
5. **Chinese display headings ≤ 5 characters and `nowrap`** (avoid one character per line)
6. **Use Lucide, not emoji**
7. **Headings serif, body sans, metadata mono**

#### Style B · Swiss International must-checks

1. **Sans-serif throughout**—any serif is wrong (check `font-family` does not use `--serif` class variables)
2. **Exactly one accent color**—a deck must not show IKB blue + lemon yellow + safety orange at the same time
3. **No gradients / shadows / rounded corners**—all color blocks are square-cornered and solid; any `box-shadow` / `linear-gradient` / `border-radius` > 0 must be removed (except rule lines)
4. **Extreme type-size contrast**—display-to-body ratio ≥ 8:1
5. **Big type must be dual-constrained**—`font-size:min(Xvw, Yvh)`; vw alone overflows on standard 16:9 screens (lessons from P15/P20/P22)
6. **Display weight 200** (ExtraLight)—the bigger the type, the thinner; the soul of Swiss style; **forbidden** to use 600/700/800 display weights
7. **Card fill types are mutually exclusive**—`card-ink` / `card-accent` / `card-fill` / `card-outlined` must **not be mixed** (no "blue fill + blue outline", "grey fill + outline", etc.)
8. **Multiple parallel cards share one style**—3-12 cards use the same class (prefer `card-fill` grey); to highlight one item switch just that one to `card-accent`, and **only one card** may do so
9. **Square corners all the way**—no `border-radius` at all; decorations use 8×8 square mini blocks, **not** 9px round dots
10. **Icons via lucide, do not draw your own SVG**—`<i data-lucide="name"></i>` + `lucide.createIcons()`; pick angular styles (avoid rounded/chubby)
11. **Timeline alignment**—the axis column is fixed 12px + absolutely positioned dots, **never** grid `justify-self` (it misaligns with the dashed line)
12. **Section-level heading-to-content spacing ≥ 9vh**—avoid crowding (lessons from P15/P16)
13. **One semantic animation recipe per page**—not a uniform fade-up: numbers scale in, bars scaleY up, SVG strokes draw in, timeline nodes light up in sequence, etc.; **forbidden** to reuse one generic recipe on all pages
14. **playSlide entry reveals containers**—`[data-anim]` containers are first forced to opacity:1, and the recipe then overrides with motion `{opacity:[0,1]}`; otherwise some pages become "invisible"
15. **ESC index page visibility**—cloned slides need a CSS override so `[data-anim]` shows at opacity:1 in thumbnails
16. **Helvetica/Inter with Chinese fallback**—Windows users lack "苹方" (PingFang SC); must fall back to `"Microsoft YaHei UI", "Noto Sans SC"`
17. **Weight conventions**: display 200 / body 300 / `t-cat` SemiBold 600 / `t-meta` mono uppercase
18. **Keep the low-power shortcut**—the bottom-right must hint `B 静态` (B static); pressing `B` toggles `body.low-power`, stopping WebGL/ASCII canvas RAF and Motion entrance animations
19. **Decorations strictly inside the grid**—bars matrices, dot matrices, ring-mat must not hug edges or overflow the page
20. **Reserve nav space for bottom content**—nav sits at ~97vh; content must not pass 93vh (lesson from P22 KPI overflow)
21. **Image containers square-cornered, shadowless**—`.frame-img` gets no `border-radius` / `box-shadow`; edges use hairlines only
22. **P23/P24 images consistent within a group**—same ratio, height, margin and line weight across the group; infographics/UI images get `.fit-contain`
23. **Component roles must be correct**—P23/P24 captions are required info anchors; P22's KPIs/captions are required; data-specific layouts need real data, not filler copy
24. **Know general vs non-general layouts**—P3/P8/P11/P19/P23 are fairly general; P6/P7/P20/P21/P22 are data/case-specific; P14/P15/P17 are structure-specific

### Step 5 · Local preview

Just open `index.html` in a browser. On macOS:

```bash
open "项目/XXX/ppt/index.html"
```

No local server needed. Images use relative paths `images/xxx.png`.

### Step 6 · Iterate

Modify based on user feedback—the template CSS is highly parameterized; 90% of adjustments are inline style tweaks (font size `font-size:Xvw` / height `height:Yvh` / spacing `gap:Zvh`).

---

## Resource Map

```
guizang-ppt-skill/
├── SKILL.md                  ← you are here
├── assets/
│   ├── template.html         ← Style A · E-Magazine template (seed file)
│   ├── template-swiss.html   ← Style B · Swiss International template (seed file)
│   └── motion.min.js         ← Motion One local copy (offline fallback, ~64KB, shared)
├── scripts/
│   └── validate-swiss-deck.mjs ← Style B static validation: registered layouts, image slots, SVG text, heading alignment
└── references/
    ├── components.md         ← component handbook (fonts, colors, grids, icons, callouts, stats, pipeline, motion... for Style A)
    ├── layouts.md            ← Style A · 10 page-layout skeletons (paste-ready, with animation markers)
    ├── swiss-layout-lock.md  ← Style B · original 22P layout lock; body pages must be registered here
    ├── layouts-swiss.md      ← Style B · original 22P skeleton guide + a few clearly-marked experimental zones
    ├── swiss-map-component.md ← Style B · S08 map extension component (MapLibre pins/lines/cards/controls)
    ├── themes.md             ← Style A · 5 theme presets (choose only, no customization)
    ├── themes-swiss.md       ← Style B · 4 Swiss theme presets (IKB / Lemon Yellow / Lemon Green / Safety Orange)
    ├── image-prompts.md      ← GPT-M 2.0 image types, ratios and base prompts
    └── checklist.md          ← quality checklist (P0/P1/P2/P3 graded)
```

**Suggested loading order**:
1. First read `SKILL.md` (this file) for the big picture
2. Step 1 requirement clarification's **first question** settles Style A vs B, then:
   - Style A: read `themes.md` to help the user pick a palette
   - Style B: read `themes-swiss.md` to help the user pick a palette
3. **Before building, Read the corresponding template's `<style>` block**—it is the single source of class names; missing classes collapse the whole page's styling
   - Style A → `assets/template.html`
   - Style B → `assets/template-swiss.html`
4. Read the corresponding layouts file to pick layouts:
   - Style A → `layouts.md` (top has the Pre-flight class list, theme rhythm planning, and the animation recipe decision tree)
   - Style B → **first read `swiss-layout-lock.md`**, then `layouts-swiss.md`; body pages must be chosen from S01-S22, each page carrying `data-layout`
5. If Style B needs maps for places, routes, residences or city relations, read `swiss-map-component.md`
6. If generating images in Codex, read `image-prompts.md` to pick image types, ratios and base prompts
7. For fine-tuning, read `components.md` for components (including the Motion animation system chapter, mainly serving Style A; Style B component details are in the `layouts-swiss.md` appendix)
8. After generating, first run `node scripts/validate-swiss-deck.mjs path/to/index.html`, then self-check with `checklist.md`

**Motion notes**: the template embeds Motion One loading and recipe logic in the bottom module script. You don't need to touch JS; just add `data-anim` / `data-animate` in HTML per the `layouts.md` / `layouts-swiss.md` skeletons. Offline demos rely on `assets/motion.min.js`; when offline it automatically degrades to "no animation but readable content". The Style B template must keep the `B` low-power mode: when toggled, stop the WebGL/ASCII canvas RAF, cancel running Web Animations, and reveal the current page's content directly to its static final state.

## Core Design Principles (Philosophy)

### Style A · E-Magazine (summarized over 5 iterations)

> Break any one of these and the magazine feel collapses.

1. **Restraint over showmanship** — the WebGL background only surfaces on hero pages; barely visible on normal pages
2. **Structure over decoration** — no shadows, no floating cards, no padded boxes; all information is carried by **large type + font contrast + grid whitespace**
3. **Hierarchy is defined jointly by size and font** — largest serif = main title, mid serif = subtitle, large sans = lead, small sans = body, mono = metadata
4. **Images are first-class citizens** — crop only the bottom, keep top/left/right intact; grids use fixed `height:Nvh`, never `aspect-ratio`
5. **Rhythm comes from hero pages** — hero and non-hero alternate, so eyes don't tire
6. **Terminology consistency** — Skills is Skills; no mixed Chinese-English translation

### Style B · Swiss International

> Break any one of these and the page instantly drops from Swiss to PowerPoint.

1. **Single anchor color** — one accent per deck; no multi-color highlight collage
2. **Extreme type-size contrast** — display-to-body ratio ≥ 8:1; KPIs must be "Data Hero" (18-22% of screen width)
3. **Sans-serif only** — Inter / Helvetica / Noto Sans SC; any serif is wrong
4. **Square corners, solid colors** — no gradients / shadows / rounded corners (except rule lines)
5. **Grid supremacy** — everything snaps to the 12-col grid; left-aligned + generous whitespace for asymmetric aesthetics
6. **Hairline is the scalpel** — a 1px ultra-thin divider is enough; no thickening, no shadows
7. **Dot-matrix decoration only on hero pages** — body pages keep a pure base

## Reference Works

The two styles of this skill reference respectively:

**Style A · E-Magazine**:
- 归藏 (Guizang)'s talk "一人公司：被 AI 折叠的组织" ("One-Person Company: The Organization Folded by AI", a user-facing example title) (2026-04-22, 27 pages)
- The layout language of *Monocle* magazine
- The demo in YC president Garry Tan's blog post "Thin Harness, Fat Skills"

**Style B · Swiss International**:
- Massimo Vignelli's NYC Subway / Unimark systems
- The type design language of *Helvetica Forever*
- Josef Müller-Brockmann's classic grid-system books
- Contemporary design: Acne Studios / Off-White / IKEA / Beck Design

Treat them as style anchors.
