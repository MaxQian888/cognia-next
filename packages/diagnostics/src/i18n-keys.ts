/**
 * The `code`/`kind`/`source` → i18n key contract.
 *
 * Kept here, next to the vocabulary, rather than inlined in each renderer:
 * the message files are gated by a parity test that has to derive the exact
 * same keys, and two independent transliterations would drift silently.
 *
 * Codes are already camelCase and used verbatim. Action kinds and sources are
 * kebab-case in the type (they read better as discriminants) and camelCase as
 * keys, matching every other namespace in `i18n/messages/`.
 */

import type { DiagnosticActionKind, DiagnosticSeverity, DiagnosticSource } from "./types"

/** Every action kind, in the order the i18n file lists them. */
export const DIAGNOSTIC_ACTION_KINDS: readonly DiagnosticActionKind[] = [
  "retry",
  "wait-and-retry",
  "retry-fallback-provider",
  "retry-when-online",
  "switch-to-builtin",
  "open-settings",
  "reauth",
  "restart-sidecar",
  "reconnect-adapter",
  "reconnect-external-agent",
  "copy-install-command",
  "locate-binary",
  "shorten-input",
  "view-logs",
  "jump-to-node",
  "open-external",
  "export-crash-log",
  "copy-report",
  "report-issue",
  "reload-app",
  "reset-boundary",
  "dismiss",
]

export const DIAGNOSTIC_SOURCES: readonly DiagnosticSource[] = [
  "chat",
  "agent-team",
  "external-agent",
  "provider",
  "plugin",
  "workflow",
  "scheduler",
  "inbox",
  "connector",
  "tauri",
  "storage",
  "settings",
  "boundary",
  "execution",
  "unknown",
]

export const DIAGNOSTIC_SEVERITIES: readonly DiagnosticSeverity[] = [
  "fatal",
  "error",
  "warning",
  "info",
]

/** `wait-and-retry` → `waitAndRetry`. */
function camelize(value: string): string {
  return value.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase())
}

/** i18n key for an action's button label, under the `action.` sub-namespace. */
export function actionI18nKey(kind: DiagnosticActionKind): string {
  return camelize(kind)
}

/** i18n key for a source's display name, under the `source.` sub-namespace. */
export function sourceI18nKey(source: DiagnosticSource): string {
  return camelize(source)
}
