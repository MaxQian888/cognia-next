---
"cognia-next": patch
---

Show the lead's proposed plan when the plan-approval gate was raised by the run's risk assessment rather than set by the operator. The approval panel additionally required the team's `requirePlanApproval` setting to be on, but the runtime opens the gate when _either_ that setting is on or the risk assessment raised it — so a risky run asked for approval while rendering no plan to approve. The panel now appears whenever the lead is awaiting approval.
