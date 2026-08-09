---
"cognia-next": minor
---

Add `cognia-agent x <claude|codex>` command to launch external coding agents (Claude Code, OpenAI Codex) through cognia's model gateway. Routes the agent's API calls through the desktop Rust gateway (or a fallback Node.js proxy), enabling credential sharing, provider routing, and model management without modifying the external tools. Includes interactive model picker with preference memory, CLI detection with install hints, and passthrough argument support.
