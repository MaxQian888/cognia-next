# Install and reach a Cognia Host through an existing VS Code tunnel

| Field      | Value                                                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status     | Approved design (ADR-0235), revised after the reuse audit on 2026-10-18. Implementation not started. P0 spikes gate P1–P7                                                                                                |
| Date       | 2026-10-18                                                                                                                                                                                                               |
| Decision   | [ADR-0235](../content/docs/en/adr/0235-a-vscode-tunnel-installs-a-host-and-is-one-more-route-to-it.md)                                                                                                                   |
| Supersedes | [VS Code tunnel workspace provider proposal](./2026-10-18-vscode-tunnel-workspace-provider.md)                                                                                                                           |
| Research   | [Feasibility](../research/2026-10-18-vscode-remote-tunnels-feasibility.md), [SDK audit and live probe](../research/2026-10-18-dev-tunnels-sdk.md)                                                                        |
| Flag       | A local build flag, off by default, until P5's real-tunnel smoke passes. It follows the `lib/account-sync/feature-flag.ts` pattern: the dormancy is documented at the type, labeled inert in the UI and pinned by a test |

## Summary

The desktop uses a user's existing `code tunnel` to install a full Cognia Host on that machine. The Host is headless and runs as a user-scoped service. The desktop pairs it into the existing remote-host registry. The Host then publishes the tunnel through its existing `tunnelBaseUrl` slot as a fallback route.

After pairing, all work uses the Host's existing contracts, and the relay stays primary. No tunnel-specific file, command or Agent semantics are built.

**Reuse rule for every phase.** Each deliverable names the existing owner it extends. Code marked _new_ exists only where the 2026-10-18 audit found no owner. A reviewer rejects any change that reimplements something listed under "Reuse" below.

## Facts this plan depends on

| Fact                                                                                                                                                                                                                                                                                                                                                                         | Consequence                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `request_origin` (`crates/cognia-companion-security/src/request_origin.rs`) sees only peer and headers. A loopback peer without Cloudflare headers is direct loopback. The listener tag `TransportPlane` (`crates/cognia-companion/src/server.rs`) exists, but the loopback gates do not consult it. `TransportPlane::Plaintext` maps to `ExecutionPlane::LoopbackPlaintext` | P1: add a new ingress `TransportPlane` variant and make `request_origin` listener-aware. Never forward an existing listener            |
| Forwards live in the `code tunnel` serve loop (`PortForwardingProcessor`). They survive client disconnect and are lost on restart                                                                                                                                                                                                                                            | The credential-holding desktop re-ensures the route from existing connect and liveness paths                                           |
| `companion_endpoints` reports a single `tunnelBaseUrl`. A headless Host reports none. Clients already merge it, clear it and try it as a candidate. `pickTrustMode` (`lib/tauri/pinned-fetch.ts`) gives system trust only to `*.trycloudflare.com`. Other hosts are pinned whenever a fingerprint is known, which fails closed on Capacitor                                  | P1: publish the dev-tunnel URL in `tunnelBaseUrl`. Trust is decided by "equals the Host-reported tunnel URL"                           |
| The Linux `cognia-server` links the Tauri desktop stack (`Dockerfile.cognia-server`, the "no-tauri feature is a tracked follow-up (ADR-0059)" comment). `ocr-paddle` needs glibc 2.38+                                                                                                                                                                                       | P2: build the no-tauri headless binary before any Linux archive                                                                        |
| `HOST_ARCHIVE_TARGETS` holds darwin targets only, and no CI job builds host archives (`host:archive` is a local script). The Node pins in `scripts/build/prepare-plugin-node.mjs` already include Linux                                                                                                                                                                      | P3: extend the packager and catalog, and add the first CI job                                                                          |
| `service install` already runs `ensure_master_key_file` and `adopt`. `adopt` skips `verify_files`. Only `InstallHome::stage_archive` verifies per-file hashes. `service status` and `pair` print text only                                                                                                                                                                   | P4: add a thin `cognia-server` stage subcommand over `stage_archive`, and `--json` for `service status`. Drop the separate `init` step |
| `ghCliToken` (`lib/ai/agent/team/pr-feedback/resolvers.ts`) and the `integration-github-credentials` PAT/App store (`lib/integrations/github-auth.ts`) already exist in TS. No GitHub device flow exists                                                                                                                                                                     | P4: one GitHub credential home in TS, plus a new device-flow provider registered there                                                 |
| An optional `RemoteHost` field survives `partialize`/`merge` (`stores/remote-host/remote-host-store.ts`)                                                                                                                                                                                                                                                                     | No persist version bump                                                                                                                |
| `cognia-bootstrap-agent` is an existing, unrelated crate                                                                                                                                                                                                                                                                                                                     | The new crate is `cognia-host-installer`                                                                                               |

## P0 — Spikes (gate)

Each spike is an opt-in script in an owned scratch directory, run against a disposable tunnel. None of them ships. Results are appended to `docs/research/2026-10-18-dev-tunnels-sdk.md`, with no account, tunnel or machine identifiers.

**S1 — public forward.**

- **What to observe** (the test server is HTTPS+WS on `127.0.0.1`, forwarded with `forward {port, public:true}`):
  - (a) the URL form, and whether it stays the same across re-forwards;
  - (b) anonymous `fetch` and WebSocket upgrade from Node, the Tauri webview and an Android Capacitor WebView;
  - (c) the anti-phishing interstitial, and what bypasses it for `fetch` and for WebSocket;
  - (d) the client-IP forwarding header that dev tunnels sets;
  - (e) persistence across client disconnect, loss on `code tunnel` restart, and restore by re-forwarding.
- **Pass:** (a)–(e) are all observed, and WebSocket works without a custom header.
- **On failure:** stop and return to ADR-0235 decision 4 with the evidence. F2 is the held alternative.

**S2 — upload and install commands.**

- **What to observe:**
  - `fs_mkdirp` and `fs_write` of an archive-sized file: throughput and SHA-256 equality;
  - `spawn` of `sha256sum`/`shasum`, `tar`, `chmod` and `cognia-server service install --scope user` with redirected stdio;
  - what happens when the stream drops mid-upload.
- **Pass:** the upload is byte-identical, the time is recorded, the installer spawns complete, and a dropped upload is detected and leaves a removable partial file.
- **On failure:** redesign the upload (chunking or resume) before P4.

**S3 — GitHub tokens.**

- **What to observe:** whether each token kind is accepted for tunnel list, connect token and relay connect:
  - (a) the `gh` CLI token;
  - (b) a token from the existing integration PAT store;
  - (c) a Cognia-owned OAuth app token obtained through device flow.

  Record the authorization header each kind needs.

- **Pass:** (a) passes, which is enough for the preview. (c) must pass for the GUI release.
- **On failure:** the kinds that fail are not offered. Record why.

**S4 — Microsoft accounts.**

- **What to observe:** for work/school and for personal accounts, whether a Cognia-owned Entra app gets a token the tunnel service accepts.
- **Pass:** the result is documented per account type.
- **On failure:** P7 ships only the passing types, or none.

**Exit:** S1–S3 are recorded. Any S1 failure is resolved with the user before P1 starts.

## P1 — Host tunnel ingress and the published tunnel route

**Goal.** The Host can accept public traffic on a structurally classified listener and publish one tunnel route. Clients trust and tier that route correctly. This phase is testable without VS Code.

| Deliverable           | Reuse                                                                                                                                                                                                             | New                                                                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ingress listener      | `spawn_browser_listener` (`crates/cognia-companion/src/server.rs:371`) as the template; tolerant start in `CompanionServerState::start`                                                                           | A `TransportPlane` variant for tunnel ingress, mapped to `ExecutionPlane::Network`. It is enabled by a `serve` flag or Host config (name decided here). Off by default |
| Listener-aware origin | `request_origin` and its call sites in `crates/cognia-fleet/src/routes.rs` and `crates/cognia-companion/src/{middleware,api}.rs`                                                                                  | A listener-kind input. Ingress is never `direct_loopback`. The rate-limit identity comes from the header S1 found, on ingress only                                     |
| Route persistence     | `crates/cognia-companion/src/browser_access.rs` (`save_and_apply`, reapplied at `serve` in `src-tauri/src/bin/cognia-server.rs`)                                                                                  | A persisted published route `{ baseUrl, registeredAt }`                                                                                                                |
| Route commands        | host-admin arm pattern (`src-tauri/src/companion_api/rpc/host_admin.rs`), `protocol/companion-commands.json`, `pnpm companion-api:gen`; the hand-maintained response-schema catalog, edited by splice             | Set and clear commands, named from `protocol/companion-verbs.json` (e.g. resource `companion.tunnel_route`, verbs `set`/`clear`)                                       |
| Reporting             | `tunnelBaseUrl` production in `src-tauri/src/companion_api/rpc/service_plane.rs` and `companion_endpoints`                                                                                                        | A third source in the existing precedence: running Cloudflared, then named hostname, then published dev-tunnel route                                                   |
| Client trust          | `pickTrustMode` (`lib/tauri/pinned-fetch.ts`); `mergeEndpointsIntoConfig` (`lib/connectivity/endpoint-refresh.ts`) clear rule; candidates (`lib/connectivity/connection-strategy.ts`); `classifyWsHost` unchanged | Trust rule: a URL equal to the Host-reported `tunnelBaseUrl` uses system trust. Delete the hard-coded `trycloudflare` regex                                            |

**Tests**

- `request_origin` matrix: listener kind × loopback/non-loopback peer × with/without CF headers.
- Companion integration tests: through ingress, every loopback-privileged route is refused. That covers operator endpoints, service-token issuance, the single-user Owner invitation, `/internal/_rpc/companion_create_owner_invitation` and the rate-limit exemption. The same calls still pass on the main listener from loopback, and the browser listener keeps `LoopbackPlaintext`.
- Route persistence and command tests (capability, idempotency, verb vocabulary).
- `tunnelBaseUrl` precedence tests.
- `pinned-fetch.test.ts`:
  - a reported dev-tunnel URL and a reported named Cloudflared URL get system trust;
  - an unreported look-alike stays pinned;
  - `trycloudflare` behaviour is unchanged.
- `endpoint-refresh.test.ts`: a route that disappears is cleared.
- Gates: `cargo test` for touched crates, `pnpm audit:rust-architecture`, `pnpm companion-api:check`, scoped Jest, `pnpm typecheck`.

**Exit and rollback.** Ingress and route are off unless configured. Changeset: `minor`. The fix for named Cloudflared trust gets its own `patch` line.

**Progress (2026-10-19).** The ingress half has landed. The route half waits for spike S1.

- **Listener kind.** `ListenerKind { Local, TunnelIngress }` lives in `crates/cognia-companion-security/src/request_origin.rs`, and `request_origin` / `is_direct_loopback` take it as their first argument. Every call site passes it: fleet routes, the operator, service-token, local-debug and rate-limit middleware, and the Owner invitation. An untagged router reads as `Local`.
- **Visitor buckets.** On ingress, every visitor shares the forward peer's rate-limit bucket. No relayed header can pick a bucket until S1 names the tunnel's forwarding header.
- **Listener.** `TransportPlane::TunnelIngress` maps to `ExecutionPlane::Network` and `wss` signaling. `server::spawn_tunnel_ingress_listener` shares one loopback-plaintext spawn with the browser listener. `tag_listener` inserts both extensions as the outermost layer of every listener.
- **Config and CLI.** The config is `crates/cognia-companion/src/tunnel_ingress.rs`: `<data_dir>/cognia/tunnel-ingress.json`, mode 0600, off by default, port 27896. The bootstrapper switches it with `cognia-server tunnel-ingress status|enable [--port]|disable`, which prints the saved config as JSON. `serve` binds the listener from the saved config, and a bind failure leaves the HTTPS listener up.

## P2 — No-tauri headless `cognia-server`

**Goal.** Deliver the ADR-0059 follow-up: a `cognia-server` that links no Tauri, GTK or WebKit.

- **Approach (revised 2026-10-19).** This phase executes ADR-0196 P8 and P9. The RPC families (`src-tauri/src/companion_api/rpc*`, `commands.rs`, `dispatch_host.rs`, about 27k lines) move into `cognia-companion-rpc` behind the `RpcHost` trait. `cognia-server` then moves to `crates/cognia-server`, with no `tauri` in `cargo tree -p cognia-server -i tauri`. An `app_lib` feature cannot work: on Linux, `tauri` depends on `gtk` unconditionally, and `muda` needs gtk3.
- **Audit (2026-10-19).** Besides re-exports of Tauri-free crates, the binary still needs from `app_lib`: `companion_api::{commands, wiring, push_dispatchers}`, `headless::{brain, deployment_id, gateway_host, tenant_lease}`, `shutdown`, `jobs` and `init_structured_tracing`. The dispatcher reaches these local desktop modules: `browser`, `claude`, `cli_bridge`, `codeserver`, `codex_app_dispatch`, `fleet`, `github`, `keyring_secrets`, `perf`, `pi_extension`, `process_registry`, `recovery`, `session_import_watch`, `sftp_service` and `terminal_host_bridge`.
- **Scheduling.** `rpc.rs` takes several commits a day from other sessions, so the move runs in a separate worktree in family-sized batches, each rebased and committed on its own. P4 proceeds first against macOS archives.
- **Decide here, with evidence:** whether `ocr-paddle` stays in the Linux build. Choose from the resulting glibc baseline and the headless OCR need, and record the baseline in this plan.
- **Verification:** `ldd`/`readelf` on the headless binary shows no `libgtk`, `libwebkit2gtk` or `libjavascriptcore`. The existing headless conformance and server smoke tests pass. The server image switches to the headless binary and drops the GTK/WebKit runtime packages.

**Exit and rollback.** The desktop build is untouched. Changeset: `patch` (smaller server image).

## P3 — Native Linux host archives

| Deliverable | Reuse                                                                                                                                                                                       | New                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Targets     | `scripts/build/package-host-archive.mjs` (`HOST_ARCHIVE_TARGETS`, `hostArchiveLayout`, `writeHostManifest`, `fetchVerifiedNode`) and its test; Linux Node pins in `prepare-plugin-node.mjs` | `linux-x64`, `linux-arm64` entries built with the P2 headless feature; the "Linux uses Compose" refusal removed |
| Integrity   | Signed catalog digest + manifest per-file hashes (`InstallHome::stage_archive`)                                                                                                             | None; codesign stays darwin-only                                                                                |
| Catalog     | `scripts/release/update-catalog.mjs` `HOST_TARGETS`                                                                                                                                         | Linux archive entries                                                                                           |
| CI          | `publish-agent-hosts` matrix shape in `.github/workflows/release.yml`; `ubuntu-24.04-arm` runner from `images.yml`                                                                          | The first host-archive job, covering all four targets (darwin included)                                         |
| Self-update | `detect_host_install`, `cognia-host-service` `install_home` (`boot`, `commit`, `roll_back`)                                                                                                 | Linux user-scope detection, if missing                                                                          |
| Docs        | `docs/content/docs/{en,zh}/companion/always-on-host.mdx`                                                                                                                                    | The truthful native Linux install path: user scope, linger, glibc baseline                                      |

**Tests**

- Packager and catalog tests.
- `install_home` and updater tests for a Linux user-scope install.
- A container smoke: unpack, then `service install --scope user` under systemd, then `/healthz`, on the recorded baseline distribution and on the oldest one that should be refused.

**Exit and rollback.** The archives are additive; withdrawing them from the catalog stops new installs. Changeset: `minor`.

## P4 — Installer crate, Host CLI entry points, tunnel helper, GitHub device flow

**Installer crate (_new_ `crates/cognia-host-installer/`, service layer)**

The crate is registered in `scripts/gates/rust-architecture.json`, with Tauri shells behind `tauri-host`.

| Part                                  | Reuse                                                                                                                                       | New                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Release selection                     | `cognia_update_catalog::{verify_signed_catalog, select_host_release (current_version: None), HttpUpdateNetwork, TrustFile, digest_matches}` | none                                                                                                  |
| Remote staging                        | `InstallHome::stage_archive` + `commit` (`crates/cognia-host-service/src/install_home.rs`)                                                  | Thin `cognia-server` subcommand wrapping them. The installer runs it from the single extracted binary |
| Service                               | `cognia-server service install\|status\|uninstall --scope user`; `install_plan`/`uninstall_plan`/`ServiceIo` as the test seam               | `--json` output for `service status`                                                                  |
| Pairing                               | `cognia-server pair` (`--direct --advertise-url` only on the confirmed branch)                                                              | none                                                                                                  |
| Outcome model                         | `IdempotencyDecision::Indeterminate`, `JobStatus` `Failed`/`Interrupted`, `SandboxSpawnError` refused/fault                                 | `RemoteOutcome { Completed, NotStarted, Unknown }`                                                    |
| Local exec (probe of `gh`, checksums) | `cognia_terminal::exec::terminal_exec_inner`                                                                                                | none                                                                                                  |

**State machine.** `probe → inspect (service status --json) → plan (fresh | repair | re-pair | uninstall) → consent → select + download + digest → upload → remote digest → extract cognia-server → stage → service install → health (/healthz, /readyz) → enable ingress → pair → hand-off → ensure route`.

- Every stage has a deadline, a typed error, and an idempotent retry from the last verified stage. `Unknown` is never replayed.
- Relay reachability is probed on the remote before `pair`. If it is unreachable, the plan switches to the tunnel-only branch, which needs its consent token.
- Uninstall runs `service uninstall` and removes the install root. The data directory is deleted only with the second, typed confirmation token.

**Tunnel helper (_new_ `services/devtunnel-helper/`)**

| Part         | Reuse                                                                                                                         | New                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Node runtime | `cognia_core::node_runtime::node_executable()`                                                                                | none                                                                             |
| Process      | `cognia_exec_sandbox::proc_group`; stdin secret hand-off from `crates/cognia-local-browser/src/supervisor.rs`                 | Session-scoped spawn; no auto-restart; a crash fences the session                |
| Protocol     | NDJSON shape of `PluginHost` (`crates/cognia-plugin-runtime/src/python/protocol.rs`)                                          | Closed op set; bounded MessagePack decode with `msgpackr` as a direct dependency |
| Packaging    | digest/stamp logic of `scripts/build/stage-browser-runtime.mjs`; `pnpm-workspace.yaml`; `src-tauri/tauri.conf.json` resources | A staging script for the helper, hooked into `predev`/`prebuild`                 |
| SDK          | `@microsoft/dev-tunnels-connections`, `-management` and `-contracts` at the audited version                                   | none                                                                             |

**GitHub credentials (TS, one home)**

| Part            | Reuse                                                                                                                                                                                                    | New                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| CLI account     | `ghCliToken`                                                                                                                                                                                             | Numeric id check (`GET /user`, as the App path validates ids in `github-auth.ts`)             |
| Stored accounts | `integration-github-credentials` PAT/App providers, `resolveGithubReadToken`                                                                                                                             | none, if S3(b) passes                                                                         |
| Device flow     | Request/poll/cancel shape of `crates/cognia-subscription/src/codex/oauth.rs` and `lib/subscription/core/transport.ts`; device-code UI of `components/settings/subscription/add-account-dialog/codex.tsx` | A `github-oauth` provider registered in the same store, with a Cognia-owned client id (S3(c)) |
| Transit         | renderer → IPC → installer command → helper stdin                                                                                                                                                        | none persisted; never logged or on argv                                                       |

**Registry and route self-heal (TS)**

- `stores/remote-host/remote-host-store.ts`: optional `tunnelBinding` (provider, account reference, numeric account id, cluster id, tunnel id, label, ingress port). There is no persist version bump. `activateHost` and `CompanionConfig` are unchanged.
- Ensure-route is called from `probeHostConnection` and from the liveness success branch (`lib/remote-host/liveness.ts`), through `withManagementChannel` as in `lib/remote-host/host-update.ts`. It has no loop of its own; a small module holds the call and its bounded retry.

**Pairing hand-off (TS)**

- Extract `PairStep.completePairing`'s pre-flights (transport diagnosis, credential-store readiness) from `components/connectivity/pair/pair-step.tsx` into one shared function. `PairStep` and the installer flow both call it, then `registerPairPayload` (`components/connectivity/pair/pair-api.ts`) and `persistPairing`. The invitation is never rendered into an input.

**Tests**

- Installer state machine over a fake `RemoteShell`:
  - every stage failing;
  - unknown outcomes;
  - an existing master key preserved;
  - the double-confirmed uninstall;
  - the relay-unreachable branch requiring consent;
  - the invitation absent from logs and errors.
- `cognia-server` stage subcommand and `service status --json` tests.
- Helper: `node --test` against a local fake relay/control peer covering fragmentation, oversize frames, duplicate ids, late EOF, auth errors and unsupported versions. Also assert that no listening socket is opened.
- Session disposal: no orphan child, and timers settle.
- `PairStep` regression tests after the extraction.
- GitHub provider tests.
- Opt-in real-tunnel install and uninstall on a disposable machine.
- Gates: `pnpm audit:rust-architecture`, `cargo test -p cognia-host-installer`, `tauri-rust-reviewer` checklist, `pnpm audit:colocated-tests`, the Tauri smoke procedure.

**Exit.** Behind the flag, with no UI entry. No changeset (internal).

**Progress (2026-10-19).** Landed without the spikes:

- **Host CLI.** `cognia-server stage`, `service status --json` (`ServerStatusReport` plus `Readiness` in `cognia-host-service`) and `pair --json`. A refusal carries a cause: `relay_unavailable`, `not_running` or `failed`.
- **The `cognia-host-installer` crate.** It contains:
  - the `RemoteShell` seam;
  - the exec-built probe;
  - the target rules (`GLIBC_BASELINE` 2.35 for now, systemd, a linger notice);
  - release selection and verified download through `cognia-update-catalog`;
  - the consent-bound `Session` (inspect, install, pair, uninstall). Data is deleted only with the typed machine name. Tunnel-only pairing needs its own consent.

  It has no adapter and no caller yet. A test pins that.

- **GitHub.** The dormant device flow (`lib/integrations/github-device-flow.ts`, client id `NEXT_PUBLIC_COGNIA_GITHUB_OAUTH_CLIENT_ID`) and the github.com-only `github-oauth` provider.

Still waiting:

- **The helper and its adapter wait for S2.** Its `fs_write`/`spawn` path over the `code tunnel` control protocol is what S2 verifies.
- **The `PairStep` pre-flight extraction and `tunnelBinding`** land with their second caller, the installer flow in P5.
- **Ensure-route** waits for S1.
- **The device-flow scopes** the tunnel needs are decided by S3. The module takes them as a parameter.

## P5 — Devices UI

| Surface               | Reuse                                                                                                                                                          | New                                                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Entry                 | `AddHostForm` / `AddHostSheet` (`components/connectivity/pair/add-host-form.tsx`, `components/devices/add-host-sheet.tsx`)                                     | A third way to add a Host: account, then tunnel list, then probe result, then plan and consent, then staged progress, then paired |
| Account               | GitHub account picker over the TS store; device-code display from the Codex dialog                                                                             | none                                                                                                                              |
| Consent               | Always-on consent pattern (`components/devices/always-on/always-on-section.tsx`)                                                                               | Copy listing machine, account, steps, disk, scope, linger and shell equivalence; a separate tunnel-only confirmation              |
| Progress              | Stage-status vocabulary of `components/servers/operation-inspector.tsx` (`OperationTimeline`) and `components/creator/creator-step-rail.tsx`                   | none                                                                                                                              |
| Repair / route repair | `HostControls` repair slot (`components/devices/host-controls.tsx`)                                                                                            | Routing to the installer flow for a bound Host                                                                                    |
| Uninstall             | `DeviceSection`, `lib/devices/section-plan.ts` (union, `WIDE`, `ORDER`, applicability) and the `device-detail.tsx` switch; `ConfirmActionDialog` typed confirm | A "this machine" section for bound Hosts                                                                                          |
| Forget                | Existing remove flow (`requestRemove`)                                                                                                                         | none; it never touches the machine                                                                                                |

**States.** Each needs its own UI:

- not signed in;
- no tunnels;
- tunnel offline;
- unsupported OS, architecture or glibc;
- no systemd/launchd;
- linger off (a warning);
- existing install found;
- relay unreachable;
- upload failed;
- outcome unknown;
- credential expired.

**Localisation and accessibility.** All strings go in `i18n/messages/{en,zh-CN}/**`, then run `pnpm i18n:build`. Focus returns after consent, and stage changes are announced. A build with the flag off shows nothing, and a test pins that.

**Tests**

- Component tests for every state and for consent gating.
- Playwright on the static build with the installer commands faked.
- A real desktop smoke on a disposable tunnel machine: install, pair, a chat turn over the relay, block relay reachability and confirm the tunnel route works, uninstall.

**Exit.** The smoke passes. The user then decides on the preview default. Changeset: `minor`.

## P6 — SSH adapter

- **Reuse:** `RemoteShell` over `cognia-terminal`'s `russh` client and saved profiles (ADR-0162).
  - Host keys: `verify_or_learn_host_key`.
  - Upload: `open_hosted_sftp` as transport, with the installer's own digest check, because SFTP checks size only.
- **New:** a public exec-channel entry point in `crates/cognia-terminal/src/ssh.rs`, built over the existing dial and credential path. Today `dial_authenticated` and `load_all_credentials` are private, and the only exec is the shell probe.
- **Not included:** route publishing, because SSH has no public route.
- **Tests:** mirror P4 with a fake SSH peer, plus an opt-in real host.

## P7 — Microsoft accounts

Only the account types that passed S4. They become a provider in the same TS account layer, with an account picker and tests. If S4 passes nothing, the plan records that and P7 closes without code.

## Security acceptance (every phase that touches the area)

1. No request through the ingress listener reaches a loopback privilege or `LoopbackPlaintext`.
2. Tunnel credentials, connect tokens, invitations and archive bytes are never logged, exported or placed on argv or in env. A tunnel credential never reaches the remote machine.
3. A command with an unknown outcome is never replayed. Retries resume from the last verified stage.
4. An existing master key or data directory is never overwritten. Deleting data requires the typed second confirmation.
5. Tunnel-only pairing never happens without its explicit confirmation.
6. The helper never opens a listening socket and never accepts a method outside its closed protocol.
7. Activating, deactivating or removing a bound Host behaves exactly as for any paired Host. `RoutingTransport` and `activateHost` are unchanged.
8. Only a URL the Host itself reported as `tunnelBaseUrl` gets system trust.

## Observability

- **Stages:** `probe`, `plan`, `fetch`, `upload`, `stage`, `service`, `pair`, `route`.
- **Outcomes:** `ok`, `denied`, `unsupported`, `unreachable`, `unknown`, `timeout`, `failed`.
- Recorded through the existing diagnostics and audit owners, with operation ids only. Host, account and path never appear in metric labels.

## Open items owned by phases

- P1: the route command names. The ingress config name is decided: `tunnel-ingress.json` and `cognia-server tunnel-ingress`.
- P2: the `ocr-paddle` decision and the recorded glibc baseline.
- P4: the upload strategy, if S2 shows a single `fs_write` stream is too slow or fragile.
