---
"cognia-next": patch
---

Connections: when a platform rejects a connection's credential, the adapter now shows "Re-authenticate" (in the inbox badge and the Connections list) instead of a generic "circuit open", and it is no longer restarted in a loop by the health probe. OneBot edits now fall back to sending a new message instead of failing.
