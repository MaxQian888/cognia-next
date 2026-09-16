---
"cognia-next": minor
---

Add Router + Fusion, an opt-in routing mode that is off by default (Settings → AI connections → Routing). Once you turn it on for chat, each turn is routed through an action router. Every model call is reserved against a run budget before it is sent and settled from the provider's reported usage. The model never switches silently mid-turn, and any retry to another provider is a visible, ledgered reroute. Each assistant message gets a run card showing the route, cost, calls and budget. If the ledger itself fails, the chat still completes on the original path with a "Not ledgered" notice, and repeated failures switch the surface back off until you re-arm it. The ledger lives in its own local database, which is deleted with the account and cleaned up on a retention schedule.
