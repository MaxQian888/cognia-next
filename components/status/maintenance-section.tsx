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
import { CalendarCheck2Icon, CalendarClockIcon, WrenchIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import {
  pickLocalized,
  sortIncidentUpdatesNewestFirst,
  type MaintenanceState,
  type MaintenanceView,
} from "@/lib/status/public-status"

import { IconTile, PanelEmpty, SectionHeading, StatusPanel } from "./status-labels"
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
      <div className="mt-6 space-y-4">
        {windows.length === 0 ? (
          <StatusPanel>
            <PanelEmpty
              icon={CalendarCheck2Icon}
              tone="info"
              title={t("maintenance.empty")}
              description={t("maintenance.emptyDescription")}
            />
          </StatusPanel>
        ) : (
          windows.map((entry) => {
            const latest = sortIncidentUpdatesNewestFirst(entry.updates).find(
              (update) => update.message !== null
            )
            return (
              <StatusPanel
                key={entry.id}
                className="relative before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-sky-500"
              >
                <article
                  className="p-5 sm:p-6"
                  aria-label={pickLocalized(entry.title, locale)}
                  data-testid="maintenance-window"
                >
                  <div className="flex items-start gap-3.5">
                    <IconTile icon={WrenchIcon} tone="info" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="font-semibold tracking-tight">
                          {pickLocalized(entry.title, locale)}
                        </h3>
                        <Badge
                          variant="outline"
                          className="border-sky-500/30 bg-sky-500/10 font-normal text-sky-700 dark:text-sky-300"
                        >
                          {t(`maintenance.states.${entry.state}`)}
                        </Badge>
                      </div>
                      <p className="mt-1.5 text-sm leading-6 whitespace-pre-line text-muted-foreground">
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
                        <p className="mt-3 rounded-xl bg-muted/50 px-3.5 py-2.5 text-sm leading-6 whitespace-pre-line">
                          {pickLocalized(latest.message, locale)}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <div className="mt-4 grid gap-1 rounded-xl border bg-muted/30 px-3.5 py-3 text-xs text-muted-foreground tabular-nums">
                    <span className="font-medium text-foreground" data-testid="maintenance-utc">
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
                      <span className="mt-1">{t("maintenance.excluded")}</span>
                    ) : null}
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
