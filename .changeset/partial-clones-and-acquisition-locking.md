---
"cognia-next": minor
---

Repository clones are no longer shallow. `--depth 20` truncated history, and a truncated history cannot be rebased past its boundary — the operation a branch stacked on another branch has to perform whenever the branch below it moves. Clones now use `--filter=blob:none --single-branch`, which keeps the whole commit graph and skips only historical file contents. Applies to the GitHub workspace path (Issue→PR loop, agent delivery) and to E2B sandbox workspaces.

Two workspace acquisitions for the same repository no longer race. They run in parallel on the blocking pool and both drive `git worktree add`, which collided on Git's `index.lock` and failed with an error unrelated to what the caller asked for; acquisitions are now serialized per repository. A `remoteDefault` base also stops refetching the remote on every acquisition — a fan-out of tasks over one repository shares a 30-second freshness window instead of making one network round trip per task.
