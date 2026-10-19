---
"cognia-next": patch
---

IM bots now answer a message they could not handle in the chat itself (a team or workflow that failed to start, or a failed reply with the live card off), mark a reply cut short by the turn or budget limit as incomplete instead of done, keep a failed run eligible for Continue safely / Retry, release a workspace turn whose start reply was lost, and clear old heartbeat rows fully on each daily sweep.
