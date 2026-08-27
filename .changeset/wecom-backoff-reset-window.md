---
"cognia-next": patch
---

Fix a WeCom reconnect backing off as if the reconnect it had just completed had failed. The adapter marked itself healthy at the moment its subscribe succeeded, but reset the reconnect-attempt counter one `await` later — after hashing the credential fingerprint and claiming the bot's live-connection slot. A socket dropping inside that window was counted as a second consecutive failure, so the next retry waited on the escalated backoff instead of the base delay.
