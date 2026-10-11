# Always-on host — phased implementation plan

**ADR:** [ADR-0224](../content/docs/en/adr/0224-an-always-on-host-is-a-peer-the-user-brings.md)
**Date:** 2026-10-10
**Order:** phase A in table order, A1 → A12 (user decision). Each item lands as its own commit(s) with co-located tests, i18n for both locales, and a changeset when user-facing.

Every seam below was located by a read-only survey on 2026-10-10. Line numbers drift; re-grep before editing.

---

## Phase A — a standalone, usable always-on host

### A1 — Packaging and durability

**Goal:** a user can run an always-on host on Linux (Compose) or macOS (native LaunchDaemon) from documented steps, and it stores data durably.

1. **Shared service installer.** Done in the new foundation crate `crates/cognia-host-service`: `ServiceSpec {label, unit, program, args, env, run_as, credentials, restart}` with a `user | system` scope, rendered as a LaunchAgent / LaunchDaemon plist or a systemd user / system unit, installed through an injected `ServiceIo`.
   - The system scope (LaunchDaemon, systemd system unit) starts the service at boot without a login and runs it as a named non-root account.
   - The terminal host's `crates/cognia-terminal/src/terminal_host_service.rs` now renders its login service through the same crate.
   - `server.rs` in the crate resolves a `cognia-server` install (install layout, data dir, service account, master key placement) and refuses root, unknown accounts and incomplete installs.
   - Deferred to phase C: the TypeScript worker's `cli/src/worker/daemon-service.ts` stays user-scope until execution-only nodes need a boot-time install; it will move onto the same spec shape then.
   - Tests: plist/unit rendering per platform and scope, install/uninstall with injected IO.
2. **`cognia-server service install|uninstall|status`** subcommands in `src-tauri/src/bin/cognia-server.rs`.
   - `install` writes the definition with `serve`, data dir, master key file and brain/sidecar paths resolved relative to the install root.
   - `status` reports loaded/running and the health of `/readyz`.
3. **Master key provisioning.**
   - `cognia-server init` generates `<data>/master.key` (0600) when absent and refuses to overwrite.
   - `crates/cognia-secrets/src/secret_store.rs` `resolve_master_key_from_env` gains `systemd-creds` (`$CREDENTIALS_DIRECTORY/cognia-master-key`) and the macOS Keychain as providers.
   - Tests cover provider precedence and a missing key.
4. **macOS standalone archive.** A build script assembles `cognia-server`, the brain layout (`scripts/build/build-cli-binary.mjs --layout-only`), the sidecars and a pinned Node into one archive with an install contract.
   - The entry name is `cli.mjs` in both the image and the archive; the service sets `COGNIA_BRAIN_ENTRY` explicitly, so the dev `cognia-agent.mjs` name never reaches a host.
   - Sign and notarize with the desktop's identity.
5. **Durability default `sqlite-v5`.**
   - Make the resolved backend reach the store: `DurabilityStoreOptions.backend`, honoured by `resolveBackend` when no manifest exists (`cli/src/serve/persistence/store.ts:236`, `backend.ts:106`). This fixes the env gate that is silently ignored on fresh accounts.
   - Change the fresh-boot fallback in `cli/src/serve/durability.ts:114`.
   - Write a snapshot-v3 → ledger importer (`db-<acct>.json` → sqlite) and run it automatically before switching an existing account. Never reseed.
   - Update the pins: `durability.test.ts:305-318`, `manifest.test.ts:18-22`, `backend.test.ts:182-185`. Add a fresh-boot sqlite test and an importer round-trip test.
   - Confirm the `node:sqlite` floor of the bundled Node.
6. **Compose.**
   - `server` profile: pass `--no-mdns`.
   - Document `COGNIA_SECRET_ROOT` and `compose.production.yaml`.
   - Fix the Dockerfile quickstart, which boots without a master key.
7. **Docs.** A bilingual "Run an always-on host" page under `docs/content/docs/{en,zh}/` (Linux Compose, macOS native, OS settings for a Mac mini: auto-login is not needed for the daemon, restart after power failure, wake). Use the `subsystem-docs` skill; gate with `pnpm docs:build`.

**A1 verification (2026-10-11).** An archive assembled from the debug server, the `--layout-only` brain and a local Node was installed with `service install --scope user` on a spare port. It reached `/readyz` ready with sqlite-v5 durability, `pair` returned a relay invitation through the running server, launchd restarted it after `kill -9`, and `service uninstall` left the data in place. The run surfaced three packaging defects, all fixed in A1 and shared with the Docker image:

- The CLI bundle inlined `jsonc-parser`'s UMD `main`, whose internal `require("./impl/format")` cannot resolve inside a bundle, so the brain died on start. `scripts/build/lib/prefer-esm-entry-plugin.mjs` now bundles its ESM entry.
- The sidecar's copied externals lacked their dependencies and peers (`@modelcontextprotocol/sdk`, `zod`, `@anthropic-ai/sdk` for the Claude Agent SDK), so the sidecar could not import. `scripts/build/lib/copy-runtime-closure.mjs` copies the runtime closure, and the layout now carries webclone's runtime closure too (the image's separate overlay is gone).
- Sidecar launchers compared `import.meta.url` with `process.argv[1]`, which differ when the install path crosses a symlink (macOS `/tmp`), so the sidecar silently did nothing. `sidecar/src/shared/main-module.ts` compares the real path.

### A2 — Relay-first pairing

1. `pair` probes the running server on `--port`, not only `COGNIA_PORT` (`cognia-server.rs:1449`).
2. When a running server cannot open a relay room, `pair` fails with the reason instead of silently emitting `cgnp3`. `--direct` opts into a direct invitation.
3. Print a terminal QR code alongside the `cgnp4` string, and the expiry.
4. The desktop pairs an always-on host through the existing add-host flow (`components/connectivity/pair/add-host-form.tsx`) without activating it. The host is recorded as an always-on peer, not switched to.
5. `cognia-agent host login` accepts `cgnp4` (relay pairing through `createRelayPairFetcher`).
6. Tests: pair-port probe, relay-less refusal, QR rendering, `cgnp4` consumption in the CLI.

**A2 outcome (2026-10-11).** All six done and run against a live server:

- The invitation issuer now waits (up to 10 s) until the relay has subscribed the pairing room, closes a room that never gets there, and reports why there is no relay (`relayUnavailable` on the invitation, added to the response schema). `pair --port N` asks that port, prints a terminal QR and the expiry, and refuses a relay-less invitation with the reason unless `--direct`.
- The desktop's add-host form has an **Always-on host** switch: the host is recorded with `alwaysOn` on `RemoteHost`, never switched to, and badged in the list.
- `cognia-agent host login <name> --invitation 'cgnp4|…'` takes the same direct-first, relay-second path as the pair screen (`lib/companion/pair-path.ts`). Found and fixed on the way: the CLI's direct pairing could not reach a self-signed host (the TLS fingerprint was dropped, so Node refused the certificate); an aborted pinned request held its socket until the OS connect timeout (~75 s); pairing rooms wrote an event cursor to `localStorage` they never used.
- Not in A2: the CLI sends its later requests to the host's address, so a CLI paired through the relay needs a direct route afterwards. `host login` says so. Requests over the relay belong with the management channel (A4).
- `pnpm companion-api:gen` fails on HEAD since `ae76e4d69` (ADR-0221 dispositions without command descriptors); the response schema change was mirrored into `crates/cognia-cli/assets/host-command-catalog.json` by hand.

### A3 — Desktop always-on mode

1. Persisted mode flag with a Rust mirror, following the `exit.close-behavior` + `AtomicU8` pattern (`src-tauri/src/window_behavior.rs`, `lib/tauri/close-behavior.ts`). Device-local in settings sync.
2. A `WakeReason::HostMode` at `WakeLevel::System` in `crates/cognia-power`, acquired in Rust while the mode is on.
3. Login launch hidden: an autostart argument (`src-tauri/src/lib.rs:431`) that skips the renderer reveal and the boot grace timer (`webview_watchdog.rs:66`).
4. Enabling the mode sets close behavior to Tray and keeps the tray's Quit.
5. A "hosting" predicate beside the static `always-on` capability, so the console and bot UI can say whether this machine is actually hosting.
6. UI: a block in `components/settings/desktop-section.tsx` and a status row in the Connectivity overview. Keys in `i18n/messages/{en,zh-CN}/settings/desktop.json` and `connectivity.json`.
7. Tests: `window_behavior.rs`, `cognia-power`, `desktop-section.test.tsx`. Run `tauri-smoke`.

**A3 outcome (2026-10-11).**

- **The flag lives in Rust, not in the prefs store.** A login launch has to decide to stay hidden and to hold the machine awake before any renderer exists, and nothing in Rust reads `cognia.store.json`. The mode is persisted in `host-mode.json` in the app config dir (the `shell-background.json` precedent). It is read in a `host_mode` boot step before `main_window`, and read and written by the renderer through `host_mode_get` / `host_mode_set` (`lib/tauri/host-mode.ts`). It is device-local by construction: not an `AppSettings` field, never synced. The commands are registered as client-owned `local-only` with written reasons; `known_commands.rs` was mirrored by hand because `companion-api:gen` still fails on HEAD.
- **Wake.** `WakeReason::HostMode` at `System` level, set with `cognia_power::set_host_mode_hold(bool)`, a switch rather than a counted pair, so re-applying the flag never stacks a hold.
- **Hidden login launch.** The autostart entry passes `--autostart` (declared in `tauri.conf.json` so the CLI plugin accepts it). Only `--autostart` with host mode on stays hidden; plain launch at login still opens the window. In that case Rust disarms the 8 s force-show and the renderer's `WindowShowInitializer` skips its reveal. A second instance started by the login entry no longer pops the window. The Dock icon brings a hidden window back (macOS `RunEvent::Reopen`).
- **Close.** While the mode is on, the close handler applies `Tray` whatever is stored; turning the mode on also stores `tray` and registers launch at login. The tray's Quit is unchanged.
- **Hosting predicate.** `lib/platform/hosting.ts` resolves `hosting | standing-by | off | unsupported` from host mode, the LOCAL `always-on` baseline and whether the shell drives a remote host; `hooks/platform/use-hosting-state.ts` subscribes to all three. It is consumed by the Desktop block and the Connectivity overview's **Always-on host** row. The bot console's `local` reach stays silent as designed (host mode does not change whether the runner runs); the device console's local row uses the predicate in A4.
- **Not done here.** WKWebView may throttle timers in a hidden window. That was already the case for close-to-tray, and the system wake assertion also exempts the process from App Nap. Proving that bots and schedules fire with the window hidden for hours belongs to the A12 end-to-end run.

### A4 — Device console host state

1. `DeviceRow` gains a host role (`always-on`, `headless`, `desktop`), populated from `featureManifest.hostIdentity` and `platform` in `buildRemoteHostRow` and from the local mode in `buildLocalRow` (`lib/devices/build-device-rows.ts`).
2. Liveness for hosts that are not being routed to: a periodic probe through the management channel writes the remote-host store. The persisted `connectionState: "ready"` is reset on load.
3. The desktop reports platform `desktop` (`DevicePlatform` gains the value; `lib/tauri/companion-auth.ts:192`).
4. An always-on badge (`components/devices/device-visuals.tsx`), online state in the hero, row and overview sections.
5. The management channel: a hook over `openRemoteHostTarget` (`lib/remote-host/target-transport.ts:31`) that host panels share.
6. Tests for each builder and component; i18n for every label.

### A5 — Per-item ownership and migration

1. **Owner field.**
   - Add an owner field to scheduled tasks, bot installations (reuse the unread `placementRef`) and adapter instances. This is a Dexie schema bump; use the `dexie-migration` skill.
   - Gates read it: the per-task `isTimingAuthority` (`lib/scheduler/task-scheduler.ts:625`, call sites 988, 1157, 2078, 2137, 3603), bot delivery and reconcile, and the connector runtime per adapter.
   - Global timing authority stays only for items with no owner.
2. **Machine-bound classifier** (`lib/placement/`) returning reasons:
   - task type via the host matrix (`lib/scheduler/host-support.ts`);
   - desktop, pet, file-watch and terminal triggers;
   - local project roots;
   - `promotion`;
   - stdio MCP;
   - keyring references.
3. **Remote create surfaces:**
   - Connector instance create and configure on a host. This includes `connection`, `enabled`, `type`, `settings`, and credentials through the A6 store; today only `adapter_update_policy` exists.
   - Bot install as one grouped operation (install, config, bind, enable).
   - Fix `scheduled_task_import`: strip `promotion`, keep `status`, check host support and project scope, record provenance (`task-scheduler.ts:3536-3610`).
4. **Plugin transfer.** Preflight lists missing plugins and versions. After confirmation, export a signed cogpack (`lib/plugin/cogpack/`) and install it on the host through the management channel.
5. **Migration service.**
   - Preflight, transfer, confirm and fence, modelled on `lib/thread-handoff/service.ts`.
   - Idempotent by operation id.
   - The local item becomes a disabled placeholder owned by the host. _Take back_ reverses it.
6. **Guided flow UI** after pairing: movable items, machine-bound items with reasons, and a progress and result view.
7. **New items default to the always-on host** when one is paired and reachable; machine-bound items stay local.
8. **Liveness fix** for the global authority: ADR-0136's authority reads probe-backed liveness (A4).
9. Tests: classifier, gates honouring owner, migration happy path and every blocker, take back, idempotent replay.

### A6 — Sealed secrets on the host

1. A host provider-credential store over `secret_store`, scoped per provider.
   - Companion commands to set, list (names only) and delete. Capability `secret.manage`, interactive approval.
   - The brain reads provider keys from it for unattended runs, so scheduled tasks and bots work without a per-turn key.
2. Connector and git credentials go through the same store.
   - `connectors_keyring_set` already writes there.
   - Add git credentials consumed by the mirror (`crates/cognia-git-mirror/src/credential.rs`).
3. Owner tagging: delete secrets written by a device when that device is revoked.
4. Move `companion_push_configure_*`, `bot_installation_mutate` and `bot_trigger_set_armed` to the interactive class.
5. Desktop UI on the management channel: "Secrets on this host", showing names, provider and when set, never values.
6. Tests: store round trip, revoke cascade, approval classes pinned.

### A7 — Declared permission and parked approvals

1. **Permission profile** on bot installations and scheduled tasks, folded through `lib/bot/policy/ceilings.ts` and `AgentCapabilityGrantV1` (narrowing only).
   - Classes: workspace file/shell, outbound send, secret use, host configuration.
2. **Sandbox auto-allow.** A permission-ladder step that allows workspace file and shell operations when the run's sandbox attestation is verified (`sidecar/src/policy/permission/ladder.ts`, pinned in `ladder.pins.test.ts`).
3. **Park instead of deny.** Replace the immediate deny in `lib/claude/unattended-permission-responder.ts:66` with a run interrupt.
   - Push notification plus approval card.
   - Resume on approval; deny on timeout.
   - The Claude-SDK approval waiter gains a TTL (`sidecar/.../approval.ts`).
4. **Bot approvals.**
   - Push channel `bot_approval` added to `PUSH_TRIGGER_CHANNELS`, emitted at `lib/bot/runtime/step.ts:278`.
   - A dedicated mobile card modelled on `pending-approvals-card.tsx`.
5. Tests: each class decision, park/resume/timeout, push emission, mobile card.

### A8 — Container per task by default

1. **Host-authored placement** for every dispatched surface: phone turns (`remote-run-service.ts:827`), scheduled agent tasks, bots, agent teams, plugin SDK dispatch.
   - Resolves the project runtime or a host default environment.
   - Phone turns gain a project and working directory.
2. Per-project opt-out to host-process execution on `ProjectRuntimeSelection`.
3. **Cognia Docker API proxy**, a new crate:
   - Validates request bodies: Cognia labels only, workspaces volume only, no privileged mode, no host network or PID namespace, no extra capabilities.
   - Exec only into labelled containers.
   - Replaces `docker-socket-proxy` in Compose.
   - Comments in `docker-compose.t2.yml` and the README are corrected.
4. Compose enables the pool for always-on hosts (`COGNIA_SANDBOX_POOL_ENABLED`, workspaces dir and volume, agent bundle image).
5. Tests: proxy allow and deny tables, placement for each surface, opt-out.

### A9 — Occurrence keys

1. **Webhook and integration events** key on the provider delivery id (`webhook_router.rs:507-512`, `integration_spool.rs:57`; `lib/integrations/events.ts:176`).
2. **Connector messages** key on the platform message id, independent of the local adapter id (`lib/connectors/bus.ts:1898, 1959`).
3. **Rust cron** keys on the scheduled slot (`alarm_daemon.rs:242, 265`, `cron_daemon.rs:208-224`).
4. **Bot ticks** key on the slot (`lib/scheduler/executors/bot-executor.ts:99`).
5. **Scheduler executions** key per slot. Add a unique `(taskId, scheduledFor)` index (shares the A5 schema bump).
6. **Correct the ADR-0136 §4 text** and the `trigger-idempotency.ts` header: they overclaim cross-host absorption.
7. **Tests:**
   - Two payloads in the same second produce two runs.
   - Two hosts' keys match for the same occurrence.
   - Cron keys are stable across a wake boundary.

### A10 — Updates and exact-version UX

1. **New update kinds** `host-server` and `host-brain`, shipped as one unit:
   - Signed artifacts.
   - Update-server rollout support for the new kind (today keyed to `desktop`).
   - Client adapters in `lib/updates/`.
2. **Host self-update.**
   - Follows the account's channel.
   - Runs when idle (no run in flight, no lease held).
   - Swaps server and brain together, checks health, rolls back on failure.
   - Auto-update is on by default and can be switched off in the host panel.
   - Compose hosts update by digest through the same check.
3. **Exact-version UX (ADR-0175 unchanged).**
   - The in-memory contract verdict (`lib/tauri/companion-contract.ts`) becomes a persisted host state.
   - The host panel and console show "update the host" or "update the app", with one-click update of the host through the management channel.
4. **Brain and server mismatch.** Trace and fix the supervisor's behavior after a bridge refusal: it must report the state, not loop.
5. Tests: update decision, rollback, verdict persistence and UI states.

### A11 — Code supply

1. **Project repository remote** on the project model, filled from the checkout (`lib/sandbox/run-environment.ts:612`).
2. **Clone-on-dispatch.**
   - Wire `task_workspace_remote_source_ensure` (`lib/task-workspace/client.ts:568`, no caller today) into host placement.
   - Uses the A6 git credential.
3. **Snapshot producer** on the desktop.
   - Base commit plus a binary-safe diff covering tracked, untracked, deletions and modes.
   - For non-git projects, a tar archive with a size cap (default 100 MiB, configurable).
4. **Snapshot transfer.** A chunked upload into the host's task workspace.
   - Raise caps for this purpose only.
   - Tar inspection alongside the zip inspection in `lib/security/upload-content-inspection.ts`.
5. **Host receiver.** Fetch the base commit, verify it, apply the diff to a fresh task checkout, refuse on mismatch.
6. **Return path.**
   - A pushed branch (`cognia/<agent>`) or a patch set.
   - The desktop applies either into a new worktree with one action.
   - An optional PR action when an integration credential exists.
7. Tests: producer coverage (binary, untracked, deletes, modes), receiver mismatch refusal, round trip.

### A12 — End-to-end proof, desktop off

A recorded run on a real BYO host (Compose on Linux, and the macOS daemon) with the desktop quit:

1. A phone pairs over the relay and completes a chat turn.
2. A bot answers in a real IM platform (Lark or Telegram; needs the user's credentials).
3. A scheduled task fires on its slot.
4. A dispatched coding task runs in a container from a snapshot handoff, and the desktop applies the result after it starts again.
5. A parked approval is pushed to the phone, approved, and resumes.

Record the evidence in `docs/reports/`. Run `preflight` and the gates for every item.

---

## Phase B — leases replace manual ownership

- ADR-0215 phase 4: execution leases in the account object for connector instances, scheduled tasks and live turns.
- The A5 owner field becomes the pin. Unpinned items fail over in rank order: headless server, then the most recently active desktop.
- Placeholders become synced rows.
- A9 keys plus the lease generation fence every external effect.
- Secrets move to the ADR-0215 secrets class (phase 5). The paired-channel delivery from A6 is retired.

## Phase C — team execution nodes

- `cognia-agent worker` nodes enrolled into a team through the collaboration server's roles (ADR-0149), with per-member quotas and concurrency.
- Members dispatch to the pool. Each person keeps their own single-account brain.
- Builds on ADR-0113 remote dispatch, which leaves dark launch here.

---

## Known defects found during the survey (fix inside the item named)

| Defect                                                                                                                          | Item                   |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `COGNIA_DURABILITY_BACKEND=sqlite-v5` writes journal-v4 on a fresh account                                                      | A1                     |
| `pair` ignores `--port` and silently emits a relay-less invitation (fixed)                                                      | A2                     |
| Persisted `ready` survives relaunch; hosts that are not being routed to are never probed                                        | A4                     |
| Global timing authority's liveness goes stale for hosts that are not being routed to, so the desktop takes over and fires twice | A5                     |
| `scheduled_task_import` copies the OS promotion and forces paused tasks active                                                  | A5                     |
| Push credential config and bot install/arm have no approval gate                                                                | A6                     |
| T2 Compose proxy sets `EXEC=0` but the pool needs exec; comments claim otherwise                                                | A8                     |
| Webhook and connector events in the same second collapse into one run (data loss)                                               | A9                     |
| Cron occurrence key is the wake time, not the slot                                                                              | A9                     |
| Signaling live join path does not enforce `SIGNALING_MAX_*` (docs claim it does)                                                | out of scope; reported |
