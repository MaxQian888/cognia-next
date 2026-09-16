---
title: "0182 — A project names the image it runs in"
description: "Cloud and container execution stop using one runner image per deployment. A project resolves an immutable EnvironmentSpec from a two-level image catalog, an approved repository declaration (.cognia/workspace.json or devcontainer.json) or the deployment default. Approval is per device on the desktop and server-side on a shared Host. The whole subsystem is off by default, leaves the off path unchanged, and falls back on infrastructure faults unless isolation is mandatory."
---

# ADR 0182 — A project names the image it runs in

**Status:** Accepted — Step ① in progress
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

## Consequences

- **What this buys.** A project runs in the toolchain it declares, on the desktop, in compose, and in the cloud pool. A repository that already ships a `devcontainer.json` works without a Cognia-specific file.
- **What it costs.**
  - Two new Rust stores: `environment.sqlite` now and `sandbox-pool.sqlite` in Step ②.
  - One new crate, `cognia-environment`.
  - A new optional block in `workspace.json`.
  - A set of companion commands: `environment.catalog.*`, `environment.approval.*`, `environment.spec.resolve_preview`, `environment.declaration.read`, `environment.egress_grant.*`, `environment.probe.get`, `sandbox.docker.status`.
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
9. Brain wiring, the Runtime environment and Image catalog UI, and the compose smoke.
