---
"cognia-next": minor
---

A paired device that has not checked in for 30 days no longer keeps a permanent WebRTC relay connection open. The desktop holds one relay socket per paired device, and nothing ever pruned the paired-device list, so reinstalls, dev pairings and retired phones accumulated until one real session was holding sixteen at once. The pairing itself is untouched: the record, its keys, its permissions and its grants all stay exactly as they were, and the device reconnects on its own the next time it checks in.

The device console now has a WAN connection card for each paired device saying whether a connection is being held and, when it is not, which of six reasons applies. "Idle for 30 days", "paused", "paired before relay connections existed", "the master switch is off" and "this shell does not manage relay connections" were previously indistinguishable from a device that simply never answered. Only the first is one click away, and its Connect now button starts a connection on demand, lasting until the device checks in or the app restarts.
