---
"cognia-next": patch
---

Source Control error handling, three small fixes: syncing a branch that has no upstream now returns a clear "publish it first with push --set-upstream" message instead of a generic command failure; unstaging a file only falls back to dropping it from the index on a genuinely unborn HEAD (a repo with no commits), so a lock or bad-path failure surfaces instead of being masked; and the lock-detection condition is parenthesized for clarity (no behavior change).
