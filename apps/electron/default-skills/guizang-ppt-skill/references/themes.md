# Theme Presets (Themes)

5 carefully tuned palettes that keep the "电子杂志 × 电子墨水 (E-Magazine × E-Ink)" aesthetic from collapsing. **User-defined colors are not allowed — a wrong color pairing makes the deck instantly ugly**; choose only from the presets below.

---

## How to use

1. Ask the user which set (or recommend one based on the content)
2. Open the `<style>` block of `assets/template.html`
3. Find the `:root{` block at the top
4. **Replace wholesale** the lines marked with the "主题色" (theme color) comment: `--ink` / `--ink-rgb` / `--paper` / `--paper-rgb` / `--paper-tint` / `--ink-tint`
5. All other CSS goes through `var(--...)`; no other changes needed

---

## 🖋 墨水经典 (Ink Classic · Monocle default)

**Fits**: general talks, business launches, tech products; the safe default for any occasion.
**Tone**: pure ink black + warm off-white; the strongest magazine feel; Monocle / Apricot / A Book Apart style.

```css
--ink:#0a0a0b;
--ink-rgb:10,10,11;
--paper:#f1efea;
--paper-rgb:241,239,234;
--paper-tint:#e8e5de;
--ink-tint:#18181a;
```

---

## 🌊 靛蓝瓷 (Indigo Porcelain)

**Fits**: tech/research/data talks, engineering culture, deep content, tech launches.
**Tone**: deep indigo + porcelain white; calm, rational, with depth; like an academic journal or blue-and-white porcelain.

```css
--ink:#0a1f3d;
--ink-rgb:10,31,61;
--paper:#f1f3f5;
--paper-rgb:241,243,245;
--paper-tint:#e4e8ec;
--ink-tint:#152a4a;
```

---

## 🌿 森林墨 (Forest Ink)

**Fits**: nature/sustainability/culture/non-fiction content, outdoor brands, environmental themes.
**Tone**: deep forest green + ivory; steady and breathable; like a vintage *National Geographic*.

```css
--ink:#1a2e1f;
--ink-rgb:26,46,31;
--paper:#f5f1e8;
--paper-rgb:245,241,232;
--paper-tint:#ece7da;
--ink-tint:#253d2c;
```

---

## 🍂 牛皮纸 (Kraft Paper)

**Fits**: nostalgia/humanities/reading/history/literature talks, indie magazines, craft brands.
**Tone**: deep brown + warm beige; like a kraft envelope or an old notebook; warm, with a sense of age.

```css
--ink:#2a1e13;
--ink-rgb:42,30,19;
--paper:#eedfc7;
--paper-rgb:238,223,199;
--paper-tint:#e0d0b6;
--ink-tint:#3a2a1d;
```

---

## 🌙 沙丘 (Dune)

**Fits**: art/design/creative/fashion talks, gallery booklets, aesthetics-first private salons.
**Tone**: charcoal + sand; restrained, refined, neutral; like a desert dusk or an architecture portfolio.

```css
--ink:#1f1a14;
--ink-rgb:31,26,20;
--paper:#f0e6d2;
--paper-rgb:240,230,210;
--paper-tint:#e3d7bf;
--ink-tint:#2d2620;
```

---

## Selection guide

| If it's... | Recommended theme |
|---|---|
| Unsure / first time | 🖋 墨水经典 (Ink Classic) |
| AI / tech / product launch | 🌊 靛蓝瓷 (Indigo Porcelain) |
| Content / industry observation / culture | 🌿 森林墨 (Forest Ink) |
| Book reviews / lifestyle / humanities | 🍂 牛皮纸 (Kraft Paper) |
| Design / art / brand | 🌙 沙丘 (Dune) |

---

## Switching principles

- **One deck, one theme**; no mid-deck color switches
- The WebGL shaders' default dominant colors (titanium-gold dispersion / silver flow) fit all 5 sets (tested acceptable)
- `currentColor`-driven borders / icons auto-adapt to each section's text color; no extra adjustment needed
- After choosing a theme, the `<title>` text and `chrome` copy can reinforce its semantics (e.g. Kraft Paper paired with "Vol.03 · 秋" — a user-facing example)

## ❌ Don'ts

- ❌ **No mixing** (e.g. ink from Ink Classic, paper from Dune) — it becomes thoroughly incoherent
- ❌ **No accepting arbitrary hex values from the user** — politely decline and show the 5 presets to choose from
- ❌ **Don't modify colors elsewhere in template.html** — all scattered rgba values go through vars; change `:root` in one place

After choosing, tell the user in the skill conversation: "用 🖋 墨水经典 / 🌊 靛蓝瓷 ..." (a user-facing example meaning "Using Ink Classic / Indigo Porcelain ...") and note it in the deck's project record for consistent later iterations.
