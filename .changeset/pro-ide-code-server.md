---
"cognia-next": minor
---

Add an optional desktop "Pro IDE" mode to the Agent Team Project Editor: a full browser VS Code (code-server) embedded alongside the built-in Monaco editor. A new engine toggle in the editor header switches between Monaco and code-server, which is downloaded on first use (streamed with progress, SHA-256-verified against a pinned version) and served from a loopback-only port with a dedicated native webview pinned over the pane. macOS and Linux only — the toggle is disabled on unsupported platforms with a hint to use your local VS Code instead. The Monaco editor, the in-app browser, and the web/mobile shells are unchanged.
