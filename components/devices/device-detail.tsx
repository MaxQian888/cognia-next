"use client"

/**
 * The detail pane: one device, one continuous dashboard.
 *
 * There are no tabs. Five of them meant every question cost a click and hid
 * that most answers are two lines long — a phone's whole Runtime tab was one
 * sentence saying a phone hosts nothing, and you only learned that by going
 * there. As one scroll the sections are cards in a grid, so the short ones sit
 * beside each other and the wide ones (matrices, registries) take the full
 * width. Nothing is behind a click, and the reader can see at once how much
 * there is.
 *
 * Layout rules carried over from `components/settings/mcp/mcp-panel.tsx` and
 * `@container/memory-pane`:
 *
 *  * The scroll container is `@container/device-pane`, and everything
 *    multi-column inside sizes off *that*, never the viewport. This pane is a
 *    draggable fraction of the window (18–40% goes to the rail), so a viewport
 *    `sm:` here seats two columns in a 300px pane purely because the monitor
 *    is wide.
 *  * The masthead is outside the scroller, so the device you are looking at
 *    stays named however far down you are.
 *  * Switching devices resets the scroll. Carrying the old offset lands you in
 *    the middle of a different machine's dispatch queue with no way to tell
 *    that is what happened.
 */

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { TerminalIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import type { DeviceRow } from "@/lib/devices/types"
import type { DeviceGrantActions } from "@/hooks/devices/use-device-grant-actions"

import { DeviceHero } from "./device-hero"
import { DeviceSection } from "./device-section"
import { HostControls } from "./host-controls"
import { SshHostControls } from "./ssh-host-controls"
import { AccessSection } from "./sections/access-section"
import { ActivitySection } from "./sections/activity-section"
import { CapabilitiesSection } from "./sections/capabilities-section"
import { OverviewSection } from "./sections/overview-section"
import { RuntimeSection } from "./sections/runtime-section"
import { WanSection } from "./sections/wan-section"

export interface DeviceDetailProps {
  row: DeviceRow | null
  actions: DeviceGrantActions
  /**
   * Opens the add-host sheet. A revoked host can only be paired again, not
   * reconnected, so the card needs a way back to the flow that pairs one.
   */
  onRepairHost?: () => void
}

export function DeviceDetail({ row, actions, onRepairHost }: DeviceDetailProps) {
  const t = useTranslations("devices")
  const scroller = useRef<HTMLDivElement>(null)
  const ref = row?.ref ?? null

  useEffect(() => {
    // `scrollTop`, not `scrollTo`: the latter is absent in jsdom and in the
    // older Android WebViews the Capacitor shell still runs on, and a jump to
    // the top is exactly the unanimated behaviour we want anyway.
    if (scroller.current) scroller.current.scrollTop = 0
  }, [ref])

  if (!row) {
    return (
      <Empty className="h-full border-none" data-testid="device-detail-empty">
        <EmptyHeader>
          <EmptyTitle>{t("detail.noSelectionTitle")}</EmptyTitle>
          <EmptyDescription>{t("detail.noSelectionBody")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div
      className="@container/device-pane flex h-full min-h-0 flex-col"
      data-testid="device-detail"
    >
      <DeviceHero row={row} />

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
        {/* Device-wide alerts sit above the grid, not inside a card: they are
            about the machine, not about one of the questions asked below. */}
        {row.adminStateConflict ? (
          <Alert variant="destructive" className="mb-3.5" data-testid="device-admin-conflict">
            <AlertTitle>{t("overview.conflictTitle")}</AlertTitle>
            <AlertDescription>{t("overview.conflictBody")}</AlertDescription>
          </Alert>
        ) : null}
        {row.connectionError ? (
          <Alert variant="destructive" className="mb-3.5">
            <AlertTitle>{t("overview.connectionErrorTitle")}</AlertTitle>
            <AlertDescription className="break-all">{row.connectionError}</AlertDescription>
          </Alert>
        ) : null}

        {/* `items-start` so a short card keeps its own height instead of being
            stretched to match the tall one beside it — equal-height rows of
            mostly empty card is the classic dashboard-grid failure. */}
        <div className="grid items-start gap-3.5 @3xl/device-pane:grid-cols-2">
          <OverviewSection row={row} />
          <HostControls row={row} onRepair={onRepairHost} />
          {/* An SSH host has no grants, no capability matrix and no runtime to
              describe, so its own card is the only one that says anything. It
              sits where `HostControls` does for the same reason: this is the
              "what can I do with this machine" slot. */}
          {row.kind === "ssh-host" ? (
            <DeviceSection id="ssh" title={t("ssh.title")} icon={TerminalIcon}>
              <SshHostControls row={row} />
            </DeviceSection>
          ) : null}
          <CapabilitiesSection row={row} />
          {/* Sits next to Access because both answer "what can this device do
              from where it is", and because a dormant WAN connection explains a
              grant that looks live but cannot be exercised off the LAN. */}
          <WanSection row={row} />
          <AccessSection row={row} actions={actions} />
          <RuntimeSection row={row} />
          <ActivitySection row={row} />
        </div>
      </div>
    </div>
  )
}
