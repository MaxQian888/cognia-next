---
"cognia-next": patch
---

Fix a paired browser or phone never bringing its Host online. The Host stores
host-state under its own runtime target, but every client addressed it by the
id it filed the pairing under, so the Host refused each `host_state_*` call
with `host_state_scope_mismatch` and the client retried the manifest forever —
"Host is offline" with a spinner that never resolved. The Host now declares the
scope its state actually lives under, clients address it that way, and the
refusal names which of its six causes fired instead of one sentence for all.
