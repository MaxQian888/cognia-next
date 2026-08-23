---
"cognia-next": minor
---

Run control, verification results, and approval auditing now work everywhere they claim to.

Stop / Pause / Resume / Steer previously stopped working whenever a remote host was active or a second window held the connector runtime's lease, because the run-control dispatch table was installed inside that runtime and torn down with it — every control silently reported "unsupported". It is now installed independently and refcounted, so no owner can disarm it for another.

Test runs a chat turn performs are projected onto the run as a verification result (passed / failed / skipped / total / duration). Output that cannot be parsed is reported as inconclusive and never as a green run; the raw output and the command line stay out of the run journal.

Background subagent and plugin-agent tasks now appear in the unified execution monitor as background tasks, with a working Stop, instead of being invisible to it.

Tool approvals now write a durable action-review receipt and park the owning run on a pending interrupt, so a blocked run is visible and its decision is auditable. Each receipt records who authorized it — a person, a rule, a policy deny, or the system — and "always allow" is recorded as the standing rule it creates.
