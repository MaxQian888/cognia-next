---
"cognia-next": patch
---

Fix two CLI TUI markdown rendering bugs caused by `marked@18`'s lexer no longer HTML-escaping token text. Inline code spans and fenced code blocks are now rendered verbatim instead of being entity-decoded, so a literal `&amp;` or `&#39;` inside code keeps the characters the author typed; and a heading no longer leaves a stray blank line between itself and the block beneath it, so headings stay visually attached to their own content.
