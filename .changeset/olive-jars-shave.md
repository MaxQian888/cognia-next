---
"cognia-next": patch
---

Make the coding-agent migration and session-import dialogs usable on a phone. Both passed an unprefixed max-width that removed the mobile side gutter while being overridden on desktop, so neither width ever applied as intended, and neither had a scroll container, so a long list pushed the footer off the screen. The migration wizard also shows a progress bar for its step, and its conflict-handling control is now the app's own select.
