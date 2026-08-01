"use client"

/**
 * Renders one zone of the status bar from the user's resolved layout.
 *
 * The bar used to hardcode its segments in JSX and gate three of them on
 * boolean flags. Both the order and the visibility are user data now
 * (`AppSettings.statusBarLayout`, see `@/types/shell/bars`), so the bar hands
 * this component the items for a zone and the switch below maps each id to its
 * component. Adding a segment means one catalog entry plus one case here.
 */

import type { BarCatalogItem } from "@/lib/shell/bar-items"
import { AccountBarButton } from "@/components/account/account-bar-button"
import { AttentionPanel } from "@/components/attention/attention-panel"
import { JobCenterPanel } from "@/components/desktop/job-center-panel"
import { StatusBarConnectivity } from "@/components/desktop/status-bar-connectivity"
import { StatusBarPerf } from "@/components/desktop/status-bar-perf"
import { StatusBarRunState } from "@/components/desktop/status-bar-run-state"
import { StatusBarSync } from "@/components/desktop/status-bar-sync"
import { StatusBarTerminal } from "@/components/desktop/status-bar-terminal"
import { StatusBarUsage } from "@/components/desktop/status-bar-usage"
import { NotificationBell } from "@/components/notifications/notification-bell"
import { StatusBarBranch } from "@/components/source-control/status-bar-branch"

export function StatusBarZone({ items }: { items: BarCatalogItem[] }) {
  return (
    <>
      {items.map((item) => (
        <StatusBarSegment key={item.id} id={item.id} />
      ))}
    </>
  )
}

/**
 * A hidden segment is not rendered at all — it is unmounted, not merely
 * invisible. That matters for `perf`, whose mount starts native CPU/memory
 * sampling, and for the panels that open Dexie live queries.
 */
function StatusBarSegment({ id }: { id: string }) {
  switch (id) {
    case "connectivity":
      return <StatusBarConnectivity />
    case "branch":
      return <StatusBarBranch />
    case "sync":
      return <StatusBarSync />
    case "terminal":
      return <StatusBarTerminal />
    case "notifications":
      return <NotificationBell />
    case "attention":
      return <AttentionPanel />
    case "jobs":
      return <JobCenterPanel />
    case "perf":
      return <StatusBarPerf />
    case "usage":
      return <StatusBarUsage />
    case "accountStatus":
      return <AccountBarButton />
    case "runStatus":
      return <StatusBarRunState />
    default:
      // Unreachable for catalog ids — `status-bar-zone.test.tsx` pins that every
      // entry in `STATUS_BAR_ITEMS` has a case above.
      return null
  }
}
