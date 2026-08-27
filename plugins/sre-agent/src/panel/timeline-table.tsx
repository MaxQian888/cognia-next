"use client"

import { AlertTriangleIcon, CheckCircle2Icon, HelpCircleIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { SreValidationIssue } from "../evidence"
import type { SreIncident } from "../incident/model"
import { usePluginT } from "../use-plugin-t"

/**
 * Which rows a validation issue is about.
 *
 * Issues that name no row (`timeline.empty`, a finding citing a dead id) are
 * NOT dropped — they are the ones a per-row renderer loses, and losing them is
 * how a panel shows an all-green timeline under a failed verdict.
 */
export function groupIssues(issues: readonly SreValidationIssue[]): {
  byRow: Map<number, SreValidationIssue[]>
  general: SreValidationIssue[]
} {
  const byRow = new Map<number, SreValidationIssue[]>()
  const general: SreValidationIssue[] = []
  for (const issue of issues) {
    if (typeof issue.rowIndex !== "number") {
      general.push(issue)
      continue
    }
    const bucket = byRow.get(issue.rowIndex)
    if (bucket) bucket.push(issue)
    else byRow.set(issue.rowIndex, [issue])
  }
  return { byRow, general }
}

/**
 * The drafted timeline with its verdict rendered per row.
 *
 * The validator returns coded issues; the panel shows the code AND its message
 * verbatim rather than translating it. The code is what the agent has to repair
 * against, and paraphrasing it into friendly prose was how a user ended up
 * unable to tell the diagnostician what was actually wrong.
 */
export function TimelineTable({
  incident,
  validating,
  onValidate,
}: {
  incident: SreIncident
  validating: boolean
  onValidate: () => void
}) {
  const t = usePluginT()
  const { byRow, general } = groupIssues(incident.validation?.issues ?? [])
  const validation = incident.validation

  return (
    <section className="space-y-2" data-testid="sre-timeline">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium">{t("timeline.title")}</h3>
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-xs"
          disabled={incident.timeline.length === 0 || validating}
          onClick={onValidate}
          data-testid="sre-timeline-validate"
        >
          {t("timeline.validate")}
        </Button>
      </div>

      {incident.timeline.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="sre-timeline-empty">
          {t("timeline.empty")}
        </p>
      ) : (
        <>
          <div
            className={cn(
              "flex items-center gap-1.5 text-xs",
              !validation && "text-muted-foreground",
              validation?.ok && "text-green-700 dark:text-green-500",
              validation && !validation.ok && "text-destructive"
            )}
            data-testid="sre-timeline-verdict"
          >
            {!validation ? <HelpCircleIcon className="size-3.5" /> : null}
            {validation?.ok ? <CheckCircle2Icon className="size-3.5" /> : null}
            {validation && !validation.ok ? <AlertTriangleIcon className="size-3.5" /> : null}
            <span>
              {!validation
                ? t("timeline.unchecked")
                : validation.ok
                  ? t("timeline.ok")
                  : t("timeline.failed", { count: validation.issues.length })}
            </span>
          </div>

          <ul className="divide-y">
            {incident.timeline.map((row, index) => {
              const issues = byRow.get(index) ?? []
              return (
                <li key={`${row.time}-${index}`} className="py-1.5" data-testid="sre-timeline-row">
                  <div className="flex items-baseline gap-2">
                    <span className="w-16 shrink-0 font-mono text-xs text-muted-foreground">
                      {row.time}
                    </span>
                    <span className="w-16 shrink-0 truncate text-xs text-muted-foreground">
                      {row.component}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs">{row.event}</span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      {row.evidenceIds.join(" ")}
                    </span>
                  </div>
                  {issues.map((issue) => (
                    <p
                      key={`${issue.code}-${issue.evidenceId ?? ""}`}
                      className="mt-1 ml-16 text-xs text-destructive"
                      data-testid="sre-timeline-issue"
                    >
                      <span className="font-mono">{issue.code}</span> — {issue.message}
                      {issue.evidenceId ? ` (${issue.evidenceId})` : ""}
                    </p>
                  ))}
                </li>
              )
            })}
          </ul>

          {general.length > 0 ? (
            <div className="space-y-1 pt-1">
              <h4 className="text-xs text-muted-foreground">{t("timeline.issueGeneral")}</h4>
              {general.map((issue) => (
                <p
                  key={`${issue.code}-${issue.evidenceId ?? ""}`}
                  className="text-xs text-destructive"
                  data-testid="sre-timeline-general-issue"
                >
                  <span className="font-mono">{issue.code}</span> — {issue.message}
                  {issue.evidenceId ? ` (${issue.evidenceId})` : ""}
                </p>
              ))}
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}
