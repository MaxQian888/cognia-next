"use client"

/**
 * The device's masthead: who it is, and the four numbers that explain it.
 *
 * The strip exists because the old tab bar answered "where do I click" and
 * never "is anything wrong here". Each stat is a fraction whose denominator
 * is what the device *could* have — reported/total capabilities, held/grantable
 * permissions, usable/known shell tiers — so a shortfall is legible without
 * opening the section that details it. `buildDeviceStats` decides which of
 * them a given kind can answer at all; nothing here renders a placeholder.
 */

import { useTranslations } from "next-intl"

import { StatStrip, type StatStripItem } from "@/components/surface/stat-strip"
import { buildDeviceStats } from "@/lib/devices/device-stats"
import type { DeviceRow } from "@/lib/devices/types"
import { cn } from "@/lib/utils"

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

export function DeviceHero({ row }: { row: DeviceRow }) {
  const t = useTranslations("devices")
  const relative = useDeviceRelativeTime()
  // Labels are translated here rather than inside the strip: `StatStrip` is
  // shared with `/workspace`, and calling `t()` in the cell is what bound the
  // old implementation to the `devices` namespace.
  const stripStats: StatStripItem[] = buildDeviceStats(row).map((stat) => ({
    id: stat.id,
    label: t(`stat.${stat.id}`),
    value: stat.value,
    ...(stat.total !== undefined ? { total: stat.total } : {}),
    tone: stat.tone,
  }))

  // The one identifying detail that differs per kind — an address for a Host,
  // a version for anything that runs the app.
  const trailing =
    row.kind === "remote-host" ? row.baseUrl : row.appVersion ? `v${row.appVersion}` : null

  return (
    <div className="shrink-0 border-b px-4 py-3.5" data-testid="device-hero">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg",
            KIND_PLATE[row.kind]
          )}
        >
          <DeviceKindIcon kind={row.kind} className="size-4.5 text-current" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold leading-tight">
              {row.label}
            </h2>
            <AdminStateBadge state={row.adminState} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span>{t(`kind.${row.kind}`)}</span>
            <span aria-hidden className="size-0.5 rounded-full bg-muted-foreground/50" />
            <ReachabilityLabel reachability={row.reachability} />
            {!row.isSelf ? (
              <>
                <span aria-hidden className="size-0.5 rounded-full bg-muted-foreground/50" />
                <span>{relative(row.lastSeenAt)}</span>
              </>
            ) : null}
            {trailing ? (
              <>
                <span aria-hidden className="size-0.5 rounded-full bg-muted-foreground/50" />
                <span className="truncate font-mono text-[11px]">{trailing}</span>
              </>
            ) : null}
          </div>
        </div>
      </div>

      <StatStrip
        stats={stripStats}
        pane="device-pane"
        testId="device-stat-strip"
        cellTestIdPrefix="device-stat"
        className="mt-3"
      />
    </div>
  )
}
