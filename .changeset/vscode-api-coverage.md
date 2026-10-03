---
"cognia-next": patch
---

The warning a VS Code extension's card shows when it uses APIs Cognia lacks now names the exact calls (for example `vscode.window.createTreeView`), not only whole namespaces like `vscode.debug`, measured against the full VS Code 1.91 API the extension host implements.
