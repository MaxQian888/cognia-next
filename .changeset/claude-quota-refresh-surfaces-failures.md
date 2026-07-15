---
"cognia-next": patch
---

Fix the Claude subscription quota panel silently freezing on a stale or blank reading. The free OAuth usage endpoint collapsed every failure — expired bearer, 429 throttle, network error, changed response shape — into an empty meter list, which the limits source then reported as "no data": the panel went blank next to a stale number, nothing reached the log, and each poll wasted a paid probe that was bound to fail the same way. Failures are now classified (following cc-switch's `query_claude_quota`) and surfaced inline via `ProviderLimits.error`, so the Overview tab shows why a quota read failed instead of the generic "No usage data yet" copy. The token refresh now only fires on a real 401/403 rather than on any empty reading, and usage windows Anthropic adds later are shown with their raw key instead of being silently dropped.
