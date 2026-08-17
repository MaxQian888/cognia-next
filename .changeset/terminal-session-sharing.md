---
"cognia-next": minor
---

Terminal: share a hosted session with paired devices.

The terminal dock gains a **Share** button (desktop host only). Its dialog
shows who is attached to the session right now — the host's live participant
roster with the controller / viewer lease role — and lists every paired device
with its remote-terminal grant as a switch. Turning the grant on lets the device
attach to this host's terminals over the existing companion link and contend
for the same controller lease the desktop uses; turning it off drops a live
attachment within a second. The session status chip now reports "Shared with N
devices" and lists them. The host broadcasts the roster whenever a client
attaches, detaches, or the lease moves, so every window sees the change without
polling. No links or tokens are minted; access is the existing per-device
grant, which is device-wide rather than per session.
