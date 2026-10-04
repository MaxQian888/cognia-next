---
title: "0196 — A library crate links Tauri only when asked"
description: "ADR-0067 reduced the Tauri crate `app_lib` from 170k lines to 67k. Ten weeks later it had grown to 187k, with 96k in `companion_api`. Nineteen library crates linked `tauri`, and headless `cognia-server` included webkit. Defines a gated Rust workspace layer map. Library crates are Tauri-free by default. Their command shells use a `tauri-host` feature enabled only by the app. Splits `companion_api` into companion crates behind a host trait. Makes `cognia-server` a separate package with no Tauri dependency."
---

# ADR 0196 — A library crate links Tauri only when asked

**Status:** Accepted — in progress (P0–P5 and P7 landed, P6 partly; see Progress below)
**Date:** 2026-09-25
**Related:** [ADR-0067](./0067-src-tauri-crate-decomposition-and-build-speed) (the first decomposition; this ADR continues it), [ADR-0014](./0014-capacitor-mobile-shell) (the headless server), [ADR-0021](./0021-webrtc-datachannel-wan-transport) (the WebRTC transport `companion_api` owns), [ADR-0059](./0059-cloud-deployment-headless-brain) (the `cognia-server` image)

## Context

ADR-0067 split the monolithic `app_lib` into twenty library crates in July.
By the end of September the numbers had turned around:

| Measure | After ADR-0067 Tier B | 2026-09-25 |
| --- | --- | --- |
| `src-tauri/src` lines | 66.7k | 186.8k |
| `companion_api` lines | 28.2k | 96.5k (112 files) |
| library crates that link `tauri` by default | — | 19 |
| `Cargo.lock` packages / multi-version names | 1,331 / 130 | 1,545 / 164 |

Nothing in the repo made the split stick. The contributor docs still told
people to add commands to `src-tauri/src`. Clippy excluded `cognia-next`, so
`app_lib` was never linted. The co-located-test gate did not look at
`crates/`. And there was no check on which crate may depend on which, so the
layering degraded in quiet ways:

- the foundation crate `cognia-net` picked up `rquickjs` (a C JavaScript
  engine) and `cognia-secrets`, and with them every crate above it;
- `cognia-agent-state`, documented as Tauri-free, reached `tauri` through
  `cognia-gateway`'s default feature;
- `cognia-observability` linked the 45k-line `cognia-automation` for one
  screenshot call;
- `cognia-terminal` and `cognia-plugin-runtime` linked `cognia-automation`
  only for its execution-sandbox module.

Because nineteen library crates linked `tauri` unconditionally, the headless
`cognia-server` — a `[[bin]]` of `src-tauri` that links all of `app_lib` —
could not be built without Tauri, and its Docker image installed and shipped
webkit2gtk. Two std-only setup binaries rebuilt all of `app_lib` too.

The assembly in `lib.rs` had also become fragile. It registered 1,117
commands, 47 managed states, a 554-line setup hook, and eleven process-global
setters with three different behaviors when never called. It also called
`Builder::setup` twice. Tauri keeps only the last closure
(`self.setup = Box::new(setup)`), so the first closure never ran on desktop. This skipped push credentials,
the fs allow-list seed, the backups fs scope, task-workspace maintenance, the
gateway brain bridge and the WASM plugin host services.

## Decision

### 1. The workspace has layers, and a gate enforces them

`scripts/gates/rust-architecture.json` assigns every workspace member one
layer:

```
foundation  problem · canonical-json · instrument · core · git-mirror · headless-contract
            secrets · net · tenant-auth · deployment · (companion-contract)
platform    jobs · environment · agents · files · media · sandboxd
            (exec-sandbox · provider-diagnostics · sidecar · hooks
             companion-security · companion-connectivity · companion-bus)
domain      git · ocr · vector · automation · scheduling · terminal · subscription · connectors
            plugin-runtime · skills · tts · gateway · ccswitch · mcp-server · external-agent
            task-workspace · observability · agent-state · sandbox-pool
            (codex-app · fleet · browser-cookies · codeserver)
companion   (companion · companion-rpc)
service     cli · collab-server · ops-controller · deploy-agent · sandbox-runner
            (cognia-server · elevated-setup)
app         cognia-next (src-tauri)
```

Crates in parentheses are planned by the phases below.

`pnpm audit:rust-architecture` reads `cargo metadata --no-deps` and checks:

1. every member has a layer;
2. every internal edge points down, or is a same-layer edge listed by name;
3. forbidden reach — a foundation crate's default-feature closure never
   contains `tauri`, `wry`, `rquickjs`, `wasmtime`, `matrix-sdk`,
   `uiautomation` or `webrtc`, and `cognia-sandboxd` never reaches a network
   stack;
4. with default features, no library crate reaches `tauri` or a
   `tauri-plugin-*`;
5. only `cognia-next` turns on another crate's `tauri-host` feature;
6. `src-tauri/src` has only the top-level modules its allow-list names, and
   stays under a line ceiling each extraction lowers.

The gate resolves features itself, one crate at a time, over workspace edges
only. `resolve` would unify features across the workspace and show every crate
reaching Tauri because the app enables it. `:deep` cross-checks each verdict
with `cargo tree -p <crate> -i tauri`. Violations that existed when the gate
landed are in `rust-architecture-baseline.json`, which may only shrink.

### 2. A library crate links Tauri only when asked

Every library crate is Tauri-free with default features. Its
`#[tauri::command]` shells and `AppHandle` adapters sit behind a `tauri-host`
feature (`default = []`, `tauri-host = ["dep:tauri", …]`). `src-tauri` is the
only crate that enables it. This follows `cognia-observability`'s
`desktop-host`, which already worked this way.

- Commands live in a submodule (`#[cfg(feature = "tauri-host")] pub mod
  commands;`) — a `#[tauri::command]` at a crate root collides in the macro
  namespace (E0255).
- In-crate adapters (`AppHandleEmitter`, `AppHandleTaskDueEmitter`,
  `TauriWasmHostServices`…) move into the crate's `tauri_host` module and are
  re-exported at their old paths behind the feature.
- Non-command code spawns through `cognia_core::rt::spawn`, not
  `tauri::async_runtime::spawn`.
- CI runs the workspace tests and clippy a second time with every crate's
  `tauri-host` on, so command code never drops out of CI.

### 3. New Rust logic goes into a crate

New Rust logic goes in the lowest-layer crate under `crates/` that can own it.
`src-tauri/src` only assembles the desktop app: `lib.rs`, the `startup/` boot
steps, window, tray, overlay and webview code, and `AppHandle` adapters. A new
top-level module there fails the gate and points here.

Extractions keep ADR-0067's shim-and-re-alias technique: `pub use cognia_x as
x;` (or a facade module) keeps every `crate::x::…` path and every
`generate_handler!` entry compiling, including other sessions' uncommitted
code.

### 4. `companion_api` becomes companion crates behind a host trait

`companion_api` becomes six crates:

- `companion-contract` — the generated command manifest;
- `companion-security` — the security store, identities, grants, JWT and
  OIDC, and `DeviceContext`;
- `companion-connectivity` — TLS, mDNS, mesh, tunnels, and the WebRTC peer
  (isolating `webrtc`);
- `companion-bus` — the event plane, push, and the data bridges;
- `companion` — the core: auth HTTP, `remote_execution`, the RPC gates, the
  server and the WebSocket transports;
- `companion-rpc` — the sixteen RPC families.

The seams that let the core leave the app:

- `CompanionState.app_handle` becomes `renderer: Option<Arc<dyn
  RendererPort>>` (emit, bridge transport, resource dir);
- the RPC gates and `dispatch_canonical` move into a Tauri-free `rpc_core`, and
  the families plug in through an installed `CommandDispatcher` — which also
  breaks the `rpc ↔ remote_execution` cycle;
- the closed `DispatchHost { Tauri(AppHandle), Headless(..) }` enum becomes an
  object-safe `RpcHost` trait with typed accessors in place of
  `host.tauri_app(name)?.state::<T>()`;
- `HeadlessHooks`, `RouteContributor` and `WorkerRosterObserver` replace the
  core's reads of `crate::headless::headless_services()`, `fleet` and
  `codeserver`.

`companion_api` stays in `app_lib` as a facade module for the whole program.

### 5. Process-global slots behave one way

`cognia_core::installed::{Installed<T>, Replaceable<T>}` replace the ad-hoc
setters. A duplicate install warns by slot name. An unset slot answers a named
`NotInstalled` error. Each binary checks at the end of boot that every
required slot is filled.

### 6. `cognia-server` is its own package

The headless server moves to `crates/cognia-server` (lib + bin) and links no
Tauri. A CI gate asserts that `cargo tree -p cognia-server -i tauri` (and
`wry`, `webkit2gtk`) matches nothing; it runs on `-p` alone because a
`--workspace` build unifies `tauri-host`. The Docker image drops webkit, gtk,
soup, ayatana and rsvg, and the desktop's terminal-host sidecar gets smaller.

## Phases

Each step is one commit, behavior-neutral except P0a, gated by the crate's
tests with and without `tauri-host`, `cargo check -p cognia-next`,
`pnpm audit:rust-architecture` and the path-keyed companion gates.

| Phase | Content |
| --- | --- |
| P0 | Fix the double `setup` (the six host services run again on desktop); split setup into ordered `startup/` steps; drop dead shims |
| P1 | This gate; the crate-aware co-located-test gate; `[workspace.package]` / `[workspace.dependencies]` / `[workspace.lints]`; aligned `rust-version` and our own dependency versions; clippy over `cognia-next`; docs |
| P2 | Layering fixes: `cognia-provider-diagnostics` out of `cognia-net`; `cognia-exec-sandbox` out of `cognia-automation`; observability's screenshot provider and `tracing-host` feature; `http_client` into `cognia-net`; `cognia-files` off `cognia-agents` |
| P3 | `tauri-host` conversion, headless-path crates first (external-agent, gateway, ocr, mcp-server, scheduling, connectors, terminal, plugin-runtime), automation last |
| P4 | Companion leaf crates: connectivity, bus, contract, security |
| P5 | Invert the companion core in place: `RendererPort`, `CommandDispatcher`, `RpcHost`, runtime hooks, the `commands.rs` split |
| P6 | Extract the other `app_lib` subsystems: sidecar, codex-app, hooks, fleet, the terminal host bridge and SFTP, browser cookies, codeserver, the setup binaries |
| P7 | Move the companion core into `cognia-companion` |
| P8 | Move the RPC families into `cognia-companion-rpc` |
| P9 | `cognia-server` as its own Tauri-free package; the image drops webkit |
| P10 | Collapse facades, lower the line ceiling, record the before/after numbers here |

### Progress (2026-09-27)

`src-tauri/src` is down from 187k lines to 96k, and the line ceiling in
`scripts/gates/rust-architecture.json` follows each extraction down.

| Phase | Landed | Open |
| --- | --- | --- |
| P0–P3 | All of it: setup fixed and split into steps, workspace governance and the gates, the layering fixes, `tauri-host` on every library crate, and observability's tauri-free `tracing-host` (trace-context propagation) | The rest of `desktop-host`'s logging for `cognia-server` (P9) |
| P4 | `cognia-companion-connectivity`, `-bus`, `-contract`, `-security` | — |
| P5 | `RendererPort`; `CompanionRuntime` (dispatch and the app's routes) and the headless slots; `RpcError`, the payload capability gate and the approval-authority check in the core; `cognia-power` and Wake-on-LAN out of the app | `RpcHost` (P5.3, with P8), the `commands.rs` split |
| P6 | `cognia-codex-app`, `cognia-browser-cookies`, `cognia-hooks`, `cognia-fleet`, `cognia-task-workspace-host`, `cognia-terminal::host_client` and `::host_bridge`, GitHub workspace and repo import into `cognia-git`; `cognia-elevated-setup`; the job supervisor host/RPC runtime in `cognia-jobs::host`; `cognia-sidecar` locator, supervisor, Langfuse, Pi integrity verifier and command core; `cognia-codeserver`; `cognia-terminal::sftp_service` | — |
| P8 | `cognia-companion-rpc` project environment, shell execution and shared command services | RPC families, host adapter and headless registry |
| P7 | `cognia-companion`: the core (51 files, 44k lines); `companion_api` is a facade plus the dispatch table, command shells and `wiring` | — |

Where the plan met the code:

- **P6h and the jobs host were extracted on 2026-09-27.** The sandbox and VDD
  setup binaries keep their executable names in `cognia-elevated-setup`. Their
  Windows-only `dirs` and `chrono` dependencies remain; neither binary depends
  on Tauri. `cognia-jobs::host` now owns supervisor installation and host RPC
  dispatch; the desktop keeps the existing command shells and registrations.

- **`cognia-task-workspace-host` is a crate, not a module of
  `cognia-task-workspace`.** That crate is deliberately sync (no tokio), and
  every host-surface body runs on the async runtime.
- **The terminal bridge moved in two steps.** `cognia-terminal::commands`
  still defined the pre-durable-host `terminal_*` commands under the same
  names, unregistered, and `#[tauri::command]` exports crate-global
  `__cmd__*` macros, so the bridge could not join that crate until they were
  deleted. With them gone, the bridge commands and their state live in
  `cognia_terminal::host_bridge` behind `tauri-host`, and
  `src-tauri/src/terminal_host_bridge.rs` is a glob re-export, which carries
  those macros, so `generate_handler!` in `lib.rs` did not change. Only the
  `terminal_host_service` shell stays in the app: its LAN URL fallback reads
  the companion server's state, so the shell passes it to the crate's
  `run_terminal_host_service` as a closure.
- **The hooks runtime and Fleet reach the binary through slots**
  (`cognia_hooks::host::HOST`, `cognia_fleet::companion::COMPANION`), which the
  desktop fills at boot and `cognia-server` fills with its headless services.
  A source test pins both installs for Fleet.
- **A crate's `cfg(test)` behaviour forks become `test-support` forks** when
  the desktop's own tests relied on them (Fleet's recovery file and `git`
  capture). `src-tauri` enables `test-support` only from its dev-dependencies,
  so release builds never see it.
- **The core's app hooks are a field, not a global.** `CompanionState.runtime`
  (`CompanionRuntime`: dispatch, whether a host exists, the IDE relay routes)
  is required when a state is built, so a binary that forgets it does not
  compile; a missing global install would have been a silent 503 or 404. The
  headless server's extras stay process-global slots (`runtime::HEADLESS`,
  `BRAIN`) because the services behind them are, and they are filled in the
  same call that installs those services. Unit-test states take
  `runtime::unwired()`.
- **The WebView adapter stayed in the app.** `TauriRenderer` needs the bus's
  WebView transport, which is behind the bus's `tauri-host`; a crate may not
  turn on another crate's host feature, and only app code recovers an
  `AppHandle` anyway, so it is `companion_api::host` in `src-tauri`.
- **Every `cfg(test)` fork in the core became a `test-support` fork**, for the
  same reason as Fleet's: the app's tests had always compiled the core with
  `cfg(test)` (the bridge hello timeout, bridge-slot ownership). Two tests
  only passed through test order in the old crate (the OIDC middleware test
  needed another test's proxy policy) and now set up what they use.
- **`cognia-power` is its own crate.** The keep-awake assertion is held by the
  sidecar, the companion worker and the desktop screen-hold command, so it
  sits below all three rather than in connectivity as planned.
- **The sidecar locator and supervisor are now a platform crate.** Desktop
  installs the directory before other startup steps, and headless installs it
  beside its resolved script. Plugin runtime reads the same `Installed` slot.
  The existing `SidecarHost` now supplies recovery decisions, telemetry
  injection and host RPC dispatch, keeping domain services out of the crate.
  Process-group cleanup moved unchanged into `cognia-exec-sandbox` and is
  re-exported by `cognia-external-agent`. Pi extension integrity verification
  moved alongside the locator; the app retains only its command shell.
  Account-scoped Langfuse validation, credentials and export also live there;
  the five Tauri command shells stay registered at their existing paths.
  Its release version joins the app version-sync group. Legacy telemetry
  secret cleanup is shared through `cognia-secrets`, without a desktop link.

## Consequences

- An edit to the app shell no longer recompiles the companion plane, and an
  edit to a companion crate no longer relinks through `app_lib`'s 187k lines.
- `cargo build -p <crate>` compiles no Tauri for any library crate, so crate
  test binaries are small and portable (no webkit on Linux CI for them).
- The headless image stops carrying a desktop GUI stack.
- `app_lib` cannot silently regrow: a new top-level module or a line count
  over the ceiling is a gate failure, not a surprise found months later.
- The cost is manifest churn and a period in which `companion_api` is a facade
  over crates. The shim-and-re-alias technique keeps every existing path
  compiling while that lasts.

## Alternatives considered

- **Keep ADR-0067's pattern (crates depend on Tauri directly).** It speeds up
  incremental builds but keeps Tauri in every crate's closure, so the headless
  server can never shed webkit. Rejected.
- **Move every command shell back into `src-tauri`.** It makes crates
  Tauri-free, but moves 563 commands into the app shell this ADR is trying to
  shrink. The `tauri-host` feature gets the same crate purity without the
  churn.
- **One `cognia-companion` crate.** Simpler, but the RPC families depend on
  codeserver, fleet and the sidecar, which depend on the companion core. One
  crate would be a dependency cycle, so the core and the families are
  separate crates.
