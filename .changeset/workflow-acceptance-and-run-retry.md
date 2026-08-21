---
"cognia-next": minor
---

Draft mode now holds a workflow before it runs, and a failed run can be retried.

**A workflow-bound conversation in draft mode no longer runs it live.** Draft
mode means a person signs off before the assistant acts, and each target honours
that with the mechanism it has: a direct turn holds its reply as a draft, a team
holds its plan at the approval gate. A workflow had neither — its nodes deliver
the output themselves, so by the time anything could be held the work had already
shipped, and the conversation was answered by a run nobody approved. It now posts
the same Approve / Cancel card the "run a workflow by name" flow already uses,
and the run starts only when someone taps Approve. If the card cannot be
delivered the workflow does not run, and the permission ceiling is frozen onto
the card, so a policy change while it waits cannot widen what gets approved.

**Retry works.** A failed or cancelled run offers a Retry button that starts a
fresh run linked back to the one it replaces, leaving the original's history
intact — pressing it twice reuses the replacement instead of starting two. A
workflow retried from a chat thread keeps reporting back to that thread, and a
delegation retries the piece of work that failed and keeps it on the same card.
The button appears only where a re-dispatch actually exists — never on a run that
succeeded, and never on kinds that cannot restart — so it is never a control that
does nothing.
