---
"cognia-next": minor
---

CLI: rebuild how the TUI renders tool calls, and give the fullscreen renderer the colour and folding it was missing.

- One shared result descriptor (`format/tool-result.ts`, the terminal twin of the app's `tool-result-summary`) drives every tool row, so a call reads the same in the app and in the CLI: "12 matches", "3 files", "+5 -2", "320 lines", and a failure's first line on its own full-width row.
- Tool headers now carry a per-bucket glyph and a humanized label (`bash` -> "Bash", `mcp__github__create_issue` -> "github:Create issue"), a caret only when collapsing actually hides something, and an expanded body nested under a left rule instead of running flush against the transcript.
- The fullscreen transcript is no longer painted one colour per cell: its rows carry per-run styles, so diffs get their sign colours, headings and code spans get theirs, and a failed call reads red.
- The fullscreen renderer now folds settled read/grep/glob/ls bursts into one summary row. That collapse previously existed only in the legacy renderer, so the default layout showed every read in full.
- A read or search no longer echoes the first line of its own output under the header, and `/inspect` is advertised once in the footer instead of on every settled row.
