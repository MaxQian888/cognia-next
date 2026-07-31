---
title: ADR-0059 — Cloud Deployment — Headless Brain & Frontend/Backend Separation
description: "Defines the cloud deployment strategy: keep the desktop's proven two-plane split (Rust axum front door + TS lib/ brain) and swap only the brain's host (WebView → Node headless-host). Covers the full plan: deployment engineering for the existing services (CI deploy, GHCR images, compose suite), completing the cognia-server headless binary (BridgeTransport, headless bootstrap registry, brain process, secret store), frontend/backend-separated web access, the execution plane (sidecar + external agent CLIs via an ExecBackend abstraction), and the three-layer isolation model (ADR-0028 sandbox / workspace containers / tenant microVMs)."
---

# ADR-0059 — Cloud Deployment — Headless Brain & Frontend/Backend Separation

**Status**: Accepted — Phases 0–1 landed, Phase 2 partial (2026-07-13; proposed 2026-07-02)
**Authors**: Max Qian + Claude

> **2026-07-18 addendum**: ADR-0085 adds a second, opt-in T2 execution shape:
> one persistent WorkspaceRuntime per migrated workspace, hosting repeated
> external-Agent children, its dev server, and a private Playwright service.
> The disposable per-Agent `ContainerBackend` remains the default and is not
> removed. Clients reach the browser only through `cognia-server`; runtime and
> CDP endpoints remain private.

> **Implementation status (2026-07-13, `dev`)**: Phase 0 is fully landed —
> `deploy.yml` is the real gated deploy workflow (P0.1), `images.yml`
> publishes/compile-checks all four GHCR images (P0.2), the service
> workflows push on `dev` too (P0.3), and the compose suite exists with the
> tuned seccomp profile (P0.4). Phase 1 (W1–W6) is landed: the headless
> binary supervises brain + sidecar, the server secret store is env-keyed,
> and `compose-e2e.yml` runs the tier-2 smoke in CI. From Phase 2, F2 (Caddy
> ACME front door) and F4 (public connector webhooks) are shipped, plus
> Logto OIDC multi-user auth on the gateway. From Phase 3,
> `ExecBackend::Container` (R13, bollard + `docker-compose.t2.yml`), its
> Kubernetes flavor (`k8s-exec` feature — runner Pods with attached stdio
> and PVC-subPath workspaces, opt-in via `tenant-template/runners/`), and
> the `deploy/k8s` kustomize tree (D9/T3) all exist.
> The companion default port moved to **27890**
> (Clash collision) and the whole deploy suite tracks it. The "Context"
> section below describes the world as of 2026-07-02 and is kept as-is.
**Builds on**: ADR-0012 (transport abstraction), ADR-0014/0015 (companion API, Phase D skeleton), ADR-0021 (signaling), ADR-0025 (unified subscription), ADR-0028 (sandbox), ADR-0037 (share server), ADR-0043 (provider execution), ADR-0048/0049/0051 (external agents), ADR-0054 (local multi-account)

## Context

Cognia is local-first: the Next.js static export is consumed by three shells, and the **desktop is the server** — mobile reaches it via mDNS → WebRTC → cloudflared tunnel (`lib/connectivity/connection-strategy.ts`). The cloud footprint today:

- **Two standalone services** (`services/signaling-server`, `services/share-server`), each shipping an axum binary + a Cloudflare Worker variant, Dockerfile, and a sample fly.toml. CI tests them (clippy + ≥90% llvm-cov) but **deploys nothing** — `deploy.yml` is dead Vercel scaffold (`DEPLOY_ENABLED: false`), and the service workflows' push triggers only fire on `master`.
- **A headless companion-API skeleton already exists**: `src-tauri/src/bin/cognia-server.rs` ("Phase D") opens a SQLite `AppStore`, self-signed TLS + fingerprint, pair JWT (`cgnp2|` payload), `FilePushCredStore`, and serves the companion axum router with `app_handle: None`. `Dockerfile.cognia-server` exists but is never built in CI.
- **The CLI (`cli/`) proves the brain runs headless**: `fake-indexeddb` preamble (`cli/src/db/install-indexeddb.ts`) lets the desktop Dexie code run in Node; `setTransport(StdioTransport)` drives the same sidecar; a debounced JSON snapshot (`cli/src/db/{bootstrap,snapshot}.ts`) persists the store.
- **The frontend/backend seam already exists**: everything flows through `Transport { call, subscribe }` (`lib/tauri/transport-types.ts`) with five implementations (Tauri IPC / companion HTTP+WS / WebRTC / web stub / CLI stdio). The plain-web build gets the stub, which rejects every call.

Three facts decide the architecture:

1. **`AppStore` covers 2 tables; the brain owns 15+.** The Phase D trait (`companion_api/store.rs`) has six methods (sessions/messages CRUD). `sync_registry.rs` advertises characters, skills, workflows, workflowRuns, twinProfile, plugins, adapterInstances, settings, goals, memories, mcpServers, conversationOverrides, widgets… backed by the Dexie v54+ schema and its migration history. Rewriting the data plane in Rust means re-implementing all of that **plus** the TS-only business logic (build-options, PII gate, connectors, team orchestration) — a permanent dual-schema drift.
2. **The three WebView bridges are transport-agnostic.** `sync_bridge` / `desktop_messages_bridge` / `desktop_writes_bridge` all follow the same pattern: emit `{request_id, …}`, the brain answers via a command, a oneshot resolves. Only the transport (Tauri `Emitter` + command) is WebView-specific; the ~45 RPC handlers are not.
3. **The mobile client is already a lib/-brained client of this exact protocol.** Capacitor runs the same `lib/`, resolves `resolveSendOptions` locally, and calls the companion RPC remotely. A headless brain joining as a localhost client — and a browser joining as a remote client — changes nothing about the protocol.

## Decision

### D1 — Swap the brain, keep the front door

Reuse the desktop's proven two-plane split and replace only the brain's host:

```
┌── cognia-server (Rust, PID 1) ────────────────────────────────┐
│ Front door: TLS · JWT · rate limit · audit · companion RPC     │
│             sync_pull · connector webhooks (public!) · push    │
│ Supervisor: spawns brain (as Tauri spawns the sidecar) ·       │
│             spawns sidecar · spawns external agents (ACP)      │
│ Fallback:   SqliteAppStore (sessions/messages, read-only       │
│             degraded surface when the brain is down)           │
└──────┬──────────────────────────────▲─────────────────────────┘
  BridgeTransport (stdio/WS)     CompanionTransport (localhost
  data plane: Rust asks the       + service token) control plane:
  brain for rows                  brain invokes Rust commands
       ▼                              │
┌── headless-host (Node brain) ───────┴─────────────────────────┐
│ Full @/lib business layer: build-options · PII gate ·          │
│ connector adapters · scheduler · workflows · twin · teams ·    │
│ sync source · ExecutionBroker                                  │
│ Dexie (fake-indexeddb + durability ladder)                     │
│ sidecar (Claude Agent SDK / AI SDK)                            │
└────────────────────────────────────────────────────────────────┘
```

Strict isomorphism with the desktop: `WebView ↔ headless-host`, `Tauri IPC ↔ CompanionTransport(localhost)`, `app.emit bridges ↔ BridgeTransport`. One business codebase, one protocol, two hosts — no fork.

### D2 — Two seam abstractions, same move twice

- **`BridgeTransport`** (Rust): the three bridges' `AppHandle.emit` collapses behind a trait with a WebView implementation (today's behavior, unchanged) and a WS/stdio implementation (headless). RPC handlers untouched.
- **`ExecBackend`** (Rust): `external_agent/process.rs`'s "spawn = local tokio process" assumption collapses behind a trait — `LocalProcess` (desktop + single-container cloud) and `Container` (per-workspace runners, later). ACP is a stdio stream; attaching to a container's stdio is transparent to the TS `acp-client`.

Protocol stays, transport swaps — in both cases.

### D3 — The brain owns the data; AppStore is a fallback, not a destination

The single source of truth in headless mode is the brain's Dexie (full v54+ schema), persisted via a durability ladder (see W3). The Phase D `AppStore` direction — rewriting RPC handlers to hit SQLite directly — is **rejected as the primary path** (fact 1 above) and retained only as the degraded read-only surface.

### D4 — Execution plane parity: sidecar and external agent CLIs

Cloud capability = desktop capability minus hardware-bound features. Both execution paths ship:

- **Sidecar** (Claude Agent SDK / AI SDK): spawned and supervised by cognia-server exactly as `claude/sidecar.rs` does on desktop (ready probe, crash backoff).
- **External agents** (claude-code / codex / opencode / cursor / cline / gemini): the TS orchestration (`lib/ai/agent/external/{manager,acp-client,env-builder}.ts`) already lives in `@/lib` and calls `Transport.call("spawn_external_agent")`; the Rust supervisor (`external_agent/` — `command_resolver`, `proc_group`, ADR-0049 hardening) is kept as-is behind `ExecBackend`. Credentials flow through the unified subscription vault exactly as on desktop (`env-builder.ts`); Codex device-code OAuth and Claude token paste are headless-friendly.

Not available in cloud (degraded/hidden): computer-use, OCR, native terminal into the host, desktop pet, native sqlite-vec (use the five cloud vector backends from ADR-0023).

### D5 — Three-layer isolation, three-tier topology

| Layer | Threat | Mechanism |
| --- | --- | --- |
| **L1** tool execution (bash/python/plugins) | one malicious/runaway command | ADR-0028 sandbox — on Linux, bubblewrap + seccomp + `net_proxy.rs` allowlist proxy. Already built; already consumed by automation/canvas/plugin-python/terminal. |
| **L2** external-agent workspace | a full-trust dev agent should still not escape its workspace | workspace boundary: volume mount (T1) → per-workspace runner container (T2) |
| **L3** tenant | users must not see each other's data/credentials | container/microVM hard boundary (T3) |

Topology ladder:

- **T1 — single container** (self-host, single user): container = tenant boundary; bwrap inside for L1; workspace volumes for L2. **Gotcha**: Docker's default seccomp profile blocks `CLONE_NEWUSER`, so bwrap fails inside a stock container. Ship a tuned seccomp profile with the compose suite (never `--privileged`); on failure the sandbox already degrades honestly via `UninstalledSandboxBackend`.
- **T2 — split execution plane**: `cognia-server + brain` stay in the main container (the bridge couples them tightly); external agents move to per-workspace runner containers (image = external CLIs + git + workspace volume) spawned via `ExecBackend::Container` (Docker/containerd API).
- **T3 — multi-tenant**: one T1/T2 unit per tenant on gVisor/Kata/Firecracker, orchestrated per-tenant (K8s namespace + NetworkPolicy). `lib/execution/broker.ts` is the brain-side quota/fairness hook. If T2's abstraction is right, T3 changes implementations, not architecture.

### D6 — Security model

- Browser clients **cannot pin self-signed fingerprints** → the cloud front door requires a real domain + ACME TLS (reverse proxy, e.g. Caddy in the compose suite). Fingerprint pinning remains for Capacitor direct-connect.
- The brain authenticates to localhost cognia-server with a dedicated **service token** (scoped, loopback-minted) — never a device JWT.
- `spawn_external_agent`-class commands on the headless RPC surface are **RCE-grade**: preset-only allowlist (no arbitrary argv), separate scope, full audit trail.
- `remote_control` (47821) and the LLM `gateway` (47823) keep their loopback-only threat model — never exposed beyond the container.
- The PII redaction gate (`packages/redact/src/index.ts:hasNoLeakingPii`) sits in the brain and therefore survives the move unchanged; verify with the pii-gate audit before each phase ships.
- Client-side secrets keep the keyring; **server-side secrets move to an encrypted file store** (pattern precedent: `FilePushCredStore`), master key via env/boot secret.

## Plan

Work packages are ordered by dependency. Every TS/Rust item follows repo rules: co-located tests, ≥90% coverage, i18n for any UI string, conventional commits; each phase ends with the preflight audit set (test-gap, i18n, static-export, tauri-rust, pii-gate, wiring).

### Phase 0 — Deployment engineering (independent, start any time)

| # | Task | Key files | Acceptance |
| --- | --- | --- | --- |
| P0.1 | Replace dead `deploy.yml` with real, opt-in deploy jobs: `wrangler deploy` (both Workers) + `flyctl deploy` (both axum) gated by GitHub Environments + repo `DEPLOY_ENABLED` var + secrets | `.github/workflows/deploy.yml`, service READMEs | manual dispatch deploys to staging; forks stay green with no secrets |
| P0.2 | GHCR image publish on tags for `signaling`, `share`, `cognia-server`; compile-check `Dockerfile.cognia-server` in CI | new `images.yml`; `Dockerfile.cognia-server` | `docker pull ghcr.io/...` works for all three |
| P0.3 | Fix service workflow push triggers to include `dev`; add signaling `worker-build` artifact verification; add a share-core↔TS-Worker constants parity check (code length/alphabet/limits emitted as JSON from a `cargo` test, asserted by a Worker vitest) | `.github/workflows/{signaling-server,share-server}.yml`, `services/share-server/core/`, `worker/src/index.test.ts` | drift in either side fails CI |
| P0.4 | docker-compose self-host suite v1: signaling + share + healthchecks + volume; include the tuned seccomp profile (userns allowed) as a deliverable for Phase 1 | new `deploy/compose/` | `docker compose up` → both `/healthz` green |
| P0.5 | Document `NEXT_PUBLIC_SHARE_URL` in `.env.example` + `env.d.ts` (existing gap) | `.env.example`, `env.d.ts` | — |
| P0.6 | Docs site hosting (Cloudflare Pages) — optional, low priority | `docs/` | public docs URL |

### Phase 1 — Headless Cognia core (the strategic build)

| # | Task | Key files | Acceptance |
| --- | --- | --- | --- |
| W1 | **`BridgeTransport` trait**: abstract the emit side of the three bridges; `WebViewBridgeTransport` (today, unchanged) + `SocketBridgeTransport` (WS or stdio to the brain). Zero desktop behavior change; mergeable alone | `src-tauri/src/companion_api/{sync_bridge,desktop_messages_bridge,desktop_writes_bridge}.rs`, new `bridge_transport.rs` | all existing bridge tests pass against both impls |
| W2 | **Headless bootstrap registry**: extract the effect bodies of the runtime providers (`companion-boot`, `desktop-sync-source`, `desktop-message-source`, `backup-scheduler`, `a2ui-dispatch`, connector runtime, scheduler, initializers/*) into a plain-TS `bootstrapHeadlessRuntimes()`; providers become thin wrappers. Zero desktop behavior change; mergeable alone | `components/providers/**`, new `lib/headless/bootstrap.ts` | desktop app behaves identically; each extracted runtime has a headless smoke test |
| W3 | **headless-host process**: extend the CLI package with a `serve` mode (reuses `install-indexeddb`, snapshot, sidecar bootstrap): connect `SocketBridgeTransport` (answer the data plane), use `CompanionTransport` → localhost with a service token (drive the control plane), call `bootstrapHeadlessRuntimes()`. Durability v1: flush-on-write debounce + exit hooks + RSS metric | `cli/src/serve/` (new), `cli/src/db/bootstrap.ts` | `cognia-agent serve` answers a `sync_pull` end-to-end against a local cognia-server |
| W4 | **cognia-server supervision + RPC expansion**: spawn/supervise brain + sidecar (ready probe, crash backoff, mirroring `claude/sidecar.rs`); aggregate `/healthz`; mint/verify the brain's service token; add `spawn/send/kill/status_external_agent` to the headless RPC surface behind preset allowlist + scope + audit; extract **`ExecBackend`** (`LocalProcess` impl only) | `src-tauri/src/bin/cognia-server.rs`, `companion_api/rpc.rs`, `external_agent/{process,commands}.rs`, new `exec_backend.rs` | kill -9 the brain → front door serves 503 + degraded reads, brain restarts, clients recover |
| W5 | **Server secret store**: encrypted-file store replacing keyring reads in headless (subscription vault, vector creds, connector creds, share upload secret); master key via env; PII-gate audit re-run | `src-tauri/src/subscription/vault.rs` (backend trait), `companion_api/push_creds.rs` pattern | codex + claude-code creds resolve in a container with no keyring |
| W6 | **Container + smoke**: `Dockerfile.cognia-server` slim (sidecar only) / full (external CLIs preinstalled + git) variants; wire into the compose suite with the seccomp profile; e2e smoke: pair → chat turn (sidecar) → external-agent turn → connector webhook in | `Dockerfile.cognia-server`, `deploy/compose/` | the smoke script passes against `docker compose up` |

**Phase 1 exit criterion**: a phone pairs against a cloud container and completes a full chat turn executed server-side, with the desktop switched off.

### Phase 2 — Frontend/backend separation

| # | Task | Notes |
| --- | --- | --- |
| F1 | Web transport selection: browser build uses `CompanionTransport` when a cloud base URL is configured (replaces `WebStubTransport`); login/pair page (paste/scan `cgnp2\|`, exchange for device JWT, browser-safe storage) | i18n both locales; `static-export-auditor` must stay green |
| F2 | Real TLS story: Caddy (ACME) in the compose suite fronting cognia-server; keep fingerprint pinning only on Capacitor paths | docs + compose |
| F3 | Account model: align `HEADLESS_LOCAL_ACCOUNT_ID` with ADR-0054 multi-account isolation; per-account scoping in brain + front door | prerequisite for T3 |
| F4 | Connectors go public: webhook routes exposed via the front door's public URL; retire the tunnel requirement in docs/UI for cloud installs | biggest structural win |
| F5 | Capability degradation matrix in UI: hide/disable desktop-only features when the transport is cloud-companion | i18n; per-feature capability flags already exist for mobile — extend, don't fork |

### 2026-07-31 Web dual-runtime completion

Phase 2 no longer selects behavior from `web` versus `tauri` alone. The Web shell now activates one account-scoped `RuntimeTarget` at a time:

- `standalone` executes AI SDK chat, browser-safe tools, attachments, memories, and provider routing locally.
- `companion` resolves an encrypted credential reference from the unlocked browser Vault, binds transport and synchronization to that target, and uses only healthy, granted operations advertised by `HostRuntimeManifestV2`.
- `legacy-readonly` preserves unclassified pre-migration data without allowing it to be written back to an arbitrary host.

Target metadata is account-scoped, while each target has a physically separate Dexie database. Switching follows stop subscriptions → activate database → rebind transport → refresh manifest/sync; a failed transport rebind rolls back the active pointer. Outbound queue rows carry both `accountId` and `targetId`, and are never replayed against a different target. Browser secrets (provider keys, device JWTs, signaling JWKs) are encrypted by the PBKDF2/AES-GCM Vault and never stored in the public target book.

Public navigation and deep links consume the shared `SurfaceContract` registry. Each route therefore resolves to executable, remote, cached read-only, queued, or an explicit localized recovery state. Host build ids are diagnostic only: compatibility is negotiated from protocol range and per-feature versions, and undeclared, unhealthy, or ungranted operations fail closed.

### Phase 3 — Scale-out (only if/when multi-tenant is wanted)

`ExecBackend::Container` (per-workspace runners) → per-tenant units on gVisor/Kata → K8s orchestration + `ExecutionBroker`-backed quotas → observability per the services convention (Prometheus `/metrics` everywhere).

## Risks

| Risk | Mitigation |
| --- | --- |
| Dexie durability in Node (fake-indexeddb is in-memory; snapshots lose the last seconds on crash; whole-DB serialize is O(n)) | ladder: v1 debounced snapshot + write-triggered flush + exit hooks → v2 mutation journal for the crash window → v3 SQLite-backed IndexedDB adapter. Monitor brain RSS; the in-memory dataset is this path's ceiling. |
| Residual `window`/DOM assumptions in `lib/` runtimes the CLI never exercised (connectors, schedulers) | W2 lands a headless smoke per extracted runtime; failures surface at extraction time, not in production |
| bwrap unavailable inside stock Docker (`CLONE_NEWUSER` blocked) | ship the tuned seccomp profile in compose; honest degradation via `UninstalledSandboxBackend` |
| RCE surface of spawn-class RPC | preset allowlist + dedicated scope + audit; loopback-only for remote-control/gateway |
| Brain⇄front-door version skew (rolling container updates) | ship them in one image; `/healthz` reports both versions; bridge protocol carries a version field |

## Alternatives considered

- **A — Complete the Phase D `AppStore` rewrite (Rust owns data)**: rejected as primary path — re-implements 15+ tables + TS-only business logic in Rust, permanent dual-schema drift. Kept as the degraded fallback surface.
- **B — Headless WebView/Electron in the container**: GUI runtime in a server container; unreasonable on resources, image size, and stability.
- **C — Turn Next.js into an SSR backend**: violates the `output: "export"` invariant that all three shells consume one static export.
- **D — Node brain spawns external agents itself**: discards `command_resolver`/`proc_group`/ADR-0049 hardening and forks the supervision logic.

## Consequences

- The desktop and cloud share one business codebase and one protocol; features land in both by default. The cost is a hard rule: **new runtime side-effects must register through the headless bootstrap registry, not raw provider effects** — enforce via the wiring audit.
- Mobile and web clients need zero protocol changes; the web build finally becomes a first-class client.
- The companion RPC allowlist becomes the de-facto public API contract of Cognia; changes to it now carry compatibility weight (spec-parity tests already exist — extend them).
- Until v3 of the durability ladder, cloud installs are bounded by brain memory; this is acceptable for single-tenant self-host and must be revisited before T3.
