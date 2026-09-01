---
"cognia-next": patch
---

Two owner capabilities that granted nothing are now labelled as dormant everywhere they appear instead of reading as security controls, and the RPC parity gate now fails on device-reachable commands that answer "use the desktop app" while running on one. Both classes were already at zero, and this stops them coming back silently.
