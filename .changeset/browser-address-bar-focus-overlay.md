---
"cognia-next": patch
---

Browser address bar: the prettified read-mode address no longer paints on top of the URL while you are editing it. Focusing the field selects the whole address, and the selection was rendered through the transparent input — so the typed URL and the shortened one overlapped. The toolbar now drops the overlay whenever the field has focus, which also fixes the web-fallback and remote-preview surfaces that never tracked edit state at all.
