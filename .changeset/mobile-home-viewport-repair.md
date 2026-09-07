---
"cognia-next": patch
---

Mobile home screen no longer overflows its viewport. The top bar clips and folds its secondary controls (Inbox, Artifacts) into the overflow menu on a narrow phone, instead of pushing the menu itself off-screen and giving the page a horizontal scroll. The bottom tab-bar reserve is now made once rather than twice, which removes the empty strip that appeared under every page after leaving the home screen. The tab bar grows for the device's bottom safe area instead of absorbing it, so its labels and selection pill clear the gesture bar. The quick-action grid and the active-runs card can be dismissed in place and restored from the new "Customize home" entry in the overflow menu, and the composer's toolbar stays on one row at phone width instead of wrapping three read-only glyphs onto a line of their own.
