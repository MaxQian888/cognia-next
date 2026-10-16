# Managed cloud desktop — Phase 3 dependency check

Date: 2026-10-15. The user authorized Phase 3 only after the delivery dependency is ready, with Rust validation still skipped and real-provider smoke separately gated. This check changes documentation only. No handoff, provider operation, dependency-file edit, worktree rebase or merge was performed.

## Follow-up implementation

The user subsequently authorized completing D1b and then Phase 3 on 2026-10-15. That implementation is recorded in [the Phase 3 verification report](./2026-10-15-managed-cloud-desktop-phase3-verification.md). The original check below remains as historical evidence of why provenance had to be added; it is not the current implementation status. Native validation and real-provider qualification remain unverified.

## Original decision

**The delivery ledger is merged; the authoritative source binding required by ADR-0228 is not ready.** Separate these two gates. Do not treat a delivery list entry or an agent ID as proof of ownership, repository authority or the originating run.

| Evidence                        | Observed value                                                                                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delivery implementation commit  | `ff3c51c617deb351caf07415d25d4b59467e6fe0` — `feat(sandbox): persist remote sandbox delivery and cleanup outcomes`                                             |
| Local integration branch        | `dev`, inspected at `740f76e4b23ee3ddab78ab94be28ce1143706842`                                                                                                 |
| Live remote branch              | `git ls-remote --heads origin dev main` returned `6f52d4f356d477f2786ad57c41442878417ffa35` for `refs/heads/dev`                                               |
| Remote ancestry                 | `git merge-base --is-ancestor ff3c51c617deb351caf07415d25d4b59467e6fe0 6f52d4f356d477f2786ad57c41442878417ffa35` exited 0                                      |
| Read API registration           | `environment_delivery_list` exists in the implementation and committed command catalog, including commit `87bb41926`; capability is `host.observe`             |
| Shared dependency paths         | Scoped status was clean for `crates/cognia-sandbox-pool/`                                                                                                      |
| Desktop implementation worktree | Still based on `6bf654a73ad004b88a4ec0e2e82c7141eec62839`, with the owned Phase 1–2 work retained; the new dependency was not copied or partially transplanted |

These are observations from this check, not a promise that moving branches remain at these revisions.

## What the committed contract provides

`crates/cognia-sandbox-pool/src/delivery.rs:44` persists a unique delivery ID, agent ID, optional task ID, provider/instance IDs, branch, optional exact commit, publish/cleanup states, timestamps and revision. `DeliveryStore::list` survives pool disablement and restart. Exact-ID selection can be implemented over that API; lack of a public `get` is not itself a blocker.

The producer at `crates/cognia-sandbox-pool/src/docker/remote_prep.rs:799` writes the record before starting the remote session. The delivery ID is a unique remote-session identity, not a reusable agent ID. Its optional task ID comes from authenticated gateway authority.

Recovery exports preserve a bundle and a best-effort sibling manifest. The manifest contains repository URL, base ref/base commit, exact commit and provider/instance/agent metadata. Its write failure is tolerated, and the returned recovery payload does not include the manifest path. The committed producer's `MAX_RECOVERY_BUNDLE` is **512 MiB**, matching the ADR's import ceiling. Computing a bundle hash, inspecting prerequisites and verifying imported objects are normal Phase 3 work, not separate missing dependencies.

## What cannot be recovered authoritatively

| Required binding                               | Current evidence and limitation                                                                                                                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Owner and Host deployment at delivery creation | Absent from `TaskDeliveryRecord`. A directory on the currently authenticated Host cannot establish the historical owner after account rebinding.                                                                                     |
| Source conversation and coding run             | Absent from the delivery. `crates/cognia-external-agent/src/spawn_authority.rs:7` carries task/device plus an ephemeral authorization callback; task ID is not the execution-run ID.                                                 |
| Durable join after task/sandbox exit           | `lib/ai/agent/external/runtimes/remote/remote-run-service.ts:250,1009` uses in-memory run/session maps. `docker/retained_tasks.rs:7` persists cleanup identity, not the missing source binding.                                      |
| Authorized repository for a pushed commit      | The running checkout holds repository metadata in memory. Published delivery records do not preserve a normalized repository identity or Host credential reference. Branch/commit alone does not identify the authorized repository. |
| Complete source authority for a bundle         | The optional recovery manifest supplies Git context, but not owner/conversation/coding-run provenance. Its presence cannot repair those absent facts.                                                                                |

`environment_delivery_list` (`src-tauri/src/companion_api/rpc/environment.rs:199`) lists the Host directory with optional agent/task filters; it does not perform the missing source-owner join. Existing `lib/db/execution-runs.ts` child-run/binding helpers can be reused later, but browser-supplied IDs or browser-local history are not a substitute for Host authorization of the delivery.

## Required prerequisite before handoff implementation

Persist a versioned provenance binding **at the original task's authenticated admission**, before remote execution can produce a delivery:

1. Bind owner account, Host deployment, source conversation/task/coding-run and normalized repository identity through the existing trusted task authority. Resolve a Host-owned credential reference; never serialize credential values.
2. Carry that trusted binding through remote spawn and persist its identity with the unique delivery. Do not merely add caller-controlled optional fields to `delivery.rs`.
3. Resolve a selected delivery by immutable ID and revision through that binding, then reauthorize the current caller against the source. Prove the binding survives Host restart, sandbox removal, reused agent IDs and account changes.
4. Refuse legacy or orphaned records without sufficient provenance. Never backfill them from the current login, mutable agent state or browser assertions.
5. Record the implementing commit and scoped contract evidence, then carry the owned Phase 1–2 changes onto an isolated integration checkout without changing the shared working tree.

After that gate, proceed with the already accepted Phase 3 work: explicit read-only Git proxy, pinned-commit reconstruction, bounded recovery import, acceptance-file transfer, child-run binding and the human-triggered proposal UI. Production handoff still stays dormant until Phase 4 evidence/deletion support and the relevant authorized smoke pass.

No Rust build/test, provider smoke or billed operation was run. No Phase 3 application code or changeset was added because its dependency gate is still open.
