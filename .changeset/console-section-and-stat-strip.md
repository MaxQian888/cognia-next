---
"cognia-next": patch
---

Console cards and their number strips are now one shared pair of primitives instead of a per-console rewrite. The card frame and the hairline stat strip that the device console had grown are lifted into `ConsoleSection` and `StatStrip`, which `/workspace` and the other consoles can use rather than hand-rolling a bare `<section>` and a local stat tile. Both now carry the surface tier, so the device console's cards and stat strip finally answer to the style pack and the elevation setting: their corners follow the same named radius scale as the rest of the app instead of a fixed `rounded-xl`, and their depth follows the elevation preference instead of a hardcoded shadow.
