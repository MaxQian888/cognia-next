"use client"

/**
 * What this device says it can do.
 *
 * `pairedDevices.capabilities` has been written on every connect since
 * ADR-0060 and rendered by nothing, so this is the first surface that has to
 * answer "what does an unreported device look like?". The answer it refuses to
 * give is a full column of misses: `absent` means the device answered and
 * lacks the capability, `unknown`/`expected` mean nobody confirmed either way,
 * and collapsing them would state twenty negative facts nobody gave.
 *
 * Reported capabilities come last, not first. The reader's question in a
 * console is almost always "why can this machine not do X", so the cells that
 * answer it lead — the same ordering `capability-matrix-card.tsx` settled on.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { summarizeCapabilityCells } from "@/lib/devices/capability-cells"
import type { DeviceCapabilityCell, DeviceCapabilityGroup, DeviceRow } from "@/lib/devices/types"
import { cn } from "@/lib/utils"

import { CapabilityDot, capabilityToneClass, useDeviceRelativeTime } from "../device-visuals"

const GROUPS: readonly DeviceCapabilityGroup[] = ["platform", "host-execution", "host-proxy"]

/** Unconfirmed first, then answered misses, then what works. */
const STATE_ORDER: Record<DeviceCapabilityCell["state"], number> = {
  unknown: 0,
  expected: 1,
  absent: 2,
  reported: 3,
}

export function sortCapabilityCells(
  cells: readonly DeviceCapabilityCell[]
): DeviceCapabilityCell[] {
  return [...cells].sort(
    (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.id.localeCompare(b.id)
  )
}

function CapabilityGroup({
  group,
  cells,
}: {
  group: DeviceCapabilityGroup
  cells: readonly DeviceCapabilityCell[]
}) {
  const t = useTranslations("devices")
  const sorted = useMemo(() => sortCapabilityCells(cells), [cells])
  const totals = useMemo(() => summarizeCapabilityCells(cells), [cells])

  return (
    <section data-testid={`capability-group-${group}`}>
      <h3 className="mb-1 flex items-baseline justify-between gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span>{t(`capabilities.group.${group}`)}</span>
        <span className="text-[11px] font-normal normal-case tabular-nums">
          {t("capabilities.reportedCount", {
            reported: totals.reported,
            total: cells.length,
          })}
        </span>
      </h3>
      <ul className="divide-y divide-border/50">
        {sorted.map((cell) => (
          <li
            key={cell.id}
            className="flex items-baseline gap-2 py-1"
            data-testid={`capability-${cell.id}`}
          >
            <CapabilityDot state={cell.state} className="translate-y-[-1px]" />
            <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{cell.id}</span>
            {cell.detail ? (
              <span className="hidden max-w-[45%] truncate text-[11px] text-muted-foreground sm:inline">
                {cell.detail}
              </span>
            ) : null}
            <span className={cn("shrink-0 text-[11px]", capabilityToneClass(cell.state))}>
              {t(`capabilityState.${cell.state}`)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function CapabilitiesTab({ row }: { row: DeviceRow }) {
  const t = useTranslations("devices")
  const relative = useDeviceRelativeTime()

  const byGroup = useMemo(
    () =>
      GROUPS.map((group) => ({
        group,
        cells: row.capabilities.filter((cell) => cell.group === group),
      })).filter((entry) => entry.cells.length > 0),
    [row.capabilities]
  )

  if (byGroup.length === 0) {
    return (
      <div className="space-y-3" data-testid="device-capabilities-tab">
        <Alert>
          <AlertTitle>{t("capabilities.noVocabularyTitle")}</AlertTitle>
          <AlertDescription>{t(`capabilities.noVocabulary.${row.kind}`)}</AlertDescription>
        </Alert>
      </div>
    )
  }

  return (
    <div className="space-y-4" data-testid="device-capabilities-tab">
      {row.capabilityReportMissing ? (
        /**
         * One explanatory banner instead of twenty `absent` rows. The device
         * has told us nothing; the matrix below is a platform-baseline guess
         * and says so per cell.
         */
        <Alert data-testid="capability-never-reported">
          <AlertTitle>{t("capabilities.neverReportedTitle")}</AlertTitle>
          <AlertDescription>{t("capabilities.neverReportedBody")}</AlertDescription>
        </Alert>
      ) : row.capabilitiesReportedAt ? (
        <p className="text-[11px] text-muted-foreground">
          {t("capabilities.reportedAt", { when: relative(row.capabilitiesReportedAt) })}
        </p>
      ) : null}

      {byGroup.map((entry) => (
        <CapabilityGroup key={entry.group} group={entry.group} cells={entry.cells} />
      ))}
    </div>
  )
}
