import type { useTranslations } from "next-intl"

/**
 * Humanize an `AuditKind` enum for display. The connector audit log persists
 * machine-readable dotted kinds (`delivery.success`, `inbound.policy_blocked`,
 * `adapter.heartbeat`, …). Both the Overview "recent activity" card and the
 * Audit tab used to render the raw enum; this resolves a translated label
 * from the `settings.connections.audit.kind` namespace instead.
 *
 * The kind strings contain dots, which next-intl treats as nested-path
 * separators — so `kind.delivery.success` lives as nested objects in the
 * message files and `tKind("delivery.success")` navigates into them.
 *
 * Unmapped kinds (a future enum value shipped before its translation) fall
 * back to the raw string via `tKind.has` so a missing key never throws — the
 * repo's recurring missing-key crash class.
 */
export type AuditKindTranslator = ReturnType<typeof useTranslations>

export function auditKindLabel(tKind: AuditKindTranslator, kind: string): string {
  return tKind.has(kind) ? tKind(kind) : kind
}
