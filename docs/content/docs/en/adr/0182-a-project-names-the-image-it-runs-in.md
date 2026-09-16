---
title: "0182 — A project names the image it runs in"
description: "Cloud and container execution stop using one runner image per deployment. A project resolves an immutable EnvironmentSpec from a two-level image catalog, an approved repository declaration (.cognia/workspace.json or devcontainer.json) or the deployment default. Approval is per device on the desktop and server-side on a shared Host. The whole subsystem is off by default, leaves the off path unchanged, and falls back on infrastructure faults unless isolation is mandatory."
---

# ADR 0182 — A project names the image it runs in

**Status:** Accepted — Step ① implemented (desktop local containers dormant); Steps ②–④ planned
**Date:** 2026-09-15
**Related:** [ADR-0059](./0059-cloud-deployment-headless-brain) (the T2/T3 execution plane this replaces the image choice of), [ADR-0085](./0085-cloud-shared-browser) (the persistent WorkspaceRuntime), [ADR-0147](./0147-repository-declared-workspace) (the repository file and its approval gate this extends), [ADR-0149](./0149-a-person-is-not-a-device) (the roles that approve on a shared Host), [ADR-0183](./0183-the-agent-is-brought-to-the-image) (how agent CLIs reach an arbitrary image)

## Context

A containerised agent in Cognia runs in exactly one image per deployment. `COGNIA_RUNNER_IMAGE` is read once at boot (`crates/cognia-external-agent/src/container_backend.rs`), and the backend itself is chosen once per process from `COGNIA_EXEC_BACKEND`. The published runner is `node:26-slim` with git and a dozen agent CLIs installed at `latest`. It has no language toolchains.

So a Python project, a Rust project and a Java project on the same cloud Host all get the same Node image. The only workaround is a `setup` script that installs a toolchain on every fresh sandbox. The only place a user picks an image at all is a Docker sandbox connection for a CUA desktop (`types/sandbox` `DockerSandboxConfig.image`), which is a different feature.

The ecosystem already has a way for a repository to say what it runs in: `devcontainer.json`. Cognia reads none of it. `.cognia/workspace.json` ([ADR-0147](./0147-repository-declared-workspace)) describes setup, variables and provisioning, but not an image.

## Decision

### Off by default, in layers

This is a large subsystem on the spawn path, so it is opt-in and cannot break normal work when it fails.

1. **Deployment switch.** `sandboxPool.enabled` in the environment baseline (or `COGNIA_SANDBOX_POOL_ENABLED`), default off.
2. **Project selection.** With the deployment switch on, a project still runs as today until it selects a Runtime environment or approves a repository declaration.
3. **Desktop toggle.** "Run in a local container" is per project and defaults to off.

When any layer is off, `spawn_external_agent`, workspace commands, the gateway and egress take today's paths unchanged. Every slice that touches one of those paths carries an "off path" test that pins it.

With the deployment switch off there is no router on the spawn path at all: `cognia_sandbox_pool::boot::wrap_exec_backend` hands the Host back the same execution backend it was given, and a test asserts the identity of the `Arc` rather than that the behaviour matches. Boot is refused only when an operator set something and cannot have it: a baseline file that does not parse, an unreadable switch, the switch on with no catalog, or the switch on in a binary built without a driver. A deployment that set none of the new variables can never be refused by this subsystem.

### One placement per spawn

A spawn, not a process, chooses its environment. `ExternalAgentSpawnConfig.sandbox` is an optional `SandboxPlacement`, absent for every caller that predates runtime environments and omitted from the wire when absent:

```
{ "kind": "container", "spec": <EnvironmentSpec>, "isolationMandatory": false }
```

The spec travels as JSON because it came through a client the Host does not trust, and is re-admitted against the Host's own baseline, catalog, approvals and egress grants before a container exists. `isolationMandatory` is the client's half of the fault rule below: a client can only make its own run stricter with it.

`SandboxRoutingBackend` sits in front of whatever execution path the Host already had — local processes, legacy runner containers, or the ADR-0085 workspace-runtime router — and decides per spawn. Where an agent ended up is emitted on `external-agent://placement` and repeated in `get_info`, so the UI can say what actually ran: the image digest, the isolation tier it was attested at, the bundled command, and the user, with the declared uid when it was remapped. A fallback arrives on the same channel as `{ "kind": "fallback", "code", "message" }`.

A stray placement reaching a Host with the pool off is handled without a router: `spawn_with_events` refuses it when isolation is mandatory (`sandbox_pool_disabled`) and otherwise strips it and reports `sandbox_fallback_pool_disabled`. A spawn with no placement on a multi-tenant Host is refused with `sandbox_placement_required`.

### One resolved, immutable spec

The brain resolves an `EnvironmentSpec` once per sandbox acquisition. The shape is `types/sandbox/environment-spec.ts`, mirrored in Rust by `crates/cognia-environment`. The spec carries:

- the image, as registry, repository and `sha256` digest;
- the agent bundle digest ([ADR-0183](./0183-the-agent-is-brought-to-the-image));
- the minimum isolation tier;
- the size class;
- the lifecycle, persistent or ephemeral;
- the declared container user;
- container env and lifecycle commands;
- forwarded ports;
- the egress tier;
- where the spec came from.

Its digest covers everything except a human-readable resolution trace. Rust re-validates the spec at admission and persists the body it admitted. Once admitted, the spec does not change for that sandbox. A changed declaration marks the sandbox "update pending approval" and takes effect on recreate.

### Precedence

1. **An explicit project setting** naming a catalog entry. If that entry is unavailable, resolution fails closed with `catalog_entry_unavailable`. It never falls through to a different image the user did not pick.
2. **An approved repository declaration.**
   - Either `.cognia/workspace.json`'s new optional `environment` block (the file stays `version: 1`, and files without the block keep their existing digest), or `devcontainer.json` at one of the standard locations.
   - When both name an image, `workspace.json` wins, and the trace says so.
   - An unapproved declaration behaves differently by surface. Interactive surfaces fall through to step 3 with a visible verdict. Unattended surfaces (scheduler, issue runs, batch) refuse with `environment_approval_pending`, so a background run never uses an image the repository did not declare.
3. **The deployment default:** the tenant default, else the baseline default, else `no_environment_available`.

### A two-level catalog

- **Global baseline.** Owned by the Ops Controller when one exists. It holds entries, the registry allowlist, the isolation floor, the node-pool → tier map, egress presets and internal exceptions. It is edited in `/servers`, versioned in Postgres, and delivered to each deployment as a signed operation.
- **Standalone baseline.** Without an Ops Controller, the baseline is a file (`COGNIA_ENVIRONMENT_BASELINE_FILE`). Failing that, a read-only `legacy-env` entry is derived from `COGNIA_RUNNER_IMAGE`.
- **Tenant catalog.** The tenant `cognia-server` is the runtime authority, stored in its own SQLite database. Tenant admins may append entries. They can never widen the baseline registry allowlist or lower its isolation floor. Admission re-checks both, so an entry written around the UI is still refused.

Entries are digest-pinned. A tag is resolved to a digest when the entry is added.

### The devcontainer subset is closed-world

- **Honored.**
  - `image` and `name`.
  - `containerEnv`, and `remoteEnv` (static values and `${containerEnv:…}` / `${containerWorkspaceFolder}` only).
  - The five lifecycle commands: `onCreate`, `updateContent` and `postCreate` run at first create, `postStart` at every resume, `postAttach` at every attach.
  - `forwardPorts` / `portsAttributes`, `remoteUser` and `containerUser`, and `workspaceFolder` (under `/workspace`).
  - `hostRequirements` as a size-class hint. GPU is reserved and dormant.
- **Refused, making the whole declaration invalid:** `privileged`, `capAdd`, `securityOpt`, `runArgs`, `mounts`, `workspaceMount`, `appPort`, `initializeCommand` (it runs on the host), and compose-based configurations.
- **Ignored with a trace:** `customizations`, `init`, `shutdownAction`, `updateRemoteUserUID`, `otherPortsAttributes`.
- **Any other key** is refused with `devcontainer_field_unknown`.
- **Builds.** `build` and `features` are parsed but stay **dormant until the build service exists** (ADR-0186, planned). They are refused with `devcontainer_build_requires_build_service`, which is stated in the type, labelled in the UI and pinned by a test.

### Approval follows who shares the Host

- **Desktop.** Approval stays per device ([ADR-0147](./0147-repository-declared-workspace)). The trust row gains non-indexed `approvedDevcontainerDigest` / `approvedDevcontainerAt`, with no Dexie version bump.
- **Shared cloud Host.** A per-device answer is meaningless when several people share the Host. The approval is a server-side record on the tenant database.
  - It covers the project, the normalised remote, the path, the declaration digest, the resolved image and the runtime-fields digest.
  - Only a Maintainer of the workspace, an Org Owner/Admin ([ADR-0149](./0149-a-person-is-not-a-device)) or the Host owner may create it. Every approval and revocation is audited.
  - The Host learns that from the collaboration plane, not from a local table: `GET /internal/v1/orgs/{org}/workspaces/{workspace}/access/{user}` on `cognia-collab-server` answers with the same `resolve_workspace_access` every authorized route there uses, and `Manage` is the bar. The brain's Dexie mirror is a UI affordance — `lib/db/identity.ts` says so on its own function — and an image a credentialed sandbox will run is not an affordance.
  - The Host authenticates as itself, because it is not the person: a paired client asks it to approve something, and the Host holds no grant for that person and could not verify one, since the grant key never leaves the collaboration server. It presents `COGNIA_COLLAB_SERVICE_CREDENTIAL`, whose SHA-256 the plane stores as `COLLAB_INTERNAL_SERVICE_CREDENTIAL_SHA256`. A plane that configured none answers 401, so a Host that was never granted this authority refuses the approval instead of granting it on a local guess.
  - The endpoint can therefore tell its holder whether any given person is in any given workspace. It lives under `/internal`, which the tenant ingress does not route, and it answers `null` both for "no access" and for a workspace that does not exist, so it cannot be used to enumerate an org.
  - Admission compares the frozen values, so Rust needs no devcontainer parser.
- **Digest.** Both paths digest the parsed, canonicalised form, using the same `canonicalize` ADR-0147 introduced, now shared from `lib/project-environment/canonical-json.ts`.

### Faults fall back unless isolation is mandatory

When the pool, a driver, the gateway sandbox ingress or the egress proxy is unavailable:

- **Isolation not mandatory:** a project that did not mark isolation mandatory (`ProjectEnvironmentPolicy.requireSandbox`, or an explicit minimum tier) runs on today's execution path. The UI shows a `sandbox_fallback_*` reason.
- **Isolation mandatory:** a project that did mark it, or any project on a multi-tenant Host whose baseline forces sandboxes, is refused. Falling back there would run untrusted repository code inside the server container next to other tenants' data.

Which failures are faults at all is the other half of the rule, and it is decided by what the failure says about the request:

| Refused — never falls back | Fault — falls back unless isolation is mandatory |
| --- | --- |
| The spec was not admitted (`catalog_entry_unavailable`, `approval_missing`, `approval_mismatch`, `isolation_below_floor`, `egress_open_requires_grant`, `size_class_not_offered`, `gpu_not_supported`, `isolation_tier_unavailable`, …) | `sandbox_pool_disabled`, `bundle_unavailable`, `sandbox_store_unavailable` |
| The image cannot host the agent (`probe_libc_unsupported`, `probe_glibc_too_old`, `probe_no_shell`, `probe_user_missing`, `probe_workspace_not_writable`, `bundle_arch_mismatch`, `sandbox_probe_failed`, `sandbox_probe_timeout`, `sandbox_image_unavailable`) | `sandbox_daemon_unreachable`, `sandbox_volume_unavailable`, `sandbox_bundle_stage_failed`, `sandbox_container_start_failed` |
| The bundle has no such command (`sandbox_command_unavailable`) | |
| The spawn is malformed (`sandbox_placement_required`, `sandbox_workspace_required`, `sandbox_workspace_outside_root`) | |

The reason code shown for a fallback is the fault's code with its `sandbox_` prefix replaced: `bundle_unavailable` becomes `sandbox_fallback_bundle_unavailable`.

A refusal is a decision about what was asked for, and running the agent somewhere else would silently do less than that. A fault is the infrastructure being down, which says nothing about the request. That is why an image that cannot be pulled is a refusal while a daemon that cannot be reached is a fault.

### Docker and Kubernetes honour the spec; E2B does not

The resolver and injection path are shared by the Docker driver (compose T2 and the desktop toggle) and the Kubernetes pool (ADR-0184, planned). The E2B workspace backend does not honour runtime environments. That is stated on its type, labelled in its UI and pinned by a test.

### Desktop credentials are the stated exception

In a local container on the desktop, the agent receives the user's own keys exactly as `env-builder.ts` does today. The desktop gateway is loopback-only. The "sandboxes never hold raw model keys" rule of ADR-0185 (planned) applies to compose T2 and Kubernetes. The desktop exception is labelled in the Runtime environment panel.

### Step ① enforces neither egress nor credential routing, and says so

Two guarantees in this ADR need infrastructure that Step ② builds. Until then the Step ① driver is deliberately weaker, and the gap is labelled on the type, in the placement the UI renders, and in a test:

- **Egress.** `off` is honoured by giving the container no network at all. `allowlist` and `on` get the network the legacy runner had, with nothing filtering it, because the per-tenant L7 egress proxy is ADR-0185. The placement carries `egress.enforced: false`, so nothing downstream can present an unfiltered sandbox as an enforced allowlist.
- **Credentials.** A sandbox receives the same `SpawnPolicy`-filtered environment the legacy runner received, provider keys included; the gateway's ticket-only sandbox ingress is ADR-0185 §②.7. The placement carries `credentials.mode: "spawn-env"`. The in-sandbox supervisor still strips ambient credentials that came from the image rather than from Cognia, using the list of names the driver declares ([ADR-0183](./0183-the-agent-is-brought-to-the-image)).

Neither is a silent downgrade: a project cannot ask for an enforced allowlist in Step ① and be told it got one.

### The companion plane

Sixteen commands in `src-tauri/src/companion_api/rpc/environment.rs`, every one behind the deployment switch: with the pool off each answers `sandbox_pool_disabled`, which a client reads as "this deployment never opted in", not as a failure.

| Command | What it answers |
| --- | --- |
| `environment_catalog_list` / `_get` | The merged catalog, one page at a time, with the tenant entries the merge refused |
| `environment_catalog_create` / `_update` / `_delete` | Tenant entries. Delete revokes and keeps the record, so a revoked id cannot be reused |
| `environment_declaration_read` | Every declaration file under a workspace root, as bytes plus digest |
| `environment_spec_resolve_preview` | A dry run of admission: admitted with the tier and bundle it would get, or the refusal and whether it was a fault |
| `environment_approval_list` / `_get` / `_approve` / `_revoke` | The server-side approval ledger |
| `environment_egress_grant_create` / `_delete` | A project's egress grant |
| `environment_probe_get` | The cached probe verdict for one image and bundle |
| `environment_driver_status` | The driver, the tiers it can attest, whether its daemon answers, and the bundles on offer |
| `environment_image_inspect` | What a reference is, as its registry answers |

Four of those are shaped by a rule rather than by convenience:

- **Every catalog page carries the deployment facts.** The switch, the tenancy, the floor, the default entry, the size classes, the egress presets and the bundle offer repeat on every page, like `rejected`. Resolution needs them from the same merge as the entries, and a second command would let a client resolve against halves read at different moments.
- **The declaration comes back unparsed and unchosen.** The Host returns every file it found and picks none of them. The one devcontainer/JSONC parser and the one precedence rule live in the brain (`lib/project-environment/`), and a Host that also parsed or chose would be a second answer to a question that already has one.
- **A tag becomes a digest in exactly one place.** `environment_image_inspect` is how both a catalog entry and an approval are pinned. Only a registry on the baseline allowlist is contacted, with the scheme taken from the matching rule and never from the reference, so the Host's registry credentials cannot be pointed at a host a caller chose.
- **The probe cache is read through the writer's type.** `cognia_sandbox_pool::probe_cache::ProbeCacheEntry` is what the Docker driver stores and what `environment_probe_get` parses, so the two cannot disagree about the shape. The view states the user the probe was asked about and the user the image resolved it to, the libc, the architecture, the runtimes the image can run and every problem the probe found. An entry this build cannot read is reported as `unreadable`, not as absent: one means "re-probe", the other "probe".

The approval command canonicalizes the remote itself, so a run looks the approval up by the same form whatever the client sent. The driver command was first sketched as `sandbox.docker.status`; it is `environment_driver_status` because each driver answers for itself.

A client learns whether a Host can have any of this from the `sandbox-pool` capability (`lib/platform/capabilities.ts`). It is listed for server-backed hosts only. Settings → Image catalog requires it, so the tenant catalog is administered where the pool runs. The project's Runtime environment panel is gated on it too: on a host without the pool it says why instead of offering a selection every run would refuse.

### How a run reaches its environment

The brain resolves before it connects:

1. **The chat turn names the project.** The controller passes `ensureExternalAgentReady` the session's project, its environment definition, the project row and the execution root. A session with no project passes nothing and connects as before.
2. **`prepareRunEnvironment` resolves** (`lib/sandbox/run-environment.ts`). With no selection it reads nothing else. A catalog that cannot be read is the pool being off when the Host says so, and otherwise a fault: refused with `environment_catalog_unreadable` when isolation is mandatory, `sandbox_fallback_catalog_unreadable` when it is not. An approval comes from the Host's ledger. A device approval ([ADR-0147](./0147-repository-declared-workspace)) counts only on a Host that is not multi-tenant.
3. **A refusal stops the run before any process starts.** Readiness reports the localized reason, and the manager refuses to connect an agent whose run was refused. That refusal is not retried and surfaces as `sandbox_unavailable`.
4. **The placement waits for the spawn** in `lib/sandbox/spawn-placement-registry.ts`, keyed by agent. It holds the agent's current placement rather than a one-shot one: the manager respawns an agent after a crash, a reconnect or a retried connect without resolving again, and a placement consumed by the first spawn would let every one of those start on the host with nothing to say so. Every spawn of the agent carries it until a later resolution replaces or clears it. The Host re-admits each spawn, so a revocation still refuses the next one.
5. **Session processes inherit their agent's placement.** Pi runs one process per session, `<agentId>:<sessionId>`, and its capability probes are named the same way, so a spawn id resolves to the longest registered `<agentId>:` prefix.
6. **A running agent that is in the wrong place is restarted.** The registry records the spec digest each process was started with, `null` for a host spawn. When a new resolution differs, readiness reconnects the agent rather than leave it running under the old answer.

With nothing ever registered, `withSpawnPlacement` returns the caller's own arguments object, so the spawn payload is byte for byte what it was before this subsystem existed.

The Host's answer on `external-agent://placement` is kept per agent. The agent's settings row shows it next to the sandbox status: the tier and image digest, the user with its remap, the bundle release and libc, and the two Step ① labels below. Until the Host answers it shows what was requested, never what was granted. A Host fallback code is localized, and a code this build does not know is still named.

The Host's audit log records the request as well. A spawn that carries a placement adds `sandbox` to its `external_agent_spawn` line, on allow and deny alike: the kind, the claimed spec digest, project id, image digest and catalog entry, and whether isolation was mandatory. The line is written before admission, so these are the client's claims, and the placement event is what says where the agent ran. A value no valid spec could hold is recorded as `null`, so the log cannot be used to carry free text, and the spec's `containerEnv` never reaches it. A spawn without a placement writes the same line it always did.

### Desktop local containers stay dormant in Step ①

The desktop does not list `sandbox-pool`, so on the desktop's own host the Runtime environment panel explains that it cannot run one. The panel's "Run in a local container" toggle is kept in the selection, and a run that sets it is refused with `local_container_unavailable` rather than run unsandboxed. The type, the panel label and a test all say so.

What a desktop would run against is still open: it has no Ops Controller release to take a baseline and an agent bundle from. That is decided when the toggle ships, together with the device-approval path of the precedence rule, which only this path uses.

### Compose

- `deploy/compose/docker-compose.runtime-environment.yml` mounts a baseline file as `COGNIA_ENVIRONMENT_BASELINE_FILE`.
- The T2 overlay forwards `COGNIA_SANDBOX_POOL_ENABLED` for the legacy mapping. A blank value is unset, which is off.
- `scripts/smoke/compose-runtime-environment.mjs` writes a smoke baseline for a given bundle image and drives the stack with no model credentials:
  - `node:22-alpine` from the catalog and `python:3.12-slim` from an approved declaration, each resolved to a digest;
  - each admitted, spawned with a mandatory placement, reported back with the digest, tier, libc and user it got, and greeted with an ACP `initialize` by the bundled codex-acp;
  - the probe cache checked against the placement;
  - refusals for a spec that does not match its digest, an unapproved declaration, a revoked approval and a revoked entry.
- With `--expect pool-off` the same script checks the off path against a stack without the overlay.

## Consequences

- **What this buys.** A project runs in the toolchain it declares, on the desktop, in compose, and in the cloud pool. A repository that already ships a `devcontainer.json` works without a Cognia-specific file.
- **What it costs.**
  - Two new Rust stores: `environment.sqlite` now and `sandbox-pool.sqlite` in Step ②.
  - One new crate, `cognia-environment`.
  - A new optional block in `workspace.json`.
  - Sixteen companion commands (`environment_*`, above) and the `sandbox-pool` capability.
  - Two settings surfaces: the project's Runtime environment panel and the tenant Image catalog.
  - No main Dexie version bump.
- **Legacy deployments are unaffected.** A deployment that does not enable the pool keeps `COGNIA_RUNNER_IMAGE`, its shared workspaces volume and its runner Pods. Only enabling the pool requires the one-shot layout migration of ADR-0187 (planned).

## Alternatives considered

- **Per-deployment image only.** Rejected: projects on one Host need different toolchains.
- **Image chosen per run.** Rejected: runs in the same workspace would diverge, and caching, warm pools and audit lose their key.
- **Require images to derive `FROM cognia-runner`.** Rejected in favour of injection ([ADR-0183](./0183-the-agent-is-brought-to-the-image)): it pins users to Debian/Node and makes every agent upgrade a user rebuild.
- **Repository declarations that apply automatically when the registry is allowlisted.** Rejected: a malicious pull request could change the image a credentialed sandbox runs.
- **Catalog only in the Ops Controller.** Rejected: a single-host self-host would need a controller just to pick an image.

## Implementation

Step ① of the runtime-environment plan, in independently committable slices:

1. These ADRs (0182, 0183) and the 0147 amendment.
2. `cognia-external-agent` builds without Tauri (`tauri-host` default feature).
3. `crates/cognia-environment`: spec, canonical digest, catalog merge, policy, store, baseline loader.
4. TS spec types, devcontainer subset parser, resolver, `workspace.json` `environment` block, desktop devcontainer approval.
5. `cognia-sandboxd` install/probe/init modes and the agent bundle image ([ADR-0183](./0183-the-agent-is-brought-to-the-image)).
6. The fourth release image.
7. Per-spawn routing: `ExternalAgentSpawnConfig.sandbox`, `SandboxRoutingBackend`, the `external-agent://placement` channel, and `crates/cognia-sandbox-pool` with admission, the bundled-command mapping and the Docker driver.
8. Companion RPC and cloud approval authority.
9. Brain wiring: resolution before connect, the current-placement registry, respawn on a changed resolution, and the placement report.
10. The Runtime environment panel, the per-run placement badge and the Image catalog settings page.
11. The compose overlay, the smoke and its baseline.
