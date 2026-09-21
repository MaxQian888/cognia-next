---
"cognia-next": patch
---

Fix a wallpaper flash when generating a theme from the current wallpaper: unrelated settings writes re-derived fresh `background`/`wallpapers` objects, so the background applier re-resolved the image into a new Object URL and blanked the layer for a frame. Derived flat fields now keep their previous reference when contents are unchanged, and the applier reuses the painted image while the source is the same. "Generate theme" also now applies the suggested opacity/blur in the same click — one button completes the whole adaptation, and the suggestion row only resurfaces when the sliders drift away from it.
