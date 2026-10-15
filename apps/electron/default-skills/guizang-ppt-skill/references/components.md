# Component Reference · Components

This is the component handbook for the `guizang-ppt-skill` skill. template.html already defines all styles; this document only covers "what each component looks like and how to use it".

## Table of contents

- [Basic slide shell](#basic-slide-shell)
- [Typography](#typography)
- [Chrome & Foot](#chrome--foot)
- [Callout quote box](#callout-quote-box)
- [Stat number matrix](#stat-number-matrix)
- [Platform card](#platform-card)
- [Rowline table row](#rowline-table-row)
- [Pillar card](#pillar-card)
- [Tag & Kicker](#tag--kicker)
- [Figure image frame](#figure-image-frame)
- [Icons](#icons)
- [Ghost giant background word](#ghost-giant-background-word)
- [Highlight marker](#highlight-marker)
- [Motion animation system](#motion-animation-system)

---

## Basic slide shell

Every page is a `<section class="slide ...">`. It must carry the `data-theme` attribute (`light` or `dark`); the JS page flip switches the background based on this attribute.

```html
<section class="slide light" data-theme="light">   <!-- 浅色页 -->
<section class="slide dark" data-theme="dark">     <!-- 深色页 -->
<section class="slide light hero" data-theme="light">  <!-- Hero 页：浅色 + 薄遮罩透出 WebGL -->
<section class="slide dark hero" data-theme="dark">    <!-- Hero 页：深色 + 薄遮罩 -->
```

**light vs dark usage: alternate them**, switching the theme every 2-3 pages; never exceed 3 consecutive pages of the same color. On page flips the WebGL background automatically cross-fades between the two shaders.

**hero class usage**: add it only to visually dominant pages (cover, quote pages, section transitions, ending). With `hero`, the mask drops to 12-16% and the WebGL background surfaces broadly, so don't put too much text on hero pages.

---

## Typography

The font division of labor is this template's most important rule; mixing is strictly forbidden.

| Class | Use | Font |
|---|---|---|
| `.display` | Extra-large English (hero pages) | Playfair Display 700, 11vw |
| `.display-zh` | Extra-large Chinese heading | Noto Serif SC 700, 7.8vw |
| `.h1-zh` | Page main title | Noto Serif SC 700, 4.6vw |
| `.h2-zh` | Subtitle | Noto Serif SC 600, 3.2vw |
| `.h3-zh` | Pipeline step title | Noto Serif SC 500, 1.9vw |
| `.lead` | Lead paragraph (larger than body) | Noto Serif SC 400, 1.9vw |
| `.body-zh` | **Body/description (sans-serif)** | Noto Sans SC 400, 1.22vw |
| `.body-serif` | Body (serif) | Noto Serif SC 400, 1.3vw |
| `.kicker` | Section hint (above the heading) | IBM Plex Mono, 12px uppercase |
| `.meta` | Meta info tag | IBM Plex Mono, 0.88vw uppercase |
| `.big-num` | Giant number | Playfair Display 800, 10vw |
| `.mid-num` | Mid-size number | Playfair Display 700, 5.5vw |

**Core rules**:
- **Serif** (`serif-zh` / `serif-en`): headings, key quotes, numbers — used for "visual accent"
- **Sans-serif** (`sans-zh`): body descriptions, long reading content — used for "information density"
- **Mono** (`mono`): kicker, meta, foot English labels — used for "decorative rhythm"

**Emphasis techniques**:
- `<em class="en">英文词</em>` — renders the English word in Playfair Display italic (looks great)
- `<em style="opacity:.65">短语</em>` — fades out the second half of a heading to create rhythm

---

## Chrome & Foot

The meta info bars at the top and bottom of every page. Almost all pages should have them.

```html
<div class="chrome">
  <div class="left">
    <span>第一幕 · 硬数据</span>
    <span class="sep"></span>
    <span>Act I</span>
  </div>
  <div class="right"><span>02 / 27</span></div>
</div>

<!-- ... 页面主体 ... -->

<div class="foot">
  <div class="title">项目名 · CodePilot　|　github.com/codepilot</div>
  <div>Act I · Dev Numbers</div>
</div>
```

**Rules**:
- `chrome.right` always holds the page number `NN / TOTAL` (TOTAL = total pages)
- `foot.title` is the Chinese description; `foot.right` is the English act marker
- chrome and foot together form the magazine-style "running head/foot"

---

## Callout quote box

Showcases punchlines / key viewpoints / quoted remarks.

```html
<div class="callout" style="max-width:80vw">
  <div class="q-big">"这东西在三年前，<br>需要一个十人团队做一年。"</div>
  <span class="cite">— 一个观察者的判断</span>
</div>
```

Variants:
- Without cite: just remove `<span class="cite">`
- With an English quote: `<em class="en">"Thin Harness, Fat Skills."</em>`
- On a hero page: wrap it with `style="position:relative;z-index:2"` (avoids being covered by the background mask)

---

## Stat number matrix

Showcases data metrics, usually paired with `.grid-6` / `.grid-4`.

```html
<div class="grid-6">
  <div class="stat">
    <span class="m">Duration</span>
    <span class="n">64<em style="font-size:.4em;opacity:.5;font-style:normal"> 天</em></span>
    <span class="l">从 0 到现在</span>
  </div>
  <!-- ... 更多 stat ... -->
</div>
```

Three-part structure: `.m` mono small label → `.n` giant number → `.l` description. Units after numbers are shrunk to 0.4em via `<em>` with opacity 0.5.

**Common layout containers**:
- `.grid-6` — 3×2 grid (most common; 6 stats)
- `.grid-4` — 2×2 grid (4 stats)
- `.grid-3` — 3 equal columns in one row (3 stats / pillars)

---

## Platform card

Showcases social platforms / channels + follower counts.

```html
<div class="plat">
  <div class="sub">Weibo</div>
  <div class="name">微博</div>
  <div class="nb">289K</div>
</div>
```

Optional fourth line (supplementary note):
```html
<div class="body-zh" style="font-size:max(11px,.8vw);opacity:.5;margin-top:.6vh">
  含小绿书同步
</div>
```

**"Also On" variant** (supplementary platforms):
```html
<div class="plat" style="border-top-style:dashed;opacity:.72">
  <div class="sub">Also On</div>
  <div class="body-zh" style="font-weight:600;margin-top:.8vh">
    B 站　·　知乎
  </div>
</div>
```

---

## Rowline table row

List-style content, one entry per row.

```html
<div class="rowline">
  <div class="k">CLAUDE.md</div>
  <div class="v">你该怎么做事 —— 行为规则 + 工作偏好 + 禁止事项</div>
  <div class="m">EMPLOYEE · HANDBOOK</div>
</div>
```

Three-column structure: `.k` serif keyword · `.v` body description · `.m` mono tag (right-aligned). The first and last rowlines automatically gain top/bottom borders.

**Variant: 2 columns**: `style="grid-template-columns:1fr 3fr"` and drop the `.m` column.

---

## Pillar card

A three-pillar structure, often used for "parallel concepts" pages.

```html
<div class="grid-3">
  <div class="pillar">
    <div class="ic">01</div>
    <div class="t">三层<br>文档体系</div>
    <div class="d">CLAUDE.md<br>+ 项目知识库<br>+ 护栏文件</div>
  </div>
  <!-- ... 更多 pillar ... -->
</div>
```

**Pillar with icon (for emphasis pages)**:
```html
<div class="pillar" style="padding:4vh 2vw;border:1px solid currentColor;border-color:rgba(10,10,11,.2)">
  <div class="ic"><i data-lucide="compass" class="ico-lg"></i></div>
  <div class="t">判断力</div>
  <div class="d">决策和方向的权威。<br>取舍、品味、方向感。</div>
</div>
```

`.ic` can be a sequence number (`01 / 02 / 03` or `A. / B. / C.`) or a Lucide icon.

---

## Tag & Kicker

**Kicker** is the small hint text above a heading (mono, all caps, small size):
```html
<div class="kicker">过去 64 天 · 开发篇</div>
<div class="h1-zh">一个人，做了什么。</div>
```

**Tag** is a standalone tag pill (with border):
```html
<div style="display:flex;gap:1.6vw;flex-wrap:wrap">
  <div class="tag">早上 10 点起床</div>
  <div class="tag">周二 / 四下午健身</div>
  <div class="tag">晚上照样看剧 · 玩游戏</div>
</div>
```

---

## Figure image frame

**This is the component most likely to trip you up in this template; obey the rules below**.

### Basic structure

```html
<figure class="tile">
  <div class="frame-img" style="height:26vh">
    <img src="图片素材/xxx.png" alt="说明">
  </div>
  <figcaption class="frame-cap">
    <span class="pf">推特 · Twitter</span>
    <span class="nb">137K</span>
  </figcaption>
</figure>
```

### Key constraints (hard-won lessons; do not violate)

1. **Image grids must use fixed `height:Nvh`**, never `aspect-ratio`.
   - Reason: aspect-ratio inside a grid easily breaks the parent container, causing image stacking.
   - Recommended sizes: `.h-16` (small panel) / `.h-18` (compact strip) / `.h-22` (standard grid) / `.h-26` (highlighted) / `.h-28` (large image).
   - A single main image can use the template's ratio classes: `.r-16x9` / `.r-16x10` / `.r-4x3` / `.r-3x2` / `.r-3x4` / `.r-1x1`.
   - Images in one group must use the same height class; never mix one `25vh` with one `21vh`.

2. **`object-position:top center` (already set in CSS)**; only the bottom may be cropped.
   - Cropping left/right and top is strictly forbidden — that's an image's core identity area.

3. **For multiple images in a grid, use an inline grid instead of `grid-3`**:
   ```html
   <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:1vh 1.2vw">
     <figure class="tile">...</figure>
     <figure class="tile">...</figure>
     <figure class="tile">...</figure>
   </div>
   ```

4. **Align images with the rest of the layout**: use the `.grid-2-7-5` / `.grid-2-6-6` / `.grid-2-8-4` grid structure to naturally top-align. Never add `align-self:end` to images.

5. **Infographics / screenshot redesigns**: add `.fit-contain` to `.frame-img` as well, avoiding cropped in-image text and annotations.

6. **When the user's original screenshot ratio doesn't fit**: prefer regenerating a "screenshot redesign / UI scene" at the target ratio; don't force the original into a long strip.

### Frame caption variants

```html
<!-- 标准：左 figure 名，右数字 -->
<figcaption class="frame-cap">
  <span class="pf">推特 · Twitter</span>
  <span class="nb">137K</span>
</figcaption>

<!-- 带编号 -->
<figcaption class="frame-cap">
  <span class="idx">01</span>
  <span class="pf">AI 润色</span>
  <span>Polish</span>
</figcaption>
```

### Image placeholder (design-phase placeholder)

When images aren't ready yet, use a dashed-box placeholder:
```html
<div class="img-slot r-4x3">  <!-- r-4x3 / r-16x9(default) / r-3x2 / r-1x1 -->
  <span class="plus">+</span>
  <span class="label">GitHub 截图位置</span>
</div>
```

---

## Icons

**Emoji are strictly forbidden**. Use Lucide via CDN (already included in template.html).

```html
<i data-lucide="compass" class="ico-lg"></i>     <!-- 大图标（pillar 用） -->
<i data-lucide="target" class="ico-md"></i>      <!-- 中图标（列表项用） -->
<i data-lucide="check-circle" class="ico-sm"></i>  <!-- 小图标（inline 用） -->
```

**Common Lucide icon names** (grouped by meaning):

- Judgment: `compass`, `target`, `crosshair`, `search-check`
- Relations: `share-2`, `users`, `network`, `link`, `handshake`
- Brand: `crown`, `gem`, `award`, `star`, `badge-check`
- Process: `workflow`, `route`, `arrow-right-left`, `repeat`
- Data: `grid-2x2`, `bar-chart-3`, `trending-up`, `activity`
- Aesthetics: `palette`, `brush`, `eye`, `sparkles`
- Right/wrong: `check-circle`, `x-circle`, `check`, `x`
- Direction: `arrow-right`, `arrow-up-right`, `corner-down-right`

**Icon + text inline combination**:
```html
<div class="h3-zh" style="display:flex;align-items:center;gap:.8em">
  <i data-lucide="target" class="ico-md"></i>
  判断 — 什么值得写
</div>
```

---

## Ghost giant background word

Used as a "decorative background word" at very low opacity, creating the magazine feel.

```html
<div class="ghost" style="right:-6vw;top:-8vh">BUT</div>
<div class="ghost" style="left:-8vw;bottom:-18vh;font-style:italic">Harness</div>
```

- Font size 34vw, opacity 0.06
- Common positions: `right:-6vw;top:-8vh` (overflowing top-right) / `left:-8vw;bottom:-18vh` (overflowing bottom-left)
- Content: an English word or number (section numbers 01/02/03, keywords like BUT/NOW/HERE)

**Note**: on pages using ghost, other content needs `position:relative;z-index:2` to avoid being pressed underneath.

---

## Highlight marker

A "highlighter pen" effect for inline phrases:

```html
<span class="hi">不是</span>
<span class="hi">一次性爆发</span>
```

It draws a semi-transparent highlight bar under the text. Dark themes get a bright bar, light themes a dark bar (handled by CSS).

**Fits**: use only on 1-3 key words; never over large areas.

---

## Motion animation system

The whole deck has page-flip entrance animations on by default, driven by Motion One (vanilla Framer Motion, ~4KB).

### Loading

The module script at the bottom of `assets/template.html` first tries the **local** `assets/motion.min.js`; on failure it falls back to the **jsdelivr CDN**; if both fail it force-sets all elements carrying `data-anim` to `opacity:1` — content always stays readable, and the presentation never depends on the network.

```js
// template 里的核心加载器(不用改)
let motion;
try { motion = await import('./assets/motion.min.js'); }
catch(e1) {
  try { motion = await import('https://cdn.jsdelivr.net/npm/motion@11.11.17/+esm'); }
  catch(e2) {
    document.querySelectorAll('[data-anim]').forEach(el=>{el.style.opacity='1';el.style.transform='none'});
  }
}
```

### Data-attribute driven

You only need to add two kinds of attributes in HTML:

```html
<!-- 1. 在 section 上选 recipe(可选,默认 cascade / hero 自动) -->
<section class="slide light" data-animate="quote">

<!-- 2. 在需要入场的元素上加 data-anim(可选值:left/right/line/step/divider) -->
<h1 class="h-xl" data-anim>大标题</h1>
<div class="stat-card" data-anim>...</div>
<div data-anim="left">左列内容</div>
<span data-anim="line" style="display:block">引用第一行</span>
```

### The 5 recipes at a glance

| recipe | Trigger | Behavior | Representative layouts |
|---|---|---|---|
| `cascade` (default) | No `data-animate` means this value | All `data-anim` fade in with stagger, 75ms/step | Layouts 3 / 4 / 5 / 10 |
| `hero` | `.hero` slides use it automatically | Slower stagger, more ceremonial, 160ms/step | Layouts 1 / 2 / 7 |
| `quote` | `data-animate="quote"` | Other elements first; `data-anim="line"` lines reveal one by one at 550ms intervals | Layout 8 |
| `directional` | `data-animate="directional"` | `data-anim="left"` slides in from left → divider → `data-anim="right"` slides in from right | Layout 9 |
| `pipeline` | `data-animate="pipeline"` | On arrival steps stay 15% transparent; press →/space/wheel to light them one by one; the flip is released only after the last step | Layout 6 |

### Decision tree for choosing a recipe per slide

1. **Is it a `.hero` slide?** → don't add `data-animate`; `hero` is automatic
2. **Is it a big-quote punchline page?** → `data-animate="quote"`, each line in `<span data-anim="line" style="display:block">`
3. **Is it a left/right Before/After comparison?** → `data-animate="directional"`, left column `data-anim="left"`, right column `data-anim="right"`
4. **Is it a step-by-step pipeline?** → `data-animate="pipeline"`, each step `data-anim="step"`
5. **All other body pages** → add nothing; `cascade` is automatic

### Which elements should get `data-anim`?

- ✅ Every block with independent semantics: kicker / h1 / h-xl / lead / callout / stat-card / figure / tag / rowline
- ✅ Each column in multi-column structures, so they fade in column by column instead of together
- ❌ Don't add it to containers (`.grid-6` / `.frame`); only add it to leaf elements
- ❌ Don't add it to every `<li>`; adding at the `<ul>` level is usually enough
- ❌ If a page shouldn't animate at all (e.g. a transition page), simply add no `data-anim` on it — Motion One only affects marked elements

### FAQ

- **Images flash before appearing?** That's expected; the animation triggers mid-flip (at 450ms)
- **Pipeline page stuck, can't flip?** Correct behavior; press → to light steps one by one, and only after all are lit does → flip the page
- **Content doesn't show even when static?** Check whether motion.min.js is under `assets/`; or check the browser console for errors
