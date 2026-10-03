---
"cognia-next": minor
---

VS Code extensions can now open terminals. `window.createTerminal` opens a tab in the terminal dock, named as the extension asks: a shell (your default, or the one the extension names, with its arguments, folder, environment and tab color) that `sendText` types into, behind the extension's terminal permissions, or an extension-driven terminal (`Pseudoterminal`) that shows what the extension writes and hands it what you type and the tab's size. `show`, `hide` and `dispose` work, and an extension sees its own terminals through `window.terminals`, `activeTerminal` and the open, close, active and state events, including whether you, the extension or the process ended each one. Your own terminals stay out of extensions' sight. Shell integration, `strictEnv` and the `message`, `location` and `iconPath` options are not supported.
