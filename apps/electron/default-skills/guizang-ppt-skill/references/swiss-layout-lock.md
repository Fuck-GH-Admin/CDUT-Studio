# Swiss Layout Lock

This file is the Swiss theme's hard constraint. Its purpose is not to add inspiration but to prevent generations that "look Swiss but have already drifted off the original template".

## Golden Source

Original reference file:

`/Users/guohao/Documents/op7418的仓库/项目/Thin-Harness-Fat-Skills/ppt/index.html`

When generating the Swiss theme, except when the user explicitly requests experimental layouts, you may only choose from the 22 layouts registered below. New cover/closing pages may use the Skill's IKB ASCII versions, but body pages must come from these 22 layouts.

## Hard rules before generating

1. Every body page must first pick a registered layout and write `data-layout="Sxx"` on its `<section>`.
2. Do not improvise body structures like `P23/P24` that don't appear in the original 22P. When images are needed, prefer `S22 Image Hero`; for multiple images adapt the `S15/S16` original grid skeletons into image cells — do not invent new evidence walls. The only registered interactive extension is `S08 + Swiss Map Component`; see `references/swiss-map-component.md`.
3. Top Chinese headings are left-aligned by default, close to the top-left content axis. Except for original statement/split layouts like `S03/S09/S10`, do not place display headings at the page's horizontal center.
4. SVG may only handle geometric lines, circles, arrows, paths. Do not write visible text inside SVG; put all text labels in HTML inside grids, cards or captions.
5. Image slots and image generation ratios must be bound. Settle the layout and slot first, then generate images.

## Registered layouts

| ID | Original page | Name | Skeleton that must be kept | Image rules |
|---|---:|---|---|---|
| S01 | 01 | Index Cover | Three `cover-row` lines; big number left, big title right | None |
| S02 | 02 | Vertical Timeline + KPI | Top-left-aligned heading, middle `.timeline-v`, bottom `.kpi-row-4` | None |
| S03 | 03 | Split Statement | `.slide.split` double half-screen; giant type left, grey-base explanation right | None |
| S04 | 04 | Six Cells | Top-left-aligned heading, `.sub-grid-3-2` six cards below | Card interiors may become small icons; no large images |
| S05 | 05 | Three Layers | Top-left-aligned heading, `.stack-row` three big blocks below | None |
| S06 | 06 | KPI Tower | Left title + right explanation; unequal-height KPI towers below | None |
| S07 | 07 | Horizontal Bar | Left-aligned heading, horizontal bar chart | None |
| S08 | 08 | Duo Compare | `.duo-compare` two columns + center line | None; place/route content may use `S08 + Swiss Map Component` to replace the right slot |
| S09 | 09 | Dot Matrix Statement | Large statement + dot-matrix decoration | None |
| S10 | 10 | Split Closing | `.slide.split` giant type left, list right | None |
| S11 | 11 | Horizontal Timeline | Original `grid-template-columns:auto 1fr` header + `.timeline-h` | None |
| S12 | 12 | Manifesto + Ink Banner | Large statement + bottom full-width ink bar | None |
| S13 | 13 | Three Forces | Left ink hero block + 3 cards right | None |
| S14 | 14 | Loop Form | Left 4-step list + geometric loop right | No text in SVG; labels move to HTML |
| S15 | 15 | Matrix + Hero Stat | Top-left-aligned heading, 6×2 matrix mid, giant number bottom | Multi-image may adapt matrix cells; uniform `21:9` per group |
| S16 | 16 | Multi-card Brief | Top-left-aligned heading, 3×2 mini cards below | Multi-image may adapt card content; uniform `21:9` per group |
| S17 | 17 | System Diagram | Top-left small heading + right paragraph, geometric system diagram mid, three-column explanation bottom | No text in SVG; labels move to HTML |
| S18 | 18 | Why Now | Three progressive columns + bottom giant number | None |
| S19 | 19 | Four Cards | Top blue line + four equal columns | None |
| S20 | 20 | Stacked KPI Ledger | Vertical ledger-style giant numbers | None |
| S21 | 21 | Tech Spec Sheet | Display heading + three KPIs + bottom-right vertical line matrix | None |
| S22 | 22 | Image Hero | Top full-width image + white title block top-left + three-column KPIs below | Main image generated at `21:9`; key subject in the central safe area |

## Registered extension component

### S08 + Swiss Map Component

- Use cases: geography, history, city routes, store/campus/event locations, residence relations.
- Layout identity: still `data-layout="S08"`, not a new body page.
- Page structure: top-left-aligned heading + left relation/explanation cards + right MapLibre map card.
- Mark structure: pins + connection lines + HTML cards; SVG only draws fallback relation lines, no text.
- Interaction controls: `+` / `-` / `DRAG` required at top-right; wheel zoom and drag disabled by default to avoid triggering deck page flips.
- For detailed code and the data contract see `references/swiss-map-component.md`.

## Image slot rules

### S22 · Hero Strip

- Generation ratio: `21:9`
- Image use: documentary scenes, product scenes, UI scenes.
- The generation prompt must include: `21:9 ultra-wide strip`, `subject centered in the safe middle area`, `no title, no footer, no page chrome, no logo, no border`.
- The HTML container must use the original S22 top full-width image skeleton; do not change it into an ordinary centered large image.
- Photos use `object-fit:cover;object-position:center 35%`. For portraits/conference scenes, never `top center`.
- If infographics/UI screenshots go into S22, they must be regenerated near `21:9`, using `object-fit:contain` or keeping the core content within the central 70% safe area.

### S15/S16 · Multi Image Grid

- Generation ratio: uniform `21:9` or uniform `16:10`; never mixed.
- Images in one group must share height, width and container background.
- Image cells must snap to the original card grid; never let images decide their own width/height.
- If images were regenerated for slots as `s15-grid-21x9` / `s16-brief-21x9`, containers must fill the slot with `.frame-img.r-21x9`; don't add `.fit-contain`, and don't shrink long images into fixed short slots like `height:18vh`.
- `.fit-contain` is only for user screenshots or text-dense images that must keep their original ratio; once you decide to regenerate, regenerate at the slot ratio and fill it.
- If original screenshot ratios are uncontrollable, first regenerate a "screenshot redesign" with GPT-M 2.0, then insert into the fixed slot.

## Forbidden list

- `text-align:center` on top Chinese display headings is forbidden.
- Putting the top heading into the right 7.8fr column, causing visual centering, is forbidden.
- Unregistered body pages are forbidden: e.g. ad-hoc `Swiss Image Split`, `Evidence Grid`, self-drawn three-circle diagram pages.
- Grey-base containers wrapping white-background infographics are forbidden.
- `<text>` appearing in SVG as visible labels is forbidden.
- Defaulting photos to `object-position:top center` is forbidden.
