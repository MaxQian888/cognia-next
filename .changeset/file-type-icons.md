---
"cognia-next": minor
---

File paths now carry a file-type icon instead of one generic page glyph. `@`-reference chips, the composer's file picker, message file attachments, the workspace changes list and the Pro IDE file tree all resolve the icon from the filename — a `.tsx`, an image, a lockfile and a Dockerfile are distinguishable at a glance, in both themes. When a plugin contributes a VS Code icon theme (Material Icon Theme and friends), that theme's icons are preferred; the built-in set is the default everywhere else, including web and mobile where an on-disk theme can never resolve.
