---
"cognia-next": patch
---

Scheduled goals now run against the workspace that owns their conversation, never the one open in the UI. Each turn picks up that workspace's custom instructions, CLAUDE.md/AGENTS.md from every root, project knowledge, and additional directories, the same as a scheduled chat turn, and workspace confinement now applies. Goals started from an IM conversation still run without a workspace, like the rest of that conversation.
