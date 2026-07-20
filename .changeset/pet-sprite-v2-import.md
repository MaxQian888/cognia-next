---
"cognia-next": minor
---

Pet: import and manage Codex-compatible v2 sprite pets

- **Import & manage v2 sprite packs** from Settings → Pet: select a `pet.json`
  manifest plus its `spritesheet.webp`/`.png` (validated as a 1536×2288 atlas
  under 25 MiB), activate/switch between installed packs, and delete them —
  deleting the active pack restores the built-in SVG mascot.
- **AI Hatch Studio** (desktop): prepares a `$hatch-pet` agent task draft from a
  short concept and hands it off to chat to generate and QA a new pet.
- **Specific import errors**: a failed import now explains _why_ — invalid
  manifest, wrong image format, oversized atlas, mismatched dimensions, or an
  already-installed pack — instead of one generic "invalid package" message.
- **Sprite-v2 skin fallback**: every pet surface (widget, overlay, popup,
  console, customize preview) resolves to the SVG mascot when no v2 pack is
  active, so selecting the sprite skin without a pack no longer flashes a broken
  sprite.
