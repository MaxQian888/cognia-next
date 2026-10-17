---
"cognia-next": patch
---

Fix sessions that could not be resumed after a successful compaction ("a saved tool result has no matching call"): compaction now never separates a tool call from its result — the verbatim tail, the token-budget drain and the selective strategy all keep each pair whole — and a compaction that would still split one is discarded and reported instead of being saved.
