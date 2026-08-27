---
"cognia-next": patch
---

Settings sections no longer paint a card block over the page. `Card` already asked to drop its background inside the settings panel, but the request lost twice over: it lived in `@layer utilities` while the `[data-surface-layer="raised"]` tier rule that assigns the tint is unlayered (an unlayered declaration wins regardless of specificity), and with a wallpaper enabled the wallpaper stack paints `background-color` plus a backdrop blur directly onto `[data-slot="card"]`, which no `--surface-bg` value can undo. Sections built from stacked cards — Settings → Conversation most visibly — rendered as a column of tinted, blurred blocks instead of the flat sheet the rest of the panel uses. Both halves are now cleared, so the panel is flat against a plain dark ground and against a wallpaper alike. Alerts keep their tint: they are meant to stand out from the sheet.
