---
title: "0183 — The agent is brought to the image"
description: "Agent CLIs no longer live in the image a project runs in. Each release publishes one multi-arch agent bundle holding glibc and musl trees under a single digest. It is injected into any user image at start, a probe decides what that image can host, and a static supervisor, cognia-sandboxd, runs the agent as the declared user. Agent versions are pinned per release instead of `latest`."
---

# ADR 0183 — The agent is brought to the image

**Status:** Accepted — Step ① in progress
**Date:** 2026-09-15
**Related:** [ADR-0182](./0182-a-project-names-the-image-it-runs-in) (the spec that names the image and bundle), [ADR-0059](./0059-cloud-deployment-headless-brain) (the container exec backend and release contract), [ADR-0085](./0085-cloud-shared-browser) (the WorkspaceRuntime supervisor this replaces for agent hosting)

## Context

[ADR-0182](./0182-a-project-names-the-image-it-runs-in) lets a project choose any image. The agent still has to run inside it. Today the agent CLI is the runner container's only process, attached over stdio (`crates/cognia-external-agent/src/kube_backend.rs`), and the runner image is the only place the CLIs are installed (`deploy/runner/install-agents.sh`, every version defaulting to `latest`).

A user's `python:3.12-slim` or Alpine image has no Node, no Claude Code, no Codex and often no git. There are three ways to fix that:

- **Require images to derive from the runner.** This pins users to Debian and Node, and every agent upgrade becomes a user rebuild.
- **Run the agent in a second container of the same pod.** The CLIs execute their shell tools inside their own container, so the user's toolchain would be unreachable.
- **Inject the agent into the user's image at start.**

The existing persistent runtime supervisor cannot carry that job. `services/workspace-runtime/src/supervisor.mjs` forwards raw stdout chunks, which the Rust pump treats as lines (`workspace_runtime_backend.rs`), so an ACP frame can be split or merged. Events also cross a 512-entry ring polled every 100 ms, which drops frames under load.

## Decision

### One bundle per release, one digest

`deploy/bundle/Dockerfile` publishes `cognia-agent-bundle` for amd64 and arm64. libc is not an OCI platform dimension, so one image carries both trees rather than two images with two digests:

```
/opt/cognia/bundle-manifest.json   release tag, pinned CLI versions, per-libc availability
/opt/cognia/bin/cognia-sandboxd    static (musl)
/opt/cognia/common/{git,bin}       static relocatable git and rg, for either libc
/opt/cognia/certs/ca-bundle.pem    for images without a CA store
/opt/cognia/glibc/                 node, npm-installed CLIs, glibc vendor CLIs
/opt/cognia/musl/                  node on its own loader, npm-installed CLIs, musl vendor builds
```

- **Pinned versions.** Versions come from `deploy/bundle/agent-versions.json`, a bundle lock, and replace `latest`.
  - npm CLIs are also pinned in `deploy/bundle/npm/package-lock.json` with sha512 integrity for every package.
  - Vendor downloads carry the vendor-published sha256; curl, which publishes none, is verified by PGP signature from a pinned key.
  - `scripts/build/bundle-agent-versions.mjs check` holds the lock to the runtime catalog. Every catalog runtime is either bundled or marked `unavailable` with its reason, for example a vendor that publishes no checksum.
  - The lock is not certification: it never changes `certifiedVersions`, because on a desktop a certified version runs without consent.
  - A runtime with no musl build is listed as glibc-only and is refused on musl images with its reason. A vendor binary that needs a newer glibc than the bundle's floor carries its own per-architecture `minGlibc` in the manifest.
- **Two libc trees, differently self-contained.** On glibc, Node is the official build and uses the image's glibc and `libstdc++`. A newer bundled C++ runtime would demand a newer glibc than many images have. On musl, Node is patched to load a bundled musl loader and C++ runtime, so it runs on Alpine base images without `libstdc++`, whatever their musl release.
- **Release contract.** The bundle digest is the fourth image in the release contract, alongside server, runner and workspace runtime: `ImageConfig.agentBundle` and `AgentRelease.agent_bundle_image`. Production certification requires it to be digest-pinned.
- **Project pins.** A project may pin an older bundle while the deployment still retains it. A retired pin is refused with `bundle_pin_retired`.

### `cognia-sandboxd`

`crates/cognia-sandboxd` is a static, Tauri-free binary.

**Step ① modes:**

- `install --stage core|libc` copies bundle trees into the injection volume.
- `probe` runs inside the user image and writes `probe.json`. It detects:
  - libc, from the loader `/bin/sh` is linked against (`PT_INTERP`), falling back to the loader files only for a static shell. File presence alone misreads Debian with the `musl` package and Alpine with `gcompat`;
  - for glibc, the release recorded in `libc.so.6` (read, not executed), and whether `libstdc++.so.6` exists;
  - `/bin/sh`;
  - the target user, from `/etc/passwd`;
  - whether `HOME` and the workspace are writable;
  - whether a CA bundle exists.

  It exits with a typed code. The driver maps exit 126 (exec format error) to `bundle_arch_mismatch`.

  | Code | Reason |
  | --- | --- |
  | 64 | `probe_libc_unsupported` |
  | 65 | `probe_glibc_too_old` (Node needs glibc ≥ 2.28) |
  | 66 | `probe_no_shell` |
  | 67 | `probe_user_missing` |
  | 68 | `probe_workspace_not_writable` |

- `init-agent -- <argv>` is a reaping PID 1. It sets user, env, `PATH` and CA variables, runs one child with inherited stdio, forwards signals and passes the exit code through (`128 + n` for a child killed by signal `n`). ACP over container attach therefore works exactly as before. It exits 125 when it cannot start the agent at all: an unknown user, a missing program, or a user switch without root.

  Inside the container, the image's `ENV` and the driver's variables are indistinguishable, so the driver lists the names it set in `COGNIA_SANDBOXD_PROVIDED_ENV`. An ambient provider credential not on that list came from the image and is removed. `COGNIA_SANDBOXD_*` never reaches the agent. The image's `PATH` stays first, so project commands use the project's toolchain; the agent and its shims are addressed by absolute path under `/cognia`.

`cognia-sandboxd` is also a library. The probe report and bundle manifest types are what drivers read back, so it must not link `cognia-net` or `cognia-environment`, both of which pull a network stack into a static binary.

**Step ② mode:** `serve`, the persistent-sandbox supervisor (ADR-0184, planned). It multiplexes agents, PTYs, filesystem, exec, Task Workspace and lifecycle over one authenticated connection. Its per-agent streams carry sequence numbers and credit-based backpressure. When credit runs out, it stops reading the child's stdout instead of dropping frames.

### Injection

- **Kubernetes.** Three init containers share an `emptyDir` mounted at `/cognia`:
  1. `bundle-stage` (bundle image) runs `install --stage core`.
  2. `probe` (the user image) runs `/cognia/bin/cognia-sandboxd probe`.
  3. `bundle-libc` (bundle image) copies only the probed libc tree.

  The user image's entrypoint is replaced by `cognia-sandboxd`, as devcontainer `overrideCommand` does. Only on node pools where it has been verified (for example ACK with Kubernetes ≥ 1.35 and containerd ≥ 2.1) is the bundle mounted as a read-only image volume instead, leaving just the probe step.
- **Docker.** The bundle is staged once into a named volume `cognia-bundle-<digest12>-<libc>`, reference-counted and mounted read-only. Probe results are cached per (user image digest, bundle digest).

### Which user the agent runs as

- **Declared user.** `remoteUser` wins, then `containerUser`, then the image's `USER`. The image's `USER` is read from the registry when a catalog entry is added.
- **No declaration.** On gVisor and VM-level tiers the agent runs as root, and the isolation boundary contains it; agents routinely install packages mid-task. On the plain-container tier it runs as UID/GID 10001 with `runAsNonRoot`.
- **Recorded and shown.** The actual UID comes from the probe, is recorded on the sandbox and is shown in the UI.

### Environment hygiene

The supervisor removes its own secrets from every child's environment, following the precedent in `supervisor.mjs`. It strips ambient provider credentials the same way `cli/src/x/agent-launcher.ts` does, and gives each agent an isolated `HOME`/`XDG`/`CODEX_HOME`, reusing `gateway_task.rs`.

## Consequences

- **What this buys.** Any glibc ≥ 2.28 or musl image, on amd64 or arm64, can host the supported agents without the user touching a Dockerfile. Agent upgrades ship with Cognia releases and can be rolled back with them.
- **What it costs.**
  - A static musl build of `cognia-sandboxd`, git and ripgrep.
  - A larger CI matrix.
  - An init step on every cold start, shortened by warm pools and image volumes where available.
  - `cognia-external-agent` gains a `tauri-host` default feature so the supervisor can link it without Tauri.
- **What it refuses, and says so.**
  - Images with no shell, too-old glibc, an architecture mismatch, or a declared user that does not exist.
  - Runtimes unavailable for the probed libc.
- **ADR-0085.** Its Node supervisor stops hosting agents once `serve` lands. The browser service remains, as a sidecar.

## Alternatives considered

- **`FROM cognia-runner` images.** Rejected: pins the distribution and makes agent upgrades user rebuilds.
- **A second container for the agent.** Rejected: agent shell tools would run in the wrong container.
- **Downloading the agent at start.** This is how Coder's init script works. Rejected: it needs curl/wget in the image and network access before egress policy applies, and it makes the running version depend on when the sandbox started.
- **Two bundle images, one per libc.** Rejected: two digests for one release, and the release contract would grow a fifth image.
- **Keeping the Node supervisor.** Rejected: its chunk and ring defects lose ACP frames.

## Implementation

Step ①: `crates/cognia-sandboxd` (install, probe, init-agent), `deploy/bundle/`, the CI matrix entry, the version generator, the fourth release image, and Docker bundle staging with a probe cache. Step ②: `serve` and protocol v2. The pool, credentials, builds and migration are ADR-0184 to ADR-0187 (planned).
