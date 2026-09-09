---
"cognia-next": patch
---

App-side `dispatch_agent`: a child now runs in the same working directory as its parent session (so it discovers the project's CLAUDE.md and resolves relative paths correctly), a definition's `disallowedTools` and `effort` reach the executor, and the `/agents` slash command opens the subagents settings instead of the characters panel.
