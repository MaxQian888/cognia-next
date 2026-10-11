---
"cognia-next": minor
---

Python plugins can contribute tray-panel glance modules (publish with `ctx.glance.update`, hear visibility through the new `onGlanceVisibilityChange` hook); adds the opt-in Focus Timer example plugin, a glance module in the Python demo, and `cognia plugin new --kind glance`. Glance buttons can now run commands registered with `ctx.commands`, and fresh TypeScript scaffolds lint and type-check cleanly again.
