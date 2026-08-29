---
"cognia-next": minor
---

Session import now reads a coding agent's whole session graph instead of one flattened transcript. Parent/child relations, lifecycle state, tasks, plans, goals, history and inter-agent events are preserved on the imported conversation and stay available to the attached-session and diagnostics surfaces after the dialog closes. Ownership of an imported conversation is explicit — a source mirror, Cognia-owned after you continue it, or bound back to the original runtime — and a capability-gated **Resume** hands continuation back to the agent that created it when that agent is connected and verifiably supports resuming. Children that disappear from a later snapshot become recoverable tombstones rather than silent deletions, re-imports diff on real content instead of message count, and Cline, Copilot CLI, Cursor and Qwen Code join the supported sources alongside a portable agent format and a per-source support matrix.
