---
"cognia-next": minor
---

Give cross-device work one answer to "where does this run?", and stop two hosts from firing the same schedule.

Four subsystems each decided placement for themselves, and two of them decided it wrong. `action.mobile.*` sorted paired devices by last-seen time and never checked it, so a phone last seen days ago won the sort, absorbed the dispatch, and blocked the run for two minutes before failing — without trying the next candidate. Workflow capability preflight had the same omission, so a run passed the gate and then hung. Both now use one liveness rule, aligned to the same 90-second window the host uses to decide a worker went idle, and mobile steps fail over to the next live device (a device-side denial or cancel is still final — that is the device's answer, not an outage).

The scheduler's `isTimingAuthority()` returned true unconditionally whenever the timing driver had no leader election, which is every driver in production: two desktops signed into one account each armed the same cron and each fired it. Timing now defers to an explicitly configured execution authority, with unconfigured meaning self-authority so a single-machine install is unchanged. Cron double-fire is closed by making the work identifiable rather than by electing an owner — triggers now carry a deterministic idempotency key derived from the workflow, the trigger, and the scheduled instant, so the existing invocation ledger absorbs the duplicate. The ledger was already sound; it was being bypassed, because `dispatchTrigger` passed no key at all and the scheduler keyed on a per-host execution row. When a configured authority stays unreachable the work runs locally and says so, in both the notification center and the run's event log.

Run leases stop travelling and stop outliving their host: sync no longer copies a lease whose expiry is an absolute timestamp from another machine's clock, and a desktop that quits hands back what it held instead of leaving the run unclaimable for the rest of the lease TTL.

Also adds `hostDispatchQueue` (Dexie v175), a durable host-to-target outbound queue mirroring the client-to-host one, with enqueue-once enforced by a unique index rather than by a non-atomic read-then-write.
