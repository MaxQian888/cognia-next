---
"cognia-next": minor
---

Plugin DevTools can now reload a plugin when its files change on disk, without the CLI running. `/plugins → Devtools` gains a "Watch plugin folders" switch: a change under a locally-sourced plugin's install directory puts it through the same verified reload the CLI uses, so success is still only reported once the runtime reports a new active generation. Every plugin is listed with whether it is watched and, if not, why: `wasm` and `vscode-extension` plugins need a build the app cannot do and still need `cognia plugin dev`, and a plugin installed from a package has no source folder to watch. This replaces a 546-line hot-reload module that no production code called and that would not have worked if it had, because it sent the watch command a flat payload where Tauri expected the arguments nested under `args`.
