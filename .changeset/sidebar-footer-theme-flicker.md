---
"cognia-next": patch
---

Put theme and settings shortcuts on the sidebar footer's account row, and fix the theme-switch flicker: `SettingsSyncProvider` depended on next-themes' `setTheme`, which is recreated on every flip, so each toggle re-ran the effect and re-asserted the store's theme while the matching save was still in flight — snapping the DOM back to the outgoing theme for a frame. The provider now keys on the four scalars it applies, calls `setTheme` through a ref, dedupes the persisted value, and stops re-firing the webview `setZoom` repaint on every settings save. The custom-theme applier also re-stamps its inline `<html>` palette in a layout effect so tokens land in the same commit as the `.dark` toggle, and the command palette's theme toggle now persists like every other switch. The account card drops its trailing chevron button.
