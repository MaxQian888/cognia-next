// Subscription-quota section for the tray menu. The renderer's
// `buildTrayPayload` swaps the synthetic `tray.usage` submenu placeholder
// (see `defaults.ts`) for the children this module produces.
//
// Layout inside the submenu:
//   - one row per configured subscription account showing its compact
//     readout ("Claude Pro · 42% · 1h05m"). With 2+ accounts the rows are
//     checkable and clicking pins that account to the compact surfaces
//     (icon badge / title / tooltip); the extra "Auto" row restores
//     worst-across-all. A single account needs no selection UI, so its row
//     is a plain disabled info line.
//   - "Refresh usage" — funnels through the dispatcher to
//     `requestTrayUsageRefresh` (`lib/tray/usage.ts`).
//   - "Open subscription settings" — the `settings` native action (brings
//     the window to front and opens Settings, same as the tray Settings row).
//
// Account-line labels are literals (numbers + user-named account labels);
// the resilient tray translator passes them through unchanged. Static rows
// use i18n keys under `tray.usage.*`.

import { formatAccountLine } from "./usage-format"
import type { TrayMenuItem, TrayUsageSnapshot } from "./types"

/** Command-id prefix the dispatcher intercepts for pin-selection clicks. */
export const USAGE_SELECT_COMMAND_PREFIX = "tray.usage.select:"
/** Command id for the explicit refresh row. */
export const USAGE_REFRESH_COMMAND = "tray.usage.refresh"

/**
 * Build the children of the usage submenu. `now` is injectable for tests;
 * production callers use the wall clock for the reset countdowns.
 */
export function buildUsageSection(
  usage: TrayUsageSnapshot,
  now: number = Date.now()
): TrayMenuItem[] {
  const rows: TrayMenuItem[] = []
  const { accounts } = usage
  const selectable = accounts.length > 1

  if (accounts.length === 0) {
    rows.push({
      kind: "action",
      id: "tray.usage.empty",
      label: "tray.usage.empty",
      disabled: true,
      payload: { kind: "native", action: "noop" },
    })
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
