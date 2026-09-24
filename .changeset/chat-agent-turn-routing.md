---
"cognia-next": minor
---

Address one turn to a specific runtime from a direct chat: start the message with `@codex`, `@claude` or a Squad member's handle and that turn runs there — Codex on a configured Codex agent, Claude on the built-in lane, a member as that member with its own model — while the conversation keeps its own runtime for the next message. Typing `@` at the start of a message lists these under Runtimes and Squad members, each showing whether it can answer here and why not; the handle is tinted before you send, and a turn that cannot run (no Codex agent set up, external agents off, a member removed, a reply still running, or nothing after the handle) is refused with the reason and a "Set up" shortcut, keeping your draft. The reply says "via @handle", regenerate and edit keep the same runtime, and a runtime picking up a conversation after others answered is handed what it missed.
