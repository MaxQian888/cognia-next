---
"cognia-next": patch
---

Stop a paired client hammering a Host that has already refused it. The Web boot
loop retried the feature manifest on the same schedule whether the Host had
dropped a packet or rejected the request outright, so a deterministic refusal
was retried forever — spending the device's remote-execution quota until the
Host answered 429 to everything, a second failure that hid the first. The loop
now reads the `retryable` verdict the Host already sends on every refusal, and
waits the interval it names in `Retry-After` instead of its own.

Also fixes `sync_pull` refusing three tables the Host serves: `plans`,
`connectorDrafts` and `outboundQueue` were missing from the hand-written
request contract while `sync_list_tables` advertised all 25, so pulling them
was a 422 that broke pairing's authoritative sync. The contract is now pinned
to the table catalogue by a test.
