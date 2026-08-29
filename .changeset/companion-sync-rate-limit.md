---
"cognia-next": patch
---

Stop the companion sync bootstrap from rate-limiting itself. A freshly paired client pulls 25 tables back to back, which overran the per-device 10-token bucket and left the tail tables silently empty; read-only commands now have their own bucket sized for that burst, and the client honors the wait the Host names in a 429 instead of falling back to sub-second jitter.
