---
"cognia-next": patch
---

The composer's status line no longer overlaps itself. Chips could not shrink, so on a standard chat pane the last one in the group (the system-prompt preset) rendered on top of the runtime chip beside it — every label now ellipsizes inside its own box instead. The row was also de-crowded: controls sitting on their shipped value (the built-in runtime, "No preset") render as a glyph with a tooltip and spell themselves out only once they carry a choice, the "⇧⇥" keycap moved from the permission chip into its tooltip, the "No API key" badge is tinted rather than a solid red block, and the row is grouped as per-turn settings / session shape / ambient status with a single hairline. Below 520px the toolbar re-packs into its two compact rows rather than shaving every label to a stub.
