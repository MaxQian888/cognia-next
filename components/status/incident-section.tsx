"use client"

/**
 * Active incidents and the incident history.
 *
 * Incident text is operator-authored (or written by automated reconciliation)
 * and arrives from the API in both languages; it is picked with
 * `pickLocalized` and rendered as plain text, never as generated translation
 * keys. Every incident links to its detail view, which the page keeps in the
 * `?incident=` query so it can be shared and reloaded.
 */

import { useLocale, useTranslations } from "next-intl"
import { CheckCircle2Icon, Clock3Icon, HistoryIcon, RadioTowerIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { IncidentPagesState } from "@/hooks/status/use-incident-pages"
import {
  parseIsoMs,
  pickLocalized,
  type IncidentImpact,
  type IncidentSummary,
} from "@/lib/status/public-status"

import { cn } from "@/lib/utils"

import { PanelEmpty, SectionHeading, StatusLabel, StatusPanel } from "./status-labels"
import { formatList, formatUtcDate, formatUtcDateTime } from "./status-format"

function useComponentList() {
  const t = useTranslations("publicStatus")
  const locale = useLocale()
  return (ids: readonly string[]) =>
    formatList(
      ids.map((id) => t(`components.${id}.name`)),
      locale
    )
}

/** Left accent per impact, matching the status colours. */
const IMPACT_ACCENT: Record<IncidentImpact, string> = {
  degraded: "before:bg-amber-500",
  partial_outage: "before:bg-orange-500",
  major_outage: "before:bg-rose-600",
}

export function ActiveIncidents({
  incidents,
  onOpen,
}: {
  incidents: readonly IncidentSummary[]
  onOpen: (id: string) => void
}) {
  const t = useTranslations("publicStatus")
  const locale = useLocale()
  const components = useComponentList()

  return (
    <div>
      <SectionHeading
        id="active-incidents-title"
        icon={RadioTowerIcon}
        title={t("incidents.activeTitle")}
      />
      <div className="mt-6 space-y-4">
        {incidents.length === 0 ? (
          <StatusPanel>
            <PanelEmpty
              icon={CheckCircle2Icon}
              tone="success"
              title={t("incidents.activeEmpty")}
              description={t("incidents.activeEmptyDescription")}
            />
          </StatusPanel>
        ) : (
          incidents.map((incident) => {
            const title = pickLocalized(incident.title, locale)
            return (
              <StatusPanel
                key={incident.id}
                className={cn(
                  "relative before:absolute before:inset-y-0 before:left-0 before:w-1",
                  IMPACT_ACCENT[incident.impact]
                )}
              >
                <article aria-label={title} className="p-5 sm:p-6" data-testid="active-incident">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusLabel status={incident.impact} pill />
                    <Badge variant="outline" className="font-normal">
                      {t(`incidentStates.${incident.state}`)}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {t(`incidents.source.${incident.source}`)}
                    </span>
                  </div>
                  <h3 className="mt-3 text-lg font-semibold tracking-tight text-balance">
                    {title}
                  </h3>
                  {incident.componentIds.length > 0 ? (
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t("incidents.components", { components: components(incident.componentIds) })}
                    </p>
                  ) : null}
                  {incident.latestUpdate ? (
                    <div className="mt-4 rounded-xl bg-muted/50 px-4 py-3">
                      <p className="text-xs font-medium text-muted-foreground">
                        {t("incidents.latestUpdate")} ·{" "}
                        <time dateTime={incident.latestUpdate.at} className="tabular-nums">
                          {formatUtcDateTime(incident.latestUpdate.at, locale)}
                        </time>
                      </p>
                      <p className="mt-1.5 text-sm leading-6 whitespace-pre-line">
                        {pickLocalized(incident.latestUpdate.message, locale)}
                      </p>
                    </div>
                  ) : null}
                  <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
                    <p className="grid gap-0.5 text-xs text-muted-foreground tabular-nums">
                      <span>
                        {t("incidents.startedAt", {
                          time: formatUtcDateTime(incident.startedAt, locale),
                        })}
                      </span>
                      <span>
                        {t("incidents.updatedAt", {
                          time: formatUtcDateTime(incident.updatedAt, locale),
                        })}
                      </span>
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onOpen(incident.id)}
                      aria-label={t("incidents.viewDetailsFor", { title })}
                    >
                      {t("incidents.viewDetails")}
                    </Button>
                  </div>
                </article>
              </StatusPanel>
            )
          })
        )}
      </div>
    </div>
  )
}

function durationMinutes(incident: IncidentSummary): number | null {
  if (!incident.resolvedAt) return null
  const start = parseIsoMs(incident.startedAt)
  const end = parseIsoMs(incident.resolvedAt)
  if (start === null || end === null || end < start) return null
  return Math.round((end - start) / 60_000)
}

export function PastIncidents({
  pages,
  onOpen,
}: {
  pages: IncidentPagesState
  onOpen: (id: string) => void
}) {
  const t = useTranslations("publicStatus")
  const locale = useLocale()
  const components = useComponentList()

  return (
    <section
      id="history"
      aria-labelledby="past-incidents-title"
      className="scroll-mt-24 pb-12 md:pb-16"
    >
      <SectionHeading
        id="past-incidents-title"
        icon={Clock3Icon}
        title={t("incidents.pastTitle")}
      />
      <StatusPanel className="mt-6">
        {pages.incidents.length === 0 ? (
          <PanelEmpty
            icon={HistoryIcon}
            title={t("incidents.pastEmpty")}
            description={t("incidents.pastEmptyDescription")}
          />
        ) : (
          <ul className="divide-y">
            {pages.incidents.map((incident) => {
              const title = pickLocalized(incident.title, locale)
              const minutes = durationMinutes(incident)
              return (
                <li
                  key={incident.id}
                  className="grid gap-2 p-5 transition-colors hover:bg-muted/30 sm:grid-cols-[8.5rem_1fr_auto] sm:items-start sm:gap-4 sm:px-6"
                  data-testid="past-incident"
                >
                  <time
                    dateTime={incident.startedAt}
                    className="text-xs text-muted-foreground tabular-nums sm:pt-0.5"
                  >
                    {formatUtcDate(incident.startedAt, locale)}
                  </time>
                  <div className="min-w-0">
                    <button
                      type="button"
                      className="rounded-sm text-left font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => onOpen(incident.id)}
                      aria-label={t("incidents.viewDetailsFor", { title })}
                    >
                      {title}
                    </button>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t(`impacts.${incident.impact}`)}
                      {incident.componentIds.length > 0
                        ? ` · ${components(incident.componentIds)}`
                        : null}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                    <Badge variant="outline" className="font-normal">
                      {t(`incidentStates.${incident.state}`)}
                    </Badge>
                    {minutes !== null ? (
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {t("incidents.duration", { minutes })}
                      </span>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        )}

        {/* Nothing to page through and nothing to report: the empty state
            already says there is no history. */}
        <div
          className={cn(
            "flex flex-wrap items-center gap-3 border-t bg-muted/30 px-5 py-3.5 text-sm sm:px-6",
            pages.incidents.length === 0 && !pages.hasMore && !pages.error && "sr-only"
          )}
          aria-live="polite"
        >
          {pages.hasMore ? (
            <Button variant="outline" size="sm" onClick={pages.loadMore} disabled={pages.loading}>
              {pages.loading
                ? t("incidents.loadingMore")
                : // The snapshot only carries recent history; older pages may
                  // still exist, so an empty list asks rather than "loads more".
                  pages.incidents.length === 0
                  ? t("incidents.loadOlder")
                  : t("incidents.loadMore")}
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground" data-testid="incidents-exhausted">
              {t("incidents.noMore")}
            </span>
          )}
          {pages.error ? (
            <span role="alert" className="text-rose-700 dark:text-rose-300">
              {t("incidents.loadMoreError")}
            </span>
          ) : null}
        </div>
      </StatusPanel>
    </section>
  )
}
