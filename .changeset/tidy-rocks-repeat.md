---
"cognia-next": patch
---

Fix the companion sync bootstrap emptying most of its mirror on every launch. A paired browser or phone pulls 43 tables at startup, which drains the host's per-device read allowance part way through. The host answered the rest with a quota refusal it marked non-retryable, and stated the wait only in a field no client reads, so every remaining table gave up instantly and was recorded as failed. Measured against a headless host on loopback, 23 of 43 tables ended each launch empty and the next launch repeated it. The refusal is now retryable and carries the wait, and the sync orchestrator waits it out and re-runs the table instead of spending the next token that is not there.
