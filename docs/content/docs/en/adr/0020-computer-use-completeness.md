---
title: "0020 — Computer Use Completeness"
description: "Fills the gaps left by the M5 scaffold: 5 stub actions, consent UI, sidecar header, character opt-in, MCP exposure, macOS/Linux minimums."
---

# ADR 0020 — Computer Use Completeness

**Status:** Accepted
**Date:** 2026-05-14
**Branch:** `feat/computer-use-completeness`

## Context

The Computer Use scaffold (M5) shipped a working Rust automation subsystem
(`src-tauri/src/automation/`), a workflow node surface, a Settings UI shell, an
audit table, and a plugin at `plugins/computer-use/` that registers three native
Anthropic tools (`computer_20251124`, `bash_20250124`, `text_editor_20250728`).
Four pieces were stubbed or missing:

1. **5 of 10 `computer_20251124` actions** returned `"not yet implemented"` —
   `MouseMove` / `Drag` were emulated as clicks, `MouseButtonDown` / `MouseButtonUp` /
   `Scroll` / `HoldKey` literally errored.
2. **PerCall consent UI never rendered.** `Decision::RequireConsent` returned a
   hard `"Consent required for this action"` error instead of prompting the user,
   making the strictest permission tier unusable.
3. **Sidecar never saw the registered native tools.** `lib/claude/build-options.ts`
   didn't read the `native-anthropic-tool-registry`, so the Anthropic Agent SDK
   was launched without the `anthropic-beta: computer-use-2025-11-24` header.
4. **Settings → Whitelist + Inspector tabs were placeholder cards** with "Ships
   in M2" copy.

In addition: no `Character` field gated visibility (every chat surfaced the
tools), the external bridge MCP didn't expose `computer_use`, and macOS / Linux
backends were `StubBackend` placeholders.

The user asked for a non-redesign completion pass — keep the existing
architecture, fill every gap, and **lean harder on the `uiautomation` crate**
where it adds value.

## Decision

Seven concrete adjustments.

### 1. AutomationBackend trait extended with 5 new methods

`src-tauri/src/automation/backend.rs` adds `mouse_move`, `drag`, `scroll`,
`hold_key`, and `mouse_button` to the trait. `StubBackend` returns
`UnsupportedPlatform` for each. The Windows `UiaBackend` provides real
implementations via `windows::SendInput` (move / scroll / button) and the
`uiautomation::inputs::Keyboard::{begin_hold_keys, end_hold_keys}` API
(hold_key). New types `Point`, `DragOpts`, `ScrollTarget`, `ScrollOpts`, and
`ButtonTransition` land in `automation/types.rs`.

### 2. UIA Pattern-first click strategy

`ClickOpts.useNative` defaults to `true`. When clicking an `Element` target,
the backend tries `InvokePattern` → `TogglePattern` → `SelectionItemPattern`
in order; on miss, falls back to the element's native `click()` helper, and
finally to a coordinate click at the bounding-rect center. The dispatcher
lives at `automation/platform/uia/pattern.rs` and is also reused by
`desktop_invoke_pattern` (the previously-stubbed Tauri command).
`desktop_window_op` is wired through the same module's `dispatch_window_op`
and uses `UIWindowPattern` / `UITransformPattern` for visual-state /
resize / move operations.

### 3. PerCall consent UI via Tauri event broker

`automation/consent.rs` introduces `ConsentBroker`. When the gate returns
`Decision::RequireConsent`, the broker:

1. Checks `session_grants` for an existing "Always allow this session" grant
   keyed by `(surface, command, plugin_id, process_name)`. Hit → allow.
2. Else generates a UUID, registers a `oneshot::Sender`, emits
   `automation:consent-request`, and awaits the receiver with a 30s timeout.
3. The renderer-side `<ConsentOverlay />` (`components/automation/consent-overlay.tsx`)
   listens for the event and renders a floating card at bottom-right with
   `Allow once / Always allow this session / Reject`.
4. On click, the overlay invokes `automation_consent_respond({ id, allow,
persist, prompt })` which resolves the channel — and, when persisted,
   stores the grant in the session map.

Engaging the kill switch clears every session grant.

### 4. Sidecar `anthropic-beta` header passthrough

`sidecar/dispatch/anthropic.mjs` already understood `ANTHROPIC_DEFAULT_HEADERS`
for the Anthropic Agent Skills passthrough. The same path now merges
`sendOptions.appendHeaders` — populated by `resolveSendOptions` from
`computeAnthropicBetaHeaders([...])` — so the API request goes out with the
`anthropic-beta: computer-use-2025-11-24` token.

Full canUseTool-side dispatch to the renderer's `desktop.*` API is **not**
included in this ADR; the `executeIpc.invoke` field on each registered tool
points at a real Tauri command, so workflow nodes and MCP callers can drive
the action directly, but the chat-driven SDK path will need a renderer-side
bridge in a follow-up.

### 5. Soft `Character.enableComputerUse` binding

Mirrors the existing `Character.twinId` and `Character.a2uiEnabled` conventions:

```ts
interface Character {
  enableComputerUse?: boolean
  computerUseSettings?: {
    allowedToolIds?: string[] // subset of registered tool ids
    requireConsent?: boolean
  }
}
```

`lib/claude/build-options.ts` reads the registry via
`lib/claude/computer-use-tools.ts:applyComputerUseTools` and only populates
`opts.anthropicTools` + `opts.appendHeaders["anthropic-beta"]` when the
character has `enableComputerUse === true`. The Characters settings editor
gets a `Enable Computer Use` switch alongside the existing brief/debug/bare
toggles. Schema bumps to v32 (no migration — fields are optional).

### 6. `computer_use` MCP tool on the external bridge

`lib/external-bridge/handlers/computer-use.ts` registers a `computer_use`
tool with a union action schema (`screenshot` / `click` / `type` / `keys` /
`mouse_move` / `drag` / `scroll` / `hold_key` / `mouse_button`). The Node
sidecar entry advertises the tool; the new `mcp:computer-use` scope (default
OFF) gates every call through `checkToolCall`. Settings → External Bridge
renders the new scope toggle.

When running in standalone mode (Cognia desktop app not attached), the
handler returns a structured `not-yet-bridged` error so external agents see a
clear reason; the renderer-bridged dispatch lives in the in-app path until
the sidecar→renderer→Tauri IPC bridge lands.

### 7. macOS / Linux minimum-viable backends

`platform/ax/mod.rs` (macOS) and `platform/atspi/mod.rs` (Linux) replace the
`StubBackend` placeholders with `enigo`-backed implementations of
`capabilities`, `screenshot` (via the cross-platform
`platform::shared::screenshot::capture_primary`), `click(Point)`,
`type_text`, `send_keys`, `mouse_move`, `drag`, `scroll`, and `mouse_button`.

`AXUIElement` / AT-SPI tree navigation is **not** in scope — `find` /
`read_tree` / `invoke_pattern` / `window_op` / Element-target clicks return
`UnsupportedPlatform` on those platforms. `Capabilities.hasUia` is false on
macOS and Linux so the renderer hides UIA-only affordances (the Inspector
tab, locator-by-tree dialogs in workflow nodes).

## Capability Matrix

| Action                     | Windows | macOS    | Linux    |
| -------------------------- | ------- | -------- | -------- |
| `screenshot`               | yes     | yes      | yes      |
| `click(Point)`             | yes     | yes      | yes      |
| `click(Element)`           | yes     | no       | no       |
| `type_text`                | yes     | yes      | yes      |
| `send_keys` (chord)        | yes     | partial¹ | partial¹ |
| `mouse_move`               | yes     | yes      | yes      |
| `drag`                     | yes     | yes      | yes      |
| `scroll`                   | yes     | yes      | yes      |
| `mouse_button`             | yes     | yes      | yes      |
| `hold_key`                 | yes     | no       | no       |
| `read_tree` / `find`       | yes     | no       | no       |
| `invoke_pattern`           | yes     | no       | no       |
| `window_op`                | yes     | no       | no       |
| UIA / accessibility events | no (M2) | no       | no       |

¹ macOS and Linux accept single-token chords (`Enter`, `Tab`, `Escape`,
`Backspace`, `Delete`, `Space`); modifier chords (`ctrl+shift+t`) return a
clear `BackendError`. The Windows backend parses every chord
`uiautomation::inputs::Keyboard::send_keys` accepts.

## Settings UX

- **Settings → Automation → Permissions** — three tiers (Off / Whitelist /
  Per-call) per surface (Workflow / Computer Use / MCP / Plugin). Default Off.
- **Settings → Automation → Whitelist** — process-name and window-title-glob
  editors with a "Capture focused window" helper.
- **Settings → Automation → Inspector** — tree manager + per-element
  details + locator / element-ref copy buttons + UIA-pattern test buttons.
  Disabled on macOS / Linux (`Capabilities.hasUia === false`).
- **Settings → Characters → Edit** — Enable Computer Use switch under the
  brief / debug / bare-mode toggles.
- **Settings → External Bridge** — `mcp:computer-use` scope toggle.

## Non-Goals

- macOS / Linux UIA-equivalent tree walking (AXUIElement.children, AT-SPI
  introspection). Phase 6.b follow-up.
- Plugin-registered custom desktop actions / UIA patterns. Plugins still
  contribute whole native tools via `registerNativeAnthropicTool`.
- Element-picker overlay (the `desktop_pick_start` / `_cancel` Rust commands
  needed by Inspector → "Pick" button). UI placeholder rendered as disabled
  with a "Ships in M5b" tooltip.
- Full canUseTool sidecar dispatch for the chat-driven path (workflow nodes
  and MCP callers can already drive computer-use through the existing
  `desktop_*` Tauri commands).

## Files

```
src-tauri/src/automation/
  backend.rs        — trait extended; StubBackend grew 5 methods
  commands.rs       — 6 new Tauri commands + consent broker wiring
  consent.rs        — ConsentBroker (new)
  permission.rs     — Call::kind() recognises new driving commands
  types.rs          — Point / DragOpts / ScrollTarget / ScrollOpts / ButtonTransition
  worker.rs         — 5 new Request variants + AutomationHandle methods
  platform/
    shared/
      mod.rs        — re-exports
      screenshot.rs — xcap-based capture (moved from uia/)
    uia/
      mod.rs        — UIA Pattern-first click + 5 new methods
      input.rs      — windows::SendInput-based mouse / scroll / button
      pattern.rs    — UIA pattern dispatch (new)
    ax/mod.rs       — minimum-viable macOS backend (enigo)
    atspi/mod.rs    — minimum-viable Linux backend (enigo)

plugins/computer-use/rust/src/
  commands.rs       — 5 stubs replaced with real handle.* calls
  translator.rs     — Anthropic action shape → automation types

lib/automation/
  client.ts         — 6 new methods + consent-respond
  types.ts          — mirror Rust types

lib/workflow/nodes/
  desktop.ts        — windowFocus / Close / Resize via desktop.windowOp

lib/claude/
  build-options.ts  — call applyComputerUseTools
  computer-use-tools.ts — registry → SendOptions mapping (new)
  types.ts          — SendOptions.anthropicTools + appendHeaders;
                      Character.enableComputerUse + computerUseSettings

lib/external-bridge/
  handlers/computer-use.ts — MCP tool handler (new)
  mcp-server/server.ts     — registerComputerUseTool
  types.ts                 — TOOL_TO_SCOPE.computer_use

types/wiki/index.ts — BridgeScope adds "mcp:computer-use"

components/automation/consent-overlay.tsx — new
components/settings/automation/
  whitelist-tab.tsx        — new
  inspector-tab.tsx        — new
  automation-section.tsx   — replaces 2 PlaceholderTabs
components/settings/characters-section.tsx — Computer Use toggle
components/settings/external-bridge/external-bridge-section.tsx — scope desc

app/layout.tsx — mount <ConsentOverlay />

sidecar/dispatch/anthropic.mjs — appendHeaders → ANTHROPIC_DEFAULT_HEADERS merge

lib/db/schema.ts — v32 marker (no migration)
```

## Addendum 2026-05-15 — Completeness slate 2

A follow-up completion pass closed 11 of the gaps left by the M5 scaffold.
Two of the original Non-Goals (chat-driven `canUseTool` sidecar dispatch,
sidecar→renderer MCP automation-proxy IPC) turned out to require structural
new architecture, not "completion" work, and remain Non-Goals to be tracked
in a dedicated follow-up ADR.

**Closed gaps**

1. `text_editor` `undo_edit` action — `TextEditorAction::UndoEdit { path }`
   in `plugins/computer-use/rust/src/types.rs`, snapshotted by an
   `UNDO_STORE: Lazy<Mutex<HashMap<PathBuf, UndoEntry>>>` before every
   mutating action (`Create` / `StrReplace` / `Insert`). Undo restores the
   prior content, or deletes the file when the snapshot was "absent".
2. `bash.restart: true` honored as an audited no-op. Cognia has no persistent
   shell to restart, so the call returns a synthetic `BashResult` whose
   `stdout` explains the divergence. Audited under `command: "bash:restart"`.
3. `plugins/computer-use/plugin.json` `runtimeCompatibility` key renamed
   `desktop` → `tauri` (canonical per `types/plugin/plugin.ts:99`). A new
   `lib/plugin/core/builtin-manifest-shape.test.ts` walks every built-in
   manifest and rejects non-canonical surface keys. Six other plugins were
   normalized in the same pass.
4. The activate-time `ctx.agent?.registerNativeAnthropicTool?.(...)` calls
   were dropped from `plugins/computer-use/src/index.ts`. Manifest-driven
   registration (`manifest.nativeAnthropicTools`) is canonical.
5. TypeScript SDK scaffold created at the paths the capability contract
   advertises: `packages/plugin-sdk/src/api/native-anthropic-tool.ts` and
   `packages/plugin-sdk/src/context/index.ts`.
6. `runtime-proof-audit.test.ts` locks `native-anthropic-tool` proof status
   = `verified`.
7. Settings → Automation consent overlay + all five tabs (Overview,
   Permissions, Whitelist, Audit, Inspector) plus the Characters Computer Use
   toggle and the External Bridge `mcp:computer-use` scope description are
   fully i18n-wired via `useTranslations()` under the new
   `automation.*` and existing `settings.*` namespaces. The plugin
   `/cu` slash command registers an i18n bundle via
   `lib/i18n/plugin-i18n-registry`.
8. `i18n/messages/en.json` + `zh-CN.json` parity restored.
   `scripts/i18n-baseline.json` rebased — JSX hardcoded-string count fell
   from 811 to 698 (~113 strings closed).
9. Capability contract `hostBindings` updated for the runtime-proof audit.

**Still-deferred (Non-Goals, tracked separately)**

- Chat-driven `canUseTool` sidecar dispatch for `computer` / `bash` /
  `text_editor`. The `@anthropic-ai/claude-agent-sdk` is MCP-only — it has
  no field through which to inject API-level native tools. Closing this
  requires either teaching `sidecar/dispatch/ai-sdk.mjs` to plumb
  provider-defined tools through the Vercel AI SDK, or adding a brand-new
  Anthropic-direct dispatcher. Either path is a structural new dispatcher,
  not a completion task.
- MCP standalone `computer_use` IPC. The Node MCP sidecar uses the SDK's
  `StdioServerTransport`, which owns stdin/stdout. Wiring an
  `automation_proxy` envelope requires a custom transport wrapper on the
  Node side plus a stdout-pumping refactor of
  `src-tauri/src/mcp_server/sidecar.rs`. Tracked separately.
- macOS / Linux UIA-equivalent tree walking (Phase 6.b).
- Plugin-registered custom desktop actions / UIA patterns.

## Addendum 2026-05-18 — Chat dispatch + 3 actions + cursor_position

A follow-up completion pass closes the two structurally-deferred dispatch
gaps via a different architectural approach than the original ADR
forecasted, plus shipping the three minor actions the original M5 surface
left out.

### Architectural pivot — chat path via Plugin MCP, not a new dispatcher

The 2026-05-15 addendum framed chat-driven `canUseTool` dispatch as
requiring "either teaching `ai-sdk.mjs` to plumb provider-defined tools
through the Vercel AI SDK, or adding a brand-new Anthropic-direct
dispatcher". Both routes would have bypassed `@anthropic-ai/claude-agent-sdk`
and forfeited every Claude Code feature that lives only in that SDK
(built-in Bash/Read/Edit, subagent `agents`, settings sources, resume/fork
session continuity, `effort`, `maxThinkingTokens`, partial-message streaming,
Anthropic Skills passthrough).

The pivot: **expose `computer_use` / `bash` / `text_editor` as Plugin MCP
tools** through the existing `cognia-plugin-tools` bridge instead of
trying to inject API-level native tools. The model sees them as
`mcp__cognia-plugin-tools__{computer_use,bash,text_editor}` rather than
the API-level `type: "computer_20251124"` shape. Functional surface is
identical (same action union, same backend dispatch). The cost is the
Anthropic API's _native_ computer-use pretraining boost does not engage
in the same way — the model is still very capable but doesn't get the
special-cased prompt treatment the native tool type triggers.

Tradeoff accepted by the user explicitly: every Claude Code SDK feature
is preserved; the chat path runs through `dispatchAnthropic` unchanged.

### Closed gaps

1. **Chat-driven Computer Use** — `plugins/computer-use/src/index.ts`
   `activate()` now registers three plugin tools via
   `ctx.agent.registerTool()`. `plugin.json` adds the `"tools"` capability.
   The existing sidecar bridge at `sidecar/builtin-tools/plugin-tools.mjs`
   surfaces them as MCP tools to the SDK without any dispatcher change.
   `requiresApproval: true` engages the chat-side `canUseTool` modal;
   the Rust permission gate fires independently on every `desktop.*` call.

2. **External MCP `mcp_computer_use`** — `src-tauri/src/mcp_server/automation_proxy.rs`
   (new) creates a dedicated Unix domain socket / Windows named pipe per
   `SidecarProcess`. The path is passed to the Node MCP sidecar via the
   `COGNIA_AUTOMATION_PROXY` env var. `lib/external-bridge/handlers/computer-use.ts`
   opens that socket on first call, sends a newline-framed JSON envelope
   `{ id, command, args, ctx }`, awaits the matching response. The MCP
   stdin/stdout transport's strict sequential mutex stays untouched —
   automation requests ride a fully separate channel.

3. **Inspector Pick** — `src-tauri/src/automation/platform/uia/pick.rs`
   (new, Windows) registers a low-level `WH_MOUSE_LL` hook on a dedicated
   thread, opens a transparent always-on-top webview labelled
   `automation-pick-overlay` (the overlay is purely cosmetic — clicks
   pass through to the underlying app via `pointer-events: none`), and
   resolves an `ElementInfo` via UIA's `ElementFromPoint(x, y)` on the
   first `WM_LBUTTONDOWN`. New Tauri commands `desktop_pick_start` /
   `desktop_pick_cancel`. macOS / Linux return `UnsupportedPlatform`.
   The Inspector tab enables its Pick button when `caps.hasUia === true`.

4. **`triple_click` / `wait` / `cursor_position`** — `ClickOpts.count`
   added (1/2/3); UIA backend repeats clicks at the OS double-click cadence
   (`GetDoubleClickTime`). `Wait` was already in the action enum and is
   handled at the Anthropic-action-mapper layer (TS sleep, no Rust round
   trip needed). `cursor_position` added as a new read-only Tauri command
   (`GetCursorPos` on Windows, `Enigo::location()` on macOS / Linux).

### Renamed Non-Goals

The two items the 2026-05-15 addendum classified as structurally-deferred
Non-Goals are now closed:

- ~~Chat-driven `canUseTool` sidecar dispatch~~ — shipped via Plugin MCP.
- ~~MCP standalone `computer_use` IPC~~ — shipped via the
  `COGNIA_AUTOMATION_PROXY` side-channel.

### Still-deferred

- macOS / Linux UIA-equivalent tree walking (Phase 6.b).
- Plugin-registered custom desktop actions / UIA patterns.
- macOS / Linux full chord parser + `hold_key` parity. Tracked as part of
  the Phase 6.b non-Windows backend completion.

### Schema

Schema bump to `v40` (additive — no migration). Adds optional
`Character.computerUseSettings.chatConsentMode`
(`"always-ask" | "session-grant" | "auto"`, defaults to `"always-ask"`)
and `ClickOpts.count` (1/2/3). Existing rows round-trip unchanged.

## Addendum 2026-05-29 — Remote execution target (cua Docker sandbox)

Adds a remote **execution target** axis: computer-use GUI actions can run
inside an isolated, cognia-orchestrated [`trycua/cua`](https://github.com/trycua/cua)
(MIT) Docker desktop (`ghcr.io/trycua/cua-xfce`) instead of the local host.
This is *orthogonal* to the ADR-0028 `sandboxTier` axis (which isolates
Bash/Edit/Write — a command-execution contract); the GUI target is a separate
contract and does **not** ride `dispatchSandbox`. cua is used as the "hands"
only — the agent loop stays in `@anthropic-ai/claude-agent-sdk`; cua's
`ComputerAgent`/LiteLLM loop is **not** adopted.

### Architecture (R3 routing)

- **Anchor entity** — `sandboxConnection` (Dexie `v57`, `lib/db/sandbox-connections.ts`).
  Every target selector references a connection by `id`. Storing a connection
  id (never a bare flag) keeps a future convergence (below) a pure addition.
- **Target axis** — `Character.computerUseTarget` and
  `ChatSession.computerUseTarget` (`"local" | { connectionId }`), resolved
  session → character → local by `lib/automation/sandbox-target.ts`, stashed
  per-session (`lib/claude/computer-use-target-state.ts`) in `resolveSendOptions`,
  and stamped onto `CallContext.sandboxConnectionId` by the computer-use plugin
  executor. Workflow `desktop` nodes carry a per-node `target` param.
- **Routing (R3)** — `src-tauri/src/automation/cua_route.rs` is the single
  routing layer. Both backend-dispatch surfaces — `dispatcher::execute_action`
  (canonical renderer `desktop.*` + chat Plugin-MCP path) and the granular
  `desktop_*` commands — call it *inside* the `run_gated` `do_call` closure, so
  the gate → consent → audit pipeline wraps local and remote paths identically.
  A remote `CallContext` (non-empty `sandboxConnectionId`) dispatches to an
  async `CuaRemoteClient` (`tokio-tungstenite` WS to the container's
  `computer-server`); otherwise the existing synchronous COM worker runs.
  **Invariant:** every driving/reading action is routed; actions with no remote
  equivalent (`get_focus` / `find` / `invoke_pattern` / `window_op` /
  `pick_at_point`) return `UnsupportedPlatform` when remote rather than silently
  hitting the host.
- **Lifecycle** — `src-tauri/src/cua_sandbox/` (module named to avoid the
  existing `src-tauri/src/sandbox/` ADR-0028 collision) shells `docker run/stop/
  port` and owns a per-connection `CuaRemoteClient` registry; `cua_sandbox_*`
  Tauri commands + a Settings → Automation → Sandboxes tab drive it. The
  container is the isolation boundary (same model as the e2b microvm tier).
- **Capability** — `Capabilities.has_a11y_tree` (the remote backend exposes a
  cross-platform `get_accessibility_tree`; local enigo backends do not).

### Phase 1 scope / Non-Goals

In: local Docker provider, GUI action routing, Character + workflow-node target
pickers. Deferred: cua.ai Cloud + Lume providers, the `cua-driver` background
host driver, and **convergence** with ADR-0028 — a future `sandboxTier:
"cua-desktop"` that routes Bash/Edit/Write into the *same* container's
`run_command`/`read_text`/`write_text` by reading the same session→connectionId
binding. Because the binding is already a first-class entity, that convergence
is purely additive (no migration). A per-session composer target picker is the
remaining UI surface (the session field + resolution already work end-to-end).

### Schema (remote-target)

Dexie bump to `v57` (additive, no upgrade hook) — new `sandboxConnections`
table. `Character.computerUseTarget` + `ChatSession.computerUseTarget` are
optional; existing rows round-trip unchanged.

## Addendum (2026-06-27) — OCR-assisted click + macOS bounded element tree

### `find_text` / `click_text` (pixel ⇄ OCR bridge)

Two new **gated** plugin MCP tools (`lib/automation/ocr-click.ts`, surfaced by
the computer-use plugin) let the model act on on-screen text by name instead of
guessing pixel coordinates:

- `find_text` — capture the screen (gated `desktop.screenshot`) → OCR → return
  text blocks with **screen-space** coordinates, ranked best-first for a query.
- `click_text` — the same, then `desktop.click` the matched block's center
  (occurrence/button/double selectable). Coordinates map OCR `bbox` → physical
  px via the provider rasterization dims and the Rust screenshot-downscale
  factor (the `coordinate-scaler` signal). Both ride the existing
  gate/consent/audit pipeline. Requires an OCR provider that emits bounding
  boxes (tesseract / windows-ocr); a no-geometry provider returns a clear error.
  `extract_screenshot_ocr` also now returns image-relative `blocks`.

### macOS bounded AX element tree

`read_tree` / `find` on macOS now walk the **frontmost window's** AX subtree via
the high-level `accessibility` crate, depth/node-capped through the new
platform-agnostic `automation::platform::shared::tree_shape` helper (matcher +
budget + rect-center; unit-tested on every host including the Windows dev box).
`capabilities.has_a11y_tree` is now `true` on macOS, and `find` satisfies
name / name_contains / control_type (not just process/title). The native AX FFI
is verified on macOS CI — it does not compile on the Windows dev host.

**Deferred (Phase-next):** macOS `pick_at_point` coordinate hit-test
(`AXUIElementCopyElementAtPosition` needs a raw `-sys` ref wrap across the
`accessibility` crate's older core-foundation pin), element-targeted
actions (re-resolvable element refs), element geometry (`AXPosition`/`AXSize`),
and the **Linux AT-SPI** equivalent (async/zbus — not attempted blind from the
Windows host). `tree_shape` is the shared backbone those will reuse.

## Addendum (2026-07-06) — macOS Inspector actually usable

Two follow-on defects made the macOS Inspector effectively dead even though the
2026-06-27 bounded AX tree had shipped:

1. **Frontend gated on the wrong capability.** `InspectorTab` and the Overview
   badge keyed off `caps.hasUia` (Windows UI Automation), so macOS — which
   reports `hasA11yTree: true`, not `hasUia` — always fell through to the
   "Windows-only … later milestone" alert. The TS `Capabilities` type didn't
   even mirror the Rust `has_a11y_tree` field. Fix: add `hasA11yTree` to the TS
   type; gate the Inspector on `hasUia || hasA11yTree`; hide the UIA-only
   pattern-test affordances (which return `UnsupportedPlatform` off Windows)
   behind an honest a11y-only note; surface an `a11yTree` badge on the Overview
   (`platform-capabilities-card.tsx`, extracted + unit-tested).

2. **The tree was "only the window name."** Diagnosed on a macOS host by walking
   real apps (Chrome, VS Code) with a standalone AX probe — three root causes,
   all now fixed in `ax/mod.rs` + the new `ax/raw.rs`:
   - **Lazy web a11y.** Chromium / WebKit / Electron apps (Cognia's own WKWebView
     included) don't publish their web-content tree until an AT client sets
     `AXManualAccessibility` / `AXEnhancedUserInterface`. `read_tree` now
     activates it (with a short settle delay when the app had no windows).
   - **Wrong root window.** `AXWindows[0]` is often an empty helper window
     (observed on Chrome). Root selection is now `AXFocusedWindow` →
     `AXMainWindow` → first non-empty window → app element.
   - **Thin nodes.** Nodes now carry subrole (→ `class_name`), identifier (→
     `automation_id`), enabled/focused, a name fallback chain (`AXTitle` →
     `AXDescription` → string `AXValue` → `AXRoleDescription`), and geometry
     (`AXPosition`/`AXSize` → `bounding_rect`). An **AX trust gate** now fails
     `read_tree` loudly (with the system prompt) when the process isn't granted
     Accessibility, instead of silently returning an empty tree.

   The whole dependency graph shares one `core-foundation-sys` (0.8), so the raw
   AX FFI bridges cleanly via `accessibility-sys` + `core-foundation-sys` without
   the core-foundation-0.9-vs-0.10 wrapper conflict the earlier note feared — the
   deferred `AXUIElementCopyElementAtPosition` pick hit-test is now unblocked by
   the same bridge. The Inspector's default `maxDepth` was raised 2 → 4 (cap 6 →
   10) so the tree reaches real content by default.
