---
"cognia-next": minor
---

Bound large file-tool payloads in the message stream: Read/Write/NotebookEdit code bodies and diffs now preview the first ~120 lines (Write also keeps a 4,000-char guard; diffs clamp each side before intraline highlighting), MultiEdit caps at 20 rendered edits, and Grep/Glob/LS lists cap at 200 rows — each with a "Show all" reveal. Prevents giant tool outputs from flooding the chat DOM and stalling highlighting/diff work.
