---
"cognia-next": patch
---

Fix the workspace loading screen leaving a bare rectangle in its bottom-right corner: the ambient backdrop is clipped to the screen's own box, and a viewport-relative height floor made that box 5rem shorter than the window at every root mount.
