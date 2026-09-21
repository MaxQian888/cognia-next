---
"cognia-next": minor
---

Welcome composer context bar: a fused strip on the new-chat composer's top edge exposes, in order, the project environment (from the workspace's `ProjectEnvironment` definitions), the repository root (multi-root workspaces can pick; local mode offers real `git checkout` branch switching), and worktree execution (off / auto-named / manually named — the manual name becomes the worktree directory and branch, validated client-side and enforced again by the host). IM completion notifications live at the strip's right end: on/off, which bound connector conversation to ping, and which run events (done / error / needs input) fire it. Sessions created while the toggle is on are armed and pushed through the existing notification pipeline on settle, so PII gating, opt-in, dedup, and the durable center record all apply.
