---
"cognia-next": minor
---

Bot modes, delegation and the model line.

Composed agent modes (ADR-0117) gain two axes so "mode" means the same thing on
the desktop and in a chat platform: **Engagement** (inline / background /
human) names how a run is attached to whoever asked for it, and **Autonomy**
(observe → autopilot) caps tool authority and floors the human ceremony a run
owes. Neither adds a second permission system — autonomy feeds the same
narrowing loop the preset cap and parent ceiling already use, and composes with
risk classification by OR, so a permissive level can never cancel a gate that
risk raised. Orchestration gains `team`. An IM turn now composes from its own
conversation config instead of silently inheriting whatever the desktop user
last picked in the composer.

Delegation becomes visible and controllable. A team run dispatched from IM now
gets the conversation binding it never had — without it there was no card, no
progress, and every control callback was rejected as a conversation mismatch —
and `team` runs reach a handler that can actually stop, pause and resume them.
Every platform's run card now shows the plan (one line per milestone with its
own status) above the activity timeline, and run control works from all twelve
platforms rather than only Feishu. An IM-triggered team run that trips a risk
gate now asks the human through the approval card instead of failing.

Model fixes: the bot default-model dropdown and the IM model switcher offered
exactly one model per provider (they collected against a settings field that
does not exist); custom-provider models were dropped from the routing
candidate set entirely; Claude 5 context windows were under-reported by 5x;
a retired model id reached the wire whenever a caller omitted one; `/model
anthropic/x` on a channel bound elsewhere silently repointed the whole channel;
and the budget guard's cost downshift never actually changed a model. An SLA
escalation could also outlive the assignment that framed it, and `/workflow
off` could be silently undone by a later unassign.
