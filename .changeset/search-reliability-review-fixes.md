---
"cognia-next": patch
---

Web search reliability follow-ups: the result cache key now digests every candidate provider's `defaultOptions` (editing an override busts stale entries instead of serving them), `avgLatency` no longer dilutes when a success lacks a timing sample, `routeSearch` strips explicit `undefined` call-time fields so they cannot clobber provider defaults, and the CLI `defaultOptions` schema accepts the full `SearchOptions` field set.
