---
"cognia-next": minor
---

Pro IDE (embedded code-server) now drives the editor bidirectionally with the agent. A side-loaded companion VS Code extension talks to the app over a loopback control channel, so: the agent's file opens/reveals land in the live VS Code window (no CLI cold start); a completed agent write is reflected as an undo-able in-editor edit (a live diff) instead of a bare external reload; and the agent can pull a new `read_active_editor` tool to see what you're looking at — the focused file, selection and selected text, that file's diagnostics, and the open editors — PII-gated before it reaches the model, and only when a workspace is present. Also fixes two Pro IDE gaps: file reveals no longer open in a hidden Monaco editor while code-server is the active engine, and losing the shared code-server pane to another editor tab (or an explicit stop) now shows a toast instead of silently falling back to Monaco.
