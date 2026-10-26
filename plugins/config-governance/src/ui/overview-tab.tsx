"use client"

import { usePluginTranslations } from "@cognia/plugin-sdk/api/i18n"
import { Alert, AlertDescription, Badge, Button } from "@cognia/plugin-ui"

import { PLUGIN_ID } from "../model"
import type { GovernanceRuntime } from "../runtime/runtime"
import { countGroups, GROUPS } from "../runtime/store"
import { act } from "./act"
import { formatDateTime } from "./format"
import type { GovernanceData } from "./use-governance"

export interface OverviewTabProps {
  runtime: GovernanceRuntime
  workspaceId: string | null
  data: GovernanceData
  busy: boolean
}

/** Notes worth telling the user about, as translation keys with their counts. */
export function summarizeNotes(notes: readonly string[]): Array<{ key: string; count: number }> {
  const tally = new Map<string, number>()
  for (const note of notes) {
    const [kind = note, payload] = note.split(":")
    // `*-capped:<n>` carries its own count; every other note counts once.
    const amount = kind.endsWith("-capped") && payload !== undefined ? Number(payload) || 0 : 1
    tally.set(kind, (tally.get(kind) ?? 0) + amount)
  }
  return [...tally.entries()].map(([kind, count]) => ({ key: `notes.${kind}`, count }))
}

export function OverviewTab({ runtime, workspaceId, data, busy }: OverviewTabProps) {
  const t = usePluginTranslations(PLUGIN_ID)
  const locale = t("format.locale")
  const visible = data.findings.filter((finding) => !data.kept.has(finding.id))
  const counts = countGroups(visible)
  const run = data.run

  return (
    <div className="space-y-3 p-3" data-testid="governance-overview">
      <p className="text-xs text-muted-foreground">{t("overview.intro")}</p>
      {data.modelChangedFrom && (
        <Alert data-testid="governance-model-changed">
          <AlertDescription className="text-xs">
            {t("overview.modelChanged", { from: data.modelChangedFrom, to: runtime.targetModel() })}
          </AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => act(runtime.audit(workspaceId), t)}
        >
          {run ? t("overview.reaudit") : t("overview.audit")}
        </Button>
        <span className="text-[11px] text-muted-foreground">{t("overview.auditCost")}</span>
      </div>
      {run ? (
        <>
          <p className="text-xs">
            {t("overview.lastRun", {
              at: formatDateTime(locale, run.finishedAt),
              surfaces: run.surfaces.length,
              model: run.targetModel,
            })}
          </p>
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {GROUPS.map((group) => (
              <li key={group} className="rounded-md border p-2">
                <p className="text-lg font-semibold tabular-nums">{counts[group]}</p>
                <p className="text-[11px] text-muted-foreground">{t(`group.${group}`)}</p>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-muted-foreground">{t("overview.questions")}</p>
          {run.failedSources.length > 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              {t("inventory.failed", { sources: run.failedSources.join(", ") })}
            </p>
          )}
          {summarizeNotes(run.notes).length > 0 && (
            <ul
              className="space-y-0.5 text-[11px] text-muted-foreground"
              data-testid="governance-notes"
            >
              {summarizeNotes(run.notes).map((note) => (
                <li key={note.key}>{t(note.key, { count: note.count })}</li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">{t("overview.never")}</p>
      )}
      {data.history.length > 1 && (
        <section className="space-y-1">
          <h3 className="text-xs font-semibold">{t("overview.history")}</h3>
          <ul className="space-y-0.5">
            {data.history.map((entry) => (
              <li key={entry.runId} className="flex items-center gap-2 text-[11px]">
                <span className="text-muted-foreground">{formatDateTime(locale, entry.at)}</span>
                <Badge variant="outline" className="text-[10px]">
                  {t("overview.historyHigh", { count: entry.high })}
                </Badge>
                <span className="text-muted-foreground">
                  {t("overview.historyTotal", {
                    count: GROUPS.reduce((sum, group) => sum + entry.counts[group], 0),
                  })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
