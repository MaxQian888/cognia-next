---
title: "0235 — A VS Code tunnel installs a Host and is one more route to it"
description: "An existing VS Code tunnel is used to install, pair, repair and uninstall a full Cognia Host on a user-owned machine, and the Host can publish the tunnel as a fallback public route. The tunnel is never an unmanaged workspace provider, and every piece reuses an existing owner."
---

# ADR 0235 — A VS Code tunnel installs a Host and is one more route to it

**Status:** Accepted. The user confirmed every decision on 2026-10-18 in a design review and a follow-up reuse audit. Implementation started on 2026-10-19 with the Phase 1 ingress listener and listener-aware origin classification. These do not depend on the spikes. The P0 spikes gate every other later phase, starting with route publishing. If spike S1 fails, decision 4 returns to review before Phase 1.  
**Date:** 2026-10-18  
**Scope:** User-owned Linux and macOS machines that already run `code tunnel`. The desktop installs a Cognia Host there, pairs it, keeps it reachable and removes it.  
**Out of scope:** Windows machines, Microsoft-account tunnels (until spike S4 passes), editing through the raw tunnel and Agent execution through the raw tunnel.  
**Amends:** [0170](./0170-cognia-relay-and-connectivity-center) (its non-goal "Tunnel or mDNS on a headless Host" no longer covers the tunnel route defined here). [0082](./0082-remote-development-remote-host) (deferred SSH provisioning is now owned here).  
**Related:** [0021](./0021-webrtc-datachannel-wan-transport), [0059](./0059-cloud-deployment-headless-brain), [0153](./0153-the-host-obtains-the-confirmation), [0162](./0162-sftp-is-shell-equivalent), [0172](./0172-remote-access-is-verified-not-assumed), [0175](./0175-the-rpc-face-has-one-grammar-one-error-and-one-version), [0196](./0196-a-library-crate-links-tauri-only-when-asked), [0224](./0224-an-always-on-host-is-a-peer-the-user-brings).  
**Plan:** `docs/plans/2026-10-18-vscode-tunnel-host-bootstrap.md`.  
**Research:** `docs/research/2026-10-18-vscode-remote-tunnels-feasibility.md` and `docs/research/2026-10-18-dev-tunnels-sdk.md` (SDK audit and the live probe). The earlier proposal `docs/plans/2026-10-18-vscode-tunnel-workspace-provider.md` is superseded by this record.

## Decision

A VS Code tunnel is an **entry** to a machine the user already owns. Cognia uses that entry for two things only:

1. **Bootstrap.** Install, pair, repair and uninstall a full Cognia Host on the machine.
2. **A fallback route.** The installed Host may publish the tunnel's forwarded port as its public tunnel URL. Clients already understand that slot.

Everything a user does on that machine afterwards (files, terminal, git, Agent runs, bots, scheduling) runs through the Host's existing contracts. Cognia builds no tunnel-specific file, command or Agent semantics. The relay (ADR-0170) remains the primary data path. A Host installed this way is an ordinary paired Host in the existing remote-host registry.

Each piece below names the existing owner it extends. New code exists only where the audit found no owner.

## Context

The earlier proposal treated the tunnel as an unmanaged workspace provider: a second kind of remote host with a read-only browser and wait-only commands. A fact check against the repository found that this shape fights the existing system:

- The remote-host registry is defined around Cognia semantics. `RemoteHost.config` is a `CompanionConfig`, activation installs a global `CompanionTransport`, and the management channel keys staleness on the Companion `deviceId`.
- ADR-0082's 2026-08-13 amendment says "no parallel remote-development transport is authorized". The raw VS Code CLI protocol (MessagePack on port 31545) would have been one.
- The raw CLI protocol offers no root confinement, no compare-and-swap write, no PTY and no confirmed termination.
- The proposal's Node module path, `sidecar/src/remote-host/`, is not a declared sidecar layer and would fail `audit:sidecar-architecture`.

Further facts shaped the decisions.

**Reachability and pairing**

- A headless Host dials the Cognia relay on its own, so once paired, desktops and phones reach it without an inbound port (ADR-0224).
- The CLI's `forward {port, public}` RPC adds a TCP port to the dev tunnel and returns its URL, `https://<tunnelId>-<port>.<cluster>.devtunnels.ms`. The forward lives in the `code tunnel` process (`PortForwardingProcessor`). It survives the client disconnecting and is lost when `code tunnel` restarts.
- The CLI offers `fs_mkdirp`, `fs_write` (a stream, no mode argument) and `spawn` (argv, cwd, env, pipes, no detach).
- `cognia-server service install --scope user` already writes a `systemd --user` unit or a LaunchAgent, creates the master key if absent (`ensure_master_key_file`) and adopts an install root. But `adopt` does not run the per-file hash check; only `InstallHome::stage_archive` does.
- `cognia-server pair` prints a five-minute bearer owner invitation (`cgnp4`). It refuses a relay-less invitation unless `--direct` is given.
- The machine-facing CLI prints text only (`service status`, `pair`).

**Linux archives**

- No native Linux host archive exists, and no CI job builds even the macOS archives; packaging is a local `host:archive` script.
- The Linux `cognia-server` binary links the whole Tauri desktop stack (GTK and WebKit shared libraries), as `Dockerfile.cognia-server` states. A no-tauri headless build is a tracked follow-up of ADR-0059.
- The default `ocr-paddle` feature needs glibc 2.38 or newer.

**Host trust boundaries**

- `request_origin` (`crates/cognia-companion-security/src/request_origin.rs`) recognises only Cloudflare's headers as a tunnel marker. It does not consult the `TransportPlane` listener tag that `server.rs` already attaches. A dev-tunnel forward also arrives from `127.0.0.1`, so forwarding an existing listener would grant loopback privileges to the public internet: operator endpoints, service tokens, single-user Owner invitations and the pre-auth rate-limit exemption. Forwarding the plaintext browser listener would also grant `LoopbackPlaintext` execution.

**Client trust**

- `companion_endpoints` already reports one `tunnelBaseUrl`, and clients already merge it, clear it when it disappears and try it as a candidate. A headless Host reports none today.
- `pickTrustMode` gives system trust only to `*.trycloudflare.com`. Any other host is pinned to the Host's self-signed fingerprint whenever one is known, which on Capacitor fails closed. Named Cloudflared hostnames are affected the same way today.

**Existing GitHub credentials**

- `ghCliToken` reads the `gh` CLI token.
- The `integration-github-credentials` keyring store holds PAT and App accounts.
- Both live in TypeScript, and the renderer already holds GitHub tokens for Octokit.
- No GitHub device flow exists. The Codex subscription has the only device-flow implementation.

**Microsoft accounts and platform status**

- The VS Code CLI's Microsoft path uses the `/organizations` tenant, which by definition accepts work and school accounts only.
- Dev Tunnels is a public preview with no SLA.

## 1. One installer crate behind a remote-shell interface

A new crate, `crates/cognia-host-installer/`, sits in the **service** layer of `scripts/gates/rust-architecture.json`, beside `cognia-deploy-agent`, which already consumes the same foundation crates. Its Tauri commands sit behind a `tauri-host` feature (ADR-0196). The name avoids `cognia-bootstrap-agent`, an unrelated crate.

The crate owns a small `RemoteShell` interface:

- an OS, architecture, init-system, linger, glibc and free-disk probe;
- `stat` and `mkdirp`;
- streamed upload with a declared length and SHA-256;
- one-shot exec with argv, cwd, explicit env, a wait budget and bounded output.

An exec result is `Completed`, `NotStarted` or `Unknown`. The policy copies two existing shapes: `IdempotencyDecision::Indeterminate`, which is never replayed, and the `JobStatus` split between `Failed` and `Interrupted`. Errors follow the refused-versus-fault split of `SandboxSpawnError`. Adapters implement the interface: the VS Code tunnel adapter first, then an SSH adapter over `cognia-terminal`'s `russh` client and saved profiles (ADR-0162).

The installer drives existing owners and adds only thin entry points to them:

- **Release selection and catalog verification:** `cognia_update_catalog` (`verify_signed_catalog`, `select_host_release` with no current version, `HttpUpdateNetwork`, `TrustFile`). The desktop downloads the archive and checks its catalog digest.
- **Remote verification and staging:** after upload, the remote re-checks the archive digest with the system checksum tool. It then extracts only `bin/cognia-server`, and that binary stages the archive through a new thin `cognia-server` subcommand. The subcommand wraps the existing `InstallHome::stage_archive` (digest, manifest, contract, per-file hashes) and `commit`. The remote therefore runs the same verification as self-update; nothing is unpacked by hand.
- **Service:** `cognia-server service install|status|uninstall --scope user`. Install already creates the master key and never replaces one, so there is no separate `init` step. `service status` gains `--json` so the installer reads structured state instead of text.
- **Health:** `/healthz` (`server_id`) and `/readyz`, read through the remote shell.
- **Pairing:** `cognia-server pair`, with `--direct --advertise-url` only on the confirmed tunnel-only branch.

The installer never writes unit files, never parses free-form text where a structured form can be added, and never models the machine as a server-ops `DeploymentTarget`.

## 2. The tunnel client is a session-scoped Node helper

The TypeScript Dev Tunnels SDK (MIT, `@microsoft/dev-tunnels-*`) runs in a Node helper package under `services/`, registered in `pnpm-workspace.yaml` like `services/workspace-runtime`. A staging script reuses the digest-stamp logic of `scripts/build/stage-browser-runtime.mjs`, hooked into `predev`/`prebuild`, and the output is added to the Tauri resources.

**Lifetime.** The installer starts the helper for one session (a bootstrap, a repair or an ensure-route call) and stops it when the session ends.

- It does not auto-restart. A helper crash fences the session, and any in-flight exec becomes `Unknown`.
- It reuses existing pieces:
  - `cognia_core::node_runtime::node_executable()` for the bundled Node;
  - `cognia_exec_sandbox::proc_group` for the process group;
  - local-browser's stdin secret hand-off, so the token is never put on argv or in the environment;
  - the NDJSON request/response shape of `cognia-plugin-runtime`'s `PluginHost`.

**Protocol.** Closed: discover, connect, stat, mkdirp, write, spawn, forward, unforward and close. It never accepts a free-form MessagePack method, an arbitrary port or `spawn_cli`.

- The CLI control protocol uses `msgpackr`, already locked transitively, as a direct dependency, with bounded decoding.
- Automatic local listeners for forwarded ports are disabled, and the SDK's host-key verification is kept.
- The Agent sidecar and its feature-call path are not touched.

**Rejected for now: the Rust `tunnels` crate.** It is only usable through a Git pin, has no reconnect or token refresh, and pulls in `russh` 0.37 with OpenSSL.

## 3. The installed Host is headless, user-scoped, verified and never overwritten

- **Supported machines.** Linux x64 and arm64, and macOS arm64 and x64. Windows is refused with an explanation.
- **Headless build first.** The Linux archive ships only after the no-tauri headless build of `cognia-server` exists: `cognia-server` becomes its own Tauri-free package. This is ADR-0196 phases P8 (the RPC families move into `cognia-companion-rpc` behind `RpcHost`) and P9, which is ADR-0059's follow-up. A cargo feature on `app_lib` cannot do it: on Linux, `tauri` links GTK unconditionally, because `muda` needs gtk3. This build also slims the server image. Whether `ocr-paddle` is left out of the Linux archive is decided in that phase from its effect on the glibc baseline. The probe refuses a machine below the recorded baseline.
- **Archive packaging.** `scripts/build/package-host-archive.mjs` and `scripts/release/update-catalog.mjs` gain `linux-x64` and `linux-arm64`, reusing the existing manifest, Node pins and archive layout. Integrity on Linux is the signed catalog digest plus the per-file manifest hashes; codesign stays macOS-only.
- **CI.** The first CI job that builds host archives for all four targets reuses the `publish-agent-hosts` matrix shape and the existing `ubuntu-24.04-arm` runner. Self-update then covers Linux as it covers macOS.
- **Scope.** User scope only, no sudo. The probe checks systemd lingering and states plainly when the Host will stop at logout or after a reboot until the user logs in. A machine without systemd or launchd is refused.
- **Existing installs.** The installer detects an existing install through `service status --json` and offers fresh install, repair or re-pair. It never replaces an existing master key or data directory.
- **Lifecycle.** "Uninstall from machine" (`service uninstall` plus removal of the install root) is a separate action from "Forget Host". Deleting the data directory needs a second, typed confirmation. Upgrades are Host self-updates and never re-run the installer.

## 4. The Host publishes the tunnel through a dedicated ingress listener and the existing tunnel slot

**Ingress.** The Host gains a tunnel ingress listener bound to `127.0.0.1`. It is built from the `spawn_browser_listener` template and tagged with a new `TransportPlane` variant; it never reuses `Plaintext`.

- `request_origin` gains a listener-kind input, and all its call sites (fleet routes, operator, service-token and rate-limit middleware, invitations) pass it. A request on the ingress listener is never direct loopback, whatever its peer or headers.
- Only this port is ever forwarded.
- Which forwarding header dev tunnels sets is measured in spike S1. The rate-limit identity is then read from that header on the ingress listener only, the way `cf-connecting-ip` is read for Cloudflared.

**Route.** The forward is created with `public: true`. Microsoft terminates TLS, as Cloudflare does today, and the Host's device authentication protects every call. The Host persists the route with the existing config pattern (`browser_access` `save_and_apply`, reapplied at `serve`). Host-admin commands to set and clear it are named from `protocol/companion-verbs.json`, added to `protocol/companion-commands.json` and regenerated.

`companion_endpoints` reports the route in the existing `tunnelBaseUrl`, with this precedence: a running Cloudflared tunnel, then a named Cloudflared hostname, then the published dev-tunnel route. No new endpoint field, credential-book field or response-schema shape is added.

**Clients.** Changes are limited to two places:

- `pickTrustMode` gives system trust to a URL equal to the Host-reported `tunnelBaseUrl` and keeps every other URL pinned. This replaces the hard-coded `trycloudflare` rule and also fixes pinned named Cloudflared hostnames.
- `classifyWsHost` already treats `devtunnels.ms` as a tunnel tier and is unchanged.

**Self-healing.** A desktop holding the tunnel credential re-creates the forward idempotently and re-registers the URL. It does this from the existing connect and liveness paths, `probeHostConnection` and the liveness success branch, through `withManagementChannel` as host updates do. No new background loop is added. Tunnel credentials never go to the remote machine. If no desktop is online while `code tunnel` restarts, phones lose the fallback route until one returns; the relay stays primary.

**Tunnel-only pairing.** If the remote machine cannot reach the relay during bootstrap, the user is told the Host will be reachable only through the tunnel route. After explicit confirmation, the installer pairs with `pair --direct --advertise-url` set to the tunnel URL. This is the operator request ADR-0224 requires.

## 5. Credentials and pairing reuse the existing owners

**One GitHub credential home.** Tunnel access uses the existing TypeScript GitHub account layer:

- accounts in `integration-github-credentials` (PAT, and App where the tunnel service accepts it);
- the `gh` CLI token via `ghCliToken`, plus a numeric user-id check;
- a new Cognia-owned GitHub OAuth device-flow provider, registered in the same store. Its client follows the request/poll/cancel shape of the Codex device flow, and its UI reuses the device-code display of the Codex add-account dialog.

Which of these the tunnel service accepts is spike S3. Cognia never reads VS Code's credential stores and never presents VS Code's OAuth client id.

**Token transit.** For each operation the renderer resolves the token and passes it over IPC to the installer command, which hands it to the helper over stdin. It is held in memory only and never logged, persisted twice or put on argv. This matches how the renderer already holds GitHub tokens for Octokit. A parallel Rust credential layer would duplicate the account store.

**Microsoft accounts.** These are spike S4, run in parallel: work or school accounts, personal accounts, and whether a Cognia-owned Entra application may request the Dev Tunnels scope. Only what passes ships, through the same account layer.

**Tunnel binding.** A bootstrapped Host's registry record gains an optional public `tunnelBinding`: provider, account reference, numeric account id, cluster id, tunnel id, label and ingress port. An optional field survives the store's `partialize` and `merge` unchanged, so no persist version bump is needed. The binding never alters `CompanionConfig`, activation or routing.

**Invitation handling.** The installer returns the `pair` invitation in memory to the existing pairing pipeline.

- The pre-flight checks that `PairStep.completePairing` runs today (transport diagnosis, credential-store readiness) move into one shared function. `PairStep` and the installer flow both call it, then `registerPairPayload` and `persistPairing`.
- The invitation is never displayed, logged or persisted.
- Redeeming it makes this desktop an owner, as a pasted invitation does.

## 6. Consent, progress and audit reuse existing UI

The bootstrap is remote code execution on the user's machine. Before anything is uploaded, the consent step shows the machine, account, steps, disk, service scope, linger consequence and shell-equivalent access (ADR-0162), following the always-on consent pattern.

The UI reuses existing components:

- **Entry point.** A third way to add a Host inside the existing `AddHostForm` / `AddHostSheet`.
- **Progress.** Uses the stage-status vocabulary of the server-ops operation timeline and the creator step rail.
- **Confirmations.** The typed second confirmation is `ConfirmActionDialog`.
- **Repair.** Uses the existing `HostControls` repair slot.
- **Uninstall.** A new device section planned through `lib/devices/section-plan.ts`, beside the existing host sections.

Every stage is recorded with an opaque operation id in the existing audit and diagnostics owners. Invitations, tokens, archive contents and command output are never recorded.

## Phases

The plan specifies each phase with files, tests and exit criteria.

0. **Spikes (gate):**
   - S1: public forward, anti-phishing interstitial, WebSocket upgrade, forwarding headers, and forward persistence and loss.
   - S2: archive-sized `fs_write` and installer `spawn`.
   - S3: which GitHub token kinds the tunnel service accepts.
   - S4: Microsoft accounts, in parallel and non-blocking.
1. **Host ingress and the tunnel route.** The ingress listener, listener-aware origin classification, route persistence, host-admin commands, `tunnelBaseUrl` precedence and client trust.
2. **Headless build.** The Tauri-free `cognia-server` package (ADR-0196 P8/P9). It runs in its own worktree, in batches, because the RPC files are edited concurrently. The Phase 4 installer does not wait for it: it is verified against macOS archives first.
3. **Linux host archives.** Packaging, catalog, the CI job, self-update and documentation.
4. **Installer.** The installer crate, the `cognia-server` stage and `--json` entry points, the tunnel helper and GitHub device flow.
5. **Devices UI.** Install through a VS Code tunnel, repair, route repair, uninstall and forget, in both locales.
6. **SSH adapter.** Adds a public exec entry point to `cognia-terminal`'s SSH client.
7. **Microsoft-account adapter**, once S4 passes.

The feature is behind a local flag, off by default, until Phase 5 passes its smoke test on a real tunnel.

## Consequences

- The remote-host registry stays Cognia-only. No provider discriminant, fabricated `CompanionConfig` or parallel transport is added.
- ADR-0059's no-tauri headless build becomes a delivered prerequisite. The server image slims with it.
- Linux gains a native host archive, and the always-on Host documentation's Linux install path becomes true. Host archives get their first CI job.
- The Host gains a second loopback listener. Its classification is structural, and Cloudflared can move onto the same ingress later.
- `pickTrustMode` stops pinning Host-reported tunnel URLs. This also fixes named Cloudflared hostnames on phones.
- ADR-0170's non-goal "Tunnel or mDNS on a headless Host" is narrowed. A headless Host may publish a dev-tunnel route; it still runs no Cloudflared and no mDNS.
- Cognia ships its first remote installer. It depends on Microsoft's preview service. Its failures are user-visible states, not silent fallbacks: unreachable tunnel, missing systemd, an unsupported glibc, a refused credential.

## Alternatives considered

- **Tunnel as an unmanaged workspace provider** (the superseded proposal). Rejected: it adds a second host kind to a Cognia-only registry, and its raw protocol has no confinement, compare-and-swap, PTY or termination guarantees.
- **The machine as a server-ops `DeploymentTarget`.** Rejected: targets are controller-enrolled compose or Kubernetes stacks with mTLS agents. A user's machine pairs as an ADR-0224 peer.
- **Sandbox provider traits (`RemoteProvisioner`, envd) as the remote shell.** Rejected: they create container instances and have no file transfer into a running target.
- **Client-side SDK with a native loopback relay** (F2). Private and end-to-end TLS, but every client needs a resident SDK session and phones are excluded. Held as the fallback if spike S1 fails.
- **A new `publicRoutes` list.** Rejected: it would change the credential book, the closed endpoint schema and its CLI mirror. Bootstrapped Hosts are headless, so the existing `tunnelBaseUrl` slot is free.
- **Recognising dev-tunnel proxy headers** instead of a dedicated listener. Rejected: a missing header would silently grant loopback privileges.
- **A Rust credential broker.** Rejected: it would be a second GitHub credential layer beside the existing account store.
- **Linux archives with the current binary.** Rejected: they would require GTK and WebKit on the remote (sudo), or bundling shared libraries, which is large and fragile.
- **The Host holding a sealed tunnel credential** to repair its own forward. Rejected for now: it puts a long-lived account token on the remote machine for a convenience the desktop already provides.
- **Remote download of the archive.** Rejected: a second trust anchor, and it requires the remote to reach the update service.
- **Embedding `vscode.dev`.** Useful for manual editing, but it gives Cognia no Host, so it is independent of this record.
