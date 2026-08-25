---
"cognia-next": minor
---

Appearance: add style packs (Soft / Studio / Sharp) and layer-semantic surfaces.

Pick a look in Settings → Appearance → Style. **Sharp** squares everything that
is not a circle — corners, badges, switches, the composer — drops shadows in
favour of stronger borders, tightens density, and sets timestamps and counts in
monospace caps. **Studio** matches the Cognia website: restrained corners,
hairline rules, no oversized pills. **Soft** is today's look, unchanged.

Packs only control shape, so any pack composes with any colour theme, accent
preset, or imported VSCode theme.

Also fixes image backgrounds. A wallpaper now appears on `/logs`, `/devices`,
`/agent-runs`, `/templates`, `/goals`, `/integrations`, `/servers` and every
mobile sub-page, where it previously rendered nothing at all, and panels across
the app take their translucency from one of three shared tiers instead of each
picking their own — so neighbouring surfaces stop disagreeing about how much of
the image shows through.

The corner-radius slider moves to the new Style panel, where it reads as an
override on the active pack. Setting it to zero now genuinely reaches zero;
previously the largest step stayed at 4px.
