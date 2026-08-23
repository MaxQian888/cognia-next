---
"@cognia/agent": minor
"cognia-next": patch
---

Make the Agent SDK runtime client correct before it is published (ADR-0142).

Event delivery is rebuilt: every `events()` call is an independent subscriber with its own bounded
queue instead of all of them draining one shared queue, history replays up to the host's head cursor
before live delivery instead of racing it, and a subscriber that falls behind closes itself with a
`BackpressureError` carrying its resume cursor rather than growing the heap without bound.

`session.start()` returns a run handle with `events()`, `result`, `abort()` and a cursor, so a caller
can react to a turn while it runs. `AgentTurnOutcome` now carries only terminal statuses — the
`requires_action` variant was unreachable, and a remote worker that finishes a turn still holding an
unresolved request is reported through the session instead.

Also: client hooks are attributed to the turn that fired them rather than to the first busy session;
`session/tree` returns one subtree and `session/forest` the whole forest; trace subscriptions can be
released; attachments are rejected instead of silently dropped; errors carry stable string codes;
negotiated protocol limits are enforced; capabilities are versioned and declared only when supported;
and `bundled`/`path` hosts reconnect, re-registering everything and replaying from a cursor, without
ever re-sending a command whose outcome is unknown.
