# Cognia mobile spot icons

This folder contains a project-matched 16-icon chibi anime character set for larger mobile feature entry points, cards, onboarding, and empty states. It is not intended to replace Lucide icons at 16–24 px.

- `style-spec.json` freezes the palette and construction system for later custom batches.
- `icon-manifest.json` records the row-major concept-to-filename mapping.
- `generation-prompt.md` stores the complete prompt for customization and regeneration.
- `raw/cognia-chibi-companion.png` is the generated 4×4 source sheet.
- `png/*.png` are transparent, individually sliced assets.
- `qa/contact-sheet-magenta.png` is the contrasting-background QA sheet.

To customize the set, keep the style spec unchanged and edit only the metaphors in `icon-manifest.json`, then regenerate one complete 4×4 sheet so the style stays coherent.
