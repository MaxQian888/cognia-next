---
"cognia-next": patch
---

The desktop no longer rebuilds every paired device's WebRTC signaling connection whenever an unrelated setting changes. The renderer re-pushed its signaling configuration on every `AppSettings` write, because the settings row is a single Dexie record, so a theme change (or any of the ~169 `saveSettings` call sites) re-fired the live query. The Rust hub then applied each push by tearing down one WebSocket per paired device and re-running each one's full challenge / signature / key-exchange handshake. Both sides now compare before acting, so an unchanged configuration is a no-op.

A device that is _paused_ also stops holding a signaling connection open: pausing already puts it on the deny-list, so the socket could never serve a request. Cancelling a signaling client is now observed during its connect and handshake instead of only after, which removes a race where a torn-down client could reclaim the room and knock its own replacement offline. Finally, an established socket that the network drops is logged quietly and only escalates after ten consecutive losses, so ordinary WAN churn across many paired devices no longer buries real failures.
