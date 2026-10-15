# Swiss International Style · Theme Presets (Swiss Themes)

4 high-contrast palettes based on Swiss International Style (瑞士国际主义). **Each set follows the minimalist principle of "refined grey-white base + a single highly saturated highlight color"** — this is the soul of Swiss style; mixing multiple highlight colors is not allowed.

---

## How to use

1. Ask the user which set (or recommend one based on the content)
2. Open the `<style>` block of `assets/template-swiss.html`
3. Find the `:root{` block at the top
4. **Replace wholesale** all variables marked with the "主题色" (theme color) comment: `--paper` / `--paper-rgb` / `--ink` / `--ink-rgb` / `--grey-1` / `--grey-2` / `--grey-3` / `--accent` / `--accent-rgb` / `--accent-on`
5. All other CSS goes through `var(--...)`; no other changes needed

---

## 🔵 克莱因蓝 (Klein Blue · IKB · International Klein Blue)

**Fits**: general occasions, business launches, AI/tech products, design-domain talks. The most classic Swiss palette; never wrong.
**Tone**: pure white base + IKB Klein Blue; supremely calm, rational, academic; like *Helvetica Forever* or Massimo Vignelli's portfolio.

```css
--paper:#fafaf8;
--paper-rgb:250,250,248;
--ink:#0a0a0a;
--ink-rgb:10,10,10;
--grey-1:#f0f0ee;
--grey-2:#d4d4d2;
--grey-3:#737373;
--accent:#002FA7;
--accent-rgb:0,47,167;
--accent-on:#ffffff;
```

**Usage notes**:
- IKB is a highly saturated deep blue with enormous visual impact on large color blocks (e.g. `.accent-block`)
- KPI numbers can be blue via the `.accent` class, but don't flood the screen with blue — once IKB is everywhere it loses its class
- Recommended to alternate with `dark` theme pages; IKB highlighted on a black base is equally refined

---

## 🟡 柠檬黄 (Lemon Yellow · Cadmium Yellow)

**Fits**: youthful, sporty, retail, consumer goods, energetic themes, Y2K retro design.
**Tone**: light off-white base + lemon yellow; bright, energetic, strongly cautionary; like IKEA's or Beck Design's visual language.

```css
--paper:#fafaf8;
--paper-rgb:250,250,248;
--ink:#0a0a0a;
--ink-rgb:10,10,10;
--grey-1:#f0f0ee;
--grey-2:#d4d4d2;
--grey-3:#737373;
--accent:#FFD500;
--accent-rgb:255,213,0;
--accent-on:#0a0a0a;
```

**Usage notes**:
- Lemon yellow is a light, highly saturated color; **`.accent-on` must be pure black** (not white) to guarantee readability
- Never put white text on yellow blocks — it smears
- Lemon yellow is most effective as a single-character highlight (`.mark` / `.underline-accent`)

---

## 🟢 柠檬绿 (Lemon Green · Highlighter Green)

**Fits**: ecology, sustainability, health, emerging tech, Gen-Z brands, AI startups.
**Tone**: light off-white base + fluorescent lemon green; futuristic, young, contemporary; like Acne Studios or Off-White visuals.

```css
--paper:#fafaf8;
--paper-rgb:250,250,248;
--ink:#0a0a0a;
--ink-rgb:10,10,10;
--grey-1:#f0f0ee;
--grey-2:#d4d4d2;
--grey-3:#737373;
--accent:#C5E803;
--accent-rgb:197,232,3;
--accent-on:#0a0a0a;
```

**Usage notes**:
- Fluorescent green, like yellow, is a light color; **`.accent-on` must be pure black**
- It renders better on screens than in print; well suited to talk projections
- Recommended for "emerging technology" and "future" themes

---

## 🟠 安全橙 (Safety Orange)

**Fits**: industry, warning, sports, construction, automotive; the "warning/key point" pages of tech launches.
**Tone**: light off-white base + safety orange; industrial, urgent, a visual anchor; like Saul Bass posters or the Highway Gothic signage system.

```css
--paper:#fafaf8;
--paper-rgb:250,250,248;
--ink:#0a0a0a;
--ink-rgb:10,10,10;
--grey-1:#f0f0ee;
--grey-2:#d4d4d2;
--grey-3:#737373;
--accent:#FF6B35;
--accent-rgb:255,107,53;
--accent-on:#ffffff;
```

**Usage notes**:
- Orange sits between light and dark; **white text is barely readable, so bold it** (`font-weight:600` or above)
- Strong industrial feel; fits content involving "warnings", "decisions", "turning points"
- A full-page `.accent` mode is not recommended; a full screen of orange is too glaring — use it for local highlights only

---

## Selection guide

| If it's... | Recommended theme |
|---|---|
| Unsure / first time / AI/tech/design | 🔵 克莱因蓝 (Klein Blue IKB) |
| Youthful, energetic, consumer, retail | 🟡 柠檬黄 (Lemon Yellow) |
| Ecology, future, Gen-Z, emerging | 🟢 柠檬绿 (Lemon Green) |
| Industrial, warning, automotive, urgency | 🟠 安全橙 (Safety Orange) |

---

## Switching principles

- **One deck, one theme**; no mid-deck accent switches
- The grey-scale variables (`--grey-1/2/3`) are identical across all 4 themes; no adjustment needed
- The WebGL grid background automatically reads the `--accent` variable; on page flips a hint of the highlight color sneaks in near the mouse
- After choosing a theme, one related word in the chrome copy can reinforce the semantics (e.g. IKB with `International / Helvetica`, lemon yellow with `Active / Living`)

---

## ❌ Don'ts

- ❌ **No mixing** (e.g. IKB blue + lemon yellow appearing together as highlights) — it flatly violates Swiss style's "single anchor color" principle
- ❌ **No user-defined arbitrary hex values** — politely decline and show the 4 presets to choose from
- ❌ **Don't change the grey-scale variables** — `--paper` / `--grey-1/2/3` / `--ink` are unified across themes; only swap the accent
- ❌ **No gradients** — Swiss style rejects any gradient; all color blocks must be solid
- ❌ **No shadows / rounded corners / transparency on accents** — square corners, solid colors, fully opaque; these are Swiss hard rules

---

## About the greys (unified across themes)

| Variable | Value | Use |
|---|---|---|
| `--paper` | `#fafaf8` | Main base color (extremely light warm white) |
| `--grey-1` | `#f0f0ee` | Light grey base (for `.grey-block` / block backgrounds) |
| `--grey-2` | `#d4d4d2` | Mid grey (dividers, borders) |
| `--grey-3` | `#737373` | Dark grey (helper text / meta) |
| `--ink` | `#0a0a0a` | Main text color (near black) |

This grey scale is color-calibrated "refined grey" that never steals the show under any accent color. **Don't** change it to pure white (`#fff`) or pure black (`#000`) — that loses the "restrained" quality of Swiss style.

---

After choosing, tell the user: "用 🔵 克莱因蓝 / 🟡 柠檬黄 ..." (a user-facing example meaning "Using Klein Blue / Lemon Yellow ...") and note it in the deck's project record for consistent later iterations.
