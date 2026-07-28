---
"cognia-next": patch
---

Fix the fleet island (Dynamic Island) hanging a notch's height below the top of the screen on MacBooks with a camera housing — it looked stuck to the bottom of the menu bar instead of growing out of the notch. The card's body now runs to the true top edge and merges with the housing (squaring its top corners while it does), while only its content stays padded below the safe-area inset, so nothing is ever hidden behind the notch; the auto-tuck now retracts the whole card, leaving the same thin sliver at the very top instead of a notch-height black band beside the housing. Displays without a notch are unchanged.

Also fix settings silently reverting to their defaults for a whole session ("settings.load failed DatabaseClosedError"). Registering plugin database tables at boot closes and reopens the shared connection, which cancelled whatever read was in flight — regularly the settings read every window makes on startup. Cancelled settings reads and writes are now re-issued once the connection is back, so a boot that races the plugin bump keeps your persisted settings instead of falling back to defaults.
