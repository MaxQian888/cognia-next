/**
 * Diagnostic → `NotificationInput` projection.
 *
 * The notification center (ADR-0042) already solves durable delivery: a Dexie
 * record, the badge/panel store, DND and per-source mute, `dedupeKey` merging
 * with a count bump, OS fan-out and serializable actions. Error delivery simply
 * never used it — 13 callers total, none of them a failure path.
 *
 * So this is a projection, not a new pipe. Both unions map ONTO the existing
 * ones with no new members: `NotificationSource`'s seven values already cover
 * every diagnostic source.
 */

import {
  DIAGNOSTIC_SOURCES,
  type CogniaDiagnostic,
  type DiagnosticActionKind,
  type DiagnosticSeverity,
  type DiagnosticSource,
} from "@cognia/diagnostics"
import type {
  NotificationInput,
  NotificationLevel,
  NotificationSource,
} from "@/types/notifications"

import { toNotificationActions } from "./actions"
import { diagnosticDedupeKey, type DiagnosticOrigin } from "./surface-router"

/** `fatal` maps to `critical`, the tier that bypasses DND and per-source mute. */
const LEVEL: Readonly<Record<DiagnosticSeverity, NotificationLevel>> = {
  fatal: "critical",
  error: "error",
  warning: "warning",
  info: "info",
}

/**
 * Total by construction — a new diagnostic source is a compile error here
 * rather than a notification silently filed under the wrong bucket.
 */
const SOURCE: Readonly<Record<DiagnosticSource, NotificationSource>> = {
  chat: "session",
  provider: "session",
  "external-agent": "session",
  execution: "session",
  "agent-team": "agent-team",
  workflow: "workflow",
  scheduler: "scheduler",
  plugin: "plugin",
  connector: "connector",
  inbox: "connector",
  tauri: "system",
  storage: "system",
  settings: "system",
  boundary: "system",
  unknown: "system",
}

export interface DiagnosticNotificationOptions {
  origin?: DiagnosticOrigin
  /** Resolves `diagnostics.code.<code>.label`. */
  resolveTitle: (code: string) => string
  /** Resolves `diagnostics.action.<kind>`. */
  resolveActionLabel: (kind: DiagnosticActionKind) => string
  /** Fold a burst into one row instead of announcing each failure. */
  collapsed?: boolean
  /** Aggregate title for the collapsed case (e.g. "3 problems"). */
  collapsedTitle?: string
}

/**
 * Project a diagnostic onto a notification.
 *
 * `title` and action labels are resolved by the caller because
 * `NotificationRecord` stores display text, not keys — the center renders
 * `action.label` verbatim, so translation has to happen where a translator is
 * in scope.
 */
export function toNotificationInput(
  diag: CogniaDiagnostic,
  opts: DiagnosticNotificationOptions
): NotificationInput {
  const actions = toNotificationActions(diag.actions, opts.resolveActionLabel)
  return {
    source: SOURCE[diag.source],
    level: LEVEL[diag.severity],
    title:
      opts.collapsed && opts.collapsedTitle ? opts.collapsedTitle : opts.resolveTitle(diag.code),
    ...(diag.message ? { body: diag.message } : {}),
    dedupeKey: diagnosticDedupeKey(diag, opts.origin),
    // Only failures the user must act on earn the red count; the rest are a dot.
    directed: diag.severity === "fatal" || (diag.severity === "error" && actions.length > 0),
    // The center row persists at most three.
    ...(actions.length > 0 ? { actions: actions.slice(0, 3) } : {}),
    meta: { diagnosticCode: diag.code, diagnosticId: diag.id },
  }
}

/** Every diagnostic source, for the totality test. */
export const DIAGNOSTIC_SOURCE_IDS = DIAGNOSTIC_SOURCES
export { SOURCE as DIAGNOSTIC_SOURCE_TO_NOTIFICATION, LEVEL as DIAGNOSTIC_SEVERITY_TO_LEVEL }
