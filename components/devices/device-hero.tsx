"use client"

/**
 * The device's masthead: who it is, what can be done to it, and where in its
 * dashboard the reader is.
 *
 * It sits outside the pane's scroller, so the three answers stay on screen
 * however far down the reader goes:
 *
 *  * **Identity.** Name, kind, reachability, last contact, and the one detail
 *    that differs per kind: an address for a host, a version for anything that
 *    runs the app. A remote host also states its handshake, because "online"
 *    and "half-connected" are different facts.
 *  * **The verbs.** Connect a host, pause or revoke a phone. These used to be
 *    cards in the grid (the second card down for a host, the bottom of Access
 *    for a phone), which put the action a visit is usually *for* a scroll away
 *    from the name it acts on. Renaming a host now happens in the title it
 *    renames.
 *  * **Orientation.** The jump strip, passed in as children by the dashboard,
 *    which owns the scroll it navigates.
 *
 * The four-number summary strip ({@link DeviceStatSummary}) used to be here as
 * well. It moved to the top of the scroll: it is a reading of the device, not
 * part of its name, and on a phone drawer every fixed pixel above the scroller
 * is a pixel of dashboard the reader cannot see.
 */

import { useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"

import { StatStrip, type StatStripItem } from "@/components/surface/stat-strip"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { DeviceGrantActions } from "@/hooks/devices/use-device-grant-actions"
import { useInlineRename } from "@/hooks/ui/use-inline-rename"
import { buildDeviceStats } from "@/lib/devices/device-stats"
import type { DeviceRow } from "@/lib/devices/types"
import { cn } from "@/lib/utils"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"

import { HostConnectionState, HostControls, isPairedCompanionHost } from "./host-controls"
import { PairedDeviceLifecycle, PairedDeviceLifecycleNotice } from "./paired-device-lifecycle"
import {
  AdminStateBadge,
  DeviceKindIcon,
  ReachabilityLabel,
  useDeviceRelativeTime,
} from "./device-visuals"

/**
 * A tinted plate behind the kind icon.
 *
 * The kinds are the console's top-level grouping, so they earn a colour the
 * eye can land on before reading — the rail already orders by kind, and the
 * masthead is where that grouping is confirmed.
 */
const KIND_PLATE: Record<DeviceRow["kind"], string> = {
  local: "bg-primary/10 text-primary",
  "paired-device": "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  "remote-host": "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  worker: "bg-teal-500/10 text-teal-600 dark:text-teal-400",
  // Muted rather than a fifth hue: an SSH host is the one kind that cannot
  // run work, and giving it the same visual weight as the others would say
  // otherwise before a word is read.
  "ssh-host": "bg-muted text-muted-foreground",
}

/**
 * The numbers that explain the device: each a fraction whose denominator is
 * what the device *could* have, so a shortfall is legible without opening the
 * section that details it. `buildDeviceStats` decides which a kind can answer;
 * nothing here renders a placeholder.
 */
export function DeviceStatSummary({ row, className }: { row: DeviceRow; className?: string }) {
  const t = useTranslations("devices")
  // Labels are translated here rather than inside the strip: `StatStrip` is
  // shared with `/workspace`, and calling `t()` in the cell is what bound the
  // old implementation to the `devices` namespace.
  const stats: StatStripItem[] = buildDeviceStats(row).map((stat) => ({
    id: stat.id,
    label: t(`stat.${stat.id}`),
    value: stat.value,
    ...(stat.total !== undefined ? { total: stat.total } : {}),
    tone: stat.tone,
  }))
  if (stats.length === 0) return null
  return (
    <StatStrip
      stats={stats}
      pane="device-pane"
      testId="device-stat-strip"
      cellTestIdPrefix="device-stat"
      className={className}
    />
  )
}

export interface DeviceHeroProps {
  row: DeviceRow
  /** The grant and lifecycle writes. Without it a phone's masthead has no verbs. */
  actions?: DeviceGrantActions
  /** Opens the add-host sheet, so a revoked host can be paired again in place. */
  onRepairHost?: () => void
  /** Rendered under the identity block: the dashboard's jump strip. */
  children?: ReactNode
}

export function DeviceHero({ row, actions, onRepairHost, children }: DeviceHeroProps) {
  const t = useTranslations("devices")
  const relative = useDeviceRelativeTime()
  const updateHostLabel = useRemoteHostStore((state) => state.updateHostLabel)

  // Only a store-managed host can be renamed from here; a `/pair` host's
  // label belongs to its pairing record.
  const renamableHostId =
    row.kind === "remote-host" && row.hostId && !isPairedCompanionHost(row) ? row.hostId : null

  const [renaming, setRenaming] = useState(false)
  // Switching devices mid-rename abandons it: the draft named the old device.
  const [renamingRef, setRenamingRef] = useState(row.ref)
  if (renamingRef !== row.ref) {
    setRenamingRef(row.ref)
    setRenaming(false)
  }

  const rename = useInlineRename({
    active: renaming,
    initial: row.label,
    onCommit: (next) => {
      if (renamableHostId) updateHostLabel(renamableHostId, next)
      setRenaming(false)
    },
    onCancel: () => setRenaming(false),
  })

  // The one identifying detail that differs per kind — an address for a Host,
  // a version for anything that runs the app.
  const trailing =
    row.kind === "remote-host" ? row.baseUrl : row.appVersion ? `v${row.appVersion}` : null

  const controls =
    row.kind === "remote-host" ? (
      <HostControls
        row={row}
        onRepair={onRepairHost}
        onRename={renamableHostId ? () => setRenaming(true) : undefined}
      />
    ) : row.kind === "paired-device" && actions ? (
      <PairedDeviceLifecycle row={row} actions={actions} />
    ) : null

  return (
    <div className="shrink-0 border-b px-4 pt-3.5 pb-2.5" data-testid="device-hero">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2.5">
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg",
            KIND_PLATE[row.kind]
          )}
        >
          <DeviceKindIcon kind={row.kind} className="size-4.5 text-current" />
        </span>
        <div className="min-w-0 flex-1 basis-56">
          {renaming ? (
            <div className="flex items-center gap-1.5">
              <Input
                {...rename.inputProps}
                aria-label={t("host.renameLabel")}
                className="h-7 text-[15px] font-semibold"
                data-testid="host-rename-input"
              />
              <Button size="sm" onClick={rename.commit} data-testid="host-rename-save">
                {t("host.save")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                // Keep the field focused: its blur commits, and a click on
                // Cancel must not save the draft on the way out.
                onMouseDown={(event) => event.preventDefault()}
                onClick={rename.cancel}
              >
                {t("host.cancel")}
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <h2 className="min-w-0 truncate text-[15px] font-semibold leading-tight">
                {row.label}
              </h2>
              <AdminStateBadge state={row.adminState} />
            </div>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span>{t(`kind.${row.kind}`)}</span>
            <Separator />
            <ReachabilityLabel reachability={row.reachability} />
            {!row.isSelf ? (
              <>
                <Separator />
                <span>{relative(row.lastSeenAt)}</span>
              </>
            ) : null}
            {row.kind === "remote-host" ? (
              <>
                <Separator />
                <HostConnectionState row={row} />
              </>
            ) : null}
            {trailing ? (
              <>
                <Separator />
                <span className="truncate font-mono text-[11px]">{trailing}</span>
              </>
            ) : null}
          </div>
        </div>
        {controls ? <div className="flex shrink-0 items-center">{controls}</div> : null}
      </div>

      <PairedDeviceLifecycleNotice row={row} />

      {children ? <div className="mt-3">{children}</div> : null}
    </div>
  )
}

function Separator() {
  return <span aria-hidden className="size-0.5 rounded-full bg-muted-foreground/50" />
}
