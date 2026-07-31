---
"cognia-next": patch
---

Four fixes to cross-device behaviour that had been built but did not hold.

"Delete from here" on a phone deleted only the handset's own copy. The paired desktop still held every message, so the next sync pulled them straight back — the one deliberately destructive action in the conversation view silently undid itself. The deletion is now fanned out to the host first, the same way editing and resending a message already did it.

Evaluation defaults set on a phone never reached the desktop. `/me/eval` edits the judge model, run count, gate thresholds and cost guard, but the field was classified as never crossing the wire in either direction — so the phone showed the built-in defaults rather than the host's real configuration, and every change stayed on the handset while the runs those defaults govern executed on the desktop.

A refused attempt to run an agent on a host left no trace. The permission's contract is that every start and every refusal is recorded with the device that asked; the policy checks inside the spawn path were recorded, but the authorization gate an ungranted device actually hits returned its refusal before reaching any of them — so an unauthorized device probing the execution plane was the one denial that went unlogged. Both the HTTPS and WebRTC paths now record it.

The companion channel table reported mDNS as "blocked — server stopped" when mDNS was simply switched off and the server happened to be down. "Blocked" means the channel is on but something upstream is breaking it, which points at a fix that would not have helped: starting the server does not make a disabled advertiser advertise.
