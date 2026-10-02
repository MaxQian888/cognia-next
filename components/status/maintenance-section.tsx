"use client"

/**
 * Scheduled, in-progress and awaiting-confirmation maintenance windows.
 *
 * Windows are minute-aligned UTC `[startsAt, endsAt)`; the page shows the UTC
 * window and the same window in the reader's own time zone. Completed and
 * cancelled windows are history, not plans, and are left out. Operator text
 * comes from the API in both languages and is rendered as plain text.
 */

import { useLocale, useTranslations } from "next-intl"
import { CalendarClockIcon, WrenchIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import {
  pickLocalized,
  sortIncidentUpdatesNewestFirst,
  type MaintenanceState,
  type MaintenanceView,
} from "@/lib/status/public-status"

import { SectionHeading } from "./status-labels"
import { formatList, formatLocalDateTime, formatUtcDateTimeBare } from "./status-format"

export const VISIBLE_MAINTENANCE_STATES: readonly MaintenanceState[] = [
  "in_progress",
  "awaiting_confirmation",
  "scheduled",
]

export function visibleMaintenance(windows: readonly MaintenanceView[]): MaintenanceView[] {
  return windows
    .filter((entry) => VISIBLE_MAINTENANCE_STATES.includes(entry.state))
    .sort((left, right) => {
      const byState =
        VISIBLE_MAINTENANCE_STATES.indexOf(left.state) -
        VISIBLE_MAINTENANCE_STATES.indexOf(right.state)
      return byState !== 0 ? byState : left.startsAt.localeCompare(right.startsAt)
    })
}

export function MaintenanceSection({ maintenance }: { maintenance: readonly MaintenanceView[] }) {
  const t = useTranslations("publicStatus")
  const locale = useLocale()
  const windows = visibleMaintenance(maintenance)
  const components = (ids: readonly string[]) =>
    formatList(
      ids.map((id) => t(`components.${id}.name`)),
      locale
    )

  return (
    <div>
      <SectionHeading
        id="maintenance-title"
        icon={CalendarClockIcon}
        title={t("maintenance.title")}
      />
      <div className="mt-8">
        {windows.length === 0 ? (
          <p className="border-y py-8 text-sm text-muted-foreground">{t("maintenance.empty")}</p>
        ) : (
          windows.map((entry) => {
            const latest = sortIncidentUpdatesNewestFirst(entry.updates).find(
              (update) => update.message !== null
            )
            return (
              <article
                key={entry.id}
                className="border-y py-6"
                aria-label={pickLocalized(entry.title, locale)}
                data-testid="maintenance-window"
              >
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 text-sky-700 dark:text-sky-300">
                    <WrenchIcon className="size-4" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="font-medium">{pickLocalized(entry.title, locale)}</h3>
                      <Badge variant="outline" className="font-normal">
                        {t(`maintenance.states.${entry.state}`)}
                      </Badge>
                    </div>
                    <p className="mt-2 text-sm leading-6 whitespace-pre-line text-muted-foreground">
                      {pickLocalized(entry.description, locale)}
                    </p>
                    {entry.componentIds.length > 0 ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        {t("maintenance.components", {
                          components: components(entry.componentIds),
                        })}
                      </p>
                    ) : null}
                    {latest?.message ? (
                      <p className="mt-2 text-sm leading-6 whitespace-pre-line">
                        {pickLocalized(latest.message, locale)}
                      </p>
                    ) : null}
                  </div>
                </div>
                <div className="mt-5 grid gap-1 border-t pt-4 font-mono text-xs text-muted-foreground tabular-nums">
                  <span data-testid="maintenance-utc">
                    {t("maintenance.utcWindow", {
                      start: formatUtcDateTimeBare(entry.startsAt, locale),
                      end: formatUtcDateTimeBare(entry.endsAt, locale),
                    })}
                  </span>
                  <span>
                    {t("maintenance.localWindow", {
                      start: formatLocalDateTime(entry.startsAt, locale),
                      end: formatLocalDateTime(entry.endsAt, locale),
                    })}
                  </span>
                  {entry.excludeFromAvailability ? (
                    <span className="font-sans">{t("maintenance.excluded")}</span>
                  ) : null}
                </div>
              </article>
            )
          })
        )}
      </div>
    </div>
  )
}
