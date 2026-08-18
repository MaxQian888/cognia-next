---
"cognia-next": minor
---

`WorktreeCreate` / `WorktreeRemove` hooks now fire.

Both events have been in the hook catalog and settings UI, but nothing ever
produced them — a hook subscribed to them got silence. They now fire from every
place a worktree is created or removed: the managed-worktree Registry (once a
worktree is locked and Active, and when it is discarded or pruned), the Agent
Team workspace allocator, and the source-control worktree panel. The payload
carries `worktree_path`, `workspace_root`, `branch`, `owner_type`, `owner_ref`,
`source` and, on removal, `reason`; both are observational and never block the
git operation. Materialized shadows of non-Git roots do not emit.
