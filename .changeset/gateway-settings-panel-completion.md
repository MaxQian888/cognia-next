---
"cognia-next": minor
---

Gateway settings: restart state now comes from the gateway itself (a banner on every panel lists the saved-but-unapplied bind-time fields and restarts the listener), and the global rate limit and connect timeout are correctly marked as restart-only instead of "applies immediately". Status refreshes live while visible, and a running gateway can be stopped even after its last key is deleted. The request log shows each request's routing decision and full failover attempt chain, adapts its columns to narrow panes, pages, exports CSV/JSON, and asks before clearing. Keys show created date, recent usage, and a quota bar, with inline validation and honest copy feedback; allowlist, retry-status and field-strip entries are validated before they reach the gateway; parked upstream accounts can be restored per provider; route tickets expand into their operations, budget and candidates and ask before revoking.
