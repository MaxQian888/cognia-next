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
 *   `desktop-network-runtime`, `provider-core-runtime`, `routing-runtime`,
 *   `ocr-runtime`,
 *   `template-trust-reconciliation`, `background-task`,
 *   `provider-cost-mirror` — the boot-initializer batch (T-A7..A9; see
 *   ./initializers.ts for what is deliberately excluded and why).
 * - `connector-runtime` — the shared connector bootstrap with the Tauri
 *   command/event seams mapped onto the R12 `connectors_*` RPC arms and
 *   `/ws/events`, including webhook, polling, reverse/forward WS, gateway,
 *   long-connection, and IMAP/SMTP transports (T-A5).
 *
 * - `backup-scheduler` — the shared encrypted local/WebDAV scheduler with an
 *   injected host filesystem and the server secret-store auto-key (T-A6).
 * - `plugin-runtime` — boots the canonical Node PluginManager and serially
 *   reconciles native install/restore/uninstall events from cognia-server.
 * - `twin-job-worker` — drains enabled Twin ingest/distill jobs in a headless brain.
 * - `workflow-trigger-bridge` — subscribes to `workflow:trigger` on the brain's
 *   events plane so the Rust cron daemon / webhook router in cognia-server
 *   actually start workflow runs (host-neutral `installTriggerBridge`).
 * - `issue-tracker` — the ADR-0132 board's runtime half: four issue sources,
 *   the run bridge that dispatches an issue to an agent engine, the lifecycle →
 *   Notification Center watcher, label seeding and the GitHub refresh schedule
 *   (host-neutral `bootIssueTracker` in lib/issues/boot.ts).
 * - `plan-notification` — the ADR-0045 `plan.respond` notification command;
 *   approve/reject/start mutate the brain-side plan runtime, and an orchestrated
 *   plan starts running from here.
 * - The bridge-owned `BridgeWorkerRpcPool` is the one sanctioned bootstrap
 *   exception: `serveCommand` creates it only after the authenticated bridge
 *   connects, injects that transport into the existing AgentTeam runtime, and
 *   closes/uninstalls both in the same command teardown. It cannot be created
 *   from this import-only roster because its dependency is the live bridge.
 *
 * ## Deliberately NOT registered (desktop/mobile-UI-only provider effects)
 *
 * - `companion-boot` — the CLIENT side of the companion protocol (pairing,
 *   sync-down into a phone); a brain is the server side.
 * - `companion-outbound-runner` — drains phone-originated writes from the
 *   browser-local IndexedDB queue into the paired desktop; a brain is the
 *   receiving authority and never owns that client-side queue.
 * - `storage-persistence` — `navigator.storage.persist()` is a browser API.
 * - `window-title`, `context-keys`, `appearance` — WebView chrome/UI state.
 * - `window-liveness-initializers` — reveals and heartbeats the Tauri main
 *   window; a headless/cloud runtime has no native window to manage.
 * - `transformers-runtime` — its Web Worker/WebGPU/WASM execution is an
 *   explicitly enabled browser feature; headless callers must use a server runtime.
 * - `desktop-only-initializers` / `mobile-only-initializers` — shell-specific
 *   by definition; anything inside them that belongs in the brain must be
 *   extracted out and registered individually.
 * - `wasm-renderer-request-source` — Tauri-only response bridge for WASM host
 *   calls into renderer-owned provider and workflow registries. A headless host
 *   has no Tauri event source; unsupported calls fail closed as HOST_UNAVAILABLE.
 * - `pet` — desktop pet window runtime.
 * - `sites-preview` / `sites-operation-recovery` — Sites uses a visible native terminal,
 *   the singleton embedded webview, and the host-local credential keyring. Provider
 *   reconciliation is deliberately initiated only by the owning desktop account.
 * - `session-peer-runtime` — reachability is defined by renderer-open conversation panes
 *   and delivery appends into their live chat slices. Headless sessions are independently
 *   addressed through the brain transport and do not share this UI-local presence model.
 * - `remote-notification-initializer` — the CLIENT-side ingest of
 *   `notification://remote` frames into the local notification center; the
 *   brain is the publisher (`lib/notifications/runtime.ts` →
 *   `remote_notification_publish`) and must not subscribe to itself.
 */

import "./desktop-sync-source"
import "./desktop-message-source"
import "./a2ui-dispatch"
import "./behavior-telemetry"
import "./initializers"
import "./connector-runtime"
import "./backup-scheduler"
import "./plugin-runtime"
import "./managed-ide-broker"
import "./memory-job-worker"
import "./twin-job-worker"
import "./integration-runtime"
import "./performance-runtime"
import "./workflow-trigger-bridge"
import "./issue-tracker"
import "./plan-notification"

export {}
