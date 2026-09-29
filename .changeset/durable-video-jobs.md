---
"cognia-next": patch
---

Video generation (plugins and `videos.generate`) now works in the desktop and mobile apps and survives reloads: a started video keeps generating, is checked again after the app reopens, and is saved once it finishes, with honest cancel and clear failure reasons (ADR-0205).
