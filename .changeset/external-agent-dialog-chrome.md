---
"cognia-next": patch
---

External agent manager dialog: opening it no longer flashes the Refresh tooltip — the initial focus stays on the dialog instead of auto-focusing the first tooltip-wrapped button. The close control now lives in the body's header row alongside Refresh / Add Agent (via the manager's new `headerActions` slot) rather than floating at the dialog corner. The Sessions section renders a 20-row preview inside a bounded scroll area with a "show all" toggle, instead of expanding every resumable session at once. Agent cards now lay the status badge, credential badge, and connect/remove buttons out on one flex line, so the pill no longer floats a half-line above the buttons.
