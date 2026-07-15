---
"cognia-next": minor
---

Add an optional blocking review step to Agent Team runs (Settings → Governance → "Lead reviews each task"). When enabled, the team lead reviews every task's work — and a diff of what it actually changed on disk, not just the teammate's summary of it — before any dependent task is allowed to start. Work the lead rejects goes straight back to the same teammate, in the same workspace, with the lead's feedback, and is reviewed again; two revision attempts by default. A task that cannot be approved fails the run rather than quietly being built on.

Previously nothing could stop a team from building on bad work: the GitHub PR reviewer only runs after everything has finished, and the existing result-review setting is a human gate that dependent tasks ignore. That setting still applies and composes with this one — when both are on, an approved task waits for you on the board instead of completing.

Off by default; a team that doesn't enable it behaves exactly as before.
