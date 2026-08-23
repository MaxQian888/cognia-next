---
"@cognia/agent": minor
---

Add content-addressed assets, and stop calling a sandbox policy record a snapshot.

`client.assets` uploads bytes or registers a host-visible path, and a turn then carries
`{ assetId, digest, mediaType, byteLength }` — never bytes and never a host path, so neither reaches
the canonical event log that gets replayed, exported and shared. Storage is content-addressed, so
identical bytes yield one id; a registered path is not copied, and the host refuses to read it later
if it changed underneath. Bytes or a path smuggled onto a reference are rejected.

Two capabilities rather than one: `assets-v1` means the store works, `assets-in-turn-v1` means the
agent runtime can read an asset during a turn. This host declares the first only, so a turn carrying
`assets` is refused instead of run without them — the failure mode `attachments` used to have.

`sandbox/snapshot` captured the resource policy and nothing on disk, so it is now
`sandbox/policy/capture` / `sandbox/policy/restore`, returning a `SandboxPolicyRecord`, and the
client methods are `captureSandboxPolicy` / `restoreSandboxPolicy`. `workspace-checkpoint-v1` stays
reserved and undeclared until a backend actually implements filesystem checkpointing.
