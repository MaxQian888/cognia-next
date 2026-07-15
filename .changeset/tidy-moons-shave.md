---
"cognia-next": patch
---

Fix "download as PNG" failing on every card/image export. Tailwind v4 emits its theme tokens as modern CSS colour functions (`oklch()`, transpiled to `lab()`), which html2canvas 1.4.1 cannot parse — it threw `Attempting to parse an unsupported color function` on the first element it walked. Swapped to the maintained `html2canvas-pro` fork, which supports them. Restores the message quote card, usage share card, chat PNG export, A2UI thumbnails, and workflow graph image export.
