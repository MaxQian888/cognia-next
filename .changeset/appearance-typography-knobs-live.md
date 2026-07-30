---
"cognia-next": patch
---

Settings → Appearance now actually changes the page. The line-height and letter-spacing sliders under Fine-tuning, and the line-height half of the Density presets, were written to the document on every change but read by no stylesheet, so moving them did nothing. Line height is now composed from both knobs and applied to every line-height token Tailwind resolves utilities against — plus markdown, which sets its own — and letter spacing is applied where it inherits to the whole document. Defaults are unchanged: at comfortable density and 1x scale the page renders exactly as before.
