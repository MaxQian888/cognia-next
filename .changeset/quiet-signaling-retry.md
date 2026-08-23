---
"cognia-next": patch
---

Stop the signaling client's reconnect storm. Its jitter had no floor, so however many times the relay refused, the next attempt could still fire a millisecond later and the retry interval never actually grew; the schedule now keeps at least half the backoff window between attempts. A relay that answers with a 4xx — an unreachable or mis-set `signalingUrl`, the common case being an endpoint that does not serve `/signaling` — is a configuration fault rather than an outage, so it now backs off to five minutes and logs once instead of repeating the same two lines forever.
