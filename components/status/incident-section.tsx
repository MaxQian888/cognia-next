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
import { Clock3Icon, RadioTowerIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { IncidentPagesState } from "@/hooks/status/use-incident-pages"
import { parseIsoMs, pickLocalized, type IncidentSummary } from "@/lib/status/public-status"

import { SectionHeading, StatusLabel } from "./status-labels"
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
      <div className="mt-8">
        {incidents.length === 0 ? (
          <p className="border-y py-8 text-sm text-muted-foreground">
            {t("incidents.activeEmpty")}
          </p>
        ) : (
          incidents.map((incident) => {
            const title = pickLocalized(incident.title, locale)
            return (
              <article
                key={incident.id}
                aria-label={title}
                className="border-y py-5 sm:py-6"
                data-testid="active-incident"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
                  <StatusLabel status={incident.impact} />
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="outline" className="font-normal">
                    {t(`incidentStates.${incident.state}`)}
                  </Badge>
                  <span>{t(`incidents.source.${incident.source}`)}</span>
                </div>
                {incident.componentIds.length > 0 ? (
                  <p className="mt-2 text-sm text-muted-foreground">
                    {t("incidents.components", { components: components(incident.componentIds) })}
                  </p>
                ) : null}
                {incident.latestUpdate ? (
                  <div className="mt-4 border-l-2 pl-4">
                    <p className="text-xs font-medium text-muted-foreground">
                      {t("incidents.latestUpdate")} ·{" "}
                      <time dateTime={incident.latestUpdate.at} className="font-mono tabular-nums">
                        {formatUtcDateTime(incident.latestUpdate.at, locale)}
                      </time>
                    </p>
                    <p className="mt-1 text-sm leading-6 whitespace-pre-line">
                      {pickLocalized(incident.latestUpdate.message, locale)}
                    </p>
                  </div>
                ) : null}
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                  <p className="grid gap-0.5 font-mono text-xs text-muted-foreground tabular-nums">
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
      className="scroll-mt-24 py-14 md:py-20"
    >
      <SectionHeading
        id="past-incidents-title"
        icon={Clock3Icon}
        title={t("incidents.pastTitle")}
      />
      {pages.incidents.length === 0 ? (
        <p className="mt-8 border-y py-8 text-sm text-muted-foreground">
          {t("incidents.pastEmpty")}
        </p>
      ) : (
        <ul className="mt-8 divide-y border-y">
          {pages.incidents.map((incident) => {
            const title = pickLocalized(incident.title, locale)
            const minutes = durationMinutes(incident)
            return (
              <li
                key={incident.id}
                className="grid gap-3 py-5 sm:grid-cols-[9rem_1fr_auto] sm:items-start sm:py-6"
                data-testid="past-incident"
              >
                <time
                  dateTime={incident.startedAt}
                  className="font-mono text-xs text-muted-foreground tabular-nums"
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
                    <span className="font-mono text-xs text-muted-foreground tabular-nums">
                      {t("incidents.duration", { minutes })}
                    </span>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3 text-sm" aria-live="polite">
        {pages.hasMore ? (
          <Button variant="outline" size="sm" onClick={pages.loadMore} disabled={pages.loading}>
            {pages.loading ? t("incidents.loadingMore") : t("incidents.loadMore")}
          </Button>
        ) : (
          <span className="text-muted-foreground" data-testid="incidents-exhausted">
            {t("incidents.noMore")}
          </span>
        )}
        {pages.error ? (
          <span role="alert" className="text-rose-700 dark:text-rose-300">
            {t("incidents.loadMoreError")}
          </span>
        ) : null}
      </div>
    </section>
  )
}
