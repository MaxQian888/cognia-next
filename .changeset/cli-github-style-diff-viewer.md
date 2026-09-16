---
"cognia-next": minor
---

The CLI `/diff` reviewer now renders patches GitHub-style instead of dumping raw `git diff` text: dual old/new line-number gutters, sign column, per-hunk syntax highlighting with word-level emphasis, subtle tinted row backgrounds on truecolour themes, hunk separator bars, and file-status chips (new/deleted/renamed/mode/binary). The patch pane supports a unified/split layout toggle (`s`) and hunk navigation (`[`/`]`) with a position indicator, while the file list gains a review queue — `x` marks a file viewed and advances to the next unviewed one, `X` hides/restores viewed files, and the header shows the viewed count. Screen-reader mode keeps the verbatim plain-text patch.
