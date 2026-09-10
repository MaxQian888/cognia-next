---
"cognia-next": patch
---

Mobile: the plugin batch-actions bar no longer covers the bottom tab bar. On `/plugins` and `/me/plugins` the floating bar was offset only by the safe-area inset, which put it inside the tab bar's band and hid the bottom navigation whenever plugins were selected. The compact shell now lifts it clear of the reserve, which is stated once in `lib/shell/compact-shell.ts` and shared with the scheduler FAB.
