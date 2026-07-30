---
"cognia-next": patch
---

Markdown headings in a streaming assistant turn now render at their final size straight away. They were styled only on the finalised branch, so every `#`/`##` heading rendered as plain body text for the whole stream and then jumped to its real size the instant the turn ended.
