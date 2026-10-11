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

**A4 outcome (2026-10-11).** Built and run live against a headless host, from the desktop shell and the CLI:

- **Management channel** (`lib/remote-host/management-channel.ts`, hook `hooks/remote-host/use-management-channel.ts`): one reference-counted connection per host over `openRemoteHostTarget`, kept warm for 150 s after the last lease and keyed by `RemoteHost.id` whichever ref a caller uses. A re-paired or removed host's channel is closed and reopened, so stale keys are never read as a revocation. The console's "Read its worktrees" now goes through it.
- **Liveness** (`lib/remote-host/liveness.ts`, `RemoteHostLivenessInitializer`, desktop-only, one per origin through a Web Lock): every paired host except the routed one and revoked ones is asked `host_feature_manifest` about every 60 s (inside the 90 s manifest TTL), backing off to 10 min while it does not answer. `recordHostProbe` writes `lastProbe` and, on a version-matched answer, `lastConnectedAt` / the manifest, which is what the ADR-0136 authority reads. That covers A5 step 8 without further change.
- **Session evidence:** a persisted `connectionState` other than `revoked` is reset on rehydrate (`rehydratedHosts`); `lastProbe` is not trusted across a relaunch.
- **Relay route for desktop-paired hosts:** the store and `openRemoteHostTarget` now import the signaling key as a `CryptoKey`. The vault and pairing hand back only the JWK, so `CompanionTransport`'s relay fallback had been off for every remote host the desktop paired.
- **Rows:** `DeviceRow.hostRole` (`always-on` > `headless` > `desktop`, from `alwaysOn`, the manifest's `platform`, or local host mode) and probe-backed liveness for hosts the desktop is not routing to. The **Always-on** badge sits in the row and hero; Identity gains **Host role**; Presence gains **Last check** with **Check now**.
- **Platform:** the desktop registers as `desktop` (was `unknown`), with the `tauri` capability baseline.
- **CLI over the relay** (the A2 gap): `host login` keeps the CLI's own relay room (`HostRecord.relay`, redacted like the device key), and device commands fall back to it when the address does not answer (`cli/src/api/relay-transport.ts`, `withRelayFallback`). A DPoP token exchange that never reached the host now reports `network`, not `auth`, so the fallback can see it. Raw `api request` and `--wait` stay direct and say so.
- **Fixed on the way:** with synchronous storage the store's `onRehydrateStorage` read `useRemoteHostStore` before `create()` returned, throwing on every boot once a host was persisted.
- **Not verifiable in a dev build:** desktop relay pairing and the desktop's relay route. The signaling server refuses browser WebSocket upgrades from origins not on `SIGNALING_ALLOWED_ORIGINS`, and a dev webview's origin is `http://localhost:3000`. The desktop smoke therefore used the host's loopback listener; the relay route was proven from the CLI.

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

**A5 outcome (2026-10-11).** Built against the plan with these deviations:

- **Owner** (`types/placement/item-owner.ts`, gates in `lib/placement/ownership.ts`: `runsHere`, `isOwnedElsewhere`, `assertRunsHere`) on scheduled tasks, Bot installations (replacing the unread `placementRef`) and adapter instances. Absent = the global timing authority decides, as before; `this-device` pins an item here; `remote-host` makes the local row a disabled placeholder that no gate runs. The owner fields are not indexed, so the Dexie bump (v238) is for the new `itemMigrations` journal only. The scheduler, Bot reconcile and delivery, and the connector runtime all read the gates; placeholders show a **Runs on** badge and no run controls in the scheduler, Bot console and connection detail.
- **Classifier** (`lib/placement/machine-bound.ts`): the host matrix, desktop/pet/file-watch/terminal triggers, project roots outside the host, `promotion`, stdio MCP and keyring references, each a typed reason. Tasks a Bot or connector manages are classified through their owner (`managedTaskOwner`).
- **Remote create surfaces:** `adapter_instance_mutate` (create, configure, enable, remove a whole instance; secrets go into the host's `secret_store`, never back out); `bot_installation_mutate` takes the whole installation (config, bindings, enabled, trigger overrides, policy grant) as one idempotent operation; `scheduled_task_import` strips `promotion`, keeps `status`, checks host support and project scope, and records provenance with the operation id.
- **Migration service** (`lib/remote-host/migration/`): preflight → create on the host unarmed → confirm → fence locally → arm on the host, journalled per operation (`itemMigrations`: state, `resumeFrom`) so a replay resumes where it stopped. Take back removes the host's copy, then restores the item here with the host's status; with the host unreachable it ends `awaiting-host` and `finishPendingTakeBack` completes it later. **Connector schedules** (`connection:scheduled:digest` tasks keyed by `payload.adapterId`) would have been stranded, so they travel as **companions**: frozen into the move journal, created after the connector, fenced with it, armed after it, and brought back with it.
- **Plugin transfer** (built after the service, which it plugs into): the desktop exports the missing plugins as one cogpack signed by this device and uploads it in 32 KiB chunks (`plugin_cogpack_upload_open/write/abort`, under the 64 KiB device-plane limit). `plugin_cogpack_transfer_install` verifies the signature and applies the **host's** plugin policy (the signer is not added to its trusted ledger), and Rust (`crates/cognia-plugin-runtime/src/cogpack_transfer.rs`) checks the archive against the verified manifest's hash, file by file, before installing. A desktop host activates the plugins in its renderer; a headless brain installs through the internal `plugin_cogpack_install_staged` and reconciles on `plugin://runtime-changed`. Interactive approval comes from the manifest (`approval: interactive` → admin lease).
- **Guided flow** (`components/devices/always-on/`): the host's device page gains an **Always-on work** section (moved items with Take back, interrupted operations with Resume/Finish, the host's approval code) and the move dialog (ready / needs plugins / stays here with reasons, plugin send and re-check, progress, results). After an always-on pairing, the add-host form links to it.
- **New items default to the host** (step 7) as create-then-move: the scheduler create sheet, Bot install sheet and connection create dialogs ask **Runs on** (host chosen) while an always-on host answered its last probe (`alwaysOnTarget`); the item is created here and the same dialog moves it at once, leaving anything machine-bound here with its reason. A connection moves when its dialog closes, after any sign-in it still needs.
- **Liveness** (step 8) came with A4.

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

**A6 outcome (2026-10-11).** Built against the plan with these deviations:

- **Store** (`crates/cognia-secrets/src/host_secrets.rs`): provider keys (`com.cognia.host-provider-credentials/v1`, the `keyring_secrets` namespace `host-provider-credentials`), git tokens by git host (`com.cognia.host-git-credentials/v1`) and the existing connector service, all over `secret_store`. A metadata-only index (`com.cognia.host-secret-index/v1`) records `{ setAt, setBy }` per secret; the loopback service plane writes unattributed.
- **Commands:** `host_secret_list` (names, kinds, when, by which device; `secret.manage`, approval `none`, because it carries no value), `host_provider_credential_set/delete` and `host_git_credential_set/delete` (`secret.manage`, `interactive`), and the service-only `host_provider_credentials_load`, the one command that returns values, plus a Tauri command of the same name for a desktop host's renderer. Changes publish the service-only `host://secrets-changed`.
- **Unattended runs:** the keys fill providers with no key of their own at `createProviderSettingsSnapshot`, the point all provider resolution reads (`lib/host-secrets/`). The brain loads them in the `host-provider-keys` runtime, ahead of the scheduler and awaited; a desktop host in `HostProviderKeysInitializer`. Both reload on the event.
- **Connector and git:** `connectors_keyring_set/delete` index the writer. `task_workspace_remote_source_ensure` uses the stored token for the remote's git host when the caller sends none.
- **Revoke cascade:** `device_lifecycle::apply` deletes a revoked device's secrets (suspension keeps them). `cognia-server devices revoke-device` bypasses `apply`, so it cascades itself, and because a running server's secret cache would write deleted entries back, the server also sweeps writers that are revoked or unknown at boot and before it lists or loads secrets.
- **Approval classes:** the three `companion_push_configure_*` and, per the ADR's "push credentials", the three `companion_push_clear_*`, plus `bot_installation_mutate` and `bot_trigger_set_armed`, are `interactive`. The push block and the Bot console mint a lease per gesture (`lib/tauri/interactive-approval.ts`) and show the host's approval code; the outbound queue already leases interactive commands; the A5 migration sends its lease on every Bot call.
- **UI:** a **Secrets on this host** section on the remote host's device page (`components/devices/host-secrets/`), gated on the host manifest's new `always-on.secrets` feature: grouped list, seal a provider key or git token, remove with a confirmation, the approval code in place. Connection credentials are listed read-only, since they belong to their connection.

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

**A7 outcome (2026-10-11).** Built against the plan with these deviations:

- **Contract** (`packages/agent-config-types/src/unattended-permission.ts`): `UnattendedPermissionProfileV1` holds one level per class: `workspace` takes `sandbox | ask | deny`; `outbound`, `secrets` and `hostConfig` take `ask | deny`. The ceiling is `{ workspace: "sandbox", others: "ask" }`, so no profile can let an outbound message, secret use or a host change through without a person. Narrowing is per class.
  - `AgentCapabilityGrantV1.permissionProfile` merges by narrowing.
  - `resolveBotPolicy` folds it per layer. A layer that names a level above the one in force is refused for that field, and the Bot's policy panel shows the refusal.
  - Any profile, even an empty one, marks the turn unattended. Bot turns, plugin agent turns, scheduled chat turns and goal turns always carry one.
- **Classes** are decided host-side. A plugin tool takes the classes its plugin's manifest permissions reach (`lib/claude/unattended-permission-options.ts`), and a handful of host tools are classed by what they do. A declared read-only tool is exempt from every class except secrets. Built-in tools that are not read-only count as workspace.
- **Sandbox auto-allow:** a `sandbox` ladder step after `dont-ask`, plus a `profile` hard check (pinned in `ladder.pins.test.ts`). The allow covers only the first-party sandboxed tools (`sandbox_bash`/`edit`/`write`/`text_editor`), and only with a `SandboxAttestationV1` the host stamps at build time from `sandboxSessionRuntime.attest`. The attestation requires the current placement generation on the microvm tier; anything weaker asks.
  - Always-ask classes disarm the `dont-ask`, `bypass` and grant shortcuts.
  - On the Claude Agent SDK, bypass and allow rules never reach `canUseTool`. A PreToolUse hook (`sidecar/src/runtimes/claude-agent-sdk/profile-hooks.ts`) therefore runs the gate itself for always-ask classes and hands the approved `toolUseID` to `canUseTool`.
  - The sidecar approval waiter takes `approvalTtlMs` (park TTL + 2 min) and reports a timeout as a `permission_interrupted`.
- **Park:** the unattended responder no longer denies at once.
  - It parks the request (`lib/claude/unattended-park.ts`): one `agent-turn` execution run per turn, and a `tool_approval` interrupt carrying the tool and its class.
  - It announces the park, waits in the approval registry for 30 minutes, then resumes or denies.
  - The cockpit's `execution_run_control` answers it through the agent-turn handler. Parking failures fall back to the old immediate deny.
  - Parked time is not charged: the capture wall clock pauses, and scheduled executions stop their timeout clock (`lib/scheduler/execution-clock.ts`). This covers both chat tasks, which register as the turn's capture responder, and goal turns.
- **Push:** one channel, `run://approval-pending`, carries both tool approvals and Bot approval steps, plus `run://approval-resolved`. The plan named a single `bot_approval` channel; one channel lets a phone open one card for either kind.
  - The push body names only the class or "a Bot", never the title or tool input. Push data is allowlisted to ids, the kind, the class, the deep link and the dedupe key.
  - A Bot step announces once, when its interrupt row is created and still pending after the policy auto-approve, because the step re-enters every 20 s.
- **Phone answers** go through two new commands, `execution_run_approval_list` / `execution_run_approval_respond` (`agent.run`, approval `none`; `respond` binds `callerDeviceId`). Answering through `execution_run_control` would need an admin lease, which a headless host cannot get approved for the device asking. The answer is the human approval itself, like `claude_approve`, and still passes the run control gate as the stamped device.
  - The list pages by token like every list verb (ADR-0175 B3), and the card walks every page. It caps a Bot proposal at 4,000 characters inline and otherwise marks it truncated.
- **UI:**
  - **Profile controls:**
    - A Bot's settings show a **When nobody is watching** section, saved in `policyGrant` alongside the authority switches; the policy panel names the classes each layer narrowed.
    - The chat and goal scheduler editors show the same section, written to `payload.permissionProfile`.
  - **Phone card:** `RunApprovalsCard` (`components/mobile/run-approvals/`) sits on the phone's Bots page and above the scheduler's attention block. It is modelled on the workflow approvals card.
- **Live runs:** tightening a Bot's profile cancels its live runs, the same as narrowing its authority.

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

**A8 outcome (2026-10-11).** Shipped in three commits: A8a the proxy and Compose, A8b a container tier for built-in tools, A8c host-authored placement. Deviations from the plan:

- **Docker proxy (A8a):** `crates/cognia-docker-proxy` reads bodies rather than URL prefixes.
  - A container is created only with this deployment's `cognia.owner`/`cognia.deployment` labels, the workspaces volume and its own bundle volumes, and no privileged mode, binds, devices, host namespaces, extra capabilities beyond the five the supervisor adds back, or unconfined security options.
  - Lifecycle calls and exec reach only containers the daemon confirms carry those labels. Lists are filtered.
  - Builds, networks, swarm, secrets and archives are refused.
  - The T2 override swaps it in, turns the pool on by default, and refuses `COGNIA_RUNNER_NETWORK=host`/`container:<id>`.
- **Container tier (A8b), not in the plan.** The plan placed only external agents. Built-in turns run Bash, Edit and Write through the sidecar's sandboxed tools, which had no container tier, so a phone or scheduled built-in turn would still have run on the Host. A new `container` shell tier fixes that:
  - **Pool:** `SandboxRuntimeControl::exec_task_shell`/`release_task_shell` in `cognia-sandbox-pool`. Each session gets a retained runtime with its own key and label, so it never shares an agent's runtime. Output is capped at 1 MiB per stream. Release removes only idle runtimes; the orphan sweep reaps another process's.
  - **sandboxd:** task commands skip the `postAttach` lifecycle and symlink the host's workspace path to the mount.
  - **Commands:** service-only `environment_task_shell_exec`/`_release`.
  - **Brain:** the session runtime binds the tier on headless hosts only (`lib/sandbox/container-exec-adapter.ts`, `task-shell-placement.ts`).
  - **Attestation:** `SandboxAttestationV1.tier` accepts `container`, so A7's sandbox auto-allow covers it.
- **Placement (A8c).**
  - **Built-in turns.** `resolveSendOptions` asks `resolveHostTaskPlacement` (`lib/sandbox/host-task-placement.ts`). On a headless Host every turn gets sandboxed tools on the `container` tier, whatever the session, character or app default chose, and the Restricted Mode tool denials. A turn with no session gets an unplaced record, so its sandboxed tools refuse. This one seam covers phone turns, Bots, scheduled chat and goal tasks, teammates and plugin agent turns.
  - **External agents.** Each dispatch site calls `ensureHostAgentPlacement`/`placeDispatchedAgent` (`lib/sandbox/host-agent-placement.ts`). The sites are phone turns (`remote-run-service.ts`), scheduled external-agent tasks, teammates (`dispatch-teammate.ts`), delegations, plugin SDK dispatch, and the plugin external-agent API, including its Bot path.
    - The project comes from the session, or from the closest project root holding the run's directory. A task lease's working copy is matched by the checkout it came from.
    - A project with no selection gets `{ source: auto }`, the deployment default.
    - A refusal throws before any process starts.
    - An agent connected elsewhere is reconnected where the run belongs.
  - **Phone turns** take their working directory from the session's workspace root (`resolveSessionWorkspaceRoot`) and pass it to the run.
  - **Scheduled leases.** After a scheduled task takes a task-workspace lease, its options are re-bound to the lease (`rebindSendOptionsWorkspace`), so the container mounts the lease, not the project checkout.
  - **T2 task workspaces.** `COGNIA_TASK_WORKSPACE_EXECUTION_ROOT` moves `executions/` and `scratch/` into the workspaces volume (`/workspaces/.cognia-task-workspaces`), because `resolve_mount` refuses `<data>/task-workspaces/executions`. `SpawnPolicy::from_env` follows the same variable.
- **Opt-out:** `ProjectRuntimeSelection.hostProcess` is a switch in the environment's runtime settings, on the workspace page's Environments tab. It is read only on a headless Host. An unreadable selection is not an opt-out.
- **Limits:**
  - A run with no project stays on the Host: its built-in sandboxed tools refuse, and an external agent runs in the launcher sandbox. Bot runs in an isolated workspace with no project fall here.
  - A Host without the pool refuses built-in sandboxed tools unless the project opts out.
  - No Tauri or live T2 smoke was run for A8.
  - `Dockerfile.docker-proxy` pins Rust 1.96.1 and follows the toolchain bump.

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

**A9 outcome (2026-10-12).** Built against the plan with these deviations:

- **Event keys.** `TriggerEvent` (Rust and TS) gains `occurrenceKey`, the source's own id for the event. `deterministicTriggerIdempotencyKey` (`lib/workflow/runtime/trigger-idempotency.ts`) keys slot triggers (cron, schedule) on the aligned slot. It keys event triggers (webhook, connector inbound and system, integration) only on `occurrenceKey`. Without one, the event gets no key, so two in the same second are two runs. That fixes the data-loss defect.
  - **Webhooks:** the receiver reads the delivery id from a header the trigger names (new `deliveryIdHeader` param and inspector field), or from `Idempotency-Key`. An empty or over-256-character value is not a key.
  - **Connector messages:** keyed by `connectorOccurrenceKey` (`types/connectors/event.ts`) on platform, bot account, platform chat and thread, and the message id the bus deduplicates on. The local adapter id is left out.
  - **Connector system events (gestures)** stay unkeyed. Their ids are adapter-built and nothing deduplicates them, so keying would fold a second identical reaction into the first.
  - **Integration events** key on plugin, integration, account and delivery id: the identity the event row is already deduplicated on.
- **Slots.** The Rust cron daemon emits the entry's slot as `originAt` (and `payload.scheduledFor`) rather than its wake time. The scheduler alarm's `scheduler:task-due` gains `scheduledForMs`, the armed instant, which the Rust timing driver now reports. Before, a re-arm landing between the fire and the listener could relabel the slot.
  - The plan's line numbers in `alarm_daemon.rs` needed no change: the generic loop already hands each emitter its entry, which carries the slot.
  - An OS-promoted wake ran as the wake time. It now runs as the last slot that elapsed after the persisted `nextRunAt` (`latestElapsedSlot`, `lib/scheduler/occurrence.ts`).
- **Bot ticks** key their event on the slot for `schedule` and `catch-up` fires, with `occurredAt` set to the slot. A tick started by hand, or a retry (whose `scheduledFor` is the retry time), stays a one-off.
- **Scheduler executions, deviation.** The plan asked for a unique `(taskId, scheduledFor)` index. Several rows legitimately share a slot (a skipped row, a displaced buffered start, the retries of one occurrence), so a unique index would break them; the scheduler run table is also local, so the index would not reach across hosts either.
  - Instead, an automatic fire of a slot (`schedule` or `catch-up`) gets a deterministic execution id `occ-<taskId>-<slot>`. A second fire of the same slot finds the first one's row, its running entry or its buffered start, and does not run again. An in-memory claim covers two fires racing the row lookup.
  - No schema bump.
- **Corrections.** ADR-0136 §4 and its "Not done" entry (both locales), and the `trigger-idempotency.ts` header, now say that the invocation ledger is per host. A key absorbs duplicates on the host that holds it; two hosts compute the same key but can both run, which the phase B lease fence closes.
- **Protocol:** the `workflow_handoff_create` request schema's closed `trigger` object accepts `occurrenceKey`, so a handed-off trigger keeps its key.
- **Tests** cover each plan item:
  - Same-second payloads are two runs: the router, the bridge, the bus and the key function.
  - Two hosts' keys match: connector keys across adapter ids, and the key function.
  - Cron and alarm slots are stable across a wake: the Rust cron and alarm tests, the driver, the promoted-wake test.
  - Concurrent fires of one slot start once.

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
| T2 Compose proxy sets `EXEC=0` but the pool needs exec; comments claim otherwise (fixed)                                        | A8                     |
| Webhook and connector events in the same second collapse into one run (data loss) (fixed)                                       | A9                     |
| Cron occurrence key is the wake time, not the slot (fixed)                                                                      | A9                     |
| Signaling live join path does not enforce `SIGNALING_MAX_*` (docs claim it does)                                                | out of scope; reported |
