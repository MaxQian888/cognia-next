---
"cognia-next": patch
---

Right-side dock: stop layout shake and scrollbar flashes when switching widths or opening Workspace and Prompt Templates. Programmatic resizes now commit one final layout and animate stable panel snapshots instead of reflowing the live conversation on every frame; unsupported engines resize immediately, and the embedded Pro IDE remains on its no-animation path.
