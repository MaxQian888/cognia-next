"use client"

// Receipt rendered after a successful import. Shows per-table tallies for
// added / overwritten / skipped / built-ins-preserved, plus the optional
// localStorage snapshot report and Tauri-only MCP sync re-projection report.

import { useTranslations } from "next-intl"
import type { ImportSummary as Summary } from "@/lib/data/types"

export function ImportSummary({ summary }: { summary: Summary }) {
  const t = useTranslations("settings.data")
  return (
    <div className="space-y-1 rounded-md border bg-muted/30 p-3 text-xs">
      <p className="mb-1 font-medium">{t("summary")}</p>
      <SummaryGroup label={t("summaryAdded")} map={summary.added} />
      <SummaryGroup label={t("summaryOverwritten")} map={summary.overwritten} />
      <SummaryGroup label={t("summarySkipped")} map={summary.skipped} />
      <SummaryGroup label={t("summaryBuiltIns")} map={summary.builtInsSkipped} />
      {summary.restoredRetrievalKeyProfiles && summary.restoredRetrievalKeyProfiles.length > 0 && (
        <p className="border-t pt-1 text-muted-foreground">
          <span className="font-medium">
            {t("summaryRetrievalKeys", { count: summary.restoredRetrievalKeyProfiles.length })}:
          </span>{" "}
          {summary.restoredRetrievalKeyProfiles.join(", ")}
        </p>
      )}
      <PetConflictRow summary={summary} />
      <LocalStorageReport summary={summary} />
      <SyncProjectionReportRow summary={summary} />
    </div>
  )
}

function SummaryGroup({ label, map }: { label: string; map: Record<string, number> }) {
  const entries = Object.entries(map)
  if (entries.length === 0) return null
  return (
    <p className="text-muted-foreground">
      <span className="font-medium">{label}:</span>{" "}
      {entries.map(([k, v]) => `${k}=${v}`).join(", ")}
    </p>
  )
}

/**
 * The package carried a different pet than the one on this machine.
 *
 * A pet is a singular thing, so the import kept the local one rather than
 * quietly picking. Saying so is the whole point: a silent skip would read as
 * "your pet was restored" when it was not.
 */
function PetConflictRow({ summary }: { summary: Summary }) {
  const t = useTranslations("settings.data")
  const conflict = summary.petProfileConflict
  if (!conflict) return null
  return (
    <p className="border-t pt-1 text-muted-foreground">
      <span className="font-medium">{t("summaryPetConflict")}:</span>{" "}
      {t("summaryPetConflictDetail", {
        localName: conflict.localName ?? t("summaryPetUnnamed"),
        localLevel: conflict.localLevel,
        incomingName: conflict.incomingName ?? t("summaryPetUnnamed"),
        incomingLevel: conflict.incomingLevel,
      })}
    </p>
  )
}

function LocalStorageReport({ summary }: { summary: Summary }) {
  const t = useTranslations("settings.data")
  const ls = summary.localStorage
  if (!ls) return null
  const hasContent =
    ls.written.length > 0 ||
    ls.skipped.length > 0 ||
    ls.errors.length > 0 ||
    (ls.restoredFromPreSnap?.length ?? 0) > 0
  if (!hasContent) return null
  return (
    <div className="space-y-0.5 border-t pt-1">
      <p className="font-medium text-muted-foreground">{t("summaryLocalStorage")}</p>
      {ls.written.length > 0 && (
        <p className="text-muted-foreground">
          <span className="font-medium">
            {t("summaryLsWritten", { count: ls.written.length })}:
          </span>{" "}
          {ls.written.join(", ")}
        </p>
      )}
      {ls.skipped.length > 0 && (
        <p className="text-muted-foreground">
          <span className="font-medium">
            {t("summaryLsSkipped", { count: ls.skipped.length })}:
          </span>{" "}
          {ls.skipped.join(", ")}
        </p>
      )}
      {ls.errors.length > 0 && (
        <p className="text-destructive">
          <span className="font-medium">{t("summaryLsErrors", { count: ls.errors.length })}:</span>{" "}
          {ls.errors.map((e) => `${e.key} (${e.error})`).join("; ")}
        </p>
      )}
      {ls.restoredFromPreSnap && ls.restoredFromPreSnap.length > 0 && (
        <p className="text-muted-foreground">
          <span className="font-medium">{t("summaryLocalStorageRestored")}:</span>{" "}
          {ls.restoredFromPreSnap.join(", ")}
        </p>
      )}
    </div>
  )
}

function SyncProjectionReportRow({ summary }: { summary: Summary }) {
  const t = useTranslations("settings.data")
  const reports = summary.syncResults
  if (!reports || reports.length === 0) return null
  return (
    <div className="space-y-0.5 border-t pt-1">
      <p className="font-medium text-muted-foreground">{t("summarySyncResults")}</p>
      {reports.map((r) => {
        if (r.ok) {
          return (
            <p key={r.agentId} className="text-muted-foreground">
              {t("syncResults.ok", { agentId: r.agentId, count: r.count ?? 0 })}
            </p>
          )
        }
        // The lib/data layer uses `reason` for both skips and hard failures —
        // surface them with the same compact line; keeping them grouped keeps
        // the receipt scannable.
        return (
          <p key={r.agentId} className="text-destructive">
            {t("syncResults.failed", { agentId: r.agentId, reason: r.reason ?? "unknown" })}
          </p>
        )
      })}
    </div>
  )
}
