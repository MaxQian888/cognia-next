---
"cognia-next": minor
---

Terminal sessions now survive a window reload and an app restart. The PTY is owned by a separate host process instead of the app window, so reloading the UI reattaches to the running shell — with scrollback replayed — rather than killing it and starting over. Adds a host state banner that says when the host is starting, reconnecting or unavailable, terminal host profiles, and remote terminal access as an explicit per-device grant (existing paired devices start without it, so no previously granted control or agent permission silently authorizes a shell).
