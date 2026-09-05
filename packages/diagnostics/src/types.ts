/**
 * The canonical diagnostic record.
 *
 * Cognia grew six independent error taxonomies — `@cognia/error-parsers`
 * category ids, `ProviderErrorClass`, `ExternalAgentBranchReasonCode`,
 * `lib/error/classify-error`, `ResilienceErrorKind` and the Rust
 * `CommandError` code — and then threw all of them away at the UI boundary,
 * because the only channel from a failing turn to the screen was
 * `setSessionError(id, string)`. Renderers were left re-deriving category by
 * regex from English prose (`/api[\s_-]?key/i` decided whether to offer an
 * "Open settings" button), which is both fragile and silently English-only.
 *
 * `CogniaDiagnostic` is the shared shape those taxonomies map *into*. It is
 * deliberately:
 *
 *   - **serializable** — it has to survive a Zustand store, a DOM CustomEvent,
 *     a structured log line, a Dexie-persisted notification row, and a
 *     `toEqual` assertion. That rules out callbacks (see {@link DiagnosticAction});
 *   - **i18n-free** — it carries a stable `code`, never prose. The renderer
 *     maps `code` to a localized label + hint, so a diagnostic produced in
 *     `lib/` can be read in Chinese;
 *   - **decided at the source** — severity, retryability and the default
 *     remediation actions come from {@link DiagnosticCodeSpec} in the registry,
 *     not from whoever happens to render it.
 */

/**
 * How much of the user's attention the failure has earned.
 *
 * `fatal` is reserved for "the app cannot continue" (the database never
 * opened, the root layout crashed) — it is the only tier allowed to take over
 * the screen. Everything a user can keep working around is `error` or below.
 */
export type DiagnosticSeverity = "fatal" | "error" | "warning" | "info"

/**
 * Which subsystem produced the failure. Drives grouping, dedupe scope, and the
 * mapping onto `NotificationSource` when a diagnostic is delivered to the
 * notification center rather than an on-screen surface.
 */
export type DiagnosticSource =
  | "chat"
  | "agent-team"
  | "external-agent"
  | "provider"
  | "plugin"
  | "workflow"
  | "scheduler"
  | "inbox"
  | "connector"
  | "tauri"
  | "storage"
  | "settings"
  | "boundary"
  | "execution"
  | "unknown"

/**
 * What the user can actually do about it.
 *
 * Data, never a closure. A diagnostic may be persisted to Dexie as a
 * notification row and rendered days later in a different window — an action
 * that captured a callback could not survive that trip, and could not be
 * compared in a test. The renderer resolves `kind` to a handler at click time,
 * exactly as `NotificationAction.command` already does.
 */
export type DiagnosticAction =
  /** Re-run the failed operation as-is. */
  | { kind: "retry" }
  /** Re-run, but only after the provider's stated cooldown has elapsed. */
  | { kind: "wait-and-retry"; retryAfterMs: number }
  /** Re-run against the next provider in the routing chain. */
  | { kind: "retry-fallback-provider" }
  /** Re-run once connectivity returns. */
  | { kind: "retry-when-online" }
  /** Abandon the external agent and re-issue the turn on the built-in path. */
  | { kind: "switch-to-builtin" }
  /** `section` is a `SettingsSectionId`; `focus` scrolls to a specific control. */
  | { kind: "open-settings"; section: string; focus?: string }
  /** Re-run the provider's OAuth / login flow. */
  | { kind: "reauth"; providerId?: string }
  /** Restart the Node sidecar that hosts the built-in agent. */
  | { kind: "restart-sidecar" }
  /** Re-queue a connector adapter that dropped its transport. */
  | { kind: "reconnect-adapter"; adapterId?: string }
  /** Re-establish the ACP/A2A connection to an external agent. */
  | { kind: "reconnect-external-agent"; agentId?: string }
  /** Copy the install command for a missing external-agent binary. */
  | { kind: "copy-install-command"; command: string }
  /** Point Cognia at an existing binary instead of installing one. */
  | { kind: "locate-binary"; agentId?: string }
  /** The input exceeded a hard limit and must get smaller before any retry. */
  | { kind: "shorten-input" }
  /** Open the log viewer. */
  | { kind: "view-logs" }
  /**
   * Stop the turn that is currently running on this session.
   *
   * Distinct from `retry`/`dismiss`: the turn has not failed and has not been
   * abandoned — it is open and producing nothing, and the only two useful
   * moves are to look at why (`view-logs`) or to take the session back.
   */
  | { kind: "interrupt-turn" }
  /** Jump to the offending node in the workflow editor. */
  | { kind: "jump-to-node"; nodeId: string }
  /** Open an external URL (docs, provider status page, install guide). */
  | { kind: "open-external"; url: string }
  /** Write the crash-log bundle to disk. */
  | { kind: "export-crash-log" }
  /** Copy a pre-filled markdown report to the clipboard. */
  | { kind: "copy-report" }
  /** Open the issue tracker with the report pre-filled. */
  | { kind: "report-issue" }
  /** Full page reload — the only way past a stale chunk or a blocked upgrade. */
  | { kind: "reload-app" }
  /** Re-run the crashed React subtree via the boundary's `reset()`. */
  | { kind: "reset-boundary" }
  /** Acknowledge and hide. */
  | { kind: "dismiss" }

/** Discriminator of {@link DiagnosticAction}, for handler maps and i18n keys. */
export type DiagnosticActionKind = DiagnosticAction["kind"]

/**
 * Structured context captured at the failure site.
 *
 * Everything here was already available where the error was thrown and used to
 * be discarded on the way to the UI — `httpStatus` and `retryAfterMs` in
 * particular are read from the real provider response by the sidecar, then fed
 * to the routing fallback and dropped. Keeping them lets the renderer show a
 * genuine countdown instead of guessing, and lets a report name the exact turn.
 *
 * Must stay free of secrets: it is logged, persisted, and copied into reports.
 */
export interface DiagnosticMeta {
  /** Real HTTP status from the provider response, when there was one. */
  httpStatus?: number
  /** Real Retry-After delay in ms — header-derived beats text-derived. */
  retryAfterMs?: number
  providerId?: string
  modelId?: string
  agentId?: string
  sessionId?: string
  runId?: string
  turnId?: string
  traceId?: string
  spanId?: string
  pluginId?: string
  toolName?: string
  workflowId?: string
  nodeId?: string
  adapterId?: string
  /** How many attempts had already been made when this failure landed. */
  attempts?: number
  /** Process exit code, for spawned agents and sidecars. */
  exitCode?: number
  /** Escape hatch for subsystem-specific ids. Never free-form prose. */
  extra?: Readonly<Record<string, string | number | boolean>>
}

export interface CogniaDiagnostic {
  /** Stable identity for dedupe, dismissal and log correlation. */
  id: string
  /** Epoch ms. Injected rather than read from the clock, so tests can assert. */
  at: number
  code: DiagnosticCode
  severity: DiagnosticSeverity
  /** Whether re-running the same operation could plausibly succeed. */
  retryable: boolean
  /**
   * True when the condition holds until someone acts on it (sidecar down,
   * adapter unreachable, settings failed to load) rather than being a one-shot
   * event. Persistent diagnostics belong on a steady-state badge or banner; a
   * toast per retry tick would be noise.
   */
  persistent: boolean
  source: DiagnosticSource
  /**
   * Raw, untranslated technical text — the provider's message, the stderr line,
   * the exception message. Shown as supporting detail and copied into reports,
   * but never as the primary label: that comes from `code`.
   */
  message: string
  /** Registry defaults plus any extras the producer appended, deduped. */
  actions: readonly DiagnosticAction[]
  meta?: DiagnosticMeta
  /** Stack trace or raw payload, for the "show raw" disclosure. */
  detail?: string
}

/**
 * Icon token, resolved to a concrete lucide component by the renderer.
 *
 * Kept as a token so this package stays free of React and lucide — it is
 * imported by `lib/` and by the CLI, neither of which should pull an icon set.
 */
export type DiagnosticIcon =
  "network" | "clock" | "key" | "gauge" | "server" | "plug" | "settings" | "database" | "alert"

export interface DiagnosticCodeSpec {
  severity: DiagnosticSeverity
  retryable: boolean
  persistent: boolean
  /** Default remediation, most useful first. Producers may append more. */
  actions: readonly DiagnosticAction[]
  icon: DiagnosticIcon
}

/**
 * The closed code vocabulary.
 *
 * The first 23 members are the ids `@cognia/error-parsers` already emits and
 * `chat.message.errorCategory*` already translates into both locales — reused
 * verbatim so ~90 existing translations and the existing icon mapping carry
 * over. The rest extend that vocabulary to the failures the other five
 * taxonomies describe, plus Cognia's own internal faults.
 */
export type DiagnosticCode =
  // --- Existing `@cognia/error-parsers` category ids (do not rename) ---
  | "connectionRefused"
  | "connectionReset"
  | "dnsFailure"
  | "networkUnreachable"
  | "brokenPipe"
  | "fetchFailed"
  | "timeout"
  | "sessionTimeout"
  | "unauthorized"
  | "forbidden"
  | "rateLimited"
  | "quotaExceeded"
  | "modelOverloaded"
  | "serverError"
  | "serviceUnavailable"
  | "sidecarExited"
  | "dispatchFailed"
  | "providerMisconfigured"
  | "modelRequired"
  | "pluginToolMissing"
  | "invalidRequest"
  | "notFound"
  | "payloadTooLarge"
  // --- Provider classes the parsers don't cover ---
  | "contextWindowExceeded"
  | "contentPolicy"
  // --- External agents (one per ExternalAgentBranchReasonCode) ---
  | "agentNotFound"
  | "agentDisabled"
  | "agentConfigurationMissing"
  | "protocolUnsupported"
  | "transportBlocked"
  | "prerequisiteMissing"
  | "documentedOnly"
  | "initializationFailed"
  | "healthCheckFailed"
  | "agentUnavailable"
  | "extensionUnsupported"
  | "extensionUnknown"
  | "sessionResolutionFailed"
  | "permissionDenied"
  | "executionFailed"
  | "strictFailure"
  | "fallbackToBuiltin"
  | "runtimeVersionUnsupported"
  | "sandboxUnavailable"
  | "extensionHandshakeFailed"
  | "protocolFrameInvalid"
  | "resourceLimit"
  // --- Route boundaries ---
  | "chunkLoad"
  | "offline"
  | "renderCrash"
  // --- Retry / dispatch ---
  | "aborted"
  | "interrupted"
  | "budgetExhausted"
  | "dispatchRejectedCycle"
  | "dispatchRejectedDepth"
  | "dispatchRejectedPolicy"
  | "deadlineExceeded"
  // --- Agent team ---
  | "teamSessionMissing"
  | "teamMissing"
  | "supervisorMissing"
  | "supervisorNotMember"
  | "squadNotFound"
  | "squadDispatchFailed"
  | "squadNotReady"
  | "squadAlreadyRunning"
  // --- Unified execution layer ---
  | "capabilityUnsatisfied"
  | "hostUnavailable"
  | "frozenModelBinding"
  | "degradedFallback"
  // --- Workspace / project environment preflight ---
  // These six send-path refusals used to be raw strings through
  // `setSessionError`, which nulls `errorDiagnostic` — so they landed in the
  // deprecated `InlineError` whose only affordance opens Providers, the one
  // settings page that could never fix any of them.
  | "workspaceUnavailable"
  | "workspaceBundleFailed"
  | "environmentUnavailable"
  | "environmentSetupFailed"
  // --- Chat-local ---
  /**
   * The turn was dispatched and acknowledged nothing since. Not an error: no
   * failure has been observed, which is exactly the problem — a bare `return`
   * on a path that had already flipped the session to `streaming` leaves the
   * composer spinning with nothing to report and nothing to press.
   */
  | "turnSilent"
  | "noSessionOpen"
  | "promptBlockedByPlugin"
  | "externalAgentNotSelected"
  | "externalAgentNotReady"
  | "routingNoCandidates"
  // --- Cognia internals ---
  | "settingsLoadFailed"
  | "settingsSaveFailed"
  | "dbUpgradeBlocked"
  | "dbUnavailable"
  | "seedFailed"
  | "eventChannelLost"
  | "sidecarUnreachable"
  | "healthProbeFailed"
  | "desktopOnlyFeature"
  | "proxyApplyFailed"
  // --- Terminal fallback ---
  | "unknown"
