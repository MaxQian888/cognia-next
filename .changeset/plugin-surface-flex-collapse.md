---
"cognia-next": patch
---

Fix plugin row surfaces collapsing to zero width inside the composer's flex toolbar. `container-type` hides a surface's contents from layout, so the row granted it 0px while the plugin kept painting its intrinsic width over the neighbouring chips — the visible symptom was the Tactical Mind Dial overlapping the controls to its right. Declared width hints now arrive as a definite `flex-basis`, squeezed surfaces clip instead of bleeding, and the dial's trigger fills the granted box with its label ellipsizing under pressure.

Fix an enabled built-in startup plugin never mounting in the dev `main` boot profile: the startup probe only counted enabled third-party plugins as a reason to boot `plugin-runtime`, so a user-enabled built-in (e.g. the effort dial) stayed dead on the chat route after every reload. Enabled startup plugins now request the runtime regardless of source.

Restore a plugin slot's declared fallback when its compact contribution crashes. A failed `chat.input.effort` extension left a dead declared-width box and suppressed the built-in chip; a slot with a fallback now treats a silently-removed surface as absent, while slots without one keep the width-stability contract unchanged.
