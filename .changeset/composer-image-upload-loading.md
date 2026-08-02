---
"cognia-next": patch
---

Composer image uploads now show a purpose-built scan animation instead of a generic spinner. Dropping or pasting a photo immediately parks a placeholder chip in the context bar while it is decoded and downscaled — that window previously showed nothing but a spinning send button — and the staged chip and preview panel both report the wait as "Analyzing image…" while the image is read. Documents keep the plain spinner, and the animation is replaced by a static glyph under `prefers-reduced-motion`.
