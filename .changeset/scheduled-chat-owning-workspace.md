---
"cognia-next": patch
---

Scheduled chat, agent and skill runs now resolve against the workspace that owns them, never the one open in the UI. They pick up that workspace's custom instructions, CLAUDE.md/AGENTS.md from every root, project knowledge, and additional directories, the same as an interactive turn. Workspace confinement now covers the run's worktree aliases and the task's own extra directories.
