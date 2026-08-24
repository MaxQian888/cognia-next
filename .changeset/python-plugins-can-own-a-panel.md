---
"cognia-next": minor
---

Python plugins can now contribute a right-rail panel, and any plugin can hand the chat composer its own material.

Context panels stop requiring a JavaScript module. Two declarative kinds join the manifest: `kind: "a2ui"` renders a surface the plugin builds and pushes as data, and `kind: "chat"` renders the resource conversation grounded in text the host fetches from one of the plugin's own tools. Neither needs code running in the renderer, so both work identically from TypeScript, Python and hybrid plugins — the Python reference plugin now ships one.

The A2UI catalog gains `Markdown` (the same renderer chat messages use, so Mermaid diagrams, syntax highlighting and the sanitize policy come with it) and `Tree` (arbitrary-depth navigation, where the existing `Sidebar` was fixed at two levels).

`ctx.chat` grows a write surface — `addContextSelection`, `appendToComposer` and `stageIntent` — behind the `session:write` permission, plus a new "plugin" context-selection chip that carries the workspace file and line numbers an excerpt came from, so the assistant can open the code a plugin's prose is about.

Also fixes `ctx.a2ui`, which could create a surface and fill it but never mark it renderable: `setReady` now sends the protocol's own `surfaceReady` message.
