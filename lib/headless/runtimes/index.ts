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
 * - `host-event-publisher` — installs the authenticated bridge publisher
 *   before any authoritative runtime can emit sync, workflow, or connector
 *   events, and keeps it installed until reverse teardown completes.
 * - `desktop-sync-source` — answers `companion://sync-pull-request` from the
 *   brain's Dexie (T-A2).
 * - `desktop-message-source` — the five message/session RPCs plus the
 *   generic desktop-write command channel (T-A3).
 * - `a2ui-dispatch` — feeds sidecar `a2ui://dispatch` envelopes into the
 *   A2UI store (T-A4).
 * - `scheduler`, `workflow-runtime`, `agent-team-runtime`,
 *   `workflow-exit-lease-release`,
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
 * - `bot-delivery-runner` — drains the Bot delivery queue. The brain is
 *   awake when nobody is at a desktop, and integration ingress only exists
 *   there and here.
 * - `backup-scheduler` — the shared encrypted local/WebDAV scheduler with an
 *   injected host filesystem and the server secret-store auto-key (T-A6).
 * - `plugin-runtime` — boots the canonical Node PluginManager and serially
 *   reconciles native install/restore/uninstall events from cognia-server.
 * - `workflow-trigger-bridge` — subscribes to `workflow:trigger` on the brain's
 *   events plane so the Rust cron daemon / webhook router in cognia-server
 *   actually start workflow runs (host-neutral `installTriggerBridge`).
 * - `sftp-transfer-pump` — drains the durable SFTP transfer queue so a row an
 *   agent queues on the brain actually moves (ADR-0162).
 * - `issue-tracker` — the ADR-0132 board's runtime half: four issue sources,
 *   the run bridge that dispatches an issue to an agent engine, the lifecycle →
 *   Notification Center watcher, label seeding and the GitHub refresh schedule
 *   (host-neutral `bootIssueTracker` in lib/issues/boot.ts).
 * - `collab-refresh` — pulls the four collab read caches (ADR-0149) on the
 *   shared backoff. The desktop's `installCollabRefreshScheduler` is excluded
 *   because it gates on `document.visibilityState`, so in a brain it would
 *   register and refresh nothing. Same body, no visibility question.
 * - `plan-notification` — the ADR-0045 `plan.respond` notification command;
 *   approve/reject/start mutate the brain-side plan runtime, and an orchestrated
 *   plan starts running from here.
 * - The bridge-owned `BridgeWorkerRpcPool` is the one sanctioned bootstrap
 *   exception: `serveCommand` creates it only after the authenticated bridge
 *   connects, injects that transport into the existing AgentTeam runtime, and
 *   closes/uninstalls both in the same command teardown. It cannot be created
 *   from this import-only roster because its dependency is the live bridge.
 *
 * ## Deliberately NOT registered (lifecycle owned elsewhere or UI-only)
 *
 * - `sandbox-session-runtime` — owns only immutable in-memory placement refs.
 *   Plugin deactivation drains existing E2B owners; the registered
 *   `plugin-runtime` teardown emits `APP_CLOSING` and force-disposes active and
 *   draining adapters, so there is no independent runtime entry to register.
 * - `companion-boot` — the CLIENT side of the companion protocol (pairing,
 *   sync-down into a phone); a brain is the server side.
 * - `companion-outbound-runner` — drains phone-originated writes from the
 *   browser-local IndexedDB queue into the paired desktop; a brain is the
 *   receiving authority and never owns that client-side queue.
 * - renderer `LangfuseTransport` — batches local `AgentTraceSpan` rows through
 *   the authenticated companion transport and is therefore client-owned. A
 *   brain exports its AI SDK observations from the sidecar's process-wide
 *   Langfuse span processor; account-bound companion batches terminate in the
 *   Rust service-plane `langfuse_trace_ingest` arm.
 * - renderer `instrumentation-client` console bridge and `OtlpLogTransport` —
 *   capture WebView/client logs and share the desktop Host or credentialless
 *   Collector egress policy. Headless processes own their process logging and
 *   OTel exporters directly; they do not bootstrap the renderer logger graph.
 * - `storage-persistence` — `navigator.storage.persist()` is a browser API.
 * - `window-title`, `context-keys`, `appearance` — WebView chrome/UI state.
 * - `window-liveness-initializers` — reveals and heartbeats the Tauri main
 *   window; a headless/cloud runtime has no native window to manage.
 * - `recovery Agent Host bootstrap` — starts the bundled Node sidecar through
 *   the Tauri `agent_start` command before desktop initializers mount. Headless
 *   hosts own their agent process lifecycle outside the renderer recovery gate.
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
 * - `session-import-watch-initializer` — owns a Tauri filesystem watcher over
 *   desktop external-agent history paths; its commands are client-local and
 *   internal-only in the canonical protocol manifest.
 * - `vector-credential-migration-initializer` — migrates browser localStorage
 *   secrets into the desktop OS keyring; headless hosts have neither source
 *   storage nor a renderer-owned credential settings store to rehydrate.
 * - `twin-job-worker` — Twin vector stores currently dispatch through Tauri
 *   commands. The headless bridge is a response/event transport rather than a
 *   general command RPC surface, so registering the renderer worker here would
 *   start a runtime whose first vector operation always fails. Re-enable only
 *   with an explicit server-side vector adapter.
 * - `worker-runtime-initializer` — attaches the WebView through a Tauri IPC
 *   `Channel`; the brain-side bridge-owned worker pool is installed and torn
 *   down by `serveCommand` after its authenticated bridge connects.
 * - `cloud-identity-initializer` — keyring hygiene for the renderer's
 *   per-profile Logto session (discarding the pre-ADR-0149 global blob,
 *   resolving a lapsed login into a re-auth marker at boot). The brain keeps
 *   its own file-backed session in `cli/src/serve/collab-reader.ts` and
 *   refreshes it there.
 */

import "./host-event-publisher"
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
import "./integration-runtime"
import "./performance-runtime"
import "./workflow-trigger-bridge"
import "./issue-tracker"
import "./collab-refresh"
import "./plan-notification"
import "./sftp-transfer-pump"
import "./bots"

export {}
