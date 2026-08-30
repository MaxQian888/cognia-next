---
"cognia-next": patch
---

Long-term memory no longer learns from the wrong conversation after an edit. A queued extraction or distillation job used to recover its transcript by slicing the conversation to a message COUNT parsed back out of its dedupe key, so editing, regenerating, or rewriting a message without changing the message count replayed whatever text happened to occupy those positions when the worker eventually ran. Jobs now pin the window to real message ids and verify it before replaying: a window whose messages were deleted, or that no longer spans the recorded count, is skipped instead of silently mined or retried to exhaustion. Rows written before this change keep resolving through the previous path unchanged.
