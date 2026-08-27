---
"cognia-next": minor
---

Web access is now resolved once, from what the install actually has, instead of by three switches that disagreed. On a Claude subscription with no search-provider key the composer's globe sat disabled saying "not configured", the model was handed a `web_search` that could only throw "no providers enabled", and the SDK's own WebSearch — which needs no key and returns citations — was behind an opt-in defaulting off. A new resolver (`lib/chat/web-access.ts`) picks the runtime's native search first, Cognia's multi-provider host-routed tools when there is no native, and withholds `web_search` (but not `web_fetch`, which needs no key) when nothing can serve a search. Settings → Tools' web sub-toggle becomes its inverse — "prefer Cognia's web search" — since native is now the default; the legacy `nativeOnAnthropic` field keeps working for anyone who set it.

Two safeguards came out of the same change: reaching the native path no longer writes `WebSearch`/`WebFetch` into `allowedTools`, which would have turned "no tool filtering" into "these two tools only" and let a parent permission ceiling intersect the turn down to nothing; and a turn whose tool surface was already narrowed (a character allow-list, a session tool filter) stays on the host-routed tools rather than having the natives widened into its list behind the filter.
