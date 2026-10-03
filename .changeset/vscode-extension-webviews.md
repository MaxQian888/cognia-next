---
"cognia-next": minor
---

VS Code extensions' webviews now work. Webview panels and webview views appear as tabs in the extension rail beside the main content, in a sandboxed frame that follows the app's theme (with VS Code's `--vscode-*` variables). The extension's scripts run and its files load from its own folder and the workspace (`localResourceRoots`), including files it loads later, `acquireVsCodeApi()` with saved state works, messages flow both ways, links open after you agree (or run the commands the webview allows), and a view is filled the first time you open its tab. Panels can be closed, and a tab can keep its page alive while hidden when the extension asks. Remote resources, relative imports between script modules, `portMapping` and restoring panels after a restart are not supported.
