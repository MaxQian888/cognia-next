---
"cognia-next": patch
---

The `wasm` plugin template no longer ships dormant. It declared `capabilities: []` while its `lib.rs` implemented a `tool_execute` export, so a fresh `plugin new --kind wasm` scaffolded a plugin whose tool code was never wired up. It now declares the `tools` capability with a `template_echo` demo tool — matching the ts/python/hybrid templates — so the scaffold is live out of the box, and a test pins the invariant. (The `vscode-extension` template keeps `capabilities: []`: its VS Code command is registered by the extension host at runtime, which no cognia manifest capability maps to.)
