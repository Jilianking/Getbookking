# Web color palettes (Bookking)

Generic display names for app integration and Figma board **Palette review board (v2)**.  
Figma file: https://www.figma.com/design/7s9TtmBgyANcfyhqI0z9lc

## Names by template family

| Template family | Preset 1 | Preset 2 | Preset 3 | Preset 4 |
|-----------------|----------|----------|----------|----------|
| Classic | Original | Sandstone | Soft Neutral | Vintage Warm |
| Luxe | Original | Sandstone | Blush Mauve | Soft Neutral |
| Blade | Original | Sandstone | Ocean Slate | Slate & Rust |
| Stonecut | Original | Burnt Accent | Ink & Parchment | Charcoal Greige |
| Studio 12 | Original | Sandstone | Soft Neutral | Ocean Slate |

## Firestore `webColorPaletteId`

| Display name | ID |
|--------------|-----|
| Original | `original` |
| Sandstone | `sandstone` |
| Soft Neutral | `soft-neutral` |
| Vintage Warm | `vintage-warm` |
| Blush Mauve | `blush-mauve` |
| Ocean Slate | `ocean-slate` |
| Slate & Rust | `slate-rust` |
| Burnt Accent | `burnt-accent` |
| Ink & Parchment | `ink-parchment` |
| Charcoal Greige | `charcoal-greige` |

## Figma layer rename (manual or Agent when MCP available)

Update each card **frame name** and **title text** to `{Family} / {Display name}`:

### Classic row
- `Classic / Original`
- `Classic / Sandstone` (was Warm Caramel)
- `Classic / Soft Neutral` (was Edgecomb)
- `Classic / Vintage Warm` (was Retro Editorial)

### Luxe row
- `Luxe / Original` (was Original (Blanc))
- `Luxe / Sandstone`
- `Luxe / Blush Mauve` (was Dusty Rose)
- `Luxe / Soft Neutral`

### Blade row
- `Blade / Original` (was Original (Obsidian))
- `Blade / Sandstone`
- `Blade / Ocean Slate` (was Coastal Night)
- `Blade / Slate & Rust` (was Retro Steel)

### Stonecut row
- `Stonecut / Original` (was Original (Ember))
- `Stonecut / Burnt Accent` (was Warm Ember)
- `Stonecut / Ink & Parchment` (was Monochrome)
- `Stonecut / Charcoal Greige` (was Edgecomb Stone)

### Studio 12 row
- `Studio 12 / Original`
- `Studio 12 / Sandstone`
- `Studio 12 / Soft Neutral`
- `Studio 12 / Ocean Slate` (was Coastal)

Board subtitle suggestion:

> Bookking palette names for app integration — generic labels, not third-party trademarks.

---

## Palette review board (v3) — 15 additions

**Figma file:** https://www.figma.com/design/7s9TtmBgyANcfyhqI0z9lc  
**Build script:** `Test/scripts/figma-palette-v3-board.js` (run via Figma MCP `use_figma` when not rate-limited)  
**Full token JSON:** `Test/docs/color-palette-v3-data.json`

Additive to v2: **15 new palette IDs × 5 template families** (75 token bundles when integrated in `WebColorPalette.swift`).

### New Firestore IDs

| Display name | ID |
|--------------|-----|
| Forest Sage | `forest-sage` |
| Midnight Plum | `midnight-plum` |
| Coral Bloom | `coral-bloom` |
| Arctic Mist | `arctic-mist` |
| Copper Ledger | `copper-ledger` |
| Lavender Haze | `lavender-haze` |
| Olive Grove | `olive-grove` |
| Rose Quartz | `rose-quartz` |
| Graphite Mint | `graphite-mint` |
| Honey Linen | `honey-linen` |
| Baltic Blue | `baltic-blue` |
| Terracotta Clay | `terracotta-clay` |
| Pearl Ash | `pearl-ash` |
| Berry Noir | `berry-noir` |
| Sage Steam | `sage-steam` |

### Figma card naming

Each cell: `{Family} / {Display name}` (e.g. `Studio 12 / Forest Sage`).

Strip order (left → right): page bg · page bg · accent · card surface · about band.

### v3 in app

Integrated in `Test/WebColorPalette.swift` from `color-palette-v3-data.json`.  
Template tab shows **19 presets per family** (4 v2 + 15 v3).
