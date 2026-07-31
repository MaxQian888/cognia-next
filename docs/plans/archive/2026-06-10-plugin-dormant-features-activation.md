# Implementation Plan — Plugin System "Built-but-Dormant" Activation

Date: 2026-06-10. Branch: TBD (`feat/plugin-dormant-activation` off `dev`).

Each phase ships green before the next: `pnpm typecheck`, `pnpm test:coverage` (≥90% lines/branches/functions on touched files), `pnpm lint:i18n`. Any phase touching `sidecar/` also runs `pnpm sidecar:test`. No hard-coded user-facing strings — next-intl keys in **both** `i18n/messages/en.json` and `zh-CN.json`. Co-located `*.test.ts(x)` for every touched `lib/**`, `hooks/**`, `components/**` (excluding `components/ui/`).

**Reuse, don't reinvent.** Every fix below activates code that already exists. The default disposition is **WIRE** (connect an existing producer to an existing consumer) or **FIX** (repair a stub to reach a real backend). A few items are **DECIDE** — wire vs. delete vs. mark intentionally-inert — and must not be silently left half-built.

---

## Audit summary (what is dormant and why)

Evidence gathered 2026-06-10 by reading the messaging/hooks/context layers and grepping for real (non-test, non-doc) call sites. The repo's own `lib/plugin/contracts/runtime-proof-audit.test.ts:146` already keeps an `ALLOWED_SILENT_EXCEPTIONS` allowlist — a self-admitted list of hooks with no discoverable host call site. This plan treats that allowlist as a worklist, not an excuse.

| #   | Feature                                                                                                                                                                                                                           | Status                                                         | Key evidence                                                                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | `ctx.events.ipc` (PluginIPC: send/sendAndWait/broadcast/RPC `call`/`expose` + circuit breaker)                                                                                                                                    | wired into context, **zero consumers**, type-invisible         | wired `lib/plugin/core/context.ts:309`; no plugin calls `events.ipc.*`; not declared on `PluginEventEmitter` (`types/plugin/plugin.ts:1856`)                                                            |
| A2  | `ctx.events.bus` (MessageBus pub/sub)                                                                                                                                                                                             | wired into context, **zero consumers**, type-invisible         | wired `context.ts:310`; same type gap                                                                                                                                                                   |
| A3  | MessageBus `SystemEvents` (PLUGIN_LOADED / SESSION_CREATED / AGENT_STARTED / THEME_CHANGED …)                                                                                                                                     | **never emitted**                                              | `emitFromSystem`/`emitFromPlugin` (`message-bus.ts:129,138`) defined, **zero callers** repo-wide                                                                                                        |
| B1  | Generic `HookDispatcher` class (middleware, TTL cache, `executePipeline`, parallel exec, history)                                                                                                                                 | **fully dormant**                                              | `hooks-system.ts:249-638`; `new HookDispatcher()` only in tests                                                                                                                                         |
| C1  | `onBuildOptions` (`dispatchBuildOptions`, full ADR-0026 §4§B priority merge)                                                                                                                                                      | **no host caller**                                             | `hooks-system.ts:1608`; only refs are docs/comments                                                                                                                                                     |
| C2  | Chat/stream/tool hooks: `onMessageSend`, `onMessageRender`, `onAgentToolCall`, `onChatRequest`, `onModelSwitch`, `onStreamStart/Chunk/End`, `onTokenUsage`, `onUserPromptSubmit`, `onPreToolUse`, `onPostToolUse`, `onPreCompact` | **dispatchers never called**                                   | allowlisted in `runtime-proof-audit.test.ts:152-187`; greps confirm zero callers (claim "lives in sidecar" is false — sidecar is `.mjs`, cannot call these TS dispatchers)                              |
| D1  | `ctx.settings.set/get/onChange`                                                                                                                                                                                                   | **persistence broken**                                         | `set` only logs + notifies in-memory listeners, never persists; `get` reads a `useSettingsStore["plugin:<id>"]` slice that does not exist (`context.ts:911-946`)                                        |
| D2  | `ctx.ui.showToast`                                                                                                                                                                                                                | log-only                                                       | `context.ts:524`; sonner `<Toaster/>` IS mounted (`app/layout.tsx:256`) but never called                                                                                                                |
| D3  | `ctx.ui.showDialog`                                                                                                                                                                                                               | log-only, returns first action                                 | `context.ts:530`                                                                                                                                                                                        |
| D4  | `ctx.ui.registerStatusBarItem` / `registerSidebarPanel`                                                                                                                                                                           | write **dead Maps**, no reader                                 | `context.ts:560,568`                                                                                                                                                                                    |
| D5  | `ctx.ui.showInputDialog` / `showConfirmDialog`                                                                                                                                                                                    | `window.prompt/confirm` — unreliable in Tauri/Capacitor shells | `context.ts:537,555`                                                                                                                                                                                    |
| D6  | `ctx.window.isMaximized/getSize/getPosition`                                                                                                                                                                                      | hardcoded `false`/`{800,600}`/`{0,0}`                          | `context.ts:1712-1718`                                                                                                                                                                                  |
| E1  | `chat.middleware` execution                                                                                                                                                                                                       | registered + runner on hot path, **gated off permanently**     | runner `run-and-capture.ts:356` behind `isChatMiddlewareExecutionEnabled()` (`run-and-capture.ts:329`); enabler `setChatMiddlewareExecutionEnabled(true)` (`feature-flag.ts:23`) has no non-test caller |

**Out of scope / verified WIRED** (do not touch): contribution-type registries — tools, skills, native-anthropic-tools, subagents, mcp-server-presets, routing-strategies, deployment-filters, protocol-adapters, context-providers, guardrails, tool-routes, A2UI, workflow nodes/triggers, quick-actions, context-menu, character-packs, agent-team/workflow templates, shared-memory adapters. All have a confirmed runtime consumer (see audit). Team/project/artifact/canvas/export/command/A2UI-surface hooks are also genuinely dispatched.

---

## P1 — Make plugin messaging real (A1, A2, A3)

Goal: inter-plugin IPC + event bus are type-visible, the host actually publishes lifecycle events, and there is one dogfood consumer proving the round-trip.

- **`types/plugin/plugin.ts`** — extend the plugin-facing events surface so `ipc`/`bus` are typed, not runtime-only. Add an `events` extension interface (`PluginEventEmitter & { ipc: PluginIPCAPI; bus: PluginEventAPI }`) used by `FullPluginContext`. Import `PluginIPCAPI` from `lib/plugin/messaging/ipc` and `PluginEventAPI` from `message-bus` (or relocate those type decls to `types/plugin/` to avoid a `types → lib` import — prefer moving the interfaces into `types/plugin/plugin-messaging.ts` and having `ipc.ts`/`message-bus.ts` import them).
- **`lib/plugin/core/manager.ts`** — emit `SystemEvents` at the existing lifecycle seams (where `guard.registerPlugin`/`unregisterPlugin` already run, `manager.ts:1982,2272`): `PLUGIN_LOADED`, `PLUGIN_ENABLED`, `PLUGIN_DISABLED`, `PLUGIN_UNLOADED`, `PLUGIN_ERROR` via `getMessageBus().emitFromSystem(...)`. Also call `getPluginIPC().registerPlugin(pluginId, permissions)` / `unregisterPlugin` at the same seams so the IPC permission map and method registry are populated/cleaned.
- **Bridge the other already-present system signals** (cheap, high-value): emit `SESSION_CREATED/SWITCHED/DELETED`, `THEME_CHANGED`, `SETTINGS_CHANGED` from the places that already fire the equivalent plugin hooks (e.g. alongside `dispatchOnSessionCreate`, theme store). Reuse the hook dispatch sites — do not invent new ones.
- **Dogfood consumer** (proves it isn't dormant again): make one in-tree plugin under `plugins/` subscribe via `ctx.events.bus.on(SystemEvents.SESSION_CREATED, …)` or expose+call an IPC method, with an assertion in its test. Candidate: `plugins/clipboard-history` or a tiny new example. This is the regression guard.
- **Decide permission posture**: PluginIPC defaults `requirePermission: false` (`ipc.ts:152`) — any plugin can `call` any other. Either (a) add an `ipc:call` / `ipc:expose` permission and flip `requirePermission` on, gated through `pluginHasApiPermission`, or (b) explicitly document the open posture. Recommended: (a), mirroring how `agent:dispatch` gates cross-plugin reach (`context.ts:834`).
- Tests: manager emits each SystemEvent on load/enable/disable/unload (spy `getMessageBus`); IPC registerPlugin/unregister on the same transitions; the dogfood plugin receives its event; permission gate (if chosen) rejects undeclared callers.

Verify gates.

## P2 — Fix `ctx.settings` persistence (D1)

Goal: `set`→`get` round-trips and survives reload; `onChange` fires on real writes.

- **`lib/plugin/core/context.ts:911-946`** — back `createSettingsAPI` with a real store. Reuse the existing `createStorage` localStorage pattern already in the same file (`context.ts:381`), OR route through `useSettingsStore` with a genuine `plugin:<id>` slice + setter. Pick one source of truth so `get` and `set` read/write the same place. `onChange` subscribes to that store's change events, not a private in-memory `Map`.
- Keep the namespaced key convention (`plugin:<pluginId>`). Must work in all three shells (browser/Tauri/Capacitor) — localStorage is the safe common denominator and matches `ctx.storage`.
- Tests: set→get round-trip; persistence across a fresh context instance (simulating reload); `onChange` fires on external write; namespace isolation between two plugin ids.

Verify gates.

## P3 — Connect `ctx.ui` surfaces (D2, D3, D4, D5, D6)

Goal: plugin UI calls reach real host UI instead of `console`/`window.prompt`.

- **`showToast` (D2)** — call sonner `toast[type](message)` (the provider is already mounted at `app/layout.tsx:256`). One-line fix, highest ROI.
- **`showDialog` / `showConfirmDialog` / `showInputDialog` (D3, D5)** — route through the existing plugin modal stack (`ctx.modal` → `usePluginModalStore`, consumed by the mounted `components/plugins/dialogs/plugin-modal-root.tsx`) instead of `window.*`. Reuse the modal store the audit confirmed is WIRED; do not build a new dialog system.
- **`registerStatusBarItem` / `registerSidebarPanel` (D4)** — **DECIDE**: either (a) add a host consumer that reads the registry and renders into the status bar / sidebar (promote the dead `Map` to a Zustand store + a mounted reader component), or (b) remove the methods from `PluginUIAPI` and the SDK type mirror if no surface is planned. Do not leave the dead Map. Recommend (a) only if a real slot exists; otherwise (b) to avoid advertising a no-op API.
- **`window.isMaximized/getSize/getPosition` (D6)** — make them async and back them with the real `plugin_window_*` Tauri commands already used by the rest of `createWindowAPI` (`context.ts:1688`), or document them as best-effort. Low priority.
- Tests: showToast invokes the toast mock; dialogs push to the modal store; status-bar/sidebar either render via the new reader or are removed (test deleted); window getters return real values under a Tauri mock.

Verify gates.

## P4 — Activate the option/middleware extension path (E1, C1)

Goal: the two host-side extension seams that plugins are documented to use — `onBuildOptions` and `chat.middleware` — actually run.

- **`chat.middleware` (E1)** — surface `setChatMiddlewareExecutionEnabled` through settings. Add an Advanced/experimental toggle in the relevant settings section (mirror how `confirmDangerousByDefault` is surfaced), persist it in `AppSettings`, and rehydrate on startup in a provider/bootstrap module so the flag reflects the stored value. Until a plugin actually ships a middleware this stays opt-in, but the path becomes reachable.
- **`onBuildOptions` (C1)** — call `getPluginEventHooks().dispatchBuildOptions(...)` from `lib/claude/build-options.ts` at the point where the structural `BuildOptionsHookInput` is assembled (the ADR-0026 §4§B documented seam). The merge logic already exists in `hooks-system.ts:1608`; it just needs one invocation on the live send path. Guard with the same PII/ordering conventions as the surrounding code.
- Tests: a registered middleware runs when the flag is on and is skipped when off; `dispatchBuildOptions` is invoked on send and a plugin's returned partial is shallow-merged in priority order.

Verify gates.

## P5 — Resolve the silent-hook allowlist + dead HookDispatcher (C2, B1)

Goal: stop advertising hooks the host never fires; delete or wire the generic dispatcher.

- **`runtime-proof-audit.test.ts:146` allowlist (C2)** — for each genuinely-unwired hook (`onMessageSend`, `onMessageRender`, `onAgentToolCall`, `onChatRequest`, `onModelSwitch`, `onStreamStart/Chunk/End`, `onTokenUsage`, `onUserPromptSubmit`, `onPreToolUse`, `onPostToolUse`, `onPreCompact`), **DECIDE per hook**:
  - **WIRE** if a natural host seam exists — e.g. `onMessageSend`/`onMessageReceive` at the chat send pump (`hooks/chat/use-claude-chat.ts` / `lib/claude/run-and-capture.ts`), `onModelSwitch` at the model-switch action, `onPreToolUse`/`onPostToolUse` at the tool-execution boundary. These mirror Claude Code's own hook points and are the highest-value to activate.
  - **DEMOTE** to `DEPRECATED_HOOK_POINTS` (`plugin-points.ts`) and remove from the type surface if there is no host seam and no plan to add one.
  - Shrink `ALLOWED_SILENT_EXCEPTIONS` accordingly — the allowlist should trend to empty. Every entry that stays needs a one-line justification pointing at a real (even if grep-invisible) call site.
- **Generic `HookDispatcher` (B1)** — it is exported but only instantiated in tests. **DECIDE**: either route one real subsystem through it (it offers middleware/cache/pipeline the bespoke dispatchers lack), or remove the class and its exports from `messaging/index.ts`. Default recommendation: remove, since `PluginLifecycleHooks`/`PluginEventHooks` already cover live needs — carrying 400 lines of untested-in-prod framework is a maintenance tax. Confirm no SDK/type consumer depends on it before deleting.
- Tests: update `runtime-proof-audit.test.ts` to assert the shrunk allowlist; any newly-wired hook gets a host-call-site test; if `HookDispatcher` is removed, delete its tests and the export.

Verify gates.

---

### Cross-phase invariants

- **No new abstractions** — every phase activates existing code. If a fix needs a "new system," stop and re-scope: the audit showed the systems already exist.
- **Reuse map**: sonner `toast` (mounted), `usePluginModalStore` + `plugin-modal-root` (mounted), `createStorage` localStorage pattern, `getMessageBus`/`getPluginIPC` singletons, `getPluginEventHooks().dispatchBuildOptions`, the `guard.registerPlugin` lifecycle seams in `manager.ts`, the `confirmDangerousByDefault` settings-toggle precedent.
- **Every activation needs a regression guard** — a dormant feature came back dormant because nothing asserted the wiring. Each phase ends with a test that fails if the producer is disconnected from the consumer (the `runtime-proof-audit` build-time grep is the model).
- **Phasing is by independent risk, not strict order** — P1 (messaging) and P2 (settings) are independent and can land in either order. P3 is independent. P4/P5 touch the send path and the audit test, so land them last.
- Suggested sequencing by ROI: **P2 → P3 (D2/D3 only) → P1 → P4 → P5**, deferring the DECIDE-heavy items (D4, C2 demotions, B1 deletion) until their wire-vs-remove calls are made with the maintainer.

### Open decisions to confirm before coding

1. IPC permission posture — gate `ipc:call`/`ipc:expose` (recommended) or document open access?
2. Status bar / sidebar panels (D4) — is there a planned host slot, or remove the API?
3. Generic `HookDispatcher` (B1) — adopt for one subsystem, or delete?
4. Silent hooks (C2) — which to WIRE vs DEMOTE? (proposed: wire message-send/receive, model-switch, pre/post-tool-use; demote the rest.)
