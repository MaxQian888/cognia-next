---
"cognia-next": patch
---

Conversation timeline rail: the viewport indicator is now a translucent region shade across the whole lane (VSCode-minimap style) instead of a solid pill stacked over the turn markers — the rail reads as one map rather than a scrollbar on a navigation strip, while drag-to-scrub and click-to-jump are unchanged. Expand/collapse also flips immediately instead of waiting on the serialized settings write (it persists in the background and reverts on failure), and the rail no longer re-renders on unrelated settings saves.
