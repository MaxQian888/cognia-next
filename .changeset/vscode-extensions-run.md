---
"cognia-next": minor
---

VS Code extensions now actually run as Cognia plugins: an installed `.vsix` loads from its own install root, `require("vscode")` resolves to the shim (sensitive Node modules stay permission-gated), the extension context carries real storage paths and a persisted `globalState` / `workspaceState`, a crashed extension host restarts with backoff before the plugin is marked errored, its stderr shows in Plugin DevTools, and uninstalling removes the extension's install and state.
