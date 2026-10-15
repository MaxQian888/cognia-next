---
title: "0221 — A remote sandbox is a provider behind the same seam"
description: "Kubernetes and E2B sandboxes are created on demand as dispatch targets for the desktop and the always-on host. They join the local Docker driver as members of one provider set behind the existing SandboxExecBackend seam, reuse the same driver, admission, bundle supervisor and bridges, honour the full EnvironmentSpec, never hold a model or provider key, reach git and the model gateway back through the exec channel, and are bounded by per-provider concurrency, lifetime and idle limits."
---

# ADR 0221 — A remote sandbox is a provider behind the same seam

**Status:** Accepted
**Date:** 2026-10-10
**Related:** [ADR-0182](./0182-a-project-names-the-image-it-runs-in) (the spec, admission and the fault rule), [ADR-0183](./0183-the-agent-is-brought-to-the-image) (the bundle and `cognia-sandboxd`), [ADR-0059](./0059-cloud-deployment-headless-brain) (the headless host), [ADR-0176](./0176-every-clone-shares-one-object-cache) (Host-side repository supply)
**Design record:** `docs/superpowers/specs/2026-10-10-remote-sandbox-providers-design.md`

## Context

A spawn that carries a runtime-environment placement can run in one place: a container on the Host's own Docker daemon. `cognia-sandbox-pool`'s boot seam hard-wires that driver. The Kubernetes pool that ADR-0182 and ADR-0183 reference as ADR-0184 was never written, and the runner-pod backend refuses every sandbox field and only boots in-cluster. The E2B plugin's workspace backend and microVM adapter are dormant because the webview cannot load the Node-only SDK. The desktop never installs the pool at all, so every placement it makes falls back.

Two hosts need more than one machine's Docker daemon: a desktop without Docker (or without enough of it), and an always-on host that should be able to burst into a cluster or into microVMs. Both must keep the guarantees ADR-0182 gives a local sandbox: the project's image, re-admitted on the Host; the agent bundle brought to it; the fault rule; and no provider keys inside the sandbox.

## Decision

### One seam, a set of providers

`SandboxRoutingBackend` keeps one sandbox arm. That arm is a **provider set**: a `SandboxExecBackend` whose members are keyed by provider id. The local Docker driver is the member `local`; each configured remote provider is another member. `SandboxPlacement::Container` gains an optional `provider`; absent means `local`. The set routes the spawn to that member and every later call by the owning member. A Host with remote providers and no local driver is valid.

Old Hosts reject a placement that names a provider, because the placement is `deny_unknown_fields`. A newer client therefore can never have a remote request run locally by mistake.

### The driver is shared; a provider supplies the container surface

The Docker driver reaches its daemon only through `SandboxDockerApi`. Everything after a sandbox exists runs over that surface: exec-based persistent sessions, gateway and tool-host bridges, port tunnels, label-based ownership and reaping. A remote provider implements the same surface:

- **Kubernetes:** Pod exec, Pod labels, Pod deletion.
- **E2B:** envd process streams, sandbox metadata, kill, pause and resume.

The driver gains one remote **preparation** branch, because a remote provider has no named volumes and no host workspace mount. The branch does four things in order:

1. It provisions an instance with the bundle injected natively.
2. It probes over exec.
3. It clones the workspace through the Host.
4. It starts every agent as a `connect-agent` session of the instance's `sandboxd serve` supervisor.

This is the persistent model, used for both lifecycles. An ephemeral session's cleanup destroys its instance.

### The spec is honoured or refused

Admission is the shared `SandboxAdmission`, run against the tiers the provider attests:

- Kubernetes attests `container` always, plus `gvisor` and `vm` only for tiers mapped to RuntimeClasses.
- E2B attests `vm`.

**Bundle injection:**

- **Kubernetes:** an init container from the pinned bundle image stages the core and both libc trees into an `emptyDir` at `/cognia`.
- **E2B:** a template is built per user-image digest, bundle digest and size class. It starts `fromImage` from the user image, copies the bundle's verified root filesystem to `/opt/cognia`, and runs the same `install` stages.

**Private images on E2B:** credentials go to E2B only for registries the operator lists as delegated. Anything else is refused with `sandbox_registry_not_delegated`.

**Egress:**

| Tier | Kubernetes | E2B |
| --- | --- | --- |
| `off` | Deny-all NetworkPolicy | No internet access |
| `allowlist` | Enforced only through a Cilium FQDN policy | Enforced through the provider's allow/deny lists |
| `on` | No policy | Default |

An allowlist the provider cannot enforce is refused (`sandbox_egress_unenforceable`) when isolation is mandatory. Otherwise the run continues and the placement records `egress.enforced: false`.

### Nothing secret enters the sandbox

- **Model access:** the existing managed gateway lease, bridged into the sandbox over the exec channel. The guard that refused gateway tasks with a placement now admits them when the backend routes sandboxes.
- **Git:** goes through a Host-side **git proxy**, one per task, bound to one upstream repository. It is exposed inside the sandbox as a loopback port over the same bridge. The Host adds the credential: the one the brain sent with the spawn, else the Host's own `git credential fill` for that upstream (prompts disabled, bounded by a timeout). The proxy forwards only upload-pack and receive-pack, and a push may only update the task's own branch, never delete it.
- **When a session ends:** the driver commits and pushes the workspace through the proxy, and reports the outcome on `external-agent://workspace-publish`.
- **Work that was not pushed is never destroyed with its instance.** The driver first exports every commit not on the remote as a git bundle, with a JSON manifest, to `<data_dir>/sandbox-recovery/` on the Host. The report carries the bundle's path as `recovery.bundle`. If the export fails too, the instance is `held`: it stays past its idle limit while the sweep retries delivery every minute. A held instance that reaches its deadline is reported `discarded`. Deliveries into one workspace run one at a time. A session that reuses a held persistent workspace delivers the earlier work with its own. The hold lives in memory only, so a Host restart reaps a held ephemeral instance like any other orphan. That is why the bundle export comes first.
- **Provider account credentials:** the E2B key and the kubeconfig are resolved on the Host only.

### Bounded by construction

Each provider has `maxConcurrent`, `maxLifetimeSecs` (default 7200) and `idleTimeoutSecs` (default 600).

- The lifetime is also written into the provider's own TTL: E2B `timeout` and Pod `activeDeadlineSeconds`. A Host that dies cannot leak a billed sandbox.
- If the provider refuses a delete, the instance stays tracked and keeps its slot, because it may still be running and billed. The sweep retries the delete with backoff from 15 s up to 10 min. A spawn will not reuse an instance that is still being removed. The provider TTL is the last bound.
- A spawn that cannot get a slot is a fault, so the ADR-0182 fault rule decides fallback, unchanged.
- Boot reaps this deployment's orphaned ephemeral instances and adopts persistent ones by runtime key.

### Placement chooses deterministically

A project's runtime selection gains `target`:

- `local`: the Host's local driver.
- A named provider: that provider.
- `auto` (the default): the local driver when it can attest the required tier, otherwise the Host's default remote provider. The reason is recorded in the run-environment trace.

A remote target needs the project's repository remote. A local-only checkout is refused with `sandbox_workspace_remote_required`.

### Both dispatch sources

- **Always-on host:** `cognia-server` reads `COGNIA_SANDBOX_PROVIDERS_FILE`.
- **Desktop:**
  - Settings → Remote sandboxes edits one document, `<app_data>/cognia/remote-sandboxes.json`: the providers, the default provider and the registry allowlist. Credentials go to the secret store (`remote-sandbox:<id>`) and are never read back.
  - At startup it installs the same pool from that document and a synthesized baseline (`remote-sandboxes-baseline.json`), with no local driver. Saved changes apply at the next start; the page says so (`restartRequired`) and shows why the last start refused them (`installError`). A running pool is never torn down under live sandboxes.
  - The bundle digest is pinned by the release build (`COGNIA_AGENT_BUNDLE_IMAGE`). A build without one labels remote sandboxes inert as `bundle_unpinned` and installs nothing.
  - It serves the `environment_*` commands through one local command, `environment_local_call`, which dispatches to the same handlers as a companion call. The `sandbox-pool` capability is static on the desktop; whether the pool is on is answered at call time with `sandbox_pool_disabled`, as on a server.
  - Only placed spawns go through the router. The desktop's OS sandbox wrapper still confines every spawn the router hands back to the existing path, so a fallback is never less confined than before.

## Consequences

- One driver, one admission, one bridge protocol and one session supervisor serve local and remote sandboxes. A remote provider is roughly an API client plus a preparation branch, not a second pool.
- Remote workspaces start from the remote repository. Unpushed local work is not in them, and the UI says so.
- Kubernetes allowlist egress without Cilium is unenforced. This is documented on the type, labelled in the UI and pinned by a test, like Step ①'s Docker allowlist.
- The cloud desktop for computer use and Docker on remote VMs are not covered. They need their own decisions.
- ADR-0184's Kubernetes pool is delivered here as a provider. The `sandboxd serve` protocol v2 and the per-tenant L7 egress proxy remain ADR-0184/0185 work.
