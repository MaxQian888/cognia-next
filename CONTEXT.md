# CONTEXT — Mobile App & Settings

Domain language and load-bearing decisions for the Capacitor mobile shell and its
settings surface. Keep this glossary stable; flag any usage that conflicts with it.

## Glossary

### Mobile runtime mode

The phone runs in exactly one of two modes (persisted as `AppSettings.mobileRuntimeMode`,
device-local, never synced):

- **Standalone (BYOK)** — the phone is self-sufficient with no paired desktop. Chat
  runs _in the webview_ via `lib/ai/chat/standalone-engine.ts`. Settings are written
  to the local Dexie `settings` row / `providerSettings` and consumed locally.
- **Paired (companion)** — the phone is a remote client of a Tauri desktop. Chat and
  agent work execute on the desktop sidecar; the phone pulls per-table deltas
  (`lib/sync/companion-sync.ts`) and pushes setting edits via the companion
  `app_settings_update` RPC.

### Standalone engine capability boundary _(load-bearing — verified 2026-06-28)_

`standalone-engine.ts` is a plain AI SDK `streamText` call. It consumes **only**
`sendOptions.model` and the composed **system prompt**. It does **NOT** run tools,
MCP, an agent loop, permission modes, `autoMode`, `toolFilter`, or thinking budget.
=> Any "agent-ish" setting exposed on a _standalone_ phone has no consumer today and
would be dead UI unless the engine is first extended to a real agent loop.

### Mobile settings surface

The `/me` route (NOT desktop `/settings`) is the phone's settings center: a data-driven
iOS-style list (`components/mobile/me/me-entries.ts`) of 24+ `/me/*` sub-pages, with
search, favorites (long-press pin), and 6 groups (account / appearance / connection /
automation / data / about). Some sub-pages embed the shared desktop section component
(e.g. `/me/appearance` → `<AppearanceSection/>`); others are mobile-native pages.

### Cross-platform setting sync (asymmetric) _(verified 2026-06-28)_

- Desktop → phone mirrors **19** keys (`CROSS_PLATFORM_SETTING_KEYS` in
  `lib/sync/handlers/app-settings.ts`): includes the agent fields autoMode,
  permissionMode, defaultSystemPrompt, defaultMaxThinkingTokens, bareMode,
  debugMode, briefMode.
- Phone → desktop allows **~36** keys (`APP_SETTINGS_MOBILE_ALLOWED_KEYS` in
  `src-tauri/src/companion_api/rpc.rs`): appearance, webrtc, tts, search, model
  default, conversation, sidebar/pins, telemetry, mic — all non-credential
  preference fields. Enforced server-side (400 on a disallowed key) with
  OpenAPI spec-parity + Rust unit tests.
- **The precise asymmetry**: the agent fields (autoMode, permissionMode,
  defaultSystemPrompt, defaultMaxThinkingTokens, bareMode/debugMode/briefMode)
  sync DOWN but are NOT in the write allowlist — the phone sees them but cannot
  edit them back. Enabling D2's paired remote-edit = add these to the Rust
  allowlist + OpenAPI + tests.
- **Hard security boundary (keep)**: apiKey, apiBaseUrl, provider config,
  sidecarPath, transport keys are asserted _non-writable_ from mobile by Rust
  tests. BYOK provider keys on mobile are device-local (`/me/providers`), never
  synced, never remotely writable.

## Decisions

- **D1 — Parity target: both modes equal, standalone (BYOK) is the main line.**
  Mobile settings aim for full parity, not a simplified subset.

- **D2 — Agent-ish settings are mode-gated (resolves the D1 tension).**
  Agent Runtime / tool filter / MCP / permission modes / slash commands are exposed
  only in **paired** mode, where they remote-edit the desktop sidecar (real backend).
  In **standalone** mode they are hidden/disabled (no consumer — no dead UI).
  "Extend the standalone engine to a real agent loop so BYOK can run tools/MCP" is a
  SEPARATE future initiative, not part of the settings effort.

- **D3 — Build strategy: hybrid, default reuse.** Pure settings-store-driven desktop
  sections embed directly into a `/me/*` `SubPageShell` (as `/me/appearance` already
  does). Complex sections with Tauri-only tabs (e.g. agent-runtime's sidecar/SDK tabs)
  are reused but gate those tabs out by platform/mode. Avoid full mobile-native rewrites
  (duplication + drift + double test burden).

- **D4 — `permissionMode` remote-write is gated.** Adding `permissionMode` to the write
  allowlist is allowed, but a remote write (especially an escalation toward
  `bypassPermissions`/`acceptEdits`) must pass the existing `biometricRequiredFor` /
  companion `can_control` gate — not a bare preference write. Benign bucket-1 fields
  (autoMode, defaultSystemPrompt, defaultMaxThinkingTokens, bareMode/debugMode/briefMode)
  write normally.

- **D5 — Coverage: buckets 1+2+3 (full), bucket 4 stays excluded.** Bucket 3 (absent
  desktop sections) ships wave-by-wave, one section per PR, each user-confirmed.

- **D6 — Bucket-3 desktop-bound sections are read-only on mobile.** Slash Commands,
  Network, Hooks, Agent Teams write to filesystem / OS / Rust lifecycle that a phone
  cannot replicate → ship read-only / partial views + "manage on desktop" guidance.

- **D7 — Phone→desktop setting propagation goes through `useSettingsPatch()`, not a
  global `save()` rewire.** The canonical hook (`hooks/use-settings-patch.ts`) does
  `save(patch)` + `enqueue(app_settings_update)`. Sync-down writes via `db.settings.put`
  (never `save()`), so centralizing in `save()` would be echo-free but rewrites 6 test
  files; the hook DRYs the existing per-page pattern at zero test cost. Consequence:
  edits made through _embedded_ desktop sections (`/me/appearance`, `/me/ocr`, which call
  `save()` directly) stay device-local on the phone — acceptable for presentation prefs;
  desktop→phone sync still flows. Revisit only if a shared pref must round-trip up.
