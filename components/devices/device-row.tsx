"use client"

/**
 * One row in the device rail.
 *
 * A button rather than a list item with a nested control: the whole row is the
 * target, which is what makes the rail usable with a keyboard and on touch.
 * Plain flex + `min-w-0` rather than the `Item` primitives, because `ItemTitle`
 * is `w-fit` and a long device label then runs out from under the trailing
 * badge instead of truncating.
 */

import { useTranslations } from "next-intl"

import { rowNeedsAttention } from "@/lib/devices/build-device-rows"
import type { DeviceRow } from "@/lib/devices/types"
import { cn } from "@/lib/utils"

import {
  AdminStateBadge,
  DeviceKindIcon,
  ReachabilityDot,
  useDeviceRelativeTime,
} from "./device-visuals"

export interface DeviceRowButtonProps {
  row: DeviceRow
  selected: boolean
  onSelect: (ref: string) => void
}

export function DeviceRowButton({ row, selected, onSelect }: DeviceRowButtonProps) {
  const t = useTranslations("devices")
  const relative = useDeviceRelativeTime()

  /**
   * What the second line says, in the order a reader needs it: what kind of
   * machine, then the one identifying detail that differs per kind, then when
   * we last heard from it.
   */
  const detail =
    row.kind === "remote-host"
      ? (row.baseUrl ?? t("kind.remote-host"))
      : row.appVersion
        ? `v${row.appVersion}`
        : t(`kind.${row.kind}`)

  // Shared with the header count so a lit badge always has a marked row.
  const needsAttention = rowNeedsAttention(row)

  return (
    <button
      type="button"
      onClick={() => onSelect(row.ref)}
      aria-current={selected ? "true" : undefined}
      data-testid={`device-row-${row.ref}`}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
        "hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "bg-muted"
      )}
    >
      <DeviceKindIcon kind={row.kind} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <ReachabilityDot reachability={row.reachability} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{row.label}</span>
          {needsAttention ? (
            <span
              aria-label={t("row.needsAttention")}
              className="size-1.5 shrink-0 rounded-full bg-amber-500"
            />
          ) : null}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{detail}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground/80 tabular-nums">
            {row.isSelf ? t("kind.local") : relative(row.lastSeenAt)}
          </span>
        </span>
        {row.adminState !== "active" ? (
          <span className="mt-1 flex">
            <AdminStateBadge state={row.adminState} />
          </span>
        ) : null}
      </span>
    </button>
  )
}
