"use client"

/**
 * One monitored component: what its check proves, its current status and
 * confidence, its history for the selected range, and on demand the latency,
 * phase definition and per-observer evidence behind it.
 */

import { useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import { ChevronDownIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import type { ComponentSnapshot, HistoryRange, ProbeSummary } from "@/lib/status/public-status"
import { cn } from "@/lib/utils"

import { EvidenceList } from "./evidence-list"
import { HistoryStrip } from "./history-strip"
import { LatencyPanel } from "./latency-panel"
import { ConfidenceBadge, StatusLabel, usePercentLabel } from "./status-labels"
import { formatUtcDateTime } from "./status-format"

export function ComponentRow({
  component,
  range,
  probes,
  stale,
  isLast,
}: {
  component: ComponentSnapshot
  /** The range the snapshot (and so this history) was generated for. */
  range: HistoryRange
  probes: readonly ProbeSummary[]
  /** The snapshot is no longer current: statuses lose their colour. */
  stale: boolean
  isLast: boolean
}) {
  const t = useTranslations("publicStatus")
  const locale = useLocale()
  const percent = usePercentLabel()
  const [open, setOpen] = useState(false)
  const name = t(`components.${component.id}.name`)
  const availability = component.availability

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn("border-t", isLast && "border-b")}
      data-testid={`component-row-${component.id}`}
    >
      <article aria-labelledby={`component-${component.id}-name`} className="p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <h3 id={`component-${component.id}-name`} className="font-medium tracking-tight">
              {name}
            </h3>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              {t(`components.${component.id}.description`)}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <StatusLabel status={component.status} stale={stale} />
            <ConfidenceBadge confidence={component.confidence} />
            {component.inMaintenance ? (
              <Badge variant="outline" className="font-normal text-sky-700 dark:text-sky-300">
                {t("statuses.maintenance")}
              </Badge>
            ) : null}
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t(open ? "details.hide" : "details.show", { component: name })}
              >
                <ChevronDownIcon
                  className={cn(
                    "transition-transform duration-200 motion-reduce:transition-none",
                    open && "rotate-180"
                  )}
                  aria-hidden
                />
              </Button>
            </CollapsibleTrigger>
          </div>
        </div>

        <div className="mt-5">
          <HistoryStrip buckets={component.history} range={range} name={name} />
          <div className="mt-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="font-mono tabular-nums" data-testid="component-availability">
              {t("history.summary", {
                availability: percent(availability.observedAvailability),
                coverage: percent(availability.coverage),
              })}
            </span>
            <span className="font-mono tabular-nums">
              {component.latestEvidenceAt
                ? t("details.latestEvidence", {
                    time: formatUtcDateTime(component.latestEvidenceAt, locale),
                  })
                : t("details.noEvidenceYet")}
            </span>
          </div>
        </div>
      </article>

      <CollapsibleContent>
        <div className="grid gap-8 border-t bg-muted/15 p-4 sm:p-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(16rem,1fr)]">
          <div className="min-w-0 space-y-6">
            <div>
              <h4 className="text-sm font-medium">{t("details.phaseTitle")}</h4>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {t(`components.${component.id}.phase`)}
              </p>
            </div>
            <LatencyPanel latency={component.latency} componentName={name} />
          </div>
          <div className="min-w-0">
            <h4 className="mb-3 text-sm font-medium">{t("details.evidenceTitle")}</h4>
            <EvidenceList evidence={component.evidence} probes={probes} />
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
