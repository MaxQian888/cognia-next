---
"cognia-next": patch
---

Fix the team plan-approval gate hanging forever. With `requirePlanApproval` enabled, the runtime now publishes the lead's proposed plan to the board (so the Plan Approval panel actually renders with enabled buttons) and opens the HITL gate modal, instead of waiting on a decision no UI could produce. Answering from the board panel also dismisses the matching gate modal, and the lead always leaves `awaiting_approval` once a decision (or abort) lands.
