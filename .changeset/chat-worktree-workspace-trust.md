---
"cognia-next": patch
---

Chat turns in a managed worktree, or in an isolated working copy, now carry the workspace's trust grant onto the worktree they run in. Native SDK skills and plugins load there again instead of failing with "claudeAgentSdk skills/plugins require an explicit trusted workspace root for this send". A worktree inherits trust only from the exact workspace root it checks out.
