---
"cognia-next": patch
---

VS Code extensions now have the globals they expect: `queueMicrotask`, `structuredClone`, `AbortController`, `performance`, `atob`/`btoa`, `crypto`, `Blob`, `FormData`, `Headers`/`Request`/`Response`, `MessageChannel` and Node's `global`. `fetch` works for an extension that has the `network:fetch` permission and `WebSocket` for one that has `network:websocket`; without them they refuse with a message naming the permission, and the extension's log records it. Using either now asks for that permission at install. Extension traffic (`fetch`, `WebSocket` and the `http`/`https` modules) goes through the proxy you configured, and nowhere at all when the proxy settings are unusable.
