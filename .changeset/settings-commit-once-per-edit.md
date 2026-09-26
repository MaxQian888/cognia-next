---
"cognia-next": patch
---

Settings that sync from a paired phone to the desktop now save once per edit, not on every keystroke or slider frame. Typed fields save on blur or Enter (IME-safe), and sliders and the accent colour picker save on release. Previously each intermediate value queued its own desktop update. This covers speech rate, pitch, volume and voice id, notification quiet hours and retention, appearance radius, line height, letter spacing, accent and auto-mode times and coordinates, eval defaults and gates, spending limits, compaction, the composer skin, and search max results. Emptied or half-typed times and coordinates now revert instead of saving.
