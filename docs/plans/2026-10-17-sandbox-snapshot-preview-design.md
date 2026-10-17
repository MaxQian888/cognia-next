# Sandbox snapshots, fork and preview links (S7)

Date: 2026-10-17. Follows `2026-10-16-agent-sandbox-workspace-gap-analysis.md`.
Design review: a read-only Codex pass against `dev` at `966a71933e`.

Correction to the gap analysis: an authenticated port proxy already exists
(`crates/cognia-companion/src/environment_ports.rs`, device + workspace checks,
HTTP and upgrades over `open_port`), and Settings can open a port externally.
What is missing is a snapshot/fork of a local sandbox and a short-lived,
revocable preview link with its own origin.

## Defaults adopted (2026-10-17)

- Cold filesystem checkpoints only: an active agent/task turn returns
  `snapshot_busy`; no process or memory state. In-place restore only for an
  archived/restorable workspace; otherwise restore means fork.
- Capture everything in the workspace (tracked, untracked, ignored, generated)
  except exclusions the user declares; exclusions are listed in the manifest.
  Over budget fails instead of silently dropping content.
- A separate `sandboxSnapshotBudgetBytes` (default 1 GiB) next to the existing
  1 GiB blob budget; 30-day retention and pinning as for workspace snapshots.
- Preview links serve this machine and paired devices only. No anonymous
  public links.
- Capabilities live 15 minutes by default, 1 hour at most; a copied link
  redeems once.

## Snapshot = rootfs image + workspace checkpoint

- `docker commit` of the stopped container (system packages, global installs,
  home) plus an immutable Task Workspace checkpoint of the host-mounted
  workspace via `snapshot.rs` (a new full capture profile, empty directories
  and modes, a mandatory per-checkpoint Git ref pin). The bundle is recorded
  by digest and re-mounted. tmpfs, sockets and running services are not part
  of a snapshot.
- Ledger tables in `task-workspaces.sqlite`: `workspace_checkpoints`,
  `sandbox_snapshots`, `snapshot_artifact_refs`, `snapshot_operations`
  (journal `preparing → workspaceCaptured → imageCommitted → ready`, with
  compensation on failure). Images are named
  `cognia-snapshot-<deploymentHash>:<uuid>` and identified by image ID; labels
  never authorize anything.
- **Fork**: a new task/workspace and execution root restored from the recorded
  commit + checkpoint overlay, a new port lease (ADR-0229), a new container
  from the snapshot image. No source mounts, leases, grants, sessions or egress
  bridges are copied. Lifecycle hooks: only postStart/postAttach run again.
- Reaper: tombstone, revoke previews, delete images of this deployment with no
  runtime/fork/in-flight references, then release checkpoint pins and blobs.
  Never `docker system prune`; never touch another deployment's images.
- E2B: capabilities split into `filesystemCheckpoint`, `forkFromCheckpoint`,
  `pauseResume`, `memoryResume`; E2B keeps pause/resume, fork stays
  unsupported until its API is verified.

## Preview links

- `PreviewGrantV1` (Host-owned): target = provider + container + runtime
  generation (or a tracked host dev service), port, port lease, audience
  (local owner or one paired device), expiry, revision. The capability is
  ≥256 bits and stored only as a hash.
- A dedicated loopback preview listener with one hostname per grant
  (`p-<id>.localhost:<port>`), so app cookies never share an origin with the
  companion API or each other. `/__cognia_bootstrap#<token>` exchanges a
  one-shot 60 s token for an HttpOnly host-only cookie, then navigates to `/`.
- Every HTTP request and WS upgrade re-checks grant, generation, port approval
  and device; revoke/expiry closes live bodies, SSE and WebSockets. Process
  restart invalidates all capabilities. Proxying reuses the
  `environment_ports.rs` forwarder over `open_port` (works with S4's
  `network=none`), with no Docker port publishing.
- Ports: an approved fixed port or a `workspace-lease-offset` resolved against
  the target workspace's lease, so a fork's preview follows its new block.
- Paired devices: capability ∩ paired-device grant ∩ workspace permission,
  with a separate per device/project/port approval. LAN via the existing
  native relay; WAN via a bounded preview stream adapter on the encrypted
  carrier (OPEN takes only a grant id).

## Phases

1. Ledger + checkpoint capture profile, Docker commit, cold snapshot / fork /
   restore, budgets and reaper, preview grants with a local origin, embedded
   browser + Settings/workspace UI, both locales.
2. Paired-device previews (approval, LAN relay, WAN stream adapter), E2B
   capability negotiation, audit events and metrics.

Docker commit/inspect availability through the socket proxy and `*.localhost`
resolution in the target WebViews must be verified live; unverified
environments are reported as such.
