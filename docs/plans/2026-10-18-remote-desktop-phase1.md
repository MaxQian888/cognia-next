# ADR-0234 Phase 1 — one control lease, sandbox gaps, chat dock

Design source: [ADR-0234](../content/docs/en/adr/0234-a-remote-desktop-is-a-provider-binding-brokered-by-the-host.md) §2, §8 and Phase 1. Review: `docs/research/external-remote-desktop-review-2026-10-16.md`. ADR-0233's managed control (`crates/cognia-automation/src/cua_sandbox/managed/control.rs`) is the model to converge on.

## Facts this plan relies on (verified 2026-10-18)

- Local Docker CUA control lives in `cua_sandbox/desktop_session.rs`: `RemoteDesktop { sessions, control: Option<(ControlLease, Instant)>, cleanup_unconfirmed, held_mouse_buttons }`, a 15 s token-only lease, lazy `expire()`, no fence, no frame proof, implicit takeover. The Tauri commands `cua_sandbox_desktop_{capture,acquire_control,renew_control,release_control,input}` are in `cua_sandbox/mod.rs` (~line 413), transport `internal` in `protocol/companion-commands.json`.
- Managed control (`managed/control.rs`) wraps the same `RemoteDesktop` and adds: `Lease { dto{token,fence,expires_at}, principal, deadline, epoch }`, a per-slot `fence` bumped on every `invalidate`, per-principal single-use `Frame { id, fence, deadline, width, height }` proofs (5 s, ≤8 per principal, ≤32 principals), explicit `takeover`, input limits (drag ≤2 s and ≤60 steps, chord ≤256 B, text ≤4096 B), and `CuaRemoteClient::fenced(admission)` so every send of a compound action re-checks lease deadline and revocation epochs. A denied send replies `auth_denied("sandbox input fence expired")` without sending (`remote_client.rs` ~line 159).
- Human viewer input is always one atomic `UiAction` (click, drag, scroll, key chord, typed text) delivered by `desktop_session::deliver`. A human therefore never leaves a key or button held. Held state comes only from the agent path: `cua_route::mouse_button` (tracked in `held_mouse_buttons`, released only at the next `acquire_control`) and `cua_route::hold_key` (down → sleep → up inside one `run_mutation`; cancelling it mid-sleep leaves keys down and quarantines the desktop).
- Agent actions take the desktop mutex via `agent_guard` and keep it through `run_mutation`, so a takeover waits for the in-flight action rather than preempting it.
- Human input (`cua_sandbox_desktop_input`) bypasses `run_gated`, and lease events are audited nowhere. `crates/cognia-companion-security/src/audit.rs` is a JSONL log installed only by `src-tauri/src/bin/cognia-server.rs:2607`; it is a no-op on desktop.
- The viewer (`components/settings/automation/sandbox-desktop-viewer.tsx`, hook `hooks/automation/use-sandbox-desktop.ts`, client `lib/automation/sandbox-client.ts`) is mounted only from Settings. The hook already abstracts a `SandboxDesktopSession` (`managed`, `frame`, `acquire`, `renew`, `release`, `input`, optional `status`) and handles frame proofs for the managed path.

## Work items

### 1. New crate `crates/cognia-remote-desktop` (platform layer, Tauri-free)

- Add it to root `Cargo.toml` members and to `scripts/gates/rust-architecture.json` as layer `platform`. No `tauri` dependency; no `tauri-host` feature is needed in Phase 1.
- `control` module: a provider-neutral `ControlLeaseCore` extracted from `ManagedControl`: fence, `Option<Lease>` bound to principal + token + fence + revocation epoch, per-principal frame proofs with the same limits and TTLs, `invalidate`, `expire`, `issue(principal, now, ttl_cap)`, `renew`, `require_lease(principal, token, fence)`, `register_frame`, `take_frame(principal, frame_id, fence)` (single-use: consuming clears all frames, as today), `status()` view. Keep the exact refusal codes the managed path returns today by letting the caller map a core error enum to its own error type.
- `audit` module: `RemoteDesktopAudit` durable JSONL sink at `<data_dir>/remote-desktop-audit.jsonl`, 5 MiB rotation keeping one generation (same idiom as `cognia-companion-security/src/audit.rs`, but its own file and its own process-global slot), `record_async` via `spawn_blocking`, no-op when not installed. Event kinds: `remote_desktop.lease.acquire|renew|release|expire|takeover|refused`, `remote_desktop.input` (action kind only: click/drag/scroll/key/text plus a count; never coordinates, key names or text), `remote_desktop.input.quarantined`, `remote_desktop.agent.preempted`. Envelope: `ts_ms, kind, target_kind ("sandbox"|"managed-desktop"), target_id, principal, decision, fence`, plus kind-specific fields. Install it in desktop startup (the place that builds the app data dir under `src-tauri/src/startup/`) and in `cognia-server.rs` beside the existing `audit::install`.
- Co-located unit tests for both modules (fence/principal/epoch/frame single-use/limits/expiry; rotation and field redaction).

### 2. Managed control uses the core

Refactor `managed/control.rs` so `ManagedControl` holds a `ControlLeaseCore` instead of its own `lease/frames/fence/revoked` fields. Behavior, refusal codes and the qualification-smoke assertions must not change; every existing test in `managed/control.rs` and `managed/service.rs` must pass unchanged (except mechanical field-access updates). Add audit calls for acquire, renew, release, expire (observed in `expire`), input (success and quarantine) with `target_kind = "managed-desktop"`.

### 3. Local Docker CUA moves onto the core

In `desktop_session.rs` / `registry.rs`:

- Replace `control: Option<(ControlLease, Instant)>` with a `ControlLeaseCore`. Local principal is the fixed id `local-owner` (these commands are client-local, internal transport).
- `cua_sandbox_desktop_capture(connection_id)` returns `{ frameId, fence, expiresAt, screenshot }` and registers a frame proof (same limits as managed).
- `cua_sandbox_desktop_acquire_control(connection_id, takeover: bool)`: refuses without `takeover: true`; refuses when a lease exists; then **preempts the agent** (item 4), releases agent-held mouse buttons **and keys** (item 5), captures to prove GUI availability, issues `{ token, fence, expiresAt }`.
- `renew_control(connection_id, token, fence)`, `release_control(connection_id, token, fence)`.
- `input(connection_id, token, fence, frameId, point, action)`: lease + single-use frame check, the managed input limits, live capture size check, then `deliver` through `client.fenced(...)` whose admission checks the lease deadline, the frame deadline and the fence, with `tokio::time::timeout_at(min(lease, frame))`. Uncertain outcomes quarantine exactly as today.
- `require_agent` refuses while a lease exists **or while a takeover is pending** (item 4).
- Update the five command signatures in `mod.rs`, their entries in `protocol/companion-commands.json` (still `internal`), any generated artifacts (`pnpm companion-api:gen`), and any command parity/registry gates that list these commands. Do not add new commands.

### 4. Takeover preempts the in-flight agent action

- `RemoteDesktop` gains a preempt epoch (`Arc<AtomicU64>`) and a `takeover_pending` flag readable without the desktop mutex. `acquire_control` raises both **before** awaiting the desktop mutex, and clears `takeover_pending` when it finishes (success or failure).
- Agent mutations in `cua_route.rs` (every `run_mutation` on the remote path) send through `client.fenced(...)`, which admits a send only while the preempt epoch equals the value captured when the agent took the guard.
- A send refused by the fence is known not to have been sent, and all earlier sends of that action were already acknowledged (calls are awaited sequentially). That outcome must **not** set `cleanup_unconfirmed`: introduce a typed "preempted before send" error (distinguishable from transport failure) and make `run_mutation` treat it as confirmed. The agent receives a clear error ("human took over the sandbox desktop").
- `hold_key` waits with `tokio::select!` on its sleep and a preemption notification; on preemption it releases the pressed keys in reverse order through the **unfenced** client (cleanup must not be blocked by the fence), then returns the preempted error. Record `remote_desktop.agent.preempted`.

### 5. Held input is tracked and released

- `RemoteDesktop` gains `held_keys: Vec<String>` maintained by `hold_key` (pushed before each key-down send, removed after each key-up acknowledgement), alongside `held_mouse_buttons`.
- Release held buttons and keys at takeover (before issuing the lease) and in `confirm_quiescence` paths that already clear buttons. If a release send fails, quarantine as today.
- Correct ADR-0234 §2 (both locales) to state the fact: human input is atomic, so held state originates only from agent transitions, and the Host releases it at takeover, preemption and stop; expiry of a human lease cannot leave input held.

### 6. Viewer and chat dock

- `lib/automation/sandbox-client.ts` + `use-sandbox-desktop.ts`: the local session object passes `takeover: true`, carries `fence` on lease calls and `frameId` on input, exactly as the managed session does. Keep the existing 1 s polling.
- Add a session dock panel (`useSessionSurfacePanels` in `components/artifacts/chat-dock-panels.tsx`, a `ContextPanelDefinition`) with id `sandbox-desktop` that applies when the session's resolved sandbox binding routes GUI to a connection (`bindingRoutesGuiToConnection` in `lib/sandbox/binding.ts`, tier `cua-desktop`, bound connection id). It renders the existing `SandboxDesktopViewer` for that connection (move the component to `components/automation/` only if importing it from `components/settings/` is against an existing lint rule; otherwise reuse in place).
- `components/chat/computer-use-picture-in-picture.tsx`: when the session has a bound sandbox desktop, add an action that opens the `sandbox-desktop` dock panel.
- All new strings through `next-intl`, keys in `i18n/messages/{en,zh-CN}/**`, then `pnpm i18n:build`.

### 7. Changeset

`pnpm changeset` style file for `cognia-next`, `minor`: "Watch and take over a sandbox desktop from the chat dock; takeover now preempts the agent and releases held keys."

## Tests (co-located, only the changed files' suites)

- `cognia-remote-desktop`: core and audit unit tests.
- `cognia-automation`: local takeover requires the flag; busy refusal; stale/consumed frame refused; input limits; fence change invalidates frames; preemption interrupts `hold_key` and releases keys without quarantine; a fenced denial does not set `cleanup_unconfirmed`; held keys and buttons released at acquire; `require_agent` refuses during pending takeover; existing `desktop_session.rs` tests updated; managed tests unchanged and passing.
- TS: `sandbox-client` and `use-sandbox-desktop` local path (fence/frameId/takeover), the dock panel's `appliesTo`, PiP action.
- Commands: `cargo test -p cognia-remote-desktop`, `cargo test -p cognia-automation` (filtered to `cua_sandbox` and `cua_route`), `pnpm test -- <changed test files>`, `pnpm companion-api:check`, `pnpm audit:rust-architecture`, `pnpm audit:colocated-tests`, `pnpm lint:i18n`, `pnpm i18n:build:check`.

## Out of scope for Phase 1

Companion transports and reading the audit from clients (Phase 3), streaming (Phase 4), external targets (Phase 2).

## Smoke (2026-10-18)

Real local Docker desktop (`cognia-cua-desktop:0.3.46-2`, colima, arm64) in the
macOS desktop app, keys and buttons read from X on `:99` inside the container:

- An agent `hold_key` of Ctrl+Shift, then "Take control": both keys released,
  the agent call ends with `PREEMPTED_BEFORE_SEND`, audit rows
  `agent.preempted`, `lease.takeover`, `lease.acquire`, renews every 5 s.
- An agent left-button down, then takeover: the button is released.
- Agent actions while a human holds control are refused (`under human control`).
- A human drag is delivered and audited (`action_kind: drag`); a release fired
  right behind a drag leaves no button down. After release the agent acts again.
- Found and fixed: with the Phase 4 viewer, every takeover of a sandbox without
  Selkies was released at once (the stream hook refused to "claim" a stream
  that did not exist). Polling now carries the lease when there is no stream.
- Seen once, not reproduced: an agent call failed with `cua client channel
closed`; the sandbox then refused control until it was stopped and started,
  as designed for an unconfirmed input.
