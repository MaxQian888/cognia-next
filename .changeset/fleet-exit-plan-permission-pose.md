---
"cognia-next": patch
---

Fix the Fleet island treating an `ExitPlanMode` plan review as an ordinary event, and harden the surrounding state machine against the same class of bug:

- The plan tool fires both `PreToolUse` (which parks the plan preview) and a `PermissionRequest`; the latter had no plan-aware branch, so it collapsed the row into a generic "ExitPlanMode" Approve/Deny card and hid the plan text. The plan now keeps its `plan-pending` pose — showing the full plan preview — while staying answerable, so you can review and Approve/Deny it directly from the island.
- A `Notification` hint (`permission_prompt` / `idle_prompt`) no longer overwrites a row that is already parked on a plan review or a question while its authoritative event is still in flight.
- A denied plan (auto-mode or an out-of-band "no") now releases its pose — dropping the stale plan text and returning to working — instead of leaving the row stuck on a plan with dead controls.
