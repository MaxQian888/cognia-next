/**
 * Code → behaviour table.
 *
 * This is the single place that decides what a failure *means*: how loud it is,
 * whether re-running could help, whether it is a one-shot event or a condition
 * that persists, and what the user can do about it. Producers pick a code;
 * everything else follows.
 *
 * Two invariants, both pinned by `registry.test.ts` rather than by convention:
 *
 *   1. every code offers at least one action — a diagnostic the user can only
 *      stare at is a bug report waiting to happen;
 *   2. `retryable` implies a retry-shaped action is present, so the flag and
 *      the button can never disagree.
 *
 * `Record<DiagnosticCode, …>` (not `Partial`) means adding a code to the union
 * without deciding its behaviour is a compile error.
 */

import type { DiagnosticCode, DiagnosticCodeSpec } from "./types"

/** Reused for the several network faults whose only sane response is "try again". */
const TRANSIENT_NETWORK: DiagnosticCodeSpec = {
  severity: "error",
  retryable: true,
  persistent: false,
  actions: [{ kind: "retry" }],
  icon: "network",
}

/** Auth failures: retrying the same credentials cannot work — fix them first. */
const AUTH_FAILURE: DiagnosticCodeSpec = {
  severity: "error",
  retryable: false,
  persistent: true,
  actions: [{ kind: "open-settings", section: "ai-connections" }, { kind: "reauth" }],
  icon: "key",
}

/**
 * External-agent faults that need the user to look at the agent's config.
 * Every one of these also offers the built-in path, because being stuck with a
 * broken external agent and no way back was the actual complaint.
 */
const EXTERNAL_AGENT_CONFIG: DiagnosticCodeSpec = {
  severity: "error",
  retryable: false,
  persistent: true,
  actions: [{ kind: "open-settings", section: "external-bridge" }, { kind: "switch-to-builtin" }],
  icon: "plug",
}

export const DIAGNOSTIC_CODES: Readonly<Record<DiagnosticCode, DiagnosticCodeSpec>> = {
  // ---------------------------------------------------------------- network
  connectionRefused: {
    severity: "error",
    retryable: true,
    persistent: false,
    // Refused (rather than dropped) usually means nothing is listening, so the
    // logs say more than another attempt will.
    actions: [{ kind: "retry" }, { kind: "view-logs" }],
    icon: "network",
  },
  connectionReset: TRANSIENT_NETWORK,
  dnsFailure: {
    severity: "error",
    retryable: true,
    persistent: false,
    // A proxy misconfiguration looks exactly like this, so offer the pane.
    actions: [{ kind: "retry" }, { kind: "open-settings", section: "network" }],
    icon: "network",
  },
  networkUnreachable: TRANSIENT_NETWORK,
  brokenPipe: TRANSIENT_NETWORK,
  fetchFailed: TRANSIENT_NETWORK,
  timeout: {
    severity: "warning",
    retryable: true,
    persistent: false,
    actions: [{ kind: "retry" }],
    icon: "clock",
  },
  sessionTimeout: {
    severity: "warning",
    retryable: true,
    persistent: false,
    actions: [{ kind: "retry" }],
    icon: "clock",
  },
  offline: {
    severity: "warning",
    retryable: true,
    persistent: true,
    actions: [{ kind: "retry-when-online" }],
    icon: "network",
  },

  // ------------------------------------------------------------------- auth
  unauthorized: AUTH_FAILURE,
  forbidden: AUTH_FAILURE,

  // ----------------------------------------------------------- rate / quota
  rateLimited: {
    severity: "warning",
    retryable: true,
    persistent: false,
    // `wait-and-retry` needs a delay, which only the adapter knows; it replaces
    // the plain retry when `meta.retryAfterMs` is present.
    actions: [{ kind: "retry" }, { kind: "retry-fallback-provider" }],
    icon: "gauge",
  },
  quotaExceeded: {
    severity: "error",
    retryable: false,
    persistent: true,
    // Distinct from rate-limiting: waiting does not help, paying or switching does.
    actions: [
      { kind: "open-settings", section: "subscription" },
      { kind: "retry-fallback-provider" },
    ],
    icon: "gauge",
  },
  modelOverloaded: {
    severity: "warning",
    retryable: true,
    persistent: false,
    actions: [{ kind: "retry" }, { kind: "retry-fallback-provider" }],
    icon: "gauge",
  },

  // ----------------------------------------------------------------- server
  serverError: {
    severity: "error",
    retryable: true,
    persistent: false,
    actions: [{ kind: "retry" }, { kind: "retry-fallback-provider" }],
    icon: "server",
  },
  serviceUnavailable: {
    severity: "error",
    retryable: true,
    persistent: false,
    actions: [{ kind: "retry" }, { kind: "retry-fallback-provider" }],
    icon: "server",
  },
  sidecarExited: {
    severity: "error",
    retryable: true,
    persistent: false,
    actions: [{ kind: "retry" }, { kind: "restart-sidecar" }, { kind: "view-logs" }],
    icon: "server",
  },
  sidecarUnreachable: {
    severity: "error",
    retryable: true,
    persistent: true,
    actions: [{ kind: "restart-sidecar" }, { kind: "retry" }, { kind: "view-logs" }],
    icon: "server",
  },
  dispatchFailed: {
    severity: "error",
    retryable: true,
    persistent: false,
    actions: [{ kind: "retry" }, { kind: "view-logs" }],
    icon: "server",
  },

  // ---------------------------------------------------------- request shape
  invalidRequest: {
    severity: "error",
    retryable: false,
    persistent: false,
    actions: [{ kind: "copy-report" }, { kind: "report-issue" }],
    icon: "alert",
  },
  notFound: {
    severity: "error",
    retryable: false,
    persistent: false,
    actions: [{ kind: "open-settings", section: "ai-connections" }],
    icon: "alert",
  },
  payloadTooLarge: {
    severity: "warning",
    retryable: false,
    persistent: false,
    actions: [{ kind: "shorten-input" }],
    icon: "alert",
  },
  contextWindowExceeded: {
    severity: "warning",
    retryable: false,
    persistent: false,
    // A same-sized model fails identically, so the fallback offered here is a
    // *bigger* model, not the next one in the chain.
    actions: [{ kind: "shorten-input" }, { kind: "open-settings", section: "ai-connections" }],
    icon: "alert",
  },
  contentPolicy: {
    severity: "warning",
    retryable: false,
    persistent: false,
    // Deliberately no retry: replaying the same prompt trips the same filter.
    actions: [{ kind: "dismiss" }],
    icon: "alert",
  },

  // --------------------------------------------------------- configuration
  providerMisconfigured: {
    severity: "error",
    retryable: false,
    persistent: true,
    actions: [{ kind: "open-settings", section: "ai-connections" }],
    icon: "settings",
  },
  modelRequired: {
    severity: "error",
    retryable: false,
    persistent: true,
    actions: [{ kind: "open-settings", section: "ai-connections" }],
    icon: "settings",
  },
  pluginToolMissing: {
    severity: "error",
    retryable: false,
    persistent: true,
    actions: [{ kind: "open-settings", section: "plugins" }],
    icon: "plug",
  },
  routingNoCandidates: {
    severity: "error",
    retryable: false,
    persistent: true,
    actions: [{ kind: "open-settings", section: "ai-connections" }],
    icon: "settings",
  },

  // -------------------------------------------------------- external agents
  agentNotFound: EXTERNAL_AGENT_CONFIG,
  agentDisabled: EXTERNAL_AGENT_CONFIG,
  agentConfigurationMissing: EXTERNAL_AGENT_CONFIG,
  protocolUnsupported: EXTERNAL_AGENT_CONFIG,
  transportBlocked: {
    // Not a fault: the feature needs the desktop runtime. Reporting it as an
    // error taught users to distrust working software.
    severity: "info",
    retryable: false,
    persistent: true,
    actions: [{ kind: "switch-to-builtin" }],
    icon: "plug",
  },
  prerequisiteMissing: {
    severity: "error",
    retryable: false,
    persistent: true,
    // The install command and docs URL are appended by the adapter, which knows
    // the ecosystem; `locate-binary` covers "already installed, wrong PATH".
    actions: [
      { kind: "locate-binary" },
      { kind: "open-settings", section: "external-bridge" },
      { kind: "switch-to-builtin" },
    ],
    icon: "plug",
  },
  documentedOnly: {
    severity: "info",
    retryable: false,
    persistent: true,
    actions: [{ kind: "switch-to-builtin" }],
    icon: "plug",
  },
  initializationFailed: {
    severity: "error",
    retryable: true,
    persistent: true,
    actions: [
      { kind: "reconnect-external-agent" },
      { kind: "retry" },
      { kind: "view-logs" },
      { kind: "switch-to-builtin" },
    ],
    icon: "plug",
  },
  healthCheckFailed: {
    severity: "error",
    retryable: true,
    persistent: true,
    actions: [{ kind: "reconnect-external-agent" }, { kind: "retry" }, { kind: "view-logs" }],
    icon: "plug",
  },
  agentUnavailable: {
    severity: "error",
    retryable: true,
    persistent: true,
    actions: [
      { kind: "reconnect-external-agent" },
      { kind: "retry" },
      { kind: "switch-to-builtin" },
    ],
    icon: "plug",
  },
  extensionUnsupported: {
    // A capability this agent simply lacks (resume / fork). Informational, and
    // the control that needs it should read inert rather than broken.
    severity: "info",
    retryable: false,
    persistent: true,
    actions: [{ kind: "dismiss" }],
    icon: "plug",
  },
  extensionUnknown: {
    // Distinct from `extensionUnsupported`: we have not probed this agent yet,
    // so claiming the capability is missing would be a guess. The user sees a
    // neutral "not determined", not a fault.
    severity: "info",
    retryable: true,
    persistent: false,
    actions: [{ kind: "reconnect-external-agent" }, { kind: "dismiss" }],
    icon: "plug",
  },
  sessionResolutionFailed: {
    severity: "error",
    retryable: true,
    persistent: false,
    actions: [{ kind: "retry" }, { kind: "switch-to-builtin" }],
    icon: "plug",
  },
  runtimeVersionUnsupported: {
    // The binary is present, so `locate-binary` and `copy-install-command` are
    // both wrong answers — the user needs to upgrade the one they have.
    // Retrying the same executable can only fail identically.
    severity: "error",
    retryable: false,
    persistent: true,
    actions: [{ kind: "open-settings", section: "external-bridge" }, { kind: "switch-to-builtin" }],
    icon: "plug",
  },
  sandboxUnavailable: {
    // Terminal by design (ADR-0077): there is no unsandboxed fallback, so the
    // only routes forward are fixing the launcher or leaving the external path.
    severity: "error",
    retryable: false,
    persistent: true,
    actions: [
      { kind: "open-settings", section: "external-bridge" },
      { kind: "switch-to-builtin" },
      { kind: "view-logs" },
    ],
    icon: "settings",
  },
  extensionHandshakeFailed: {
    // The permission interception this agent depends on never proved itself
    // live, so the session was refused rather than run ungated. A fresh
    // connection genuinely can succeed — slow cold starts cause this.
    severity: "error",
    retryable: true,
    persistent: true,
    actions: [
      { kind: "reconnect-external-agent" },
      { kind: "retry" },
      { kind: "view-logs" },
      { kind: "switch-to-builtin" },
    ],
    icon: "plug",
  },
  protocolFrameInvalid: {
    // The stream desynchronised and cannot be resynchronised in place, but a
    // brand-new session starts from a clean framing state.
    severity: "error",
    retryable: true,
    persistent: false,
    actions: [{ kind: "retry" }, { kind: "view-logs" }, { kind: "switch-to-builtin" }],
    icon: "plug",
  },
  resourceLimit: {
    // A concurrency ceiling, not a fault: the same request succeeds once an
    // in-flight session finishes, so this must not read as broken.
    severity: "warning",
    retryable: true,
    persistent: false,
    actions: [{ kind: "retry" }, { kind: "dismiss" }],
    icon: "gauge",
  },
  permissionDenied: {
    severity: "error",
    retryable: false,
    persistent: false,
    actions: [{ kind: "open-settings", section: "external-bridge" }, { kind: "dismiss" }],
    icon: "key",
  },
  executionFailed: {
    severity: "error",
    retryable: true,
    persistent: false,
    actions: [{ kind: "retry" }, { kind: "switch-to-builtin" }, { kind: "view-logs" }],
    icon: "plug",
  },
  strictFailure: {
    severity: "error",
    retryable: true,
    persistent: false,
    actions: [{ kind: "retry" }, { kind: "switch-to-builtin" }],
    icon: "plug",
  },
  fallbackToBuiltin: {
    // A success path — disclosed so the user knows their turn did not run where
    // they asked it to. Silent substitution changes cost and output quality.
    severity: "info",
    retryable: false,
    persistent: false,
    actions: [{ kind: "open-settings", section: "external-bridge" }, { kind: "dismiss" }],
    icon: "plug",
  },
  externalAgentNotSelected: {
    severity: "warning",
    retryable: false,
    persistent: false,
    actions: [{ kind: "open-settings", section: "external-bridge" }],
    icon: "plug",
  },

  // ------------------------------------------------------- route boundaries
  chunkLoad: {
    severity: "warning",
    retryable: false,
    persistent: true,
    // A boundary reset just re-imports the missing chunk and throws again; only
    // a full reload re-fetches the manifest.
    actions: [{ kind: "reload-app" }],
    icon: "alert",
  },
  renderCrash: {
    severity: "error",
    retryable: false,
    persistent: false,
    actions: [{ kind: "reset-boundary" }, { kind: "copy-report" }, { kind: "report-issue" }],
    icon: "alert",
  },

  // ------------------------------------------------------ retry / dispatch
  aborted: {
    // The user asked for this. It exists so the UI can say "stopped" instead of
    // rendering a cancellation as a failure.
    severity: "info",
    retryable: true,
    persistent: false,
    actions: [{ kind: "retry" }],
    icon: "alert",
  },
  interrupted: {
    severity: "info",
    retryable: true,
    persistent: false,
    actions: [{ kind: "retry" }],
    icon: "alert",
  },
  budgetExhausted: {
    severity: "warning",
    retryable: false,
    persistent: false,
    actions: [{ kind: "open-settings", section: "agent-runtime" }],
    icon: "gauge",
  },
  dispatchRejectedCycle: {
    severity: "error",
    retryable: false,
    persistent: false,
    actions: [{ kind: "open-settings", section: "subagents" }],
    icon: "alert",
  },
  dispatchRejectedDepth: {
    severity: "error",
    retryable: false,
    persistent: false,
    actions: [{ kind: "open-settings", section: "subagents" }],
    icon: "alert",
  },
  dispatchRejectedPolicy: {
    severity: "error",
    retryable: false,
    persistent: false,
    actions: [{ kind: "open-settings", section: "agent-modes" }],
    icon: "alert",
  },
  deadlineExceeded: {
    severity: "warning",
    retryable: true,
    persistent: false,
    actions: [{ kind: "retry" }],
    icon: "clock",
  },

  // -------------------------------------------------------------- agent team
  teamSessionMissing: {
    severity: "error",
    retryable: false,
    persistent: false,
    actions: [{ kind: "open-settings", section: "squads" }],
    icon: "alert",
  },
  teamMissing: {
    severity: "error",
    retryable: false,
    persistent: true,
    actions: [{ kind: "open-settings", section: "squads" }],
    icon: "settings",
  },
  supervisorMissing: {
    severity: "error",
    retryable: false,
    persistent: true,
    actions: [{ kind: "open-settings", section: "squads" }],
    icon: "settings",
  },
  supervisorNotMember: {
    severity: "error",
    retryable: false,
    persistent: true,
    actions: [{ kind: "open-settings", section: "squads" }],
    icon: "settings",
  },
  // The conversation names a Squad the store no longer has — deleted, or
  // belonging to another account. Persistent: the binding stays wrong until
  // someone changes it.
  squadNotFound: {
    severity: "error",
    retryable: false,
    persistent: true,
    actions: [{ kind: "open-settings", section: "squads" }],
    icon: "settings",
  },
  // The Squad exists but the run could not be launched. Retryable: the usual
  // causes (a loader failing, a deleted entry Character) are transient or
  // fixable without touching the binding.
  squadDispatchFailed: {
    severity: "error",
    retryable: true,
    persistent: false,
    actions: [{ kind: "retry" }, { kind: "dismiss" }],
    icon: "alert",
  },

  // -------------------------------------------------------- execution layer
  capabilityUnsatisfied: {
    severity: "error",
    retryable: false,
    persistent: true,
    actions: [{ kind: "open-settings", section: "agent-runtime" }, { kind: "view-logs" }],
    icon: "settings",
  },
  hostUnavailable: {
    severity: "error",
    retryable: true,
    persistent: true,
    actions: [{ kind: "retry" }, { kind: "open-settings", section: "remote-hosts" }],
    icon: "server",
  },
  frozenModelBinding: {
    severity: "error",
    retryable: false,
    persistent: false,
    actions: [{ kind: "open-settings", section: "ai-connections" }],
    icon: "settings",
  },
  degradedFallback: {
    // Same disclosure principle as `fallbackToBuiltin`: it worked, but not the
    // way the user configured it.
    severity: "info",
    retryable: false,
    persistent: false,
    actions: [{ kind: "open-settings", section: "agent-runtime" }, { kind: "dismiss" }],
    icon: "alert",
  },

  // ------------------------------------------------------------- chat-local
  noSessionOpen: {
    severity: "warning",
    retryable: false,
    persistent: false,
    actions: [{ kind: "dismiss" }],
    icon: "alert",
  },
  promptBlockedByPlugin: {
    severity: "warning",
    retryable: false,
    persistent: false,
    actions: [{ kind: "open-settings", section: "plugins" }, { kind: "dismiss" }],
    icon: "plug",
  },

  // ------------------------------------------------------ Cognia internals
  settingsLoadFailed: {
    // Fatal in the sense that matters: every preference the user set is absent,
    // and they cannot tell that from a fresh install.
    severity: "fatal",
    retryable: true,
    persistent: true,
    actions: [{ kind: "retry" }, { kind: "export-crash-log" }, { kind: "view-logs" }],
    icon: "database",
  },
  settingsSaveFailed: {
    severity: "error",
    retryable: true,
    persistent: false,
    actions: [{ kind: "retry" }, { kind: "view-logs" }],
    icon: "database",
  },
  dbUpgradeBlocked: {
    // Nothing in this window can fix it — the holder is another window.
    severity: "fatal",
    retryable: false,
    persistent: true,
    actions: [{ kind: "reload-app" }],
    icon: "database",
  },
  dbUnavailable: {
    severity: "fatal",
    retryable: true,
    persistent: true,
    actions: [{ kind: "retry" }, { kind: "reload-app" }, { kind: "export-crash-log" }],
    icon: "database",
  },
  seedFailed: {
    severity: "warning",
    retryable: true,
    persistent: false,
    actions: [{ kind: "retry" }, { kind: "view-logs" }],
    icon: "database",
  },
  eventChannelLost: {
    // Silent until now: every subscription on the dead channel simply stopped
    // updating, which reads as "the app is frozen", not "reload me".
    severity: "error",
    retryable: false,
    persistent: true,
    actions: [{ kind: "reload-app" }, { kind: "export-crash-log" }],
    icon: "plug",
  },
  healthProbeFailed: {
    severity: "warning",
    retryable: true,
    persistent: true,
    actions: [{ kind: "retry" }, { kind: "open-settings", section: "companion" }],
    icon: "network",
  },
  desktopOnlyFeature: {
    severity: "info",
    retryable: false,
    persistent: true,
    actions: [{ kind: "dismiss" }],
    icon: "alert",
  },
  proxyApplyFailed: {
    // Traffic silently bypassing a configured proxy is a privacy problem, not a
    // cosmetic one — hence a real diagnostic rather than a console.warn.
    severity: "warning",
    retryable: true,
    persistent: true,
    actions: [{ kind: "retry" }, { kind: "open-settings", section: "network" }],
    icon: "network",
  },

  // -------------------------------------------------------------- fallback
  unknown: {
    severity: "error",
    retryable: false,
    persistent: false,
    actions: [{ kind: "copy-report" }, { kind: "report-issue" }, { kind: "view-logs" }],
    icon: "alert",
  },
}

/** Every code in the registry — the canonical iteration order for tests + i18n. */
export const DIAGNOSTIC_CODE_IDS = Object.keys(DIAGNOSTIC_CODES) as DiagnosticCode[]

/** Look up a code's spec, falling back to `unknown` for untrusted input. */
export function specForCode(code: string): DiagnosticCodeSpec {
  return DIAGNOSTIC_CODES[code as DiagnosticCode] ?? DIAGNOSTIC_CODES.unknown
}

/** Whether a string is a known code — the guard adapters use before casting. */
export function isDiagnosticCode(value: string): value is DiagnosticCode {
  return Object.prototype.hasOwnProperty.call(DIAGNOSTIC_CODES, value)
}
