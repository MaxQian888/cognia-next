---
"cognia-next": minor
---

A repository can now describe its own workspace, and Cognia reads it. `.cognia/workspace.json` — whose parser, validator and merge had been written in full and called by nothing — supplies setup steps, reusable actions, environment variables, required secrets, extra roots, an execution default and suggested skills/MCP servers to everyone who opens the repository, so a new contributor stops having to be told the setup out of band. Managed worktrees additionally honour `sparsePaths` (cone-mode sparse checkout), `cacheLinks` (a symlinked package cache instead of rebuilding it every acquisition) and `include` (the gitignored files a build needs, which a fresh worktree lacks).

Because the file ships shell scripts, it is gated twice: an untrusted checkout's file is never read, and a trusted one's content must be approved — so a setup script that arrives in a later `git pull` cannot run on a folder you trusted months ago. The environment panel always states what is happening, including "this repository ships none", and shows the setup script verbatim before offering to approve it. Non-script declarations (roots, capabilities, execution defaults) are seeded once and never re-applied, so removing or changing one sticks.
