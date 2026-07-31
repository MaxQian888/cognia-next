---
"cognia-next": patch
---

Reliability: broaden 429 backoff matching and harden browser find-in-page

- **Quota 429 backoff** now triggers for rate-limit errors whose `429` token
  sits at the end of the message (e.g. `HTTP 429`), not only when followed by a
  space or colon — so more provider rate-limit responses correctly pause
  automatic quota refreshes instead of retrying into the limit. The built-in and
  custom limits runners share one matcher, so the two can no longer drift.
- **Browser find-in-page** degrades to "no matches" when the underlying webview
  search call fails (preview torn down / injected helper missing) instead of
  leaving an unhandled rejection and a stale match counter.
