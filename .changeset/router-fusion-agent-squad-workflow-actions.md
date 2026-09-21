---
"cognia-next": minor
---

Router + Fusion action choice for agents, Squad members and workflow nodes: an agent turn, a Squad teammate and an `ai.prompt` node can each run as `direct`, `cascade` or `panel` instead of one ordinary model call, booked on the `agentsWorkflows` surface so every call is reserved and settled through the CallLedger. `Auto` stays the default and leaves each path exactly as it was. A member's fusion run is a session-less child of its team run, so the team keeps the session lock and the member's tokens are ledgered on the run's own child budget account; a run started inside another fusion run is refused rather than nested. `Delegate` is offered but inert until it ships.
