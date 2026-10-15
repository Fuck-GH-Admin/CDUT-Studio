# Page Layout Library (Layouts)

This document collects the 10 most-used page layout skeletons. Each is a complete, paste-ready `<section class="slide ...">...</section>` code block; just replace copy/images to use it.

---

## ⚠️ Must read before generating (Pre-flight)

### A. Class names must come from template.html

All classes used in layouts.md (`h-hero` / `h-xl` / `h-sub` / `h-md` / `lead` / `meta-row` / `stat-card` / `stat-label` / `stat-nb` / `stat-unit` / `stat-note` / `pipeline-section` / `pipeline-label` / `pipeline` / `step` / `step-nb` / `step-title` / `step-desc` / `grid-2-7-5` / `grid-2-6-6` / `grid-2-8-4` / `grid-3-3` / `grid-6` / `grid-3` / `grid-4` / `frame` / `frame-img` / `img-cap` / `callout` / `callout-src` / `kicker`) are predefined in the `<style>` block of `assets/template.html`.

**Do not invent new class names**. If you must customize, write it inline with `style="..."`. If unsure whether a class exists before generating, grep template.html to confirm.

### B. Image ratio rules (very important)

**Always use standard ratios**, never odd original ratios like `aspect-ratio: 2592/1798`:

| Scenario | Recommended ratio | Syntax |
|------|---------|------|
| Quote+image main image | 16:10 or 4:3 | `.frame-img.r-16x10` or `.frame-img.r-4x3` |
| Image grid (multi-image comparison) | Uniform | `.frame-img.h-22` / `.frame-img.h-26`, no aspect-ratio |
| Small panel groups | Uniform | `.frame-img.h-16` / `.frame-img.h-18`; same group must share height |
| Small image left + text right | 1:1 or 3:2 | `.frame-img.r-1x1` or `.frame-img.r-3x2` |
| Full-screen hero visual | 16:9 | `.frame-img.r-16x9` |
| Infographics / screenshot redesigns | 16:9 or 16:10 | `.frame-img.r-16x9.fit-contain` or `.frame-img.r-16x10.fit-contain` |
| Mixed-layout small illustrations | 3:2 or 3:4 | `.frame-img.r-3x2` or `.frame-img.r-3x4` |

Images must be wrapped in `<figure class="frame-img">`. Default photos get `object-fit:cover + object-position:top center`, cropping only the bottom, never top/left/right. Infographics and screenshot redesigns must add `.fit-contain` to avoid cropping text or annotations.

### B2. Vertical alignment of images with content

Images should align with the body content area, not the display heading's top by default. Especially on quote+image and mixed text+image pages:

- If the left column is kicker + display heading + body + callout, the right image usually starts at body height; add `style="margin-top:7vh"` to `9vh` on the image
- If the image is an infographic or UI scene, prefer aligning with the body's first line or the caption text, not with the huge heading's top
- If a screenshot/UI scene becomes a very long strip in a landscape page, don't force full width; switch to an ultra-wide horizontal asset, or split it into 2-3 partial panels
- Multi-image panels must use the same height class; never mix `h-16` / `h-22` or hand-write different `height`s

### B3. Heading-to-body spacing

- Two-part pages (top heading + long body/quote/chart below) must leave obvious spacing between heading and content; recommended `margin-top:6vh` to `8vh`
- Centered display-heading pages must center the main heading horizontally on the page, using `.center` or `text-align:center; margin-inline:auto`
- Complex pages (display heading + subheading + detail) must layer the heading above the content; the content below uses a left-right justified grid or rowline; don't stack everything on one central axis

### C. Image positioning rules (avoid images piling at the page bottom, covered by browser toolbars)

**Wrong approaches** (already burned us; don't repeat):
- Using `align-self:end` in a non-grid container: `align-self` has no effect at all outside flex/grid; the image drops to the end of document flow and piles at the bottom
- Using `position:absolute + bottom:0` to "pin" the image to the bottom: it gets covered by the bottom `.foot` and the `#nav` dots
- Writing only `height:N vh` with no `max-height` on a single image: it overflows the viewport on low-res screens

**Correct approaches**:
- Mixed text+image **must use the `.frame.grid-2-7-5`** grid structure (or `.grid-2-6-6` / `.grid-2-8-4`)
- Grid containers default to `align-items:start` (already set in the template), so images naturally hug the cell top
- If you need "image bottom-aligned with the left column callout": **the left column uses flex column + `justify-content:space-between`** (so the callout hugs the left column bottom), **the right column figure just stays with align-items:start**; do not add `align-self:end`
- All grid parents should add inline `style="padding-top:6vh"` to give the heading area breathing room

### D. Theme color & theme rhythm

- The palette is chosen from the 5 presets in `references/themes.md`; custom hex values are not allowed
- Theme rhythm (which of light / dark / hero light / hero dark each page uses) has hard rules in the "Theme rhythm planning" section below; must read before generating
- Decide both before picking layouts to avoid rework

### E. Motion system (on by default · Motion One driven)

**Core mechanism**: the module script at the bottom of template.html triggers entrance animations on page flips. All elements with `data-anim` start invisible and fade in one by one via Motion One when the page becomes current.

**Motion strategy**: add `data-animate="<recipe>"` on `<section>` to choose the animation style; add `data-anim` (optionally with a value like `left` / `right` / `line` / `step`) on every element needing an entrance animation.

| recipe | Usage | Fits layouts |
|---|---|---|
| Default (cascade) | Add nothing; auto cascading fade-in | Most body pages (Layouts 3 / 4 / 5 / 10) |
| `hero` | Auto-enabled on `.hero` pages; slower, more ceremonial | Layouts 1 / 2 / 7 (all hero pages) |
| `quote` | Line-by-line reveal, slow (550ms stagger) | Layout 8 big quote |
| `directional` | Left in → divider → right in; for comparisons | Layout 9 Before/After |
| `pipeline` | Manual advance; press →/space to light steps one by one | Layout 6 pipeline |

**Degradation fallback**: if both the local motion.min.js and the CDN fail to load, the script force-sets all `data-anim` elements to `opacity:1`; content always stays readable.

**Pages that don't need motion**: to skip motion entirely on a page, just add no `data-anim` — Motion One only affects marked elements.

---

## 0. Base structure (identical for all slides)

```html
<section class="slide [light|dark|hero light|hero dark]">
  <div class="chrome">
    <div>上下文标签 · 子标签</div>
    <div>ACT · 页号 / 总页数</div>
  </div>
  <!-- 主内容 -->
  <div class="foot">
    <div>页码说明 · Page Description</div>
    <div>— · —</div>
  </div>
</section>
```

- Non-hero pages should add a `light` or `dark` theme; hero pages add `hero light` or `hero dark` (participates in WebGL theme interpolation)
- `chrome` and `foot` are optional but recommended corner metadata (the four corners)
- **Hero pages are for section covers / openings / closings / transitions**; non-hero pages carry the body

### ⚠️ chrome and kicker must not say the same sentence

This is the most common content-duplication problem. The two live on completely different semantic dimensions:

| Position | Role | Content nature | Example |
|------|------|---------|------|
| `.chrome` top-left | **Magazine running head / navigation metadata** | A stable "column name" or "section category"; may repeat across pages | "Act II · Workflow" / "Data · Result" / "lukew.com · 2026.04" |
| `.chrome` top-right | **Page number + act number** | Fixed format | "Act II · 15 / 25" |
| `.kicker` | **This page's unique hook** | A "small prefix" above the display heading, like a line above a magazine headline; different every page | "BUT" / "一个人,做了什么。" (user-facing example) / "Phase 01 · 设计阶段" (user-facing example) |

**Counter-example** (already burned us): chrome says "设计先行 · Design First" while kicker says "Phase 01 · 设计阶段" — duplicated meaning; readers immediately smell AI generation.

**Correct approach**: chrome is a **column tag** (stable, reusable across pages); kicker is a **per-page hook** (short, dramatic). They complement each other and never translate each other.

### ⚠️ Theme rhythm planning (must read · must do before generating)

**Core mechanism**: every page's `<section>` must carry one of `light` / `dark` / `hero light` / `hero dark`. JS infers the theme from the class and decides whether body gets `light-bg`, which switches which of the dark/light WebGL canvases is on top. A missing theme or custom names = fallback errors.

#### Default theme per layout

| Layout | Default theme | Why |
|---|---|---|
| 1. Opening cover | `hero dark` | Opening ceremony; strong impact on a dark base |
| 2. Act divider | `hero dark` and `hero light` **must alternate** | Breathing rhythm |
| 3. Big numbers (data) | `light` | Numbers need a paper-white base; occasionally insert `dark` across acts |
| 4. Quote + image | **alternate `light` / `dark`** | The body rhythm workhorse |
| 5. Image grid | `light` | Screenshots need a bright base |
| 6. Pipeline | `light` | Flow diagrams need clarity |
| 7. Question page | `hero dark` | Strong visual impact by default |
| 8. Big quote | **`dark` first**, occasionally `light` | Punchlines need a dark stage |
| 9. Comparison page | `light` | Two columns need clarity |
| 10. Lead image + text | **alternate `light` / `dark`** | Rhythm |

#### Rhythm hard rules (grep self-check after generating)

- ❌ **Forbidden**: 3+ consecutive pages of the same theme (including light stacking and dark stacking)
- ❌ **Forbidden**: a deck of 8+ pages without at least 1 `hero dark` + 1 `hero light`
- ❌ **Forbidden**: a deck with only `light` body pages and no `dark` body page — it looks flat, with no breathing
- ✅ **Recommended**: insert 1 hero page (cover / act divider / question / big quote) every 3-4 pages

#### 8-page rhythm template (directly reusable)

| Page | Theme | Layout | Note |
|---|---|---|---|
| 1 | `hero dark` | Cover | Opening |
| 2 | `light` | Big numbers | Data thrown out |
| 3 | `dark` | Quote + image | Contrast / story |
| 4 | `light` | Pipeline | Process |
| 5 | `hero light` | Act divider | Breathing |
| 6 | `dark` | Quote+image or big quote | |
| 7 | `hero dark` | Question page | Suspense close |
| 8 | `light` | Big quote / ending | Close |

**Draw this table and align first, then write slides**. Skipping planning and pasting skeletons = all light.

---

## Layout 1: Opening cover (Hero Cover)

```html
<section class="slide hero dark">
  <div class="chrome">
    <div>A Talk · 2026.04.22</div>
    <div>Vol.01</div>
  </div>
  <div class="frame" style="display:grid; gap:4vh; align-content:center; min-height:80vh">
    <div class="kicker" data-anim>私享会 · 李继刚</div>
    <h1 class="h-hero" data-anim>一人公司</h1>
    <h2 class="h-sub" data-anim>被 AI 折叠的组织</h2>
    <p class="lead" style="max-width:60vw" data-anim>
      一个 AI 创作者 —— 在 64 天里做了 11 万行代码、在 9 个平台上持续输出，生活节奏几乎没有被改变。
    </p>
    <div class="meta-row" data-anim>
      <span>歸藏 Guizang</span><span>·</span><span>独立创作者 / CodePilot 作者</span>
    </div>
  </div>
  <div class="foot">
    <div>一场关于 AI · 组织 · 个体的分享</div>
    <div>— 2026 —</div>
  </div>
</section>
```

**Key points**:
- Use `hero dark` to let the WebGL background surface across most of the page
- `h-hero` is the largest size (10vw); here it serves as the title hero visual
- Use `min-height:80vh + align-content:center` to vertically center the content
- No need for a page number in `.chrome`; the cover is self-contained

---

## Layout 2: Act divider (Act Divider)

```html
<section class="slide hero light">
  <div class="chrome">
    <div>第一幕 · 硬数据</div>
    <div>Act I · 01 / 25</div>
  </div>
  <div class="frame" style="display:grid; gap:6vh; align-content:center; min-height:80vh">
    <div class="kicker" data-anim>Act I</div>
    <h1 class="h-hero" style="font-size:8.5vw" data-anim>硬数据</h1>
    <p class="lead" style="max-width:55vw" data-anim>
      先看数字，再谈方法。
    </p>
  </div>
  <div class="foot">
    <div>第一幕引子</div>
    <div>— · —</div>
  </div>
</section>
```

**Key points**:
- Extremely minimal; only kicker + display heading + one lead line
- Two acts' covers can alternate `hero light` / `hero dark` to create rhythm
- `h-hero` size can be tuned from 10vw down to 8.5vw to fit length

---

## Layout 3: Big-numbers grid (Big Numbers Grid)

```html
<section class="slide light">
  <div class="chrome">
    <div>过去 64 天 · 开发篇</div>
    <div>Act I / Dev · 02 / 25</div>
  </div>
  <div class="frame" style="padding-top:6vh">
    <div class="kicker" data-anim>一个人，做了什么。</div>
    <h2 class="h-xl" data-anim>过去 64 天</h2>
    <p class="lead" style="margin-bottom:5vh" data-anim>从 0 到开源 CodePilot。</p>

    <div class="grid-6" style="margin-top:6vh">
      <div class="stat-card" data-anim>
        <div class="stat-label">Duration</div>
        <div class="stat-nb">64 <span class="stat-unit">天</span></div>
        <div class="stat-note">从 0 到现在</div>
      </div>
      <div class="stat-card" data-anim>
        <div class="stat-label">Lines of Code</div>
        <div class="stat-nb">110K+</div>
        <div class="stat-note">一行行写到 11 万+</div>
      </div>
      <div class="stat-card" data-anim>
        <div class="stat-label">GitHub Stars</div>
        <div class="stat-nb">5,166</div>
        <div class="stat-note">一个开源仓库</div>
      </div>
      <div class="stat-card" data-anim>
        <div class="stat-label">Downloads</div>
        <div class="stat-nb">41K+</div>
        <div class="stat-note">装到了几万台电脑里</div>
      </div>
      <div class="stat-card" data-anim>
        <div class="stat-label">AI Providers</div>
        <div class="stat-nb">19</div>
        <div class="stat-note">跨平台接入</div>
      </div>
      <div class="stat-card" data-anim>
        <div class="stat-label">Commits</div>
        <div class="stat-nb">608+</div>
        <div class="stat-note">没有协作者</div>
      </div>
    </div>
  </div>
  <div class="foot">
    <div>项目 · CodePilot　|　github.com/codepilot</div>
    <div>Act I · Dev Numbers</div>
  </div>
</section>
```

**Key points**:
- A 3×2 or 4×2 grid is the most stable (see `.grid-6`)
- Each `stat-card` has a fixed structure: label (small English text) → nb (big number) → note (annotation)
- Numbers should be 2-3 characters (longer overflows); use K / M abbreviations
- Leave a 5vh+ top buffer so the heading area grabs attention first

---

## Layout 4: Quote + Image (Quote + Image)

```html
<section class="slide light">
  <div class="chrome">
    <div>身份反差 · The Twist</div>
    <div>03 / 25</div>
  </div>
  <div class="frame grid-2-7-5" style="padding-top:6vh">
    <!-- 左列：标题 + 正文 + callout，flex column 让 callout 贴列底 -->
    <div style="display:flex; flex-direction:column; justify-content:space-between; gap:3vh">
      <div>
        <div class="kicker" data-anim>BUT</div>
        <h2 class="h-xl" style="white-space:nowrap; font-size:7.2vw" data-anim>
          我不是程序员。
        </h2>
        <p class="lead" style="margin-top:3vh" data-anim>
          大学毕业之后再也没写过一行代码。过去十年做的是 UI 设计和 AI 特效。
        </p>
      </div>
      <div class="callout" data-anim>
        "这东西在三年前，<br>
        需要一个十人团队做一年。"
        <div class="callout-src">— 一个观察者的判断</div>
      </div>
    </div>
    <!-- 右列：图片用标准 16/10 比例 + max-height，不要 align-self:end -->
    <figure class="frame-img r-16x10" data-anim>
      <img src="images/codepilot.png" alt="CodePilot 产品截图">
      <figcaption class="img-cap">CodePilot · 产品截图</figcaption>
    </figure>
  </div>
  <div class="foot">
    <div>Page 03 · 我不是程序员</div>
    <div>— · —</div>
  </div>
</section>
```

**Key points**:
- Use `grid-2-7-5` (left 7 parts, right 5 parts); `align-items:start` is preconfigured in the template
- **Left column** uses flex column + `justify-content:space-between`: heading hugs the top, callout naturally hugs the bottom
- **Right column image**: **do not add `align-self:end`**. It makes the image slide to the cell bottom and get covered by browser toolbars on low-res screens
- Images must use the **standard ratio classes `.r-16x10` or `.r-4x3`**, never the original's odd ratios (like `2592/1798`)

---

## Layout 5: Image grid (multi-image comparison)

```html
<section class="slide light">
  <div class="chrome">
    <div>平台粉丝实证</div>
    <div>Act I / Ops · 05 / 27</div>
  </div>
  <div class="frame" style="padding-top:5vh">
    <div class="kicker" data-anim>Proof · 粉丝实证</div>
    <h2 class="h-xl" data-anim>10 个平台 · 6 张截图</h2>

    <div class="grid-3-3" style="margin-top:4vh">
      <figure class="frame-img" style="height:26vh" data-anim>
        <img src="images/weibo.png" alt="微博 289K">
        <figcaption class="img-cap">微博 · 289K</figcaption>
      </figure>
      <figure class="frame-img" style="height:26vh" data-anim>
        <img src="images/twitter.png" alt="推特 137K">
        <figcaption class="img-cap">推特 · 137K</figcaption>
      </figure>
      <figure class="frame-img" style="height:26vh" data-anim>
        <img src="images/wechat.png" alt="公众号 96K">
        <figcaption class="img-cap">公众号 · 96K</figcaption>
      </figure>
      <figure class="frame-img" style="height:26vh" data-anim>
        <img src="images/jike.png" alt="即刻 26K">
        <figcaption class="img-cap">即刻 · 26K</figcaption>
      </figure>
      <figure class="frame-img" style="height:26vh" data-anim>
        <img src="images/xhs.png" alt="小红书 19K">
        <figcaption class="img-cap">小红书 · 19K</figcaption>
      </figure>
      <figure class="frame-img" style="height:26vh" data-anim>
        <img src="images/douyin.png" alt="抖音 10K">
        <figcaption class="img-cap">抖音 · 10K</figcaption>
      </figure>
    </div>
  </div>
  <div class="foot">
    <div>截图时间 · 2026.04</div>
    <div>Page 05 · 粉丝实证</div>
  </div>
</section>
```

**Key points**:
- Key: every `frame-img` must have a hard-coded `height:NNvh` (never `aspect-ratio`), otherwise the grid overflows
- Images automatically get `object-fit:cover + object-position:top`, cropping only the bottom
- Carry them with `.grid-3-3` (3×2) or `.grid-3` (3×1)

---

## Layout 6: Two-column pipeline (Pipeline)

```html
<section class="slide light" data-animate="pipeline">
  <div class="chrome">
    <div>我的工作流 · Workflow</div>
    <div>Act II · 15 / 27</div>
  </div>
  <div class="frame">
    <div class="kicker">Pipeline · 流水线</div>
    <h2 class="h-xl">两条流水线</h2>

    <!-- 第一组：文本侧 -->
    <div class="pipeline-section">
      <div class="pipeline-label">文本侧 · Text Pipeline</div>
      <div class="pipeline">
        <div class="step" data-anim="step">
          <div class="step-nb">01</div>
          <div class="step-title">Draft</div>
          <div class="step-desc">AI 帮我起草初稿</div>
        </div>
        <div class="step" data-anim="step">
          <div class="step-nb">02</div>
          <div class="step-title">Polish</div>
          <div class="step-desc">AI 润色去 AI 味</div>
        </div>
        <div class="step" data-anim="step">
          <div class="step-nb">03</div>
          <div class="step-title">Morph</div>
          <div class="step-desc">AI 变形成推特 / 小红书</div>
        </div>
        <div class="step" data-anim="step">
          <div class="step-nb">04</div>
          <div class="step-title">Illustrate</div>
          <div class="step-desc">AI 生成信息图</div>
        </div>
        <div class="step" data-anim="step">
          <div class="step-nb">05</div>
          <div class="step-title">Distribute</div>
          <div class="step-desc">一键分发 9 平台</div>
        </div>
      </div>
    </div>

    <!-- 第二组：视频侧 -->
    <div class="pipeline-section">
      <div class="pipeline-label">视觉 · 视频侧 · Video Pipeline</div>
      <div class="pipeline">
        <div class="step" data-anim="step">
          <div class="step-nb">06</div>
          <div class="step-title">Cut</div>
          <div class="step-desc">AI 帮我剪辑</div>
        </div>
        <div class="step" data-anim="step">
          <div class="step-nb">07</div>
          <div class="step-title">Wrap</div>
          <div class="step-desc">AI 帮我包装</div>
        </div>
        <div class="step" data-anim="step">
          <div class="step-nb">08</div>
          <div class="step-title">Cover</div>
          <div class="step-desc">AI 生成封面</div>
        </div>
      </div>
    </div>
  </div>
  <div class="foot">
    <div>Page 15 · 我的内容工厂</div>
    <div>Workflow</div>
  </div>
</section>
```

**Key points**:
- Use `.pipeline-section` for grouping + `.pipeline-label` as the group title
- The two groups are separated by a 3.6vh gap + a top thin divider (preconfigured in CSS)
- Each step is a fixed nb → title → desc structure
- Step count is unlimited but ≤5 per row is best; otherwise switch to a second pipeline
- **Motion**: add `data-animate="pipeline"` on `<section>` and `data-anim="step"` on each `.step`. When this page is reached, steps start at `opacity:.15`; pressing →/space/wheel-down lights up one step at a time; **the page only flips after all steps are lit**, creating presentation interactivity

---

## Layout 7: Suspense closing / question page (Hero Question)

```html
<section class="slide hero dark">
  <div class="chrome">
    <div>留给你的问题</div>
    <div>24 / 27</div>
  </div>
  <div class="frame" style="display:grid; gap:8vh; align-content:center; min-height:80vh">
    <div class="kicker" data-anim>The Question</div>
    <h1 class="h-hero" style="font-size:7vw; line-height:1.15">
      <span data-anim style="display:block">你的公司里，</span>
      <span data-anim style="display:block">哪些岗位本来就</span>
      <span data-anim style="display:block">不该由人来做？</span>
    </h1>
    <p class="lead" style="max-width:50vw" data-anim>
      这个问题，不是技术问题，是架构问题。
    </p>
  </div>
  <div class="foot">
    <div>Page 24 · The Question</div>
    <div>— · —</div>
  </div>
</section>
```

**Key points**:
- The more whitespace on a hero page the better; place only one question
- Tune `h-hero` size to length (7vw fits 3 lines, 10vw fits 1 line)
- Break lines manually with `<br>`, ensuring breaks land at semantic points
- The tail can add one more `lead` line as the reveal

---

## Layout 8: Big quote page (Big Quote · serif punchline)

```html
<section class="slide light" data-animate="quote">
  <div class="chrome">
    <div>The Takeaway · 核心金句</div>
    <div>18 / 25</div>
  </div>
  <div class="frame" style="display:grid; gap:5vh; align-content:center; min-height:80vh">
    <div class="kicker" data-anim>Quote · 金句</div>
    <blockquote style="font-family:var(--serif-zh); font-weight:700; font-size:5.8vw; line-height:1.2; letter-spacing:-.01em; max-width:72vw">
      <span data-anim="line" style="display:block">"没有交接,</span>
      <span data-anim="line" style="display:block">所有人都在构建。"</span>
    </blockquote>
    <p class="lead" style="max-width:55vw; opacity:.65" data-anim>
      Without the handoff, everyone builds.<br>
      And that makes all the difference.
    </p>
    <div class="meta-row" data-anim>
      <span>— Luke Wroblewski</span><span>·</span><span>2026.04.16</span>
    </div>
  </div>
  <div class="foot">
    <div>Page 18 · 金句</div>
    <div>— · —</div>
  </div>
</section>
```

**Key points**:
- The whole page is whitespace, holding only one big quote + source
- `<blockquote>` is enlarged individually with inline style (5-6vw), not with `h-hero` (that name is reserved for the page's main title)
- The English original follows below (lead · opacity:.65) to create hierarchy
- Pair with `meta-row` for source · date

---

## Layout 9: Side-by-side comparison (A vs B · old vs new)

```html
<section class="slide light" data-animate="directional">
  <div class="chrome">
    <div>旧 vs 新 · The Shift</div>
    <div>12 / 25</div>
  </div>
  <div class="frame" style="padding-top:5vh">
    <div class="kicker" data-anim>Before / After · 范式转变</div>
    <h2 class="h-xl" style="margin-bottom:4vh" data-anim>从交接到共建</h2>

    <div class="grid-2-6-6" style="gap:5vw 4vh">
      <!-- 左列：旧 -->
      <div data-anim="left" style="padding:3vh 2vw; border-left:3px solid currentColor; opacity:.55">
        <div class="kicker" style="opacity:.9">Before · 旧模式</div>
        <h3 class="h-md" style="margin-top:2vh">设计 → 开发 → 交接</h3>
        <ul style="margin-top:3vh; padding-left:1.2em; display:flex; flex-direction:column; gap:1.4vh; font-family:var(--sans-zh); font-size:max(14px,1.1vw); line-height:1.55">
          <li>设计师在 Figma 做稿</li>
          <li>开发者盯着文件翻译像素</li>
          <li>反复 PR 沟通对齐</li>
          <li>非技术人员无法触碰代码</li>
        </ul>
      </div>
      <!-- 右列:新 -->
      <div data-anim="right" style="padding:3vh 2vw; border-left:3px solid currentColor">
        <div class="kicker" style="opacity:.9">After · 新模式</div>
        <h3 class="h-md" style="margin-top:2vh">同工具 · 并行 · 共建</h3>
        <ul style="margin-top:3vh; padding-left:1.2em; display:flex; flex-direction:column; gap:1.4vh; font-family:var(--sans-zh); font-size:max(14px,1.1vw); line-height:1.55">
          <li>三个角色同时在 Intent 工作</li>
          <li>agents.md 作为共享上下文</li>
          <li>代理处理对齐 / 冲突 / 动画</li>
          <li>任何人都能安全贡献代码</li>
        </ul>
      </div>
    </div>
  </div>
  <div class="foot">
    <div>Page 12 · 范式转变</div>
    <div>Before / After</div>
  </div>
</section>
```

**Key points**:
- Use `.grid-2-6-6` (1:1) to split left/right
- Left column `opacity:.55` visually weakens the "old"; the right column at full brightness highlights the "new"
- Both columns use `border-left:3px solid` + `padding-left` for a quote-block feel
- Each column shares the same structure: `kicker` → `h-md` → `<ul>` bullets, keeping rhythm consistent

---

## Layout 10: Lead image + side text (Lead Image + Side Text)

```html
<section class="slide light">
  <div class="chrome">
    <div>Design First · 设计先行</div>
    <div>08 / 16</div>
  </div>
  <div class="frame grid-2-8-4" style="padding-top:6vh">
    <!-- 左列:大段正文 + 引用 -->
    <div>
      <div class="kicker" data-anim>Phase 01 · 设计阶段</div>
      <h2 class="h-xl" style="margin-top:1vh; margin-bottom:3vh" data-anim>设计先行 · 2 周</h2>

      <p class="lead" style="margin-bottom:3vh" data-anim>
        在 Figma 中完成视觉探索与设计系统,网格 / 排版 / 颜色变量 / 可复用组件,桌面和移动端稿件几轮反馈迭代。
      </p>

      <p data-anim style="font-family:var(--sans-zh); font-size:max(14px,1.15vw); line-height:1.75; opacity:.78; margin-bottom:2.4vh">
        两周之内,视觉风格、粗略结构、方向性内容全部稳定。这是扎实的传统设计流程——在这里还没什么新鲜事。
      </p>

      <div class="callout" style="margin-top:3vh" data-anim>
        "This phase was pretty standard.<br>Just a solid Web design process."
        <div class="callout-src">— Luke Wroblewski</div>
      </div>
    </div>
    <!-- 右列:辅助图 · 竖版或方形 -->
    <figure class="frame-img r-3x4" data-anim>
      <img src="images/figma.png" alt="Figma design system">
      <figcaption class="img-cap">Figma · Design System</figcaption>
    </figure>
  </div>
  <div class="foot">
    <div>Page 08 · Design First</div>
    <div>约 2 周</div>
  </div>
</section>
```

**Key points**:
- `.grid-2-8-4` (8:4) lets the body dominate with the image as support
- The left column carries multiple info levels: kicker → display heading → lead → body paragraph → callout (quote)
- The right image uses **portrait 3:4** or square 1:1, avoiding competing with the left text for attention
- This layout suits **pages with larger information volume** (unlike Layout 4, which holds only one punchline)

---

## Appendix: common grid templates

| Class | Ratio | Use |
|---|---|---|
| `.grid-2-6-6` | 6:6 (1:1) | Half and half |
| `.grid-2-7-5` | 7:5 | Text-dominant + support image |
| `.grid-2-8-4` | 8:4 (2:1) | Long text + small image/data |
| `.grid-3` | 1:1:1 | 3 items side by side (cases/screenshots) |
| `.grid-3-3` | 3×2 | 6-image matrix |
| `.grid-6` | 3×2 | 6 data cards |

All grids reserve `gap: 3vw 4vh` (3vw horizontal, 4vh vertical); can be overridden individually.

---

## Page rhythm advice

For a 25-30 page talk, the recommended rhythm:

1. **Hero Cover** (page 1)
2. **Act Divider** (act 1 opening, hero light or hero dark)
3. **Big Numbers** (hard data for impact)
4. **Quote + Image** (identity contrast / hook)
5. **Image Grid** (evidence support)
6. **Hero Question** (act close, suspense)
7. ... acts 2 and 3 repeat the same rhythm ...
8. **Hero Close** (final page, question or thanks)

Hero and non-hero pages should interleave at roughly a **2-3 : 1 ratio**; never more than 3 consecutive non-hero pages, nor more than 2 consecutive hero pages.
