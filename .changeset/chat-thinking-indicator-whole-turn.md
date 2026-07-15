---
"cognia-next": patch
---

Keep the chat thinking indicator alive for the whole assistant turn. It previously disappeared the moment the first tool call or token landed, leaving long agentic runs with no sign of life; it now trails the turn's content in a compact form (no skeleton placeholder) until the turn settles, and its label cycles localized "working" verbs. Expanded the rotating tips from 6 to 18, covering steering the queue, the run panel, mentions, compaction, and long-term memory.
