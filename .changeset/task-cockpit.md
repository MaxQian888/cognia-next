---
"cognia-next": minor
---

Rebuild `/agent-runs` as a task cockpit that covers every kind of run.

The console previously listed four kinds — goals, teams, plans and scheduled tasks — because the view model behind it had no member for anything else. Chat turns, workflows, delegations and background jobs, which are most of what actually runs, could not appear there at all. It now reads the execution journal directly, so a run shows up as soon as it has a bridge, and it keeps finished work: you can filter by Running, Waiting, Failed or Finished as well as by kind, and page back through history.

Selecting a run opens Overview, Activity, Changes, Tests, Artifacts and Approvals for it. Tests report a run that could not be parsed as inconclusive rather than as zero failures, Changes says out loud when its file list is incomplete, and on a device that received a run summary without its journal the affected sections say so instead of showing a confident empty list.

Run controls — stop, pause, resume, retry, approve, deny and steer — now go through the shared execution control plane instead of calling each engine directly. That gives every press an idempotency key, a revision check, an authorization check and a journalled record, and it means a refusal is explained: a conflicting edit, a stale action, a message that could not be steered and is still yours to send, each say which one it was. Buttons are drawn from what the run itself reports it can do, so a control that would always fail is no longer offered.

Deep links from IM cards now land on the right run. Every card's "open details" link carries the execution run id, which the old console could not resolve — those links opened an empty pane.

The Control Center gains durable run approvals as a fourth source, so an approval that outlived the tab that asked for it — one raised from a chat platform, a delegation held for sign-off, a workflow gate — finally appears somewhere, and links to the run it is blocking. A chat approval and its durable twin are shown once, not twice. The Job Center's background tasks link into the cockpit rather than growing a second detail view of their own.
