---
"cognia-next": patch
---

Wallpapers no longer sync between a phone and a paired desktop, because they
never could.

Every image wallpaper is a reference into the storage of the machine that saved
it — the desktop app writes a file path under its own app data, and a phone or
browser writes a key into its own local blob store. The two shells only ever
produce the kind the other cannot open, so mirroring the library filled both
galleries with tiles that showed nothing, and clicking one turned the whole
background off with no explanation.

The wallpaper library is now per-device, matching how the active wallpaper and
the "export my appearance" file already behaved. Wallpapers already copied
across before this fix are left where they are rather than deleted: the gallery
now says which device holds the image, refuses to activate the tile, and keeps
the delete button so you can tidy up.

Gradients and solid colours you build yourself stay per-device too. Themes,
custom themes, accent colour, typography, density, radius and custom CSS are
unaffected and continue to sync.
