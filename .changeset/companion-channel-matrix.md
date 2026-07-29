---
"cognia-next": minor
---

Settings → Mobile companion now answers "can my phone reach this machine, and how" in one table.

The four routes a paired device can take — the local network, local discovery, a public tunnel, and a direct WebRTC connection — each had their own card that knew only their own switch. Working out whether a phone could actually connect meant reading all four and knowing how they relate: that mDNS advertising a stopped server sends phones to a dead port, that a server bound to loopback is running but unreachable from anything else, that WebRTC switched on without a rendezvous server can never establish. Every one of those reads as "on" on its own card.

A Channels table now sits at the top of the section with one row per route: its state, the address a device would use, and the result of the last reachability test. It distinguishes a route that is simply switched off from one that is switched on but cannot work, and says which of those three reasons applies. A single badge in the header answers the summary question.

The separate "Connection diagnostics" card is gone. It ran the same reachability probe but printed a flat list of URLs with no indication of which route each belonged to; the test button now lives in the Channels table and its results are attributed to the route they came from.
