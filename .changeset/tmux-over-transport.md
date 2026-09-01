---
"cognia-next": minor
---

A browser or phone paired to a Host can now see and attach to that Host's tmux sessions. The three tmux commands were already remote-reachable, but the client library called Tauri's IPC directly and short-circuited to "no multiplexer" off the desktop, so paired clients were told a machine running tmux had none.
