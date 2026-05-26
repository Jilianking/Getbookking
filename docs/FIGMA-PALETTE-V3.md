# Build Palette review board (v3) in Figma

## Status

Figma MCP on the Starter plan may hit **rate limits**. When blocked, use one of the options below.

## Option A — Agent / MCP (fastest)

1. Open https://www.figma.com/design/7s9TtmBgyANcfyhqI0z9lc
2. In Cursor Agent mode, run `use_figma` with:
   - `fileKey`: `7s9TtmBgyANcfyhqI0z9lc`
   - `skillNames`: `figma-use`
   - `code`: entire contents of `Test/scripts/figma-palette-v3-board.js` (skip the first 3 comment lines)

The script appends **Palette review board (v3)** below the existing v2 board on the Palette page.

## Option B — Manual from JSON

1. Open `Test/docs/color-palette-v3-data.json`
2. For each palette row, create 5 cards (Classic, Luxe, Blade, Stonecut, Studio 12)
3. Name frames: `{Family} / {Display name}`
4. Five swatches per card: `bg`, `bg`, `accent`, `card`, `aboutBg` from `tokens.{family}`

## What gets created

- **15 rows** (one per new palette name)
- **5 cards per row** (one per template family)
- **75 cards total**, matching v2 strip layout
- Card names match app integration: `Classic / Forest Sage`, etc.

## Next step after Figma

Integrate approved hex into `WebColorPalette.swift` using `color-palette-v3-data.json` (not done until you confirm the board).
