# Cognia Agent Team avatars

A 16-member avatar family derived from the Cognia silver-haired AI companion.
The avatars share one character identity and use tactical science-fiction outfits,
expressions, and compact props to distinguish Agent Team roles.

## Deliverables

- `raw/concept-sheet.png` — approved 4×4 source concept on grey
- `contact-sheet-transparent.png` — production 4×4 transparent sheet, 2048×2048
- `png/*.png` — 16 transparent 512×512 PNG avatars
- `webp/*.webp` — 16 lossless transparent 512×512 WebP avatars
- `qa/contact-sheet-magenta.png` — contrast-background cutout QA
- `icon-manifest.json` — stable IDs, bilingual labels, and grid order
- `style-spec.json` — frozen identity, palette, and construction rules

## Recommended use

Use WebP in the application when supported and PNG as the compatibility source.
Render avatars at 48px or larger; the costume and prop details become difficult to
read below 40px. Keep the files transparent and let the consuming UI provide the
avatar background, border, presence indicator, or team colour.

The detailed anime artwork is intentionally raster. Automatic SVG tracing creates
very large paths and degrades the hair, face, and cel-shaded edges; it is not a
useful production format for this set.
