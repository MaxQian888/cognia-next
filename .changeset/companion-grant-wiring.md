---
"cognia-next": patch
---

Pausing a device in the Device Console now suspends it instead of revoking it, so Resume can actually bring it back without re-pairing. Turning off a device's terminal access on a phone or browser no longer reports success while the host keeps serving that device: the grant reaches the host or the switch does not move, and the message says which machine to change it on. A cloud install also keeps its collaboration mirrors fresh now, which only the desktop was doing.
