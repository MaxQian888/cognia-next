---
"cognia-next": minor
---

`"async": true` on a `command` hook handler is now honoured on every rail (sidecar, desktop Rust, CLI): the command is spawned detached with the event payload still piped on stdin, but the runner never waits on it — output can neither block the action nor inject context. The settings UI exposes a "Run in background" toggle for command handlers, and async failures are reported through the hook audit channel instead of blocking the turn.
