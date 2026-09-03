---
"cognia-next": patch
---

A paired browser no longer re-pulls every synced table each time the window flickers in and out of focus, which used to pin the server's rate limiter and make unrelated things fail.
