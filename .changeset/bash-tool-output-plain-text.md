---
"cognia-next": patch
---

Render Bash tool results as preformatted code instead of Markdown, so command output keeps its line breaks, indentation, and `<header.h>` includes. File-dumping commands (`cat`, `head`, `tail`, `bat`, `less`, `type`, `Get-Content`, …) now infer a syntax-highlight language from the file they read — `cat foo.cpp` highlights as C++.
