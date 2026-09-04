---
"cognia-next": minor
---

Built-in plugin templates now cover far more of the plugin API. The TypeScript scaffold wires settings, durable storage, a quick action, a workflow node and trigger, and lifecycle teardown alongside its tool, command and UI slot. The Python scaffold adds host calls through `ctx`, lifecycle hooks, progress reporting and an A2UI context panel. The hybrid scaffold now calls its own Python backend from JavaScript. The WASM scaffold reads a per-plugin secret, declares the workflow node its `workflow-node-execute` export always implemented, and shows how to branch on the host's error codes. The VS Code scaffold registers a command and a completion provider, and documents which parts of the `vscode` surface this Host does not answer yet — output channels, status bar items and message boxes among them — so a generated extension activates cleanly instead of logging capability errors.
