# Quality Checklist

This checklist comes from the real iteration process of the "一人公司" (One-Person Company) talk deck. Every item was learned by stepping into a pit, ordered by importance.

Read it through before generating the PPT; after generating, self-check item by item.

---

## 🔴 P0 · Mistakes you must never make

### 0-S. Swiss locked mode: body pages must come from the original 22P

**Symptom**: colors and fonts look Swiss, but headings drift to center, images aren't on the grid, and the page structure is nothing like the original 22P.

**Root cause**: during generation Swiss was treated as a style pack; new P23/P24 pages and freehand SVG pages were freely combined instead of choosing from the 22 registered layouts of the original reference PPT.

**Fix**:
- First read `references/swiss-layout-lock.md`
- Body pages may only use `S01-S22`; new cover/closing pages may only use `SWISS-COVER-ASCII` / `SWISS-CLOSING-ASCII`
- Every `<section class="slide">` must carry `data-layout="Sxx"`
- After generation you must run:

```bash
node <SKILL_ROOT>/scripts/validate-swiss-deck.mjs path/to/index.html
```

**The validator will block**:
- Unregistered layouts / missing `data-layout`
- P23/P24 experimental structures
- Visible text inside SVG
- S22 images not bound to `s22-hero-21x9`
- S22 photos using `object-position:top center`

### 0-S-2. Swiss top headings default to top-left, not centered

**Symptom**: the top Chinese heading sits mid-page like a self-made poster, no longer like the original PPT.

**Fix**:
- Except for statement/split layouts like `S03/S09/S10`, top headings must stick to the original template's top-left content axis.
- Do not put the small heading in the left column and the big heading in the right large column; that visually centers the heading.
- If you need a heading + caption two-column arrangement, copy the original `S11` or `S17` skeleton; do not hand-write `4fr 8fr`.

### 0-S-3. Swiss map pages must use the S08 Map Component

**Symptom**: place/history content drew only a crude SVG map, with no real pins, relation cards, zoom/drag controls, or the wheel triggered deck page flips.

**Fix**:
- Use `data-layout="S08"`.
- First read `references/swiss-map-component.md`.
- The right-side map component must include marker pins, connection lines, place cards, and `+` / `-` / `DRAG` controls.
- Scroll zoom and drag pan are disabled by default; dragging is allowed only after the user clicks `DRAG`.
- A static fallback must remain; when the map CDN or tiles fail, content stays readable.

**Checks**:
- `grep -n "data-map-ctrl" index.html`
- `grep -n "maplibregl.Map" index.html`
- Verify in the browser that `+` zooms in and `DRAG` toggles to `DRAG ON`

### 0-A. Swiss canvas alignment law (check on every page · most frequently tripped)

**Symptom**: the header chrome-min and the bottom footer both sit on the 5vw edge line, but the middle content is inset by an extra chunk; left and right don't line up.

**Root cause**: `.canvas-card` already carries `padding:5.6vh 5vw 4.4vh`. If the body layer also declares `padding:5vh 5vw 4vh`, the horizontal padding becomes `5vw + 5vw = 10vw`, and the body is inset 5vw more than chrome-min.

**Fix**:
- The body layer gets `padding:0`; use grid `gap` only for vertical spacing
- Spacing between chrome-min and the body comes from `.chrome-min{margin-bottom:48px}`; **do not** stack `margin-top` / `padding-top` on the body top
- Split mode exception: `.slide.split .canvas-card{padding:0}`; the two `.half` elements set their own `padding:5.6vh 3.6vw 4.4vh`

```html
<!-- ❌ Wrong: the body is inset an extra 5vw; left/right don't line up -->
<div class="canvas-card">
  <div class="chrome-min">...</div>
  <div style="flex:1;padding:5vh 5vw 4vh;...">主体</div>
</div>
<!-- ✅ Correct -->
<div class="canvas-card">
  <div class="chrome-min">...</div>
  <div style="flex:1;padding:0;display:grid;grid-template-rows:auto 1fr auto;gap:3vh">主体</div>
</div>
```

**Self-check command**: `grep "padding:.*5vw" index.html` — if it matches `padding:Xvh 5vw Yvh` on a direct child of canvas-card, it is wrong (except `.half` / decoration layers).

### 0-B. Swiss head area: the kicker must sit "above" the display heading (never side by side)

**Symptom**: the small heading (`.t-meta` / `.t-cat`) and the display heading are squeezed onto one line — a blob of small text left, big text right; the header loses hierarchy.

**Root cause**: `grid-template-columns:auto 1fr` presses two elements that should stack vertically into left/right columns.

**Fix**:
```html
<!-- ❌ Wrong -->
<div data-anim="head" style="display:grid;grid-template-columns:auto 1fr;gap:3vw;align-items:end">
  <div class="t-meta">METHODOLOGY · 03</div>
  <h2 class="h-xl-zh">为什么是 N+1</h2>
</div>
<!-- ✅ Correct -->
<div data-anim="head" style="display:flex;flex-direction:column;gap:1.4vh">
  <div class="t-meta">METHODOLOGY · 03</div>
  <h2 class="h-xl-zh">为什么是 N+1</h2>
</div>
```

Exception: if the head row simultaneously carries "left: kicker + display heading (stacked within itself)" and "right: small footnote", the outer wrapper may use `display:grid;grid-template-columns:1fr auto`, but the **inner** layers must remain flex column.

### 0-B-2. Swiss cover / closing defaults: full-bleed IKB + ASCII breathing field + white weight 200 (mandatory)

**Symptom**: the cover uses `slide light` white base + black text + a giant "01" — while the chrome corner already shows `01 / 07`, producing two "01"s on screen, visually redundant; the white base is too plain, completely lacking the ceremonial "opening hello".

**Root cause**: layouts-swiss.md's old default recommended a left ink + right paper spread; in practice this easily degrades into "white base + big black type + big number", losing IKB's signature opening impact.

**Rules (mandatory for Swiss)**:
- **The cover must be `<section class="slide accent">`** (full-bleed IKB), not `slide.light`, and not `slide.dark`; as the **first child** inside `.canvas-card` insert `<canvas class="ascii-bg">` (an ASCII character breathing field; the template's built-in IIFE activates it automatically)
- **Do not add a big number like "01" again**: `.chrome-min` already shows `01 / N`; another giant "01" on the cover = tautology — delete it
- **Emphasized words must be italic**: `font-style:italic;font-weight:300`; **forbidden** to use `color:var(--accent)` — IKB blue pressed onto IKB blue is invisible to the human eye
- **The closing must be `slide.split`** double half-screen: left half `.half.b-accent` + ASCII canvas (color loop with the cover), right half white paper base with 3 takeaways; **the 03rd item** is colored with `var(--accent)`, completing the "opening full IKB ↔ closing half IKB" color loop
- The ASCII canvas is preconfigured in the template's `<style>` with `mix-blend-mode:screen;opacity:.92`; do not touch those values
- Cover/closing display-heading sizes are dual-constrained: `min(11.6vw,19vh)` ~ `min(8vw,14vh)` (obey the Y ≥ X × 1.6 rule)

**Self-check commands**:
- `grep -c "ascii-bg" index.html` — cover + closing should match ≥ 2 (one canvas each)
- `grep -E '"slide accent"' index.html | head -1` — the cover should be `slide accent`, not `slide light`
- `grep "color:var(--accent)" index.html` — if a matched line also contains `font-style:italic` that's a danger signal (blue on blue); change to italic-only without accent; only the closing's "03 takeaway" line may legitimately use `var(--accent)` (its background there is white)
- Visual: open the page and check the cover for a big number like "01" — if present, delete it

### 0-C. Swiss display-type dual constraint: in `min(Xvw, Yvh)`, Y ≥ X × 1.6

**Symptom**: on standard 16:9 screens (MacBook 13/14/16, common monitors), heading sizes render a notch smaller than expected and the whole page feels empty or shrunken.

**Root cause**: 1vw : 1vh ≈ 1.78; if you write `min(7vw, 10vh)`, on a 16:9 screen 7vw = 12.46vh, which gets clamped by the 10vh ceiling to 10vh — a 20% shrink.

**Fix**: quick reference values
| Use | Recommended |
|---|---|
| h-hero giant manifesto | `min(11.6vw, 19vh)` |
| h-xl section heading | `min(7vw, 12vh)` ~ `min(7.4vw, 13vh)` |
| Big number KPI | `min(8.4vw, 14vh)` |
| Mid number / numbering | `min(4.6vw, 8.5vh)` ~ `min(5.6vw, 10vh)` |
| Subtitle | `min(7.6vw, 13vh)` |

**Self-check command**: `grep -E "font-size:min\([0-9.]+vw,\s*[0-9.]+vh\)" index.html`; eyeball every matched X/Y; any Y/X < 1.6 must be enlarged.

### 0-D. Swiss image mixing: square corners, equal heights, evidence only

**Symptom**: images look like ordinary PPT illustrations — rounded, shadowed, chaotic ratios; multiple screenshots with mismatched heights, or GPT-M 2.0 generated images carrying their own titles/footers that duplicate the page chrome.

**Root cause**: in Swiss style, images are not decoration but evidence blocks in the grid. Without first choosing the original layout and image slot, arbitrary images get force-stuffed into the page.

**Fix**:
- Choose the layout first: single large image + KPI → `S22`; multiple images → adapt the original `S15/S16` grid skeletons
- S22 generated image ratio is fixed `21:9`, and the `<img>` carries `data-image-slot="s22-hero-21x9"`
- Photos default to `object-position:center 35%` or `center center`; never `top center` (cuts off faces)
- Image containers use `.frame-img` only; **never** `border-radius` / `box-shadow`
- UI / infographic / flowchart images that are user-original screenshots or text-dense images use `.fit-contain`; if regenerated for a slot, they must fill the container with the matching ratio class such as `.frame-img.r-21x9`, never shrunk by a fixed short height
- Multiple images in one group must share slots, ratio and height; do not mix
- GPT-M 2.0 prompts must state: Swiss Style, single accent, square corners, no gradient/shadow/rounded corners, no header/footer/title/corner marks

**Self-check commands**:
- `grep -E "frame-img.*border-radius|box-shadow" index.html` — delete on match
- `grep -n "data-image-slot" index.html` — every local image should have a slot declaration
- Visual: if an image already contains big titles, page numbers, footers or corner marks, prefer regeneration; do not crop it inside the page as a rescue

### 0-D-2. Swiss bottom pagination safe area: keep the lowest content off the nav

**Symptom**: image captions, footnotes, labels below timelines, or bottom KPIs are blocked by the pagination squares, or visually too close.

**Root cause**: `#nav` is fixed at `bottom:2vh`; if body content uses `align-self:end` / `align-items:end` / `margin-top:auto` to hug the bottom, its lowest edge enters the pagination area.

**Fix**:
- Keep at least `3vh` of breathing space between the lowest edge of main content and the pagination component
- When P23 needs bottom alignment use `.swiss-img-split.align-image-bottom`; the template has built-in `--nav-safe-bottom:8vh`
- Other pages needing bottom-hugging get `.nav-safe-bottom` or `.nav-safe-bottom-tight` on the body container
- Never hand-write `bottom:2vh` / `bottom:0` for captions; that competes with the nav for space

**Checks**:
- Visual: flip to the page and confirm the last caption/label line sits clearly above the pagination component
- Code: `grep -E "align-items:end|align-self:end|bottom:0|bottom:2vh|margin-top:auto" index.html`; for each match confirm a nav safe zone exists

---

### 0-E. Swiss template fidelity guard: the original PPT is the golden source

**Symptom**: generated pages look Swiss but diverge from the original reference PPT's actual weights, spacing, timelines and card density; the more you iterate, the further you drift.

**Root cause**: new image layouts or experimental structures were written as global style changes, or the original base classes were unintentionally modified — e.g. `.h-hero` / `.h-xl` weights, `.tl-node` column width, `.duo-compare` spacing.

**Fix**:
- The original reference file `/Users/guohao/Documents/op7418的仓库/项目/Thin-Harness-Fat-Skills/ppt/index.html` is the Swiss theme's golden source, but defer to **actual page usage**, not unused CSS helpers
- The original pages' display headings largely use `font-weight:200` with emphasis words/numbers at `300`; `.h-hero` / `.h-xl` / `.h-hero-zh` / `.h-xl-zh` must keep light weights in this template — do not restore them to 800/900
- Except for the newly added cover/closing ASCII mechanism, the S22 image slot fix, the horizontal timeline label centering fix, and correcting the heading helpers to their actual light weights, do not modify the original base CSS/JS recipes
- New image capability must bind to the original S22/S15/S16 slots; do not invent new body structures
- To modify `assets/template-swiss.html`, first diff against the original reference; acceptable differences are only the ASCII classes, S22 image positioning classes, light-weight heading helpers, and known motion fixes

**Self-check commands**:
- Run `compare-swiss-base.mjs` in the current test directory and confirm the output shows `missing in template: 0`
- Visually compare like-for-like pages of the original PPT: display weight, chrome-min position, timeline dot/label, card density must match

### 0-F. Visual + code double verification: don't just read the HTML

**Symptom**: code looks right, but the real page is crowded, image-text relationships are wrong, optional components are piled up, or the layout doesn't fit the content.

**Fix**:
- Open the original reference PPT, the current template or generated page, and the test PPT side by side; judge visually first
- Wait for entrance animations to settle before screenshotting or judging; don't mistake animation mid-states for missing content
- Open the web page and inspect page by page: heading weight, header spacing, body density, image alignment, nav safe area
- Then return to code and check structure: did the page use the correct layout, are required components present, are optional components overused
- When comparing to the original PPT, judge by the actual visuals; raw CSS helpers assist but never replace visual judgment
- Diagnose the problem source: wrong layout choice / missing required component / optional-component abuse / spacing and safe-area issues
- General layouts (S03/S08/S11/S19) can be used freely; data-specific ones (S06/S07/S20/S21/S22) need real data or cases; structure-specific ones (S14/S15/S17) need loops, matrices or hierarchy

---

### 0. Class-name validation that must pass before generation (most important)

**Symptom**: pasting the layouts.md skeletons straight into new HTML loses all styling — display headings render sans, big-number pages render body-sized, pipelines collapse into one line across pages, images pile at the browser bottom.

**Root cause**: if the current template's `<style>` lacks these class definitions, the browser falls back to default styles.

**Fix**:
- **Before generating the PPT, you must first `Read` the template matching the current style**: Style A reads `assets/template.html`, Style B reads `assets/template-swiss.html`, confirming all classes used in layouts are defined
- Most commonly missed classes: `h-hero / h-xl / h-sub / h-md / lead / meta-row / stat-card / stat-label / stat-nb / stat-unit / stat-note / pipeline-section / pipeline-label / pipeline / step / step-nb / step-title / step-desc / grid-2-7-5 / grid-2-6-6 / grid-2-8-4 / grid-3-3 / frame / img-cap / callout-src`
- If a class is truly missing, **add it to the template's `<style>`**; do not inline-redefine it on every page
- After generating, open the browser: if "display headings are sans" or "pipeline steps crammed into one line" appears, it is almost 100% this issue

### 1. No emoji as icons

**Symptom**: emoji (🎯 💡 ✅) in the Chinese magazine style instantly destroys the tone.

**Fix**: use the Lucide icon library via CDN:

```html
<script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></script>
...
<i data-lucide="target" class="ico-md"></i>
...
<script>lucide.createIcons();</script>
```

Common icon names: `target / palette / search-check / compass / share-2 / crown / check-circle / x-circle / plus / arrow-right / grid-2x2 / network`

### 2. Images may only crop the bottom; left/right and top must never be cut

**Symptom**: using `aspect-ratio` to size images makes the grid stack or cut key image info when the parent is too small (e.g. a screenshot's top title bar).

**Fix**: image containers use **fixed height + overflow hidden**, images use `object-fit:cover + object-position:top`:

```html
<figure class="frame-img" style="height:26vh">
  <img src="screenshot.png">
</figure>
```

In CSS, `.frame-img img` is preconfigured with `object-position:top`, cropping only the bottom.

**Never write it this way** (it breaks containers in the grid):

```html
<!-- Bad example -->
<figure class="frame-img" style="aspect-ratio: 16/9">...</figure>
```

**Exception**: a single hero visual (outside a grid) may use `aspect-ratio + max-height`, because the parent container backstops it.

### 2b. Light pages over dark WebGL = a grey haze (theme switching not applied)

**Symptom**: all light pages' backgrounds look veiled in grey, even hero light.

**Root cause**: JS toggles the two canvases' opacity based on each slide's theme. If the deck opens on hero dark and nothing can switch the bg to light, `body` never gains the `light-bg` class and `canvas#bg-dark` stays on top.

**Fix**:
- The template's `go()` function now infers the theme from `classList` (`light` / `dark`), so **every slide must explicitly carry the `light` or `dark` class**. Never omit it, and never use other custom theme names
- Hero pages use `hero light` / `hero dark`; body pages use `light` / `dark`. A bare `hero` without a theme is broken
- A deck must include at least one **non-hero light page** so body gets a chance to add `light-bg`

### 2b-2. The whole deck is light; no rhythm

**Symptom**: except the `hero dark` cover, all pages default to `light` — visually flat, no breathing room, a wash of white.

**Root cause**: the layouts.md skeletons default to `light` everywhere; pasting skeletons without adjusting themes yields an all-light deck.

**Fix**:
- **Draw a "theme rhythm table" before generating**: write which of `hero dark` / `hero light` / `light` / `dark` each page uses, align, then code
- **Hard rules**: 3+ consecutive pages of the same theme = not allowed; 8+ pages must include ≥1 `hero dark` + ≥1 `hero light`; never all-`light` body pages — `dark` body pages are required
- **Pick themes by layout** (see "Theme rhythm planning" at the top of layouts.md):
  - Quote+image (Layout 4), big quote (Layout 8), lead image + text (Layout 10) → **alternate `light` / `dark`**
  - Big numbers, image grids, Pipeline, comparison pages → `light` (screenshots/numbers/flows need a bright base)
  - Cover, question pages → `hero dark`
  - Act dividers → alternate `hero dark` and `hero light`
- **Self-check after generation**: `grep 'class="slide' index.html`; visually confirm the rhythm alternates

### 2c. chrome and kicker must not say the same sentence

**Symptom**: top-left `.chrome` reads "Design First · 设计先行" while the same page's `.kicker` reads "Phase 01 · 设计阶段" — a synonymous translation, heavy AI flavor.

**Fix**:
- **chrome = magazine running head / navigation tag**: may repeat across pages (e.g. "Act II · Workflow", "Data · Result", "lukew.com · 2026.04")
- **kicker = this page's unique hook**: short, with a hook, a "small prefix" above the display heading (e.g. "BUT", "一个人,做了什么。" (user-facing example), "The Question")
- One describes the column, the other describes this page — never translate each other

### 3. Display-heading size must not exceed screen width / single-character lines

**Symptom**: a Chinese display heading set too large (e.g. 13vw) fits only one character per line; forced wrapping looks terrible.

**Fix**:
- `h-hero` (largest): 10vw, **and heading length ≤ 5 characters**
- `h-xl` (second largest): 6vw-7vw
- Break long headings manually with `<br>`; do not rely on auto wrap
- Add `white-space:nowrap` when needed

**Example** (user-facing example): `我不是程序员。` (6 characters) uses `h-xl` at 7.2vw + nowrap, fitting on one line.

### 4. Font division of labor: serif headings, sans body

**Fix**:
- Display headings, key quotes, big numbers → **serif** (Noto Serif SC + Playfair Display + Source Serif)
- Body, descriptions, pipeline step names → **sans** (Noto Sans SC + Inter)
- Metadata, code, tags → **mono** (IBM Plex Mono + JetBrains Mono)

All fonts load via the Google Fonts CDN, preconfigured in the template.

### 4b. Never use `align-self:end` to bottom-hug images

**Symptom**: in quote+image layouts, to bottom-align the right column image with the left column callout, `align-self:end` is added to `<figure>`. Results:
- If the parent isn't a grid (e.g. the class is undefined), `align-self` has no effect at all; the image drops to the end of document flow and gets covered by the browser bottom bar
- Even in a grid, the image hugs its cell bottom and on low-res screens is still covered by `.foot` and the `#nav` dots

**Fix**:
- Mixed text+image **must use `.frame.grid-2-7-5`** (or `.grid-2-6-6` / `.grid-2-8-4`)
- The right column `<figure class="frame-img r-16x10">` or `<figure class="frame-img r-4x3">` naturally hugs the top
- To make the left callout look "bottom-hugging", give the **left column** flex column + `justify-content:space-between`; don't touch the right column
- If the image top-aligns with the display heading but the body starts below the heading, add `margin-top:7vh` to `9vh` on the image so it aligns with the body content area

### 4c. Never use the original image's odd ratios

**Symptom**: ratios copied from the original image like `aspect-ratio: 2592/1798` create weird whitespace or overflow across screens.

**Fix**: whatever the original ratio, the placeholder always uses a standard ratio **16/10 / 4/3 / 3/2 / 1/1 / 16/9**. Images auto-apply `object-fit:cover + object-position:top`: the top is never cropped, and a little cropped from the bottom is harmless.

### 5. No heavy borders / shadows on images

**Symptom**: heavy shadows or black frames added for a "premium feel" instantly turn it into a corporate PPT.

**Fix**: at most 1-4px subtle rounding + **a very faint base noise** (already in the template). No `box-shadow`, no `border` (unless a 1px very light grey).

---

## 🟡 P1 · Typographic rhythm

### 6. Hero and non-hero pages must alternate

**Recommended rhythm** (25-30 pages):
```
Hero Cover → Act Divider (hero) → 3-4 pages non-hero → Act Divider (hero)
→ 4-5 pages non-hero → Hero Question → ... → Hero Close
```

2+ consecutive hero pages fatigue people; 4+ consecutive non-hero pages kill the rhythm.

### 7. Alternate big-number pages and dense pages

Big-number pages (big numbers / hero questions) and dense pages (pipeline / image grids) should alternate so the audience's eyes don't tire.

### 8. Keep English/Chinese usage of the same concept consistent

**Symptom**: sometimes "Skills", sometimes "技能", sometimes "薄承载厚技能" — inconsistent throughout.

**Fix**:
- Prefer **English words** for terms (Skills / Harness / Pipeline / Workflow); these are familiar insider words
- **Don't force-translate**; forced translation is stiffer
- One spelling per term across the deck

### 9. Bottom chrome page numbers must be consistent

Use the `XX / total pages` format (e.g. `05 / 27`). **Do not add dynamic page numbers in the top-right** (it duplicates `.chrome`).

### 9b. Motion system: every page needs data-anim markers

**Symptom**: after generating, flipping shows content appear with a flat "pop" and no rhythm — the magazine style then leans entirely on typography, missing the ceremonial layered reveal.

**Root cause**: no element carries `data-anim`, so the Motion One script finds nothing to play and the whole page appears statically.

**Fix**:
- On all body pages, **at least add `data-anim` to leaf elements: kicker / main heading / lead / callout / stat-card / figure**
- **Hero pages** (opening / act divider / question / ending): all core blocks (kicker + display heading + lead + meta-row) must carry it
- **Pages not needing special recipes**: add nothing; the default cascade already looks good
- **The 4 page types needing special recipes** must add the matching `data-animate` on `<section>`:
  - Big quote → `data-animate="quote"` + each line `<span data-anim="line" style="display:block">`
  - Before/After comparison → `data-animate="directional"` + left column `data-anim="left"` + right column `data-anim="right"`
  - Pipeline → `data-animate="pipeline"` + each step `data-anim="step"`
  - Hero pages (hero recipe is automatic, but elements still need `data-anim`)

**Self-check**: after generating, `grep -c 'data-anim' index.html` should be in the dozens. If it's single digits, markers were missed.

### 9c. Pipeline pages must add data-animate="pipeline"

**Symptom**: pipeline pages fade in all at once, losing the "step-by-step" rhythm; but moving to the next page only goes forward, with no way back to a previous step.

**Fix**: Layout 6's `<section>` must add `data-animate="pipeline"`. When presenting, pressing →/space/wheel-down lights up steps one at a time; only after all steps light up does → flip to the next page. This rhythm is deliberate, not a bug.

---

## 🟢 P2 · Visual polish

### 10. WebGL background mask opacity

**dark hero**: mask 12-15% (WebGL clearly visible)
**light hero**: mask 16-20% (WebGL faintly visible, not fighting the text)
**Normal light/dark pages**: mask 92-95% (almost hidden)

If a page has very little text (hero question), the mask can be thinner; if the body is dense, thicken the mask for readability.

### 11. Light hero shaders must not have a strong center point

**Symptom**: Spiral Vortex and radial ripples are too conspicuous on light themes, like a Windows 98 screensaver.

**Fix**: light heroes use FBM domain-warp-driven centerless flow; the base stays silver/paper (near #F0F0F0 / #FBF8F3), with subtle chromatic drift (below 0.05).

### 12. Dark heroes allow more visual impact

Dark heroes can use shaders with central structure like Holographic Dispersion (titanium-gold dispersion), because black bases tolerate more visual information.

### 13. Quote+image alignment

- Left column text group `justify-content:space-between`: heading hugs the top, quote box hugs the bottom
- Right column image stays naturally top-aligned; never add `align-self:end`
- The right image usually aligns with the body content area, not the display heading's top; add `margin-top:7vh` to `9vh` when needed
- Grid overall `align-items:start` (not `center` / `end`)

### 13b. Heading-to-body spacing

- Two-part layouts (top heading + long article/quote/chart below) need obvious spacing between them; recommended `margin-top:6vh` to `8vh`
- Centered display-heading pages must be horizontally centered as a whole, not merely left-aligned text blocks placed in the middle
- Complex pages use the display heading to set the tone, with grid / rowline justified content below; don't cram heading, subheading and body into one lump

### 13c. Don't stretch UI screenshots into giant strips

- If a single UI screenshot becomes a long strip at full width, prefer splitting it into 2-3 partial panels
- When laying out multiple panels, every `.frame-img` uses the same fixed height class like `.h-16` / `.h-18` / `.h-22`; don't force one super-wide container
- Images in one group must match in visual size; never mix heights, zooms or margin densities
- If truly full-width is needed, generate a sufficiently long horizontal image and state "ultra-wide horizontal strip" in the prompt

### 13d. Generated images must not carry slide elements

- GPT-M 2.0 generated images are embedded material only; never let them carry headers, footers, titles, page numbers, corner marks, signatures or decorative borders
- Flowcharts/infographics keep only core graphics and necessary short labels; the PPT itself owns titles, footers and chrome
- If a generated image already has these elements, prefer regeneration; don't stack another chrome layer in the PPT

### 13e. Swiss image mixing must not use only one form

- A 7-8 page Swiss test deck must use at least 6 different P-numbered layouts
- With 2-3 images, use at least two image-carrying forms: P22 hero visual / P23 single-image explanation / P24 evidence wall / P15 matrix / P16 brief
- P23 defaults to bottom alignment: the text block bottom-aligns with the image; don't retreat to top alignment out of nav fear; control image height first
- White-background infographic containers must be white and unstroked; never wrap a white image in a grey frame

### 13f. Swiss Chinese display headings need downgrading

- Chinese 2-line headings start from `min(5.8vw,10.2vh)`; don't directly use the English pages' `6.8vw-7vw`
- When any line has 9-12 Chinese characters, drop to `min(5.2vw,9.2vh)`
- 3-line headings: rewrite first; never squeeze out the images/text below just to keep the heading big

### 14. Subtle image rounding

Style A may have slight rounding. Style B Swiss must be square: `.frame-img` and the images themselves get no rounding, shadows or consumer-app card feel.

---

## 🔵 P3 · Operational details

### 15. Use relative image paths

Images live under the `images/` folder; HTML references them relatively as `images/xxx.png`, never absolute paths.

### 16. Page numbers are hard-coded in `.chrome`

JS dynamically computes the total and extends the bottom flip dots, but `XX / N` in `.chrome` is hard-coded. When adding/removing pages, update N by hand.

### 17. Keep the flip navigation

The template supports by default: ← → / wheel / touch swipe / bottom dots / Home·End. Do not delete the JS navigation logic.

### 18. Don't hard-set `height:100vh`; use `min-height:80vh`

`100vh` makes content exactly fill the screen, but browser toolbars/tab bars eat some height, causing overflow. `min-height:80vh + align-content:center` is safer.

---

## 🧪 Final self-check list

After generating the PPT, check each item (tick):

```
Pre-flight (before generating)
  □ Read template.html's <style>; confirmed all needed classes exist
  □ Decided which Layout (1-10) each page uses
  □ Drew the "theme rhythm table": each page marked hero dark / hero light / light / dark
  □ Rhythm table meets hard rules: no 3 consecutive same-theme pages / ≥1 hero dark + ≥1 hero light (8+ pages) / at least 1 dark body page
  □ `<title>` changed to the actual deck title (grep "[必填]" returns nothing)
  □ Swiss: cover is `slide accent` full-bleed IKB + `<canvas class="ascii-bg">` (not `slide light` white)
  □ Swiss: closing is `slide split` + left `b-accent` + ASCII canvas / right paper with 3 takeaways, the 03rd using var(--accent)
  □ Swiss: `grep -c "ascii-bg" index.html` ≥ 2 (one each on cover + closing)
  □ Swiss: cover has no big number like "01" (chrome already shows 01/N; no duplicates)
  □ Swiss: emphasized words on the IKB background use `font-style:italic`; `color:var(--accent)` forbidden (blue on blue)

Content
  □ Per-act page-count proportions are reasonable (no top-heavy acts)
  □ No emoji used as icons
  □ Terminology like Skills / Harness used consistently
  □ Each page has clear three-level info: kicker + heading + body

Typography
  □ No display heading wraps one character per line
  □ Image grids use height:Nvh, not aspect-ratio
  □ Images crop only the bottom; top/left/right intact
  □ Serif/sans font division matches the template
  □ Pipeline groups clearly separated

Visuals
  □ Hero and non-hero pages alternate
  □ WebGL background visible on hero pages
  □ Images have subtle rounding
  □ No heavy shadows or borders

Interaction
  □ ← → flipping works
  □ Bottom dot count matches total pages
  □ Page number in chrome matches the actual page
  □ ESC key triggers index view (if kept)
  □ B key triggers static/low-power mode; the bottom-right hint toggles between `B 静态` / `B 动态` (B static / B animated)

Motion
  □ `assets/motion.min.js` exists (local fallback)
  □ In low-power mode the WebGL/ASCII canvases stop RAF loops and current-page content remains fully visible
  □ On page flips content fades in one by one, not all at once
  □ Big-quote pages' `<section>` carries `data-animate="quote"`, each line `<span data-anim="line">`
  □ Before/After pages' `<section>` carries `data-animate="directional"`, left/right columns marked left/right
  □ Pipeline pages' `<section>` carries `data-animate="pipeline"`, each step marked data-anim="step"
  □ `grep -c 'data-anim' index.html` count ≥ pages × 3 (3+ markers per page on average)
```

Only when everything is ticked is the PPT qualified.
