---
"cognia-next": patch
---

Plugin analytics under the Agent Team activity report render again. The `agent.team.report` extension slot was mounted only once the team object had loaded, so a registered analytics renderer silently never appeared on a report opened before (or without) it — the slot never needed the team, and no longer asks for it. The reference plugin now also declares the balance adapter it contributes, and its shared-memory and balance contributions are pinned by contract tests instead of riding an undeclared manifest overlay.
