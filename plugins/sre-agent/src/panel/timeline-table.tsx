"use client"

import { useState } from "react"
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  HelpCircleIcon,
} from "lucide-react"
import { Button } from "@cognia/plugin-ui"
import { cn } from "@cognia/plugin-ui"
import type { SreValidationIssue } from "../evidence"
import type { SreIncident } from "../incident/model"
import { usePluginTranslations, type PluginTranslate } from "@cognia/plugin-sdk/api/i18n"
import { PLUGIN_ID } from "../ids"
import { TOUCH_BUTTON } from "./touch"

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
 * One issue, in the reader's language.
 *
 * The code stays visible in monospace — it is what the diagnostician repairs
 * against, and a paraphrase alone left users unable to tell it what was wrong
 * — but the sentence next to it is `validation.<code>` from the plugin bundle,
 * never the validator's English `message`.
 */
function IssueLine({
  issue,
  t,
  testId,
  className,
}: {
  issue: SreValidationIssue
  t: PluginTranslate
  testId: string
  className?: string
}) {
  const params = { ...issue.params, evidenceId: issue.evidenceId ?? "" }
  const key = `validation.${issue.code}`
  const translated = t(key, params)
  return (
    <p className={cn("text-xs text-destructive", className)} data-testid={testId}>
      <span className="font-mono">{issue.code}</span> —{" "}
      {translated === key ? t("validation.unknown", { code: issue.code }) : translated}
    </p>
  )
}

/**
 * The drafted timeline with its verdict rendered per row.
 *
 * Rows collapse to one line (time, component, event) and expand to the full
 * text — event, signals, notes, confidence and every cited evidence id — so
 * nothing is only reachable through a hover tooltip on a touch screen.
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
  const t = usePluginTranslations(PLUGIN_ID)
  const { byRow, general } = groupIssues(incident.validation?.issues ?? [])
  const validation = incident.validation
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set())

  const toggle = (index: number) =>
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })

  return (
    <section className="space-y-2" data-testid="sre-timeline">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium">{t("timeline.title")}</h3>
        <Button
          variant="outline"
          size="sm"
          className={TOUCH_BUTTON}
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
              validation?.ok && "text-success",
              validation && !validation.ok && "text-destructive"
            )}
            data-testid="sre-timeline-verdict"
          >
            {!validation ? <HelpCircleIcon aria-hidden className="size-3.5" /> : null}
            {validation?.ok ? <CheckCircle2Icon aria-hidden className="size-3.5" /> : null}
            {validation && !validation.ok ? (
              <AlertTriangleIcon aria-hidden className="size-3.5" />
            ) : null}
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
              const open = expanded.has(index)
              const detailsId = `sre-timeline-row-${incident.id}-${index}`
              return (
                <li key={`${row.time}-${index}`} className="py-1" data-testid="sre-timeline-row">
                  <button
                    type="button"
                    className="flex min-h-9 w-full items-baseline gap-2 rounded-sm py-1 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:min-h-0 [@media(hover:hover)]:hover:bg-muted/50"
                    aria-expanded={open}
                    aria-controls={detailsId}
                    aria-label={open ? t("timeline.hideDetails") : t("timeline.showDetails")}
                    onClick={() => toggle(index)}
                    data-testid="sre-timeline-row-toggle"
                  >
                    {open ? (
                      <ChevronDownIcon aria-hidden className="size-3 shrink-0 self-center" />
                    ) : (
                      <ChevronRightIcon aria-hidden className="size-3 shrink-0 self-center" />
                    )}
                    <span className="w-16 shrink-0 font-mono text-xs text-muted-foreground">
                      {row.time}
                    </span>
                    <span
                      className={cn(
                        "w-16 shrink-0 text-xs text-muted-foreground",
                        open ? "break-words" : "truncate"
                      )}
                    >
                      {row.component}
                    </span>
                    <span
                      className={cn("min-w-0 flex-1 text-xs", open ? "break-words" : "truncate")}
                    >
                      {row.event}
                    </span>
                  </button>
                  {open ? (
                    <dl
                      id={detailsId}
                      className="mt-1 ml-5 space-y-1 text-xs break-words"
                      data-testid="sre-timeline-row-details"
                    >
                      {row.signals.length > 0 ? (
                        <div>
                          <dt className="text-muted-foreground">{t("timeline.signals")}</dt>
                          <dd>{row.signals.join(" · ")}</dd>
                        </div>
                      ) : null}
                      {row.notes ? (
                        <div>
                          <dt className="text-muted-foreground">{t("timeline.notes")}</dt>
                          <dd className="whitespace-pre-wrap">{row.notes}</dd>
                        </div>
                      ) : null}
                      <div>
                        <dt className="text-muted-foreground">{t("timeline.evidence")}</dt>
                        <dd className="font-mono break-all">{row.evidenceIds.join(" ")}</dd>
                      </div>
                      <div className="text-muted-foreground">
                        {t("timeline.confidence", { value: row.confidence.toFixed(2) })}
                      </div>
                    </dl>
                  ) : null}
                  {issues.map((issue) => (
                    <IssueLine
                      key={`${issue.code}-${issue.evidenceId ?? ""}-${issue.params?.value ?? ""}`}
                      issue={issue}
                      t={t}
                      className="mt-1 ml-5"
                      testId="sre-timeline-issue"
                    />
                  ))}
                </li>
              )
            })}
          </ul>

          {general.length > 0 ? (
            <div className="space-y-1 pt-1">
              <h4 className="text-xs text-muted-foreground">{t("timeline.issueGeneral")}</h4>
              {general.map((issue) => (
                <IssueLine
                  key={`${issue.code}-${issue.evidenceId ?? ""}`}
                  issue={issue}
                  t={t}
                  testId="sre-timeline-general-issue"
                />
              ))}
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}
