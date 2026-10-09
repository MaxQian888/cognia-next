"use client"

/**
 * Renders one zone of the status bar from the user's resolved layout.
 *
 * The bar used to hardcode its segments in JSX and gate three of them on
 * boolean flags. Both the order and the visibility are user data now
 * (`AppSettings.statusBarLayout`, see `@/types/shell/bars`), so the bar hands
 * this component the items for a zone and the switch below maps each id to its
 * component. Adding a segment means one catalog entry plus one case here.
 *
 * `variant` names the host's geometry. Most segments are buttons that the rail
 * host already squeezes into icon targets through descendant selectors; a
 * segment whose wide form is not a button (the next-run link) needs to be told
 * it sits in the rail and render its own compact form.
 */

import type { BarCatalogItem } from "@/lib/shell/bar-items"
import { AgentThreadBrowser } from "@/components/agent/agent-thread-browser"
import { AccountBarButton } from "@/components/account/account-bar-button"
import { AttentionPanel } from "@/components/attention/attention-panel"
import { JobCenterPanel } from "@/components/desktop/job-center-panel"
import { StatusBarConnectivity } from "@/components/desktop/status-bar-connectivity"
import { StatusBarNetwork } from "@/components/desktop/status-bar-network"
import {
  StatusBarNextRun,
  type StatusBarNextRunVariant,
} from "@/components/desktop/status-bar-next-run"
import { StatusBarExecutionHost } from "@/components/devices/execution-host-switcher"
import { StatusBarPerf } from "@/components/desktop/status-bar-perf"
import { StatusBarRunState } from "@/components/desktop/status-bar-run-state"
import { StatusBarSync } from "@/components/desktop/status-bar-sync"
import { StatusBarTerminal } from "@/components/desktop/status-bar-terminal"
import { StatusBarToday } from "@/components/desktop/status-bar-today"
import { StatusBarUsage } from "@/components/desktop/status-bar-usage"
import { NotificationBell } from "@/components/notifications/notification-bell"
import { StatusBarBranch } from "@/components/source-control/status-bar-branch"

export type StatusBarZoneVariant = StatusBarNextRunVariant

export function StatusBarZone({
  items,
  variant = "bar",
}: {
  items: BarCatalogItem[]
  variant?: StatusBarZoneVariant
}) {
  return (
    <>
      {items.map((item) => (
        <StatusBarSegment key={item.id} id={item.id} variant={variant} />
      ))}
    </>
  )
}

/**
 * A hidden segment is not rendered at all — it is unmounted, not merely
 * invisible. That matters for `perf`, whose mount starts native CPU/memory
 * sampling, and for the panels that open Dexie live queries.
 */
function StatusBarSegment({ id, variant }: { id: string; variant: StatusBarZoneVariant }) {
  switch (id) {
    case "connectivity":
      return <StatusBarConnectivity />
    case "network":
      return <StatusBarNetwork />
    case "executionHost":
      return <StatusBarExecutionHost />
    case "branch":
      return <StatusBarBranch />
    case "sync":
      return <StatusBarSync />
    case "terminal":
      return <StatusBarTerminal />
    case "nextRun":
      return <StatusBarNextRun variant={variant} />
    case "notifications":
      return <NotificationBell />
    case "attention":
      return <AttentionPanel />
    case "jobs":
      return <JobCenterPanel />
    case "agentThreads":
      return <AgentThreadBrowser />
    case "perf":
      return <StatusBarPerf />
    case "todayUsage":
      return <StatusBarToday />
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
