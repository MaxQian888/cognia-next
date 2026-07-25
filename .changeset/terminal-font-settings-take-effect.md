---
"cognia-next": patch
---

Fix terminal font settings being swallowed while typing, and show a live font preview

Numeric terminal settings clamped on every keystroke, so a typed value could never pass through an out-of-range prefix — typing `20` into font size landed on `8`, and `20000` into scrollback landed on `100000`. They now clamp on commit (blur / Enter) and revert when left blank. The font-family and custom-shell boxes commit on blur instead of persisting every half-typed character. Settings → Terminal gains a live specimen of the configured typography that names the font actually being used and warns when the requested family isn't installed, plus a reset-to-default button. The mobile terminal now honors the configured font size and scrollback instead of hard-pinning phone defaults.
