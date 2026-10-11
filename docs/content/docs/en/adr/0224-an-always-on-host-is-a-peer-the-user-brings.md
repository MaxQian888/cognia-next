---
title: "0224 — An always-on host is a peer the user brings"
description: "A user-provided machine (a VPS, a NAS, a home Mac mini) runs the headless cognia-server and brain as an always-on host. It is a peer of the desktop, not a server the desktop becomes a client of. Bots, connectors and scheduled tasks are owned per item and can be moved to it; phones and desktops reach it over the relay without a public domain; dispatched work runs in a container by default; secrets travel over the paired channel and are sealed on the host; unattended approvals are declared, relaxed inside the sandbox and parked when they need a person. Phase A ships a standalone host with manual ownership. Phase B moves ownership onto ADR-0215 execution leases with automatic failover. Phase C adds team execution nodes."
---

# ADR 0224 — An always-on host is a peer the user brings

**Status:** Accepted
**Date:** 2026-10-10
**Related:** [ADR-0059](./0059-cloud-deployment-headless-brain) (the headless brain), [ADR-0215](./0215-one-person-one-encrypted-sync-space-many-writable-hosts) (§8 execution leases), [ADR-0136](./0136-cross-device-placement) (placement and timing authority), [ADR-0061](./0061-cross-device-workflow-execution) (capability vocabulary; P5 brain placement), [ADR-0170](./0170-cognia-relay-and-connectivity-center) (relay pairing), [ADR-0175](./0175-the-rpc-face-has-one-grammar-one-error-and-one-version) (one version), [ADR-0182](./0182-a-project-names-the-image-it-runs-in) / [ADR-0221](./0221-a-remote-sandbox-is-a-provider-behind-the-same-seam) (sandboxes), [ADR-0174](./0174-the-bot-control-plane) (bots), [ADR-0090](./0090-unified-agent-execution-and-gateway-compatibility) (headless permission), [ADR-0113](./0113-agent-team-multi-host-remote-dispatch) (workers)
**Plan:** `docs/plans/2026-10-10-always-on-host.md`

## Context

Bots, IM auto-replies, scheduled tasks and work sent from a phone stop the moment the user's laptop sleeps. The parts needed for an always-on host exist but do not join up:

- `cognia-server` supervises a headless Node brain that already runs the scheduler, bot delivery, connectors, workflows, agent teams and chat (ADR-0059). Its only packaging is a Compose profile and a single-replica Kubernetes StatefulSet. Nothing installs it as a system service. Its durable store defaults to a debounced JSON snapshot.
- Phones and desktops reach a host over direct TLS, WebRTC or an end-to-end encrypted relay (ADR-0021, ADR-0170). A running server mints `cgnp4` invitations that carry a relay room, so a host behind NAT can be paired without a domain.
- Everything the desktop runs is owned by the desktop alone. Scheduled tasks, bot installations and connector instances have no owner field; timing authority is one global value in the desktop's `localStorage` that the brain can never hold; ADR-0061 P5 ("cron and webhooks fall to the brain") was never built. A host the desktop is not actively routing to has stale liveness, so the five-minute takeover in ADR-0136 can double-fire.
- A desktop that activates a remote host becomes its client: its own connectors, bots, scheduler, MCP server and local agents stand down. There is one active-remote slot.
- Unattended runs are denied, not parked, the moment a tool asks (`unattended-permission-responder`). The headless host can hold connector credentials in its sealed store but has no at-rest store for model provider keys. Only the interactive chat controller ever asks for a sandbox placement, and a phone-dispatched run has no project working directory.
- ADR-0215 already decides the long-term model: one encrypted sync space, data replicated everywhere, execution under 30-second leases granted by the account object, failover in rank order (headless server, then the most recently active desktop), machine-bound resources pinned to their creating device. Its leases (phase 4) and secrets class (phase 5) are not built.

## Decision

### The host is the user's machine, and it is a peer

The user brings the machine: a Linux VPS or NAS (Compose) or a Mac (a native service, or the desktop app in always-on mode). Cognia does not provision or bill for machines. The host runs the same `cognia-server` and brain as ADR-0059 and serves one account.

The always-on host is a peer of the desktop. Both can execute; neither becomes the other's client by owning the always-on work. A desktop manages its always-on host through a **management channel**: an isolated connection opened with `openRemoteHostTarget`, used by the host panels (status, owned items, approvals, secrets, migration, updates). The desktop's own routing does not change. Switching the desktop's routing to the host for a conversation remains available, as today.

Two roles exist:

| Role | What runs | Phase |
| --- | --- | --- |
| Always-on host | `cognia-server` + brain: scheduler, bots, connectors, workflows, chat, dispatched agents | A |
| Execution node | `cognia-agent worker` (ADR-0113): accepts dispatched turns, owns no data | C (team pool) |

### Ownership is per item

Each scheduled task, bot installation and connector instance carries an **owner**: the host that arms, fires and runs it. Runtimes skip items they do not own. The owner field is the same pin ADR-0215 §8 describes, so phase B turns it into a lease preference without a model change.

- **Default for new items:** when an always-on host is paired and reachable, new always-on work is created on it. Machine-bound items stay on the device that creates them.
- **Machine-bound** is computed by one classifier with reasons: task types that need the local shell or filesystem, desktop and pet event triggers, file-watch and terminal triggers, local-path project roots, OS-scheduler promotions, stdio MCP servers, and keyring references that do not exist on the target.
- **Manual pin:** any movable item can be pinned to a named host. A pinned item waits when its host is offline; it does not move by itself.

### Moving an item is a handoff, not a copy

Migration moves an item to the host in four steps, modelled on the thread handoff of ADR-0103:

1. **Preflight** on the host: protocol match, host capability, required plugins and their versions, credentials, project scope, machine-bound reasons. Every blocker is listed; none is skipped silently.
2. **Transfer** what the item needs: missing plugins as signed cogpacks (ADR-0209), after the user confirms; secrets over the paired channel; the definition through an idempotent create keyed by the migration's operation id.
3. **Confirm** that the host created and armed it.
4. **Fence** the local copy: it stays as a disabled placeholder whose owner is the host. The local runtime ignores it; the UI shows where it runs and offers *take back*.

A guided flow lists every movable item after pairing, flags machine-bound items with the reason, and moves what the user selects. In phase A there is no automatic failover: when the owning host is offline the placeholder says so and the user can take the item back. Automatic failover arrives with leases in phase B.

### Every trigger has a stable occurrence key

Two owners never arm the same item, and every trigger also carries a key derived from the occurrence, not from when the host noticed it:

- Webhooks, integration events and connector messages use the provider's delivery id or the platform message id.
- Cron and scheduled tasks use the scheduled slot, not the wake time.
- Bot timed ticks use the slot, not a random record id.

This fixes a present defect (two events in the same second collapse into one run and the second payload is lost) and gives phase B's lease holder a fence that survives handover. Missed slots after a handover are made up once, through the existing per-type catch-up table.

### Reach: relay first, no domain required

- Pairing uses the `cgnp4` relay invitation. The CLI prints it with a terminal QR code. A host that cannot open a relay room refuses to print a relay-less invitation unless the operator asks for a direct one.
- IM connectors prefer transports where the host dials out (Lark long connection, Telegram long polling, Discord gateway). Webhook-only platforms need a domain or tunnel the user provides. Cognia adds no hosted inbound buffer; when every host is offline, the platform's own retry applies.
- Push notifications from the headless host reach the phone's lock screen through the existing APNs/FCM/HMS fan-out.

### Packaging and lifecycle

- **Linux:** Compose, `server` profile. **macOS:** a standalone archive (cognia-server, brain layout, sidecars, Node) installed with `cognia-server service install` as a LaunchDaemon that starts at boot without a login. The desktop app additionally offers an always-on mode: close to tray, launch hidden at login, hold a system wake assertion, and report that it is hosting.
- One service installer serves `cognia-server` and the worker daemon.
- Always-on hosts store data in `sqlite-v5` by default. Existing snapshot accounts are imported before the switch, never reseeded.
- **Updates:** the host follows the user's release channel and updates itself when idle, replacing server and brain together, and rolls back on a failed health check. Automatic updates are on by default and can be turned off.
  - **One release unit, verified on the host.** The signed update catalog lists a host release as a `host-server` entry (the macOS archive's sha256, or the Compose image's digest) paired with a `host-brain` entry of the same version; both name the command contract. A host acts only on a matched pair, so a half-published release is never installed, the same rule that refuses a half-updated host at runtime. The host verifies the catalog itself (`crates/cognia-update-catalog`, the Rust twin of `lib/updates/catalog-verify.ts`, both pinned to one fixture). Artifacts carry no separate signature: their digests sit inside the signed targets document.
  - **The Worker can hold a release back, never put one forward.** A host also asks the update Worker's `/v1/rollout` endpoint whether the release is rolling for its bucket, which makes `pause` and `abort` a kill switch. The answer only counts when its version and digest match the verified catalog.
  - **Signing is offline.** `scripts/release/update-catalog.mjs` generates the role keys, signs the catalog, and refuses a release a host would refuse. The keys never reach CI or the Worker.
- **Versions stay exact (ADR-0175 stands).** No version ranges are negotiated. A mismatch is surfaced as an explicit "update the host / update the app" state with a one-click update, instead of a refused call.

### Execution: a container per task by default

- Dispatched work on an always-on host (phone turns, bots, scheduled agent tasks, agent teams) gets a sandbox placement authored by the host, not only by the interactive chat controller. The default is a container from the sandbox pool, using the project's image or devcontainer; a project can opt out to host-process execution.
- The host reaches Docker only through a Cognia-owned API proxy that inspects request bodies: only Cognia-labelled containers, only the workspaces volume mounted, no privileged mode, no host network or PID namespace, exec only into its own containers. Rootless Docker is recommended.
- Remote and cloud sandboxes are ADR-0221 providers behind the same seam.

### Code supply

- A project gains its repository remote. The host clones it through the shared mirror cache (ADR-0176) with a credential sent from the user's device.
- A **snapshot handoff** carries local work: the base commit plus a binary-safe diff of uncommitted changes (tracked, untracked, deletions, modes), or a size-capped archive for a project without git. The host applies it to a fresh task checkout and refuses on a base mismatch.
- Results come back as a pushed branch or a patch set. The desktop applies either with one action into a new worktree.

### Secrets travel over the paired channel and are sealed on the host

- Phase A sends secrets over the paired companion channel, which is end-to-end protected (TLS pinned to the host's fingerprint on direct paths, AES-GCM with ECDH session keys over the relay). The host seals them in its encrypted secret store under the master key.
- Model provider keys gain an at-rest store on the host, scoped per provider and written only by an owner device under an interactive admin lease. Connector and git credentials use the same store.
- The master key can come from a file, `systemd-creds`, or the macOS Keychain.
- Host configuration commands that are ungated today (push credentials, bot installation changes, trigger arming) move to the interactive class.
- Phase B moves secret delivery to the ADR-0215 secrets class.

### Unattended work declares its permission and parks when it needs a person

- Each bot installation and scheduled task carries one **permission profile**, folded through the existing narrowing-only ceilings.
- Inside a verified container sandbox, file and shell operations within the workspace are allowed.
- Outbound messages, secret use and host configuration changes always require approval.
- An approval that needs a person **parks** the run instead of ending it. The run raises an interrupt, a push notification and a mobile approval card are sent, and it resumes on approval or is denied when the timeout expires. Bot interrupts use the same path.

### Phases

| Phase | Delivers |
| --- | --- |
| **A** | A standalone, usable always-on host: packaging (A1), relay pairing (A2), desktop always-on mode (A3), device console host state (A4), per-item ownership and migration (A5), sealed secrets (A6), parked approvals (A7), container default (A8), occurrence keys (A9), updates and exact-version UX (A10), code supply (A11), end-to-end proof with the desktop off (A12) |
| **B** | ADR-0215 phase 4 leases replace manual ownership: automatic failover in rank order, the owner field becomes the pin, secrets move to the sync secrets class |
| **C** | Team execution nodes: workers enrolled into a team through the collaboration server's roles, with quotas |

## Consequences

- The desktop stays a full host when an always-on host exists. Managing the always-on host never switches the desktop's routing.
- In phase A an item lives on exactly one host. If that host is offline its work pauses until the host returns or the user takes the item back. This is deliberate: an unreliable liveness signal must not cause double execution.
- Global timing authority remains only for items that have no owner. Its liveness input is fixed to probe hosts that are not being routed to.
- Bot definitions follow their plugins: moving a bot can install a plugin on the host, always with confirmation and signature checks.
- The host is a single account and a single writer, as in ADR-0059. Team sharing does not turn it into a multi-tenant brain; it adds execution nodes (phase C).
- Recorded boundaries: OS automation, the desktop pet, the system clipboard and local capture stay on the desktop (ADR-0059 D7). A webhook-only IM platform needs a user-provided domain or tunnel.
