/**
 * Headless runtime roster — THE wiring anchor (ADR-0059 W2 / T-A1).
 *
 * `cli/src/serve` imports this module once at boot; importing it registers
 * every extracted runtime into the registry. The wiring auditor enforces the
 * repo rule that new provider effects either register here or carry a
 * desktop-ui-only annotation below.
 *
 * ## Registered (extraction slices T-A2..A9 add entries here)
 *
 * - `desktop-sync-source` — answers `companion://sync-pull-request` from the
 *   brain's Dexie (T-A2).
 * - `desktop-message-source` — the five message/session RPCs plus the
 *   generic desktop-write command channel (T-A3).
 * - `a2ui-dispatch` — feeds sidecar `a2ui://dispatch` envelopes into the
 *   A2UI store (T-A4).
 * - `scheduler`, `workflow-runtime`, `agent-team-runtime`,
 *   `automation-policy`, `audit-retention`, `storage-retention`,
 *   `provider-core-runtime`, `routing-runtime`, `background-task`,
 *   `provider-cost-mirror` — the boot-initializer batch (T-A7..A9; see
 *   ./initializers.ts for what is deliberately excluded and why).
 * - `connector-runtime` — the shared connector bootstrap with the Tauri
 *   command/event seams mapped onto the R12 `connectors_*` RPC arms and
 *   `/ws/v1/events`, including webhook, polling, reverse/forward WS, gateway,
 *   long-connection, and IMAP/SMTP transports (T-A5).
 *
 * - `backup-scheduler` — the shared encrypted local/WebDAV scheduler with an
 *   injected host filesystem and the server secret-store auto-key (T-A6).
 * - `plugin-runtime` — boots the canonical Node PluginManager and serially
 *   reconciles native install/restore/uninstall events from cognia-server.
 *
 * ## Deliberately NOT registered (desktop/mobile-UI-only provider effects)
 *
 * - `companion-boot` — the CLIENT side of the companion protocol (pairing,
 *   sync-down into a phone); a brain is the server side.
 * - `storage-persistence` — `navigator.storage.persist()` is a browser API.
 * - `window-title`, `context-keys`, `appearance` — WebView chrome/UI state.
 * - `window-liveness-initializers` — reveals and heartbeats the Tauri main
 *   window; a headless/cloud runtime has no native window to manage.
 * - `ocr-runtime` — native OCR is desktop-only hardware (ADR-0059 D4).
 * - `transformers-runtime` — its Web Worker/WebGPU/WASM execution is an
 *   explicitly enabled browser feature; headless callers must use a server runtime.
 * - `desktop-only-initializers` / `mobile-only-initializers` — shell-specific
 *   by definition; anything inside them that belongs in the brain must be
 *   extracted out and registered individually.
 * - `pet` — desktop pet window runtime.
 * - `sites-preview` / `sites-operation-recovery` — Sites uses a visible native terminal,
 *   the singleton embedded webview, and the host-local credential keyring. Provider
 *   reconciliation is deliberately initiated only by the owning desktop account.
 */

import "./desktop-sync-source"
import "./desktop-message-source"
import "./a2ui-dispatch"
import "./behavior-telemetry"
import "./initializers"
import "./connector-runtime"
import "./backup-scheduler"
import "./plugin-runtime"
import "./memory-job-worker"

export {}
