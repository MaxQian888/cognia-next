---
"cognia-next": minor
---

Workspaces can now choose which skills and MCP servers they use. The library stays machine-wide; a workspace records only its own deltas, and anything left on Inherit keeps following the library. A conversation resolves its capabilities from the workspace that owns it — including background turns and scheduled runs — so a repo's tools stop depending on which workspace happens to be on screen.
