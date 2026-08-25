---
"cognia-next": patch
---

Instrument repository cloning and task-workspace provisioning. The `/performance` panel's span table now reports `git.clone`, `git.clone_guarded`, `workspace.acquire_bundle`, `workspace.acquire_root`, `workspace.begin_run`, `workspace.create_execution`, `workspace.apply_provisioning`, `workspace.resolve_git_base`, `workspace.snapshot_capture`, and `workspace.snapshot_materialize` — previously these paths had no timing at all, so there was no way to see which part of starting a task was slow. Failed clones are recorded as errors rather than counting toward the success percentiles.
