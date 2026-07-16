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
 *   `/ws/v1/events`; webhook-transport channels only (T-A5). Dial-out WS
 *   channels stay desktop-only until the Rust EventEmitter extension lands.
 *
 * Pending extraction (tracked ADR-0059 T-A6): backup-scheduler (needs an
 * injected fs seam).
 *
 * ## Deliberately NOT registered (desktop/mobile-UI-only provider effects)
 *
 * - `companion-boot` — the CLIENT side of the companion protocol (pairing,
 *   sync-down into a phone); a brain is the server side.
 * - `storage-persistence` — `navigator.storage.persist()` is a browser API.
 * - `window-title`, `context-keys`, `appearance` — WebView chrome/UI state.
 * - `ocr-runtime` — native OCR is desktop-only hardware (ADR-0059 D4).
 * - `desktop-only-initializers` / `mobile-only-initializers` — shell-specific
 *   by definition; anything inside them that belongs in the brain must be
 *   extracted out and registered individually.
 * - `pet` — desktop pet window runtime.
 */

import "./desktop-sync-source"
import "./desktop-message-source"
import "./a2ui-dispatch"
import "./initializers"
import "./connector-runtime"

export {}
