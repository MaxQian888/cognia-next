---
"cognia-next": minor
---

VS Code extensions can now use the clipboard (with the clipboard permissions you grant), open links, and receive app links. `env.openExternal` asks before opening a web or mail link in your browser (or copies it if you prefer), sends `cognia://<extension id>/…` links to that extension, and opens a file in its default app only for an extension allowed to run programs. `env.asExternalUri` turns an extension's `cognia://` callback into a link your system routes back to it (through the app's deep-link page in a browser), and `window.registerUriHandler` receives those links, activating the extension on demand, which makes sign-in flows that return to the extension work.
