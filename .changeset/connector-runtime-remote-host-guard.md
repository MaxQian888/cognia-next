---
"cognia-next": patch
---

Fix duplicate IM bot activity when a desktop is driving a remote Cognia host. The desktop no longer boots its own connector runtime while a remote host is active — the paired host's brain owns the connectors, so running a second copy locally would double-dial the same bots (duplicate inbound events and duplicate outbound replies on the same account). The local runtime is torn down when a remote host is activated and reclaimed when routing returns to local.
