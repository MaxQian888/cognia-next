---
"cognia-next": minor
---

Web search reliability: multi-key rotation, automatic retry, and provider fallback. Each search provider can now hold a pool of API keys (primary + backups) and rotate across them per request (round-robin / random / least-used); a rate-limited or rejected key is skipped automatically. Transient failures (network / 429 / 5xx) are retried per provider with exponential backoff before falling through to the next provider, while permanent errors (e.g. bad request) fall through immediately. A new "Max retries" control (Settings → Web search → Basics) and per-provider rotation controls (in each provider card) expose the behavior, and it is applied consistently across the chat composer, the agent `web_search` tool, the search hook, and the cited-answer pipeline.
