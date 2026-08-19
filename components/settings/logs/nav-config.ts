/**
 * Panels of the Settings → Observability → Logs master/detail pane.
 *
 * Replaces a five-tab strip (`Levels / Transports / PostHog / Advanced /
 * Retention`) that sat below two unrelated cards, with `Advanced` acting as the
 * drawer for everything the other four had no home for: behaviour telemetry,
 * redaction, the remote retry queue and module sampling all shared one tab.
 *
 * The grouping here is by *what the setting does to a log line* — where it is
 * captured, what survives the filters, and where it ends up — so a setting's
 * location is derivable rather than historical. Deliberately mirrors
 * `../gateway/nav-config.ts` and `../external-bridge/nav-config.ts`; the three
 * sections share a shell and any divergence would read as a bug.
 */

import {
  ActivityIcon,
  DatabaseIcon,
  FilterIcon,
  ListFilterIcon,
  RadioIcon,
  ShieldIcon,
} from "lucide-react"

import { panelIdSet, resolvePanelId } from "@/components/settings/common/resolve-panel-id"
import type {
  SettingsNavGroup,
  SettingsNavItem,
} from "@/components/settings/common/settings-panel-nav"

export type LogsPanelId =
  "overview" | "levels" | "filters" | "transports" | "telemetry" | "retention"

export type LogsNavGroupId = "statusGroup" | "captureGroup" | "deliveryGroup"

export type LogsNavItem = SettingsNavItem<LogsPanelId>

export type LogsNavGroup = SettingsNavGroup<LogsPanelId, LogsNavGroupId>

export const LOGS_NAV_GROUPS: readonly LogsNavGroup[] = [
  {
    id: "statusGroup",
    items: [{ id: "overview", icon: ActivityIcon }],
  },
  {
    id: "captureGroup",
    items: [
      { id: "levels", icon: ListFilterIcon },
      { id: "filters", icon: FilterIcon },
    ],
  },
  {
    id: "deliveryGroup",
    items: [
      { id: "transports", icon: RadioIcon },
      { id: "telemetry", icon: ShieldIcon },
      { id: "retention", icon: DatabaseIcon },
    ],
  },
]

export const LOGS_NAV_ITEMS: readonly LogsNavItem[] = LOGS_NAV_GROUPS.flatMap(
  (group) => group.items
)

const PANEL_IDS = panelIdSet(LOGS_NAV_ITEMS)

export const LOGS_PANEL_PARAM = "logsPanel"

export const DEFAULT_LOGS_PANEL: LogsPanelId = "overview"

/** Narrow an untrusted deep-link value, falling back to the overview panel. */
export function resolveLogsPanel(raw: string | null | undefined): LogsPanelId {
  return resolvePanelId(raw, PANEL_IDS, DEFAULT_LOGS_PANEL)
}
