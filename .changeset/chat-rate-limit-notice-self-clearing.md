---
"cognia-next": patch
---

Fix a spurious "rate limit reached" notice that stayed in the chat transcript forever. The marker projects a _live_ condition, but `allowed` was handled as a no-op instead of a clear, so a single `allowed_warning` — which the SDK emits at ~90% of a usage window during entirely normal use — pinned a notice into the persisted transcript that no code path ever removed. It survived reloads and still read "limit reached" days later, with a reset time in the past. Every `rate_limit_event` now drops any existing rate-limit marker before deciding whether to re-post one, so the notice clears itself as soon as the window resets. This also fixes markers accumulating one per turn: the old de-spam only collapsed a notice that was the _last_ message, which stopped being true the moment an assistant turn followed it.
