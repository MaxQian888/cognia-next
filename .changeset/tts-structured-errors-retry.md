---
"cognia-next": patch
---

Surface the real reason when read-aloud fails, and stop retrying errors that can't succeed. Provider failures previously collapsed to a single "TTS API returned an error" string, hiding the actual cause (invalid API key, quota exceeded) and its HTTP status — so retry couldn't tell a permanent 401 from a transient 503 and retried both three times with backoff. Failures now carry the error kind, status, and the provider's own message: the message shown to you is the real reason, and retries only fire for transient statuses (permanent 4xx errors fail fast).
