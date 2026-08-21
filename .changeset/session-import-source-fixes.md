---
"cognia-next": patch
---

Session-import sources: an OpenCode history that cannot be read (locked or
corrupt database) is now reported as a failed source instead of silently looking
like an empty history; Pi's imported token and cost figures are normalized, so
session insights no longer show a Pi conversation an imported-spend section full
of zeros; Gemini CLI and Continue now resolve their history directories through
the same environment-aware resolver as every other agent; the desktop scan is
bounded so a symlink loop inside a watched agent directory cannot run away; and
SQLite write-ahead-log writes now trigger live sync, which previously could stay
silent through an entire OpenCode session.
