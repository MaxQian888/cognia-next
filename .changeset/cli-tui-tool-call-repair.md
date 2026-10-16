---
"cognia-next": patch
---

Repair near-miss tool calls from relayed models (a miscased tool name or another agent's argument name such as `path` for `file_path`) instead of failing them, and tell the CLI agent to call only the tools it was given.
