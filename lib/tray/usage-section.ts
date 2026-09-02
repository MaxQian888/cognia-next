// The usage submenu in the tray menu. The renderer's `buildTrayPayload` swaps
// the synthetic `tray.usage` placeholder (see `defaults.ts`) for the children
// this module produces.
//
// Layout inside the submenu:
//   - a headline row carrying the current metric over the current period,
//     with a freshness marker when the answer is incomplete,
//   - metric rows (spend / tokens / quota), each pinning what the compact
//     surfaces lead with,
//   - period rows, disabled under the quota metric because a plan window is
//     the provider's, not ours to choose,
//   - scope rows (this app / all tools), where all-tools is what turns on
//     external scanning and therefore never happens implicitly,
//   - one row per configured subscription account showing its compact quota
//     readout. With 2+ accounts the rows are checkable and clicking pins that
//     account to the compact surfaces, and the "Auto" row restores
//     worst-across-all,
//   - "Refresh usage" and "Open subscription settings".
//
// Numeric readouts and user-named account labels are literals, which the
// resilient tray translator passes through unchanged. Static rows use i18n
// keys under `tray.usage.*`.

import {
  formatGlanceMetric,
  PERIOD_LABEL_KEYS,
  UNKNOWN_COST,
} from "@/lib/usage/usage-glance-format"
import {
  USAGE_GLANCE_PERIODS,
  type UsageGlanceMetric,
  type UsageGlancePeriod,
  type UsageGlanceScope,
} from "@/lib/usage/usage-glance"

import { formatAccountLine } from "./usage-format"
import type { TrayDisplayPrefs, TrayMenuItem, TrayUsageSnapshot } from "./types"

/** Command-id prefix the dispatcher intercepts for pin-selection clicks. */
export const USAGE_SELECT_COMMAND_PREFIX = "tray.usage.select:"
/** Command id for the explicit refresh row. */
export const USAGE_REFRESH_COMMAND = "tray.usage.refresh"
/** Command-id prefixes for the three glance dimensions. */
export const USAGE_METRIC_COMMAND_PREFIX = "tray.usage.metric:"
export const USAGE_PERIOD_COMMAND_PREFIX = "tray.usage.period:"
export const USAGE_SCOPE_COMMAND_PREFIX = "tray.usage.scope:"

/**
 * Metrics offered in the menu. `budget` is deliberately absent: it is a
 * derived view of spend against a ceiling the user may not have set, and a
 * menu row that renders a dash for most installs is worse than no row. It
 * remains selectable from Settings, where the ceiling is configured.
 */
export const TRAY_USAGE_METRICS: readonly UsageGlanceMetric[] = ["spend", "tokens", "quota"]

const METRIC_LABEL_KEYS: Record<UsageGlanceMetric, string> = {
  spend: "tray.usage.metric.spend",
  tokens: "tray.usage.metric.tokens",
  quota: "tray.usage.metric.quota",
  budget: "tray.usage.metric.budget",
}

const SCOPE_LABEL_KEYS: Record<UsageGlanceScope, string> = {
  cognia: "tray.usage.scope.cognia",
  "all-tools": "tray.usage.scope.allTools",
}

const FRESHNESS_LABEL_KEYS = {
  fresh: "tray.usage.freshness.fresh",
  stale: "tray.usage.freshness.stale",
  partial: "tray.usage.freshness.partial",
} as const

function radioRow(
  id: string,
  label: string,
  commandId: string,
  checked: boolean,
  disabled = false
): TrayMenuItem {
  return {
    kind: "action",
    id,
    label,
    checked,
    disabled,
    payload: disabled ? { kind: "native", action: "noop" } : { kind: "command", commandId },
  }
}

function infoRow(id: string, label: string): TrayMenuItem {
  return {
    kind: "action",
    id,
    label,
    disabled: true,
    payload: { kind: "native", action: "noop" },
  }
}

/**
 * Build the children of the usage submenu. `now` is injectable for tests, and
 * `display` supplies the three glance dimensions. Callers that predate the
 * spend surfaces pass no `display` and get the historical quota-only menu.
 */
export function buildUsageSection(
  usage: TrayUsageSnapshot,
  now: number = Date.now(),
  display?: Pick<TrayDisplayPrefs, "usageMetric" | "usagePeriod" | "usageScope">
): TrayMenuItem[] {
  const rows: TrayMenuItem[] = []
  const { accounts } = usage
  const selectable = accounts.length > 1
  const metric: UsageGlanceMetric = display?.usageMetric ?? "quota"
  const period: UsageGlancePeriod = display?.usagePeriod ?? "today"
  const scope: UsageGlanceScope = display?.usageScope ?? "cognia"

  // Headline. The projection is absent until a surface that needs it mounts,
  // so a menu opened before the first read shows the loading row rather than a
  // zero that would be indistinguishable from "you spent nothing".
  if (display && metric !== "quota") {
    const headline = usage.glance ? formatGlanceMetric(usage.glance, metric) : null
    rows.push(
      infoRow(
        "tray.usage.headline",
        headline && headline !== UNKNOWN_COST ? headline : "tray.usage.loading"
      )
    )
    if (usage.glance && usage.glance.freshness !== "fresh") {
      rows.push(infoRow("tray.usage.freshness", FRESHNESS_LABEL_KEYS[usage.glance.freshness]))
    }
    rows.push({ kind: "separator", id: "tray.usage.sep-headline" })
  }

  if (display) {
    for (const candidate of TRAY_USAGE_METRICS) {
      rows.push(
        radioRow(
          `tray.usage.metric:${candidate}`,
          METRIC_LABEL_KEYS[candidate],
          `${USAGE_METRIC_COMMAND_PREFIX}${candidate}`,
          metric === candidate
        )
      )
    }
    rows.push({ kind: "separator", id: "tray.usage.sep-metric" })

    for (const candidate of USAGE_GLANCE_PERIODS) {
      rows.push(
        radioRow(
          `tray.usage.period:${candidate}`,
          `tray.usage.period.${PERIOD_LABEL_KEYS[candidate]}`,
          `${USAGE_PERIOD_COMMAND_PREFIX}${candidate}`,
          period === candidate,
          // A plan's window belongs to the provider. Offering to change it
          // under the quota metric would imply a control we do not have.
          metric === "quota"
        )
      )
    }
    rows.push({ kind: "separator", id: "tray.usage.sep-period" })

    for (const candidate of ["cognia", "all-tools"] as const) {
      rows.push(
        radioRow(
          `tray.usage.scope:${candidate}`,
          SCOPE_LABEL_KEYS[candidate],
          `${USAGE_SCOPE_COMMAND_PREFIX}${candidate}`,
          scope === candidate,
          metric === "quota"
        )
      )
    }
    rows.push({ kind: "separator", id: "tray.usage.sep-scope" })
  }

  if (accounts.length === 0) {
    rows.push(infoRow("tray.usage.empty", "tray.usage.empty"))
  }

  for (const account of accounts) {
    rows.push({
      kind: "action",
      id: `tray.usage.account:${account.key}`,
      label: formatAccountLine(account, now),
      disabled: !selectable,
      checked: selectable ? usage.selectedKey === account.key : undefined,
      payload: selectable
        ? { kind: "command", commandId: `${USAGE_SELECT_COMMAND_PREFIX}${account.key}` }
        : { kind: "native", action: "noop" },
    })
  }

  if (selectable) {
    rows.push({
      kind: "action",
      id: "tray.usage.auto",
      label: "tray.usage.auto",
      checked: usage.selectedKey === null,
      payload: { kind: "command", commandId: USAGE_SELECT_COMMAND_PREFIX },
    })
  }

  rows.push({ kind: "separator", id: "tray.usage.sep-0" })
  rows.push({
    kind: "action",
    id: "tray.usage.refresh",
    label: "tray.usage.refresh",
    payload: { kind: "command", commandId: USAGE_REFRESH_COMMAND },
  })
  rows.push({
    kind: "action",
    id: "tray.usage.open-settings",
    label: "tray.usage.openSettings",
    payload: { kind: "native", action: "settings" },
  })

  return rows
}
