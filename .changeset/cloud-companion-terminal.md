---
"cognia-next": minor
---

Enable the integrated terminal for a browser paired to a cognia-server. The terminal subsystem enumerated shells (Tauri/Capacitor) instead of asking the capability layer, so a cloud companion — which already reaches chat, sessions and git over the same companion transport, and whose profile declares server-backed `pty` — fell through to "Terminal unavailable". The transport picker, the WebSocket endpoint resolver and the remote spawn adapter now recognise a web companion target, and the dock gets a `cloud` empty state instead of the mobile "pair over LAN" copy.
