# Layouts · Style B Swiss International (瑞士国际主义)

22 original registered layouts · strict modular grid · each layout documents its purpose, skeleton, key classes, and dedicated motion recipe.

> ⚠️ These layouts are **not interchangeable** with Style A (E-Magazine / E-Ink). Class names collide but semantics differ (e.g. `h-hero` is serif in Style A, sans-serif ultra-light 200 in Style B). One deck uses exactly one set.

---

## Swiss locked mode (must read first)

This theme's golden source is:

`/Users/guohao/Documents/op7418的仓库/项目/Thin-Harness-Fat-Skills/ppt/index.html`

When generating body pages, do not treat Swiss as a "free-combination style pack". By default only the `S01-S22` registered in `references/swiss-layout-lock.md` may be used. Every slide must write `data-layout="Sxx"` on its `<section>`.

**Key constraints**:

- Top Chinese headings are left-aligned by default and sit on the top-left content axis; do not place them mid-page.
- Improvising body structures beyond the original 22P is not allowed. P23/P24 at the end of this document belong to the historical experimental zone and are disabled by default.
- For a single large image use `S22 Image Hero`; for multiple images adapt the original `S15/S16` matrix/brief skeletons into image cells.
- Place / route / residence / city-relation pages use `S08 + Swiss Map Component`; this is still an extension of S08's right slot, not a new body page. Read `swiss-map-component.md` first.
- SVG draws geometry only, never visible text. Labels go in HTML.
- After generation run `node scripts/validate-swiss-deck.mjs index.html`.

---

## Design language baseline

**Palette** (`--accent` is decided by the theme, see `themes-swiss.md`)
- `--paper` paper white base #ffffff (main background)
- `--ink` black ink text #0a0a0a (main text / Ink inverted blocks)
- `--accent` single anchor color (IKB blue default / yellow / green / orange, four sets)
- `--text-primary / secondary / helper` three-level text greys
- `--border-subtle` 1px hairline #e0e0e0

**Typography**
- Fonts: `var(--sans)` Inter / Helvetica Neue + `var(--mono)` JetBrains Mono
- Weights: **200 (ExtraLight) display** / **300 (Light) body** / **600 (SemiBold) t-cat small headings**
- Display headings follow the original PPT's actual page usage: main headings `font-weight:200`, emphasis words/numbers `font-weight:300`; do not bold Swiss display type just because legacy CSS helpers once contained 800/900
- Tight display sizes: `letter-spacing:-.04em` / `line-height:.9`
- Mono numerals: `font-feature-settings:"tnum","ss01"`

**Chinese display-heading size tiers**
Chinese block characters have a heavier visual footprint than English; you cannot directly reuse the English pages' `6.8vw-7vw`. Downgrade by Chinese heading length before generating:

| Chinese heading shape | Recommended size |
|---|---|
| 1 line, ≤ 8 Chinese characters | `min(6.4vw,11.2vh)` |
| 2 lines, each ≤ 8 Chinese characters | `min(5.8vw,10.2vh)` |
| 2 lines, any line 9-12 Chinese characters | `min(5.2vw,9.2vh)` |
| 3 lines or longer | Rewrite the heading; if truly impossible use `min(4.6vw,8.2vh)` |

Rule: prefer shortening Chinese headings first, then lowering sizes; never let headings crowd the images/text below. English and numeric heroes can go bigger; Chinese methodology pages must stay more restrained.

**Grid** (IBM Carbon 2x Grid adapted)
- 16-column grid: `grid-template-columns:repeat(16,1fr)` + `gap:16px`
- Spacing tokens: `--sp-3` 8 / `--sp-4` 12 / `--sp-5` 16 / `--sp-6` 24 / `--sp-7` 32 / `--sp-8` 40 / `--sp-9` 48 / `--sp-10` 64 / `--sp-11` 80 / `--sp-12` 96 / `--sp-13` 160

**Canvas**
- `.canvas-card`: `100vw × 100vh`, square corners, no radius, padding `5.6vh 5vw 4.4vh`
- `body{background:var(--paper)}` — no WebGL background
- The bottom-right `B 静态` (B static) shortcut must be kept. Low-power mode uses `body.low-power`, stopping the WebGL/ASCII canvas RAF and Motion entrance animations; the choice persists via `localStorage` after refresh.

---

### P0 alignment laws (pass all 4 before generating every page; violation = scrap the page)

**1. Do not stack horizontal padding twice** ⚠️ most frequently tripped
`.canvas-card` already carries `padding:5.6vh 5vw 4.4vh`.
chrome-min (header), body content, and the bottom footnote are all children of canvas-card and **share the same 5vw edge line**.
If the body layer also declares `padding:5vh 5vw 4vh`, the horizontal padding becomes `5vw + 5vw = 10vw`, and the body is inset one extra ring versus chrome-min; left/right no longer align.

```html
<!-- ❌ 错:主体多缩了 5vw -->
<div class="canvas-card">
  <div class="chrome-min">...</div>
  <div style="flex:1;padding:5vh 5vw 4vh;...">主体内容</div>
</div>

<!-- ✅ 对:主体 padding 为 0,只用 grid gap 控垂直间距 -->
<div class="canvas-card">
  <div class="chrome-min">...</div>
  <div style="flex:1;padding:0;display:grid;grid-template-rows:auto 1fr auto;gap:3vh">主体内容</div>
</div>
```

Exception: `.slide.split .canvas-card{padding:0}` is already CSS-overridden; in split mode the two `.half` elements control their own padding (usually `5.6vh 3.6vw 4.4vh`), which does not conflict with this law.

**2. The kicker must sit "above" the display heading, never pressed side by side**
The small heading (`.t-meta` / `.t-cat`) is subordinate to the display heading; structurally they must be **stacked vertically**.

```html
<!-- ❌ 错:auto 1fr 把 kicker 和大标题挤成左右两列 -->
<div data-anim="head" style="display:grid;grid-template-columns:auto 1fr;gap:3vw;align-items:end">
  <div class="t-meta">METHODOLOGY · 03</div>
  <h2 class="h-xl-zh">为什么是 N+1</h2>
</div>

<!-- ✅ 对:flex column 上下叠 -->
<div data-anim="head" style="display:flex;flex-direction:column;gap:1.4vh">
  <div class="t-meta">METHODOLOGY · 03</div>
  <h2 class="h-xl-zh">为什么是 N+1</h2>
</div>
```

**3. Dual constraint: in `min(Xvw, Yvh)`, Y ≥ X × 1.6**
On standard 16:9 screens 1vw : 1vh ≈ 1.78; if Y is too tight (e.g. `min(7vw, 10vh)`), display type gets clamped by the height ceiling to 10vh, no longer governed by 7vw, and everything looks smaller.
Field-tested values:

| Use | Recommended |
|---|---|
| h-hero giant manifesto | `min(11.6vw, 19vh)` |
| h-xl section heading | `min(7vw, 12vh)` ~ `min(7.4vw, 13vh)` |
| Big number KPI | `min(8.4vw, 14vh)` |
| Mid number / numbering | `min(4.6vw, 8.5vh)` ~ `min(5.6vw, 10vh)` |

**4. Between canvas-card children use grid `gap`, never margin/padding piles**
`.canvas-card` defaults to `display:flex;flex-direction:column`; chrome-min carries `margin-bottom:48px` (`--sp-9`).
The body area stacks a few rows below (head / content / footnote): **first choice** `display:grid;grid-template-rows:...;gap:Nvh`, **second choice** flex column + gap, **forbidden**: adding `margin-top` / `padding-top` inside each child to tune spacing (it collides or tears against chrome-min's margin-bottom).

**5. Bottom pagination safe area: main content's lowest edge must not touch the nav**
The bottom pagination dots are fixed at `bottom:2vh`, visually occupying roughly the region after `93vh`. The lowest edge of main content, image captions, chart notes and timeline labels must stop above the safe area.

- The template provides `--nav-safe-bottom:8vh`, usable via `.nav-safe-bottom` / `.nav-safe-bottom-tight`
- When P23 uses `.swiss-img-split.align-image-bottom`, the template automatically adds the bottom safe area, avoiding image captions blocked by the pagination component
- If you hand-write `align-items:end` / `margin-top:auto` / `position:absolute;bottom:...` for some page, visually verify the lowest edge does not cross the nav
- Visual self-check: open that page and confirm at least `3vh` of breathing space between the content's lowest edge and the pagination dots

---

**Card fill rules (must follow)**
| Type | Class | Role | Usage |
|---|---|---|---|
| Ink black base | `.card-ink` | Inverted / manifesto | Hero blocks, half of closing pages |
| Accent blue fill | `.card-accent` | Single focus | Highlight one item in a group |
| Grey base | `.card-fill` | Neutral default | Parallel cards, stat cards |
| Outlined | `.card-outlined` | Anchor (not a card) | Hairline-divided frames |

❌ Mixing forbidden (blue fill + blue outline, grey fill + outline, etc.)

**Minimal decoration principles**
- 1px hairline dividers (`hr-hairline` / `border-bottom`)
- 8×8 / 12×12 square mini blocks instead of round dots
- Dot matrix `dot-mat` / outlined circles `ring-mat` / crosses `cross-mat` (SVG mask)

**Image usage principles (Swiss + GPT-M 2.0)**
- Images are "evidence blocks" in the grid, not decorative backgrounds; each must have a clear function: case study, documentary evidence, UI screenshot, system diagram, conceptual infographic
- All image containers stay square-cornered, shadowless, radius-free; by default **no outer frame**, letting captions or the page grid carry hierarchy
- White-background infographics / flowcharts / UI images: the container background must be `var(--paper)`; never wrap a white image in grey, and never add a `.swiss-keyline` stroke
- Only when an image's own edges can't be distinguished from the page use `.swiss-lined` with one top accent line; don't frame every image
- Documentary photos use `object-fit:cover` cropping only bottom/edges; original screenshots or text-dense images use `.fit-contain` to avoid cropping text
- If infographics, flowcharts or UI scenes were regenerated for S15/S16 slots, they must fill the slot with `.frame-img.r-21x9` / `.frame-img.r-16x10`; don't also add `.fit-contain`, or you'll get a small image floating in a white frame
- Preferred Swiss image ratios: S22 top banner `21:9`; S15/S16 multi-image grids uniformly `21:9` or uniformly `16:10`
- When generating 2-3 images, first bind to the original layout slots: single large image = S22; multiple images = S15/S16 grid adaptation; never use the unregistered P23/P24
- S22 photo subjects must sit in the central safe area; HTML uses `object-position:center 35%` or `center center`, never `top center` (cuts faces)
- GPT-M 2.0 generated images must obey: single accent color, Helvetica/Inter temperament, 12/16-column grid, square-cornered solid colors, no gradient/shadow/rounded corners
- Generated images keep only the core image itself; never draw headers, footers, titles, page numbers, corner marks, borders or signatures into the image

**Layout diversity hard rules**
The Swiss theme has 22 registered layouts; while generating, actively showcase the layout system instead of making everything `head + grid-reveal + card`:

- A 7-8 page deck uses at least **6 different S-numbered layouts**
- Never use the same body structure on 3 consecutive pages (e.g. three consecutive S19s / plain cards)
- For "test the template" or "I want to see how it looks", you must cover: cover, closing, at least 1 comparison/timeline (S08/S11/S02), at least 1 structure diagram (S14/S17/S15), at least 1 image layout (S22 or S15/S16 image cells)
- An image page is not a newly invented page. Single image → S22; multiple images → adapt the original S15/S16 grid skeletons
- Before coding each page, list `page → data-layout → why chosen → image slot`; check with the validator after generating

**Motion principles (one semantic recipe per page)**
- Not a uniform fade-up but **coupled to graphic semantics**: numbers scale in, bars scaleY up, SVG ring stroke-dashoffset draws in, timeline nodes light up in sequence
- Easing: `EASE_PROD` `cubic-bezier(.2,0,.38,.9)` for productive (120-240ms); `EASE_ENTRY` `cubic-bezier(0,0,.3,1)` for expressive (400-700ms)
- The playSlide entry must reveal all `[data-anim]` containers to opacity:1; recipes then override with motion `{opacity:[0,1]}`

---

## Visual + code dual review (mandatory after generation)

Don't just read HTML/CSS. Swiss template fidelity must be judged from both **browser visuals** and **code structure**:

1. Open three pages side by side: the original reference PPT, the current `template-swiss.html` or generated page, and the test PPT being modified. The original reference path is `/Users/guohao/Documents/op7418的仓库/项目/Thin-Harness-Fat-Skills/ppt/index.html`.
2. Wait for entrance animations to settle before screenshots (about 1-2s). Don't misjudge animation mid-states as "missing content" or "blank layout".
3. Look at visuals first: heading weight, header distance, image placement, bottom safe area, whether captions are blocked by the nav.
4. Compare against the original reference PPT's same-type layouts, not just CSS helpers; defer to actual page structure and visual results.
5. Then return to code: check whether the page misused components that don't belong to that layout — e.g. stuffing P24's three-image evidence wall into P23, or using the P7 chart for a concept list with no real numbers.
6. If visuals diverge, first judge whether it is a **wrong layout choice**, a **missing required component**, **optional-component abuse**, or a **spacing/safe-area issue**; don't patch blindly by adjusting `margin`.
7. When modifying the template, new capabilities must be isolated in new classes; never change global base classes because one page misbehaved.

### Original PPT visual anchors (check these first when comparing)

| Visual anchor | The original PPT's actual practice | Rule while generating |
|---|---|---|
| Display weight | Actual pages largely use `font-weight:200/300`; even if raw CSS helpers contain 700/800/900, they are not the visual standard | Keep display light; the bigger the type, the thinner |
| Whitespace | Pages often occupy only the upper or middle half; the bottom is left to the nav and a few footnotes | Don't push content to the bottom just to "fill" |
| Dividers | 1px hairlines only at section boundaries, evidence walls, card hierarchy | Don't line every content block |
| Heading vs content | Clear air between the heading area and body/charts | Complex pages use grid `gap`; never let content touch headings |
| Timeline | Axis in the lower-middle, but labels don't touch the bottom nav | Horizontal timelines must check both up/down labels and the nav safe area |
| Image pages | Images are evidence blocks: either S22 hero or into S15/S16 original grids | Never use unregistered image-text structures |

### Component required / optional / omissible

| Component | Rule |
|---|---|
| `.canvas-card` / `.chrome-min` | Required on base pages; split pages have their own chrome-min per half |
| `t-meta` / `t-cat` kicker | Required in the head area, but omissible inside body cards; must sit above the display heading |
| Display heading | Required on section/thesis pages; list-type mini-card pages may use a smaller heading but must keep a page-level info anchor |
| `lead` caption | Optional; omit if the heading already explains, but never butt long body text against the heading |
| Image caption | Required in S15/S16 multi-image grids; optional on S22 hero (the image is already the hero and KPIs/captions sit below) |
| Hairlines / border-bottom | Optional; only for building hierarchy, never piled as decoration |
| KPI / numbers | Only with real data; never fabricate numbers for concept explanations |
| `footnote` / bottom note | Optional; if used, must avoid the nav safe area |
| `S08 + Swiss Map Component` | For place/route/residence relations; the right map must have pins, lines, cards and `+` / `-` / `DRAG` controls; see `swiss-map-component.md` |

### General / non-general layouts

| Type | Layouts | Usage boundary |
|---|---|---|
| General | S01, S03, S08, S09, S10, S11, S19 | Usable in most narrative decks, but must still fit the content shape |
| Conditionally general | S04, S05, S13, S16 | Depends on the count matching exactly: 3/4/6 items |
| Data-specific | S02, S06, S07, S18, S20, S21, S22 | Require real times, values, metrics or case data |
| Structure-specific | S14, S15, S17 | Require loops, matrices, hierarchy/ecosystem relations; not for ordinary paragraphs |

---

## The 22 registered layouts

### P1 · Cover (封面页)

**Purpose**: deck opener / thematic manifesto.
**Content fit**: cover / section opener / thematic manifesto. **Pure text structure** (main title + subtitle + meta), carries no data.

**Default recommendation: full-bleed IKB + ASCII breathing field** ⭐
- `<section class="slide accent">` full-bleed IKB, **not** a light white base
- Insert `<canvas class="ascii-bg" aria-hidden="true">` as the first child inside `.canvas-card`; the template's bottom IIFE automatically drives a sin/cos 2D-noise breathing field
- Main title in reversed white, weight 200; micro-emphasis via italic (`font-style:italic;font-weight:300`) rather than IKB blue (the base is already blue; blue pressed on blue is invisible)
- **Do not** add a big number "01" again — chrome-min already marks 01/NN
- Paired with P9 Closing's IKB half screen to form the "opening full IKB ↔ closing half IKB" color loop

**Key classes**: `.slide.accent` `.ascii-bg` + `min(11.6vw,19vh)` dual-constraint display type
**Motion recipe**: `hero` — the ASCII character field breathes continuously; text fade-up sequence entrance

**Example code (IKB default variant)**:
```html
<section class="slide accent" data-animate="hero">
  <div class="canvas-card">
    <canvas class="ascii-bg" aria-hidden="true"></canvas>
    <div class="chrome-min">
      <div class="l">[必填] Deck 标题 · Issue/Field Note 编号</div>
      <div class="r">SS · 26.05.10 · 01 / NN</div>
    </div>
    <div style="flex:1;padding:0;display:grid;grid-template-rows:auto 1fr auto;gap:2.6vh">
      <div data-anim="kicker" class="t-meta" style="color:rgba(255,255,255,.78);letter-spacing:.22em">[必填] 章节英文 / Section En</div>
      <h1 data-anim="title" style="align-self:center;font-family:var(--sans),var(--sans-zh);font-weight:200;font-size:min(11.6vw,19vh);line-height:.94;letter-spacing:-.025em;color:#fff">[必填] 中文主标题<br/>(可在某字加 <span style="font-style:italic;font-weight:300">italic</span> 微强调)</h1>
      <div data-anim="bottom" style="display:grid;grid-template-rows:auto auto;gap:1.6vh;border-top:1px solid rgba(255,255,255,.22);padding-top:2vh">
        <div data-anim="lead" class="lead" style="max-width:52ch;color:rgba(255,255,255,.86);font-weight:300">[必填] 一段 1-2 行的副标 / 引子,定调全场.</div>
        <div style="display:flex;justify-content:space-between;align-items:end">
          <div class="t-meta" style="color:rgba(255,255,255,.6)">[选填] 作者 · 日期 · 出处</div>
          <div class="t-meta" style="color:rgba(255,255,255,.6)">→ swipe / arrow keys</div>
        </div>
      </div>
    </div>
  </div>
</section>
```

**Classic variant (left ink + right paper spread)** — only when full IKB doesn't fit the content's tone:
```html
<section class="slide" data-animate="cover-reveal">
  <div class="canvas-card cover-split">
    <div class="cover-ink">
      <span class="t-cat">Volume 18 · 2026</span>
      <h1 class="h-hero">Thin Harness,<br>Fat Skills.</h1>
      <span class="t-meta">— Kevin · 2026-05</span>
    </div>
    <div class="cover-paper">
      <p class="lead">薄型承载层,厚重技能。</p>
      <ul class="meta-list">
        <li>22 PAGES</li><li>SWISS · IKB</li><li>MP-75</li>
      </ul>
    </div>
  </div>
</section>
```

---

### P2 · Vertical Timeline (纵向时间轴)

**Purpose**: evolution comparison, era changes, version iterations (2-5 time nodes).
**Content fit**: **time evolution with quantified data**. Every node must have the trio「year + quantified value (e.g. 1× / 4× multiplier / unit number) + description」. Node names without data → use the P11 horizontal timeline instead.
**Skeleton**: left axis column with 12px dots + 1px dashed axis / right node info (year + big number + small heading + description).
**Key classes**: `.timeline-v` `.tl-node` `.tl-axis` (12px fixed column width, absolutely positioned dots to prevent misalignment) `.kpi-row-4`
**Motion recipe**: `timeline-vertical` — nodes light up top to bottom in time order (dot pops then expands → text slides in horizontally)
**Grid rule**: axis column = 12px fixed; dots use `position:absolute;left:50%;transform:translateX(-50%)` to align with the dashed line
**Example code**:
```html
<section class="slide" data-animate="timeline-vertical">
  <div class="canvas-card">
    <header class="chrome-min">...</header>
    <div class="timeline-v">
      <div class="tl-node">
        <div class="tl-axis"><span class="dot"></span></div>
        <div class="tl-body">
          <span class="yr">2023</span>
          <span class="multi">1<small>×</small></span>
          <p class="desc">Prompt Engineering Era</p>
        </div>
      </div>
      <!-- 重复 N 个 tl-node,axis 列贯穿 -->
    </div>
  </div>
</section>
```

---

### P3 · Statement (极简陈述)

**Purpose**: central thesis, section start, slogan. One sentence + simple decoration per page.
**Content fit**: **pure qualitative assertion / slogan / section switch**. One sentence compressed to 8-12 words, **carrying no data or lists**. Need data support → P18 Why Now; cover → P1.
**Skeleton**: left 1/3 whitespace + mid giant-type statement (8-10vw, weight 200) + bottom-right small footnote + bottom hairline.
**Key classes**: `.h-statement` (9.6vw, letter-spacing:-.05em) `.stmt-anchor`
**Motion recipe**: `statement-rise` — big words rise staggered by word order (180ms per word) + footnote fades in
**Example code**:
```html
<section class="slide" data-animate="statement-rise">
  <div class="canvas-card">
    <header class="chrome-min">...</header>
    <h1 class="h-statement">
      <span>Build it</span> <span>once.</span><br>
      <span>It runs</span> <span>forever.</span>
    </h1>
    <span class="stmt-anchor">— Statement 03</span>
  </div>
</section>
```

---

### P4 · Six Cells (六格定义)

**Purpose**: 6 parallel concept definitions, 6 features side by side.
**Content fit**: **6 equal concepts / features** (count must = 6; fewer → P5, more → P15/P16). Each cell carries only「icon + number + short title + one-line description」, **no expandable data / paragraphs**.
**Skeleton**: 2×3 grid / per cell: lucide icon on top + number + short title + one-line description / hairline separators between cells.
**Key classes**: `.cell-6` `.cell-icon-row` `.cell-num`
**Motion recipe**: `six-cells` — 6 cells light up in z-order (L→R, T→B, 90ms per cell)
**Note**: **never draw your own SVG icons**; use `<i data-lucide="bookmark"></i>` to load lucide inline.
**Example code**:
```html
<div class="cell-6">
  <div class="cell">
    <i data-lucide="square-stack"></i>
    <span class="cell-num">01</span>
    <h4>Skill File</h4>
    <p>纯 markdown,可手写、可重写</p>
  </div>
  <!-- 5 more -->
</div>
```

---

### P5 · Three Sub-cards (三子卡)

**Purpose**: three-step flows, three-way comparisons (mild differences).
**Content fit**: **3 equal concepts / steps** (count must = 3). Homogeneous structure, **no strong data contrast** (if data is comparable, use P6 KPI Tower). Each card carries slightly more than P4 (number + title + 1-2 line description).
**Skeleton**: left display heading + description + top hairline / right 3 horizontally stacked sub-cards.
**Key classes**: `.sub-card-stack` `.sub-card` (`.card-fill` grey base, square corners)
**Motion recipe**: `sub-stack` — main title first → 3 cards slide in from the right in stair steps (140ms per card)
**Example code**:
```html
<div class="grid-2-9">
  <div class="lead-col">
    <span class="t-cat">Three Forces</span>
    <h2 class="h-xl">压成三个事实</h2>
  </div>
  <div class="sub-card-stack">
    <article class="card-fill sub-card">
      <span class="big-num">01</span>
      <h4>Skill File</h4>
      <p>...</p>
    </article>
    <!-- 2 more -->
  </div>
</div>
```

---

### P6 · KPI Tower (不等高柱状 KPI)

**Purpose**: express hierarchy across 4 data points via visual height.
**Content fit**: **4 comparable quantified data points** (real values required; bar heights are data-driven). Typical: cost, capacity, counts, efficiency metrics. **Forbidden** for concept lists without data (that's P4/P5's job).
**Skeleton**: 4 equal columns, each with a different-height IKB blue rectangle at the bottom (height = data) + icon on top + giant number mid + label at bottom.
**Key classes**: `.kpi-tower-row` `.bar-tower` (min-height:6vh, max:36vh) `.tower-cap`
**Motion recipe**: `tower-grow` — labels first → numbers scale in → towers scaleY from 0 (transform-origin:bottom)
**Example code**:
```html
<div class="kpi-tower-row">
  <div class="tower-col">
    <i data-lucide="layers"></i>
    <span class="num-mega">90K</span>
    <span class="lbl">Skills</span>
    <div class="bar-tower" style="--h:36vh"></div>
  </div>
  <!-- 3 more,h 不同 -->
</div>
```

---

### P7 · H-Bar Chart (横向条形图)

**Purpose**: multi-item ranking / share comparison (5-10 items).
**Content fit**: **5-10 comparable quantified data points** (real percentages / scores / values required; bar widths are data-driven). Typical: benchmark rankings, market share, survey shares. ⚠️ **Strictly forbidden** for concept lists without quantified data (that's P4/P5/P15) — fabricated numbers will be seen through.
**Skeleton**: top display heading / empty middle / lower-half bar list (each row: text label + 1px blue bar 0→target width + trailing number).
**Key classes**: `.h-bar-chart` `.bar-row` `.bar-fill` (scaleX animation)
**Motion recipe**: `hbar-grow` — display heading first → each row's width 0→target in order (transform-origin:left) + trailing numbers count up
**Example code**:
```html
<div class="h-bar-chart">
  <div class="bar-row">
    <span class="bar-lbl">Anthropic Advisor</span>
    <span class="bar-fill" style="--w:84%"></span>
    <span class="bar-num">84</span>
  </div>
  <!-- N more -->
</div>
```

---

### P8 · Duo Compare (双轨对照)

**Purpose**: Before/After, A vs B, old/new comparisons.
**Content fit**: **binary contrast** (exactly 2 items). Both sides structurally homogeneous (t-cat label + big heading + paragraph/list explanation). Typical: old/new workflow, traditional/AI, customer view/team view.
**Skeleton**: left and right half-screens separated by one vertical 1px long line / each side: t-cat on top + big heading + explanation below.
**Key classes**: `.duo-compare` `.duo-half` `.vrule` (scaleY stretch)
**Motion recipe**: `duo-mirror` — the center vrule scaleY 0→1 first → left/right headings and text mirror in
**Example code**:
```html
<div class="duo-compare">
  <div class="duo-half">
    <span class="t-cat">Before</span>
    <h2>交给模型</h2>
  </div>
  <span class="vrule"></span>
  <div class="duo-half">
    <span class="t-cat">After</span>
    <h2>交给代码</h2>
  </div>
</div>
```

---

### P9 · Closing Manifesto (收束宣言)

**Purpose**: the deck's closing page.
**Content fit**: **deck closing** (one page per deck). Fixed structure: left manifesto short lines + right 3 takeaways (number + title + one-line note). **Never use mid-deck** (it would duplicate the P1 cover).

**Default recommendation: left IKB+ASCII / right paper takeaways** ⭐
- Use `<section class="slide split">` + left half `.half.b-accent` + ASCII canvas + right white half takeaways
- Forms the "opening full IKB ↔ closing half IKB" color loop with the P1 cover's full IKB
- The right side's 03rd takeaway is emphasized with `var(--accent)`, threading IKB blue from the left half to the right half to complete the color stitch
- Display heading reversed white, weight 200; emphasized words italic (the base is already blue; don't tag blue again with `var(--accent)`)

**Key classes**: `.slide.split` `.half.b-accent` `.ascii-bg` (IIFE auto-starts)
**Motion recipe**: `split-statement` — left ink/IKB heading characters rise in sequence → right white half's three takeaways trail in

**Example code (IKB default variant)**:
```html
<section class="slide split" data-animate="split-statement">
  <div class="canvas-card">
    <div class="split-half">
      <!-- 左半 · IKB + ASCII 呼吸场 -->
      <div class="half b-accent" style="padding:5.6vh 3.6vw 4.4vh;justify-content:space-between;position:relative;overflow:hidden">
        <canvas class="ascii-bg" aria-hidden="true"></canvas>
        <div class="chrome-min" style="margin-bottom:0;position:relative;z-index:1">
          <div class="l">NN / NN</div>
          <div class="r">CLOSING</div>
        </div>
        <div data-anim="manifesto" style="display:flex;flex-direction:column;gap:2vh;position:relative;z-index:1">
          <div class="t-meta" style="color:rgba(255,255,255,.78);letter-spacing:.22em;margin-bottom:1.6vh">MANIFESTO</div>
          <h2 style="font-family:var(--sans),var(--sans-zh);font-size:min(8vw,14vh);line-height:.94;letter-spacing:-.025em;font-weight:200;color:#fff">[必填] Build a model.<br/>Run <span style="font-style:italic;font-weight:300">forever</span>.</h2>
          <div style="font-family:var(--sans),var(--sans-zh);font-size:max(13px,1vw);line-height:1.6;color:rgba(255,255,255,.82);font-weight:300;max-width:36ch;margin-top:1.4vh">[必填] 一句中英文落地注脚.</div>
        </div>
        <div data-anim="signature" style="display:flex;justify-content:space-between;align-items:end;border-top:1px solid rgba(255,255,255,.22);padding-top:2vh;position:relative;z-index:1">
          <div class="t-meta" style="color:rgba(255,255,255,.62)">[选填] 作者 · 头衔</div>
          <div class="t-meta" style="color:rgba(255,255,255,.62)">YY.MM.DD</div>
        </div>
      </div>
      <!-- 右半 · 白底 takeaway,第 03 条用 IKB 蓝强调,首尾色彩闭环 -->
      <div class="half" style="padding:5.6vh 3.6vw 4.4vh;justify-content:space-between">
        <div class="chrome-min"><div class="l">TAKEAWAYS</div><div class="r">03 RULES</div></div>
        <div data-anim="rules">...</div>
        <div class="t-meta" style="color:var(--text-helper);text-align:right">→ 完 · END OF FIELD NOTE</div>
      </div>
    </div>
  </div>
</section>
```

**Classic variant (`.closing-split` ink double half-screen)** — when the cover didn't use full-bleed IKB, switch to the classic ink closing:
```html
<div class="closing-split">
  <div class="cl-ink">
    <p class="line-mega">Build it<br>once.</p>
    <p class="line-mega">It runs<br>forever.</p>
  </div>
  <div class="cl-paper">
    <ul class="takeaway-list">
      <li><span class="num">01</span><h4>Skill</h4><p>...</p></li>
      <!-- 2 more -->
    </ul>
  </div>
</div>
```

---

### P10 · Dot Matrix Statement (点阵宣言)

**Purpose**: second statement page / section switch / visual breathing page.
**Content fit**: **slogan / metaphor / section switch** (like P3 but with geometric dot-matrix decoration). Used to **avoid two consecutive P3 pages** in one deck; usually a visual palate-cleanser before "concept definitions".
**Skeleton**: mid 7vw giant three-line manifesto / top-right 36vw dot matrix + bottom-left outlined ring matrix.
**Key classes**: `.dot-mat` (SVG-mask solid dots) `.ring-mat` (outlined circles) `.cross-mat` (× grid)
**Motion recipe**: `matrix-statement` — text enters line by line → dot-matrix mask-position sweeps left to right
**Example code**:
```html
<div class="canvas-card">
  <span class="ring-mat" style="left:5vw;bottom:5vh;width:18vw;height:18vw"></span>
  <h1 class="h-statement">Build a thin harness.<br>Write fat skills.<br>Codify everything.</h1>
  <span class="dot-mat" style="right:0;top:0;width:36vw;height:36vw"></span>
</div>
```

---

### P11 · Horizontal Timeline (横向时间线)

**Purpose**: multi-step flows (4-7 steps), time evolution.
**Content fit**: **4-7 step linear flows** (each step has only a name; no expandable data / description). Expandable steps → P5; quantified data → P2. **Forbidden** for loop structures (that's P14).
**Skeleton**: top display heading / middle 1px hairline horizontal line + N evenly distributed nodes (8×8 square blocks + mono number above + step name below).
**Key classes**: `.timeline-h` `.tl-h-node` `.tl-h-axis`
**Motion recipe**: `timeline-walk` — nodes light up left→right along the axis (220ms per node)
**Alignment note**: horizontal timeline labels rely on CSS `translateX(-50%)` centering. If the animation translates vertically, it must write the full `transform: translate(-50%, y)` sequence — writing only `y` leaves labels offset from dots after the animation ends.
**Example code**:
```html
<div class="timeline-h">
  <span class="tl-h-axis"></span>
  <div class="tl-h-node">
    <span class="num">01</span>
    <span class="dot"></span>
    <span class="lbl">Investigate</span>
  </div>
  <!-- 4-6 more -->
</div>
```

---

### P12 · Manifesto + Ink Banner (宣言 + 通栏 ink 条)

**Purpose**: interim conclusions, section back covers, slogan + strong visual close.
**Content fit**: **section-level close / interim manifesto** (used mid-deck, not the ending; P9 is the deck finale). Carries the tripartite「claim + short explanation + ink full-width manifesto」, no data.
**Skeleton**: upper half: left t-cat + 4-line display manifesto + right short paragraph / lower half: ink full-width banner (no left/right/bottom margins) + reversed white short lines + lucide icon matrix.
**Key classes**: `.manifesto-top` `.ink-banner-full` (`margin:0 -5vw -4.4vh` cancels parent padding)
**Motion recipe**: `manifesto` — three display segments rise staggered → bottom ink bar sweeps scaleX 0→1 → reversed white text fades in
**Note**: the Skill File small print **top-aligns with the right display type's baseline** (`align-items:flex-start;padding-top:1.2vw`)

---

### P13 · Three Forces Cards (三力卡片小报)

**Purpose**: showcase 3 equal concepts (each = giant number + title + two-column description).
**Content fit**: **deep dive on 3 equal concepts** (count = 3, carries more text than P5). Each card is fairly rich (giant number + title + two-column paragraph description). 01/02/03 are number anchors, not real data. Typical: three rebuttals, three forces, three claims.
**Skeleton**: left 5/16 ink hero block (t-cat + 4-line title + dot-matrix decoration) / right 11/16 three horizontally stacked cards.
**Key classes**: `.three-forces` `.hero-ink-col` `.force-card` (`.card-fill`) `.force-num` (9.2vw IKB blue)
**Motion recipe**: `three-forces` — left hero slides in horizontally → right 3 cards slide in from the right in stair steps → giant blue numbers pop individually
**Note**: **the 3 cards must share one style** (all `.card-fill` grey; don't mix outline/blue); to highlight one card switch it to `.card-accent`; blue fill + outline is **forbidden**.

---

### P14 · Loop Diagram (闭环流程图)

**Purpose**: self-learning loops, automation flows (3-5 step cycles).
**Content fit**: **cyclic / closed-loop flows** (the end returns to the start, 3-5 steps). E.g. self-learning loops, CI/CD, feedback loops, agent loops. **Forbidden** for linear flows (that's P11).
**Skeleton**: left 4 numbered steps (top-aligned) / right SVG concentric rings / central giant LOOP / nodes uniformly grey square blocks (no alternating round dots).
**Key classes**: `.loop-diagram` `.loop-steps` `.loop-svg`
**Motion recipe**: `loop-form` — left steps in vertical sequence → right SVG ring stroke-dashoffset draws → nodes light in sequence
**Note**: left and right are **centrally aligned as a whole** (top-aligned + equal heights)

---

### P15 · Image Matrix + Hero Stat (矩阵 + 大字底注)

**Purpose**: showcase many same-type items (8-12 skills / team members / case icons) with one aggregate number closing at the bottom.
**Content fit**: **8-12 same-type small items + one aggregate metric**. Each item carries only a short title (no expansion); the bottom giant number is the「aggregate」(total projects / total traffic / total users). Too few items → P4 (6 items).
**Skeleton**: top heading (9vh spacing) / middle 4×3 matrix cards (each 12vh fixed height) / bottom giant number + label (margin-top:auto pushes to bottom).
**Key classes**: `.matrix-fill` (grid-template-columns:repeat(4,1fr)) `.matrix-cell` (`.card-fill` grey, **outline forbidden**) `.hero-stat-bottom`
**Motion recipe**: `matrix-fill` — 12 cells fade in as a random checkerboard (random delay per cell) → bottom giant number counts up
**Note**: card heights are capped (avoids big-number overflow); **all cards use `.card-fill` grey**; only the single emphasized item switches to `.card-accent`

---

### P16 · Multi-card Brief (微卡小报)

**Purpose**: 6 mini cards side by side (briefs, tip collections, feature overviews).
**Content fit**: **6 lightweight briefs / tips / footnotes** (count = 6, each with short main text + small footnote). More fragmented than P4; fits brief-style content. **Only one accent blue card allowed** (single-focus law).
**Skeleton**: top display heading (9vh spacing) / below, 3×2 mini cards (each: main text top-left + small print bottom-right + empty middle).
**Key classes**: `.brief-grid` `.brief-card` (`.card-fill` grey) `.brief-card.is-accent` (single blue-base emphasis)
**Motion recipe**: `field-notes` — 6 cards light up in z-order (L→R, T→B, 90ms stagger)
**Note**: in-card layout is **main text top-left + small print bottom-right**, middle left empty (prevents scattered content); **only one accent blue allowed**

---

### P17 · System Diagram (同心圆系统图)

**Purpose**: hierarchical architecture (core→middle→outer), ecosystem maps.
**Content fit**: **strictly three-tier nesting** (core inner / middle layer / outer ring). Typical: tech-stack layers, ecosystem tiers, influence radiation. **Forbidden for non-three-tier structures** (flat → P4, unclear hierarchy → P5).
**Skeleton**: left half: title + three-part explanation / right half: SVG three-tier concentric circles + labels with leader lines.
**Key classes**: `.system-diagram` `.sys-svg` `.sys-label`
**Motion recipe**: `system-diagram` — concentric circles scale in from outer to inner → labels appear in sequence

---

### P18 · Why Now (三列递进 + 巨数)

**Purpose**: three arguments + each with supporting data (why now).
**Content fit**: **3 arguments, each mapped to one quantified datum**. Each argument = t-cat label + one-line title + paragraph + one bottom giant number (percentage/year/multiplier). The last column gets IKB blue emphasis as the「key supporting evidence」.
**Skeleton**: top display heading / middle 3 columns (each: t-cat + title + description) / each column ends with an 8.4vw giant number (01 / 02 / 03, last column IKB blue).
**Key classes**: `.why-now-grid` `.why-col` `.why-num-bottom` (8.4vw, weight 200)
**Motion recipe**: `why-now` — three columns progress vertically → bottom giant numbers count up
**Note**: giant numbers share one size; only color (IKB blue) highlights the last column, **never** bold

---

### P19 · Four Cards (四列均分卡)

**Purpose**: 4 features side by side (equal weight).
**Content fit**: **4 equal-weight features / modules** (count = 4, fully homogeneous structure). Each = t-meta number + display title + one description paragraph. No data dimension; purely qualitative. More even than P5 (three steps), more text-pure than P6 (data heights).
**Skeleton**: top 80px IKB blue short hairline + two-line display title / below, 4 equal columns (each: t-meta top "— 01 / SLASH" + display title + paragraph description).
**Key classes**: `.four-cards` `.fc-col`
**Motion recipe**: `four-cards` — top blue line width 0→100% → 4 columns push in from below (110ms stagger)
**Note**: **never** use 9px round decorative dots (violates the square-corner language); use `.t-meta` text instead

---

### P20 · Stacked KPI Ledger (纵向账单 KPI)

**Purpose**: 4-6 rows of core data in ledger form (each row = number + label + icon).
**Content fit**: **4-6 core data rows** (each row requires a real value + label + icon). The vertical ledger form suits financial data, KPI dashboards, key metric lists. Holds more data than P6 KPI Tower but is visually weaker (no bar-height contrast).
**Skeleton**: hairline divider per row / left giant number (height-capped `min(13vw,16vh)` against overflow) / middle label / right lucide icon.
**Key classes**: `.stacked-ledger` `.ledger-row` (border-bottom:1px solid var(--border-subtle)) `.ledger-num`
**Motion recipe**: `stacked-ledger` — per row: number rises → label slides left → icon pops (180ms stagger)
**Note**: **font size must be height-capped** (`font-size:min(13vw, 16vh)`); otherwise the bottom row gets pushed off standard 16:9 screens

---

### P21 · Tech Spec Sheet (规格说明书)

**Purpose**: product specs, benchmark data, performance baselines (multiple KPIs + visualized vertical line decoration).
**Content fit**: **product specs / benchmark / performance baseline** (real multi-dimensional data required: 3 KPIs + 9 vertical lines = 12+ data points). Typical: model scores, API performance, load-test results. The data-densest layout in the deck.
**Skeleton**: left 4-line display heading / middle 3 KPIs (top hairline + number + unit) / bottom-right 9 vertical lines of varying heights / bottom giant number + Yearly goal + three tags + bottom-right MP-XX + page number.
**Key classes**: `.tech-spec` `.spec-title-col` `.spec-kpi-grid` `.spec-bars` (`.bar-vert`, scaleY pop, transform-origin:bottom)
**Motion recipe**: `tech-spec` — hero area fades in → titles enter → KPI top lines draw one by one → bottom giant number pops → vertical lines scaleY up from the bottom (50ms stagger)
**Note**: the bottom-right bars matrix must be **bottom-aligned** and **must not exceed the right margin**

---

### P22 · Image Hero (图文混排封面)

**Purpose**: case showcases, product image + data grounding, section covers with images.
**Content fit**: **case showcase / product launch / section cover with image** (real image assets + 3 core metrics required). Typical: product screenshot + key metrics, case image + ROI, user feedback + repurchase rate. **Forbidden without real image sources** (placeholder grey images destroy the visuals).
**Skeleton**: upper 60% full-width image + white title block overlay top-left (top:11vh, generous buffer) / lower 40% long description + three-column KPIs ($ / 127× / 100%).
**Key classes**: `.image-hero` `.hero-img-wrap` (60vh) `.hero-overlay-block` `.hero-stats`
**Motion recipe**: `image-hero` — image slowly zooms out (scale 1.05→1) → white block pushes open scaleX 0→1 → three KPI top lines draw in order
**Note**:
- Prefer local `images/{页号}-{语义}.png` files (GPT-M 2.0 or user-provided material) for images; don't default to unsplash hotlinks
- Content below the image must not hug the image's lower edge; `.image-hero-body` uniformly adds top buffer to the lower half
- The three KPI display sizes must be height-capped (`min(4.6vw, 7.6vh)`); small text anchors to the column bottom with `margin-top:auto` to avoid spilling onto the nav dots
- Columns share equal heights (no `align-items:start` on the grid; let columns stretch to the same height)

**Example code**:
```html
<section class="slide light" data-animate="image-hero">
  <div class="canvas-card" style="padding:0;display:flex;flex-direction:column;overflow:hidden">
    <div data-anim="img" style="position:relative;flex:0 0 60%;overflow:hidden;background:var(--grey-1)">
      <img src="images/22-product-scene.png" alt="[必填] 图片说明" loading="eager"
           style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center 30%">
      <div class="chrome-min" style="position:absolute;top:0;left:0;right:0;color:rgba(255,255,255,.9);padding:5.6vh 5vw 0">
        <div class="l">Section · Case / Visual Evidence</div>
        <div class="r">22 / NN</div>
      </div>
      <div data-anim="title-block" style="position:absolute;left:5vw;top:11vh;background:var(--paper);padding:3.2vh 3.2vw;max-width:40vw">
        <div style="font-family:var(--sans),var(--sans-zh);font-weight:200;font-size:min(5.2vw,9vh);line-height:1;letter-spacing:-.035em;color:var(--text-primary)">
          [必填] Image<br>Evidence
        </div>
      </div>
    </div>
    <div data-anim="kpi" class="image-hero-body">
      <div style="max-width:48ch;font-family:var(--sans),var(--sans-zh);font-size:max(15px,1.3vw);line-height:1.55;font-weight:300;color:var(--text-primary);letter-spacing:-.005em">
        [必填] 1-2 行解释这张图为什么重要,不要重复标题.
      </div>
      <div class="image-hero-stats" style="gap:4vw">
        <div style="display:flex;flex-direction:column;gap:.6vh"><div style="height:1px;background:var(--ink)"></div><div class="t-meta">Metric 01</div><div style="font-family:var(--sans);font-weight:200;font-size:min(4.6vw,7.6vh);line-height:.95;letter-spacing:-.04em">12×</div><div style="height:1px;background:var(--border-subtle);margin-top:auto"></div><p class="body-sm">[必填] 指标解释</p></div>
        <div style="display:flex;flex-direction:column;gap:.6vh"><div style="height:1px;background:var(--ink)"></div><div class="t-meta">Metric 02</div><div style="font-family:var(--sans);font-weight:200;font-size:min(4.6vw,7.6vh);line-height:.95;letter-spacing:-.04em">3.4h</div><div style="height:1px;background:var(--border-subtle);margin-top:auto"></div><p class="body-sm">[必填] 指标解释</p></div>
        <div style="display:flex;flex-direction:column;gap:.6vh"><div style="height:1px;background:var(--ink)"></div><div class="t-meta">Metric 03</div><div style="font-family:var(--sans);font-weight:200;font-size:min(4.6vw,7.6vh);line-height:.95;letter-spacing:-.04em;color:var(--accent)">100%</div><div style="height:1px;background:var(--border-subtle);margin-top:auto"></div><p class="body-sm">[必填] 指标解释</p></div>
      </div>
    </div>
  </div>
</section>
```

---

## Historical experimental zone (disabled by default)

The P23/P24 below are experimental layouts added early on to explore image-text mixing. They are not part of the original 22P and must not be used for formal generation by default. Unless the user explicitly says "I want to experiment with new image-text layouts", use S22 or the S15/S16 image slots.

### P23 · Swiss Image Split · text left / image right (or reversed) (experimental, disabled by default)

**Purpose**: explain an argument with one documentary photo, infographic, UI scene or system-relation image.
**Content fit**: **one core argument + one core image**. Fits "display heading left + image evidence right" or "image left + explanation right". If the image is the full-page hero and needs KPIs, use P22; for multiple images use P24.
**Skeleton**: inside `.canvas-card`, head stacks vertically / body `.swiss-img-split` two columns (5:7 or reversed 7:5) / `.swiss-img-caption` below the image.
**Key classes**: `.swiss-img-split` `.swiss-img-copy` `.frame-img.r-16x10.fit-contain|cover` `.swiss-img-caption`
**Motion recipe**: `grid-reveal` — head first; image and text blocks appear staggered
**Note**:
- The image usually aligns with the body's first line, not the display heading's top; you may add `padding-top:1vh` to `3vh` on the image column
- To bottom-align the left content block with the right image, use `.swiss-img-split.align-image-bottom`; don't force it with extra blank lines
- `.align-image-bottom` has a built-in bottom nav safe zone; don't additionally push the image or caption toward the page bottom
- Avoid meaningless dividers in the left content block; don't insert `.rule` unless you need section feel
- Infographics/UI images must be `.fit-contain`; documentary photos default to cover
- The right image is wide; keep headings within 3 lines and the body to 2-3 short paragraphs or 3 bullets

```html
<section class="slide light" data-animate="grid-reveal">
  <div class="canvas-card">
    <div class="chrome-min">
      <div class="l">Section · Visual Argument</div>
      <div class="r">23 / NN</div>
    </div>
    <div style="flex:1;padding:0;display:grid;grid-template-rows:auto 1fr;gap:5vh">
      <div data-anim="head" style="display:flex;flex-direction:column;gap:1.4vh">
        <div class="t-meta">Evidence · GPT-M 2.0</div>
        <h2 style="font-family:var(--sans),var(--sans-zh);font-weight:200;font-size:min(7vw,12vh);line-height:.96;letter-spacing:-.035em">[必填] 一句核心论点</h2>
      </div>
      <div class="swiss-img-split align-image-bottom" data-anim="up">
        <div class="swiss-img-copy">
          <div class="t-cat" style="color:var(--accent)">Why it matters</div>
          <p class="lead" style="font-weight:300;max-width:36ch">[必填] 2-3 行解释图片与论点的关系.</p>
          <div class="body" style="font-weight:300;color:var(--text-secondary)">[必填] 可以放 2-3 条短 bullet 或一段说明,保持左对齐和充足留白.</div>
        </div>
        <figure class="tile">
          <div class="frame-img r-16x10 fit-contain">
            <img src="images/23-visual-evidence.png" alt="[必填] 图片说明">
          </div>
          <figcaption class="swiss-img-caption"><strong>[必填] 图片标题</strong><span>16:10 · fit-contain</span></figcaption>
        </figure>
      </div>
    </div>
  </div>
</section>
```

---

### P24 · Swiss Evidence Grid · multi-image evidence wall (experimental, disabled by default)

**Purpose**: three same-type images/screenshots/charts side by side, showing an evidence chain or multi-case comparison.
**Content fit**: **2-3 same-type images**. Fits UI screenshot redraws, three-part flowcharts, three case photos, three small data charts. Mixing types breaks Swiss order.
**Skeleton**: head stacks vertically / `.swiss-img-grid` three columns / each tile uses the same `.h-22` or `.h-26`.
**Key classes**: `.swiss-img-grid` `.frame-img.h-22|h-26` `.fit-contain` `.swiss-img-caption`
**Motion recipe**: `grid-reveal`
**Note**:
- Images in one group must share ratio, height and margin density; never mix one 16:9, one 4:3 and one long-strip screenshot
- There must be obvious buffer between the heading area and the image area; the template's `.swiss-img-grid` carries a default top gap — add `.tight` only when the outer grid already provides enough gap
- UI/infographics uniformly `.fit-contain`; photos uniformly cover
- If the user's original screenshot ratios are chaotic, first regenerate a same-ratio "screenshot redesign" with GPT-M 2.0

```html
<section class="slide light" data-animate="grid-reveal">
  <div class="canvas-card">
    <div class="chrome-min">
      <div class="l">Section · Evidence Grid</div>
      <div class="r">24 / NN</div>
    </div>
    <div style="flex:1;padding:0;display:grid;grid-template-rows:auto 1fr;gap:6vh">
      <div data-anim="head" style="display:flex;flex-direction:column;gap:1.4vh">
        <div class="t-meta">Three visual proofs</div>
        <h2 style="font-family:var(--sans),var(--sans-zh);font-weight:200;font-size:min(6.6vw,11.6vh);line-height:.96;letter-spacing:-.035em">[必填] 三个证据,一个结论</h2>
      </div>
      <div class="swiss-img-grid" data-anim="up">
        <figure class="tile"><div class="frame-img h-26 fit-contain"><img src="images/24-proof-a.png" alt="[必填]"></div><figcaption class="swiss-img-caption"><strong>01</strong><span>[必填] 证据 A</span></figcaption></figure>
        <figure class="tile"><div class="frame-img h-26 fit-contain"><img src="images/24-proof-b.png" alt="[必填]"></div><figcaption class="swiss-img-caption"><strong>02</strong><span>[必填] 证据 B</span></figcaption></figure>
        <figure class="tile"><div class="frame-img h-26 fit-contain swiss-lined"><img src="images/24-proof-c.png" alt="[必填]"></div><figcaption class="swiss-img-caption"><strong>03</strong><span>[必填] 关键证据</span></figcaption></figure>
      </div>
    </div>
  </div>
</section>
```

---

## Layout selection index (decision table for the LLM)

| Content intent | Recommended layout |
|---|---|
| Deck opening cover | P1 Cover |
| Evolution comparison / timeline (vertical) | P2 Vertical Timeline |
| One-line slogan / section start | P3 Statement / P10 Dot Matrix |
| 6 concept definitions | P4 Six Cells |
| Three-step flow (light) | P5 Three Sub-cards |
| 4 data points visualized by height | P6 KPI Tower |
| 5-10 item ranking | P7 H-Bar Chart |
| Before/After / dual-track contrast | P8 Duo Compare |
| Deck closing | P9 Closing Manifesto |
| Multi-step flow (horizontal, 4-7 steps) | P11 Horizontal Timeline |
| Interim conclusion + ink banner | P12 Manifesto + Banner |
| Deep dive on 3 equal concepts | P13 Three Forces Cards |
| Closed-loop flow / self-learning loop | P14 Loop Diagram |
| 8-12 item matrix + aggregate | P15 Image Matrix |
| 6 brief mini cards | P16 Multi-card Brief |
| Hierarchical architecture / concentric system | P17 System Diagram |
| Three arguments + data support | P18 Why Now |
| 4 equal-weight features | P19 Four Cards |
| 4-6 ledger-style KPI rows | P20 Stacked Ledger |
| Product specs / benchmark | P21 Tech Spec |
| Case image + data grounding | P22 Image Hero |
| Places / routes / residence relations | S08 + Swiss Map Component |
| Single-image argument / image-text mix | P23 Swiss Image Split |
| 2-3 image/screenshot/chart evidence chain | P24 Swiss Evidence Grid |

---

## P0 layout-selection principle: content data type must match the layout

> This is **the easiest place to step on a mine** when writing a deck. The「shape」of content a layout carries is fixed — look at the content first, then pick the layout; **never pick the layout first and fabricate content to cram in**.

| Content type | Must use | Strictly forbidden |
|---|---|---|
| Real quantified data (percentages/values) | P6 KPI Tower / P7 H-Bar / P20 Ledger / P21 Tech Spec | P3 / P4 / P10 / P13 (no-data layouts) |
| No data, pure qualitative assertion | P3 / P10 Statement / P12 / P13 / P19 | ⚠️ **P7 H-Bar / P6 KPI Tower** (fabricated numbers will be seen through) |
| 4 equal items | P19 Four Cards / P6 (with data) | Don't force 6 items into P4 |
| 6 equal items | P4 Six Cells / P16 Brief | Don't force 4 items into P19 |
| 3 equal items | P5 Sub-cards / P13 Three Forces | |
| Before/After | P8 Duo Compare (exactly 2 items) | |
| Places/routes/city relations | S08 + Swiss Map Component | Plain S04/S16 card lists |
| Loop structure | P14 Loop Diagram | P11 horizontal flow (linear ≠ loop) |
| Three-tier nesting | P17 System Diagram | |
| Time evolution (with data) | P2 Vertical Timeline | |
| Multi-step flow (no data) | P11 Horizontal Timeline | |
| 8-12 same-type items | P15 Image Matrix | |
| Deck closing | P9 Closing (once per deck) | |
| 1 core image + one explanation | P23 Swiss Image Split | P22 (unless the image is the hero and has KPIs) |
| 2-3 same-type images | P24 Evidence Grid | P4/P16 (text cards, not image evidence) |

**Minefield example**: using the P7 H-Bar Chart to show「智能补全 / 实时协作 / 自主代理」(smart completion / real-time collaboration / autonomous agents) — a **concept list with no comparable percentages** — while fabricating numbers like 96/88/78 → **the data is untrustworthy, the layout abused**. Such content should use P2 (with a time dimension) or P3 Statement (if an assertion).

---

## Common mistakes (P0 checks)

1. ❌ Adding `border-radius` to cards → ✅ square corners required
2. ❌ Adding an outline on top of `.card-accent` → ✅ card fill types are mutually exclusive
3. ❌ Drawing your own SVG icons → ✅ use the `lucide` online library, angular style
4. ❌ Aligning timeline dots with the dashed line via grid `justify-self` → ✅ axis column fixed 12px + absolutely positioned dots
5. ❌ Display size without a height cap (`13vw`) → ✅ always the `min(Xvw, Yvh)` dual constraint
6. ❌ ESC index thumbnails invisible due to animations → ✅ add a visibility override CSS to cloned slides
7. ❌ One fade-up recipe on all pages → ✅ one semantic recipe per page, coupled to the graphics
8. ❌ Heading-to-card spacing < 5vh → ✅ section-level headings need at least 9vh
9. ❌ 9px round decorative dots → ✅ 8×8 square mini blocks / mono `t-meta` text
10. ❌ Decorations exceeding page margins → ✅ strictly inside the grid, never hugging edges
