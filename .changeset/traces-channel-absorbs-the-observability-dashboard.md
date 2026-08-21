---
"cognia-next": minor
---

Fold the Observability dashboard into the Logs page's Traces channel: one time range, one filter set and one span read now drive both the trace explorer and the panel grid, the layout adapts to the channel's own measured width (three columns → two → list + sheet, with the toolbar collapsing to a single Filters control and, at phone width, moving the auto-refresh cadence into its settings drawer), and the standalone `/observability` route is gone — searching for it in ⌘K lands on Logs.
