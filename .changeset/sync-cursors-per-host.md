---
"cognia-next": patch
---

Stop two machines' data blending together after re-pairing a phone somewhere else.

Sync remembered how far it had got by table name alone, with nothing recording which machine a given position came from and nothing clearing it when a device paired to a different one. Re-pair a phone to another desktop — or to a server — and it resumed from the previous machine's position, asking the new one for "everything since a moment that means nothing here". The two machines' sessions, messages and characters then piled up in the same local store, silently and permanently.

Positions are now recorded per host, and the mirrored tables are cleared when a client starts talking to a different one. Those tables are a cache of a host's data rather than the device's own, so re-pulling them costs a little time and loses nothing. Device-local preferences are deliberately left alone.

Existing saved positions are discarded on upgrade: a position with no host recorded cannot be attributed to one after the fact, so the honest outcome is a single full re-sync rather than a watermark that might belong anywhere.
