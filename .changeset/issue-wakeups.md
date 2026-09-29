---
"cognia-next": minor
---

Issue wakeups: subscribe an issue to its own activity (comments, status changes, any trail kind, people-only), to every sub-issue finishing, to another issue finishing, or to a timer, and an agent run starts on the issue with the instruction and what happened. An input that lands while a run is active joins it (steered into the live session) or is held until that run settles instead of being lost; a person assignee gets a notification instead of a run. Rules that loop between agents or fire more than 12 times an hour pause themselves and say why on the board card, the issue's Wakeups section and the scheduler; finishing an issue stops its rules. Periodic rules' runs can check in (`issue_wakeup_checkin`) to settle without moving the issue to review. Every parent issue automatically waits for its sub-issues. Agents get `issue_wakeup_create/list/set_enabled/delete/checkin`, all under the scheduler's agent-write policy.
