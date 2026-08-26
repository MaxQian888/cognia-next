---
"cognia-next": patch
---

Settings master/detail panes now size their nav rail from the pane's own width instead of the window's. The rail steps from full (icon + label + description) to compact (icon + label) to a 52px glyph strip to a drawer, so the detail column keeps a usable width in a narrow window instead of collapsing to a sliver — in an 835px window the Appearance detail column goes from 171px to ~480px. The settings sidebar also starts collapsed below 1100px (a manual toggle still wins), and Appearance's live preview starts collapsed when the detail column is too narrow to spare the height.
