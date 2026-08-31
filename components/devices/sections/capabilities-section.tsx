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

import { LayersIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { summarizeCapabilityCells } from "@/lib/devices/capability-cells"
import type { DeviceCapabilityCell, DeviceCapabilityGroup, DeviceRow } from "@/lib/devices/types"
import { cn } from "@/lib/utils"

import { DeviceSection } from "../device-section"
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
  showCount,
}: {
  group: DeviceCapabilityGroup
  cells: readonly DeviceCapabilityCell[]
  /** Suppressed for a lone group, where the card header already says it. */
  showCount: boolean
}) {
  const t = useTranslations("devices")
  const sorted = useMemo(() => sortCapabilityCells(cells), [cells])
  const totals = useMemo(() => summarizeCapabilityCells(cells), [cells])
  /**
   * The one source every cell in this group shares, or `null` when they differ.
   *
   * On this machine every answer is a local probe, so a per-cell token would be
   * the same word twenty-one times: noise that buries the states beside it.
   * Where the sources actually differ, which is the case the field exists for,
   * a paired device mixing `device-report` with `platform-baseline`, the token
   * stays on the cell and this header says nothing.
   */
  const uniformSource = useMemo(() => {
    const first = sorted[0]?.source ?? null
    if (!first) return null
    return sorted.every((cell) => cell.source === first) ? first : null
  }, [sorted])

  return (
    <section data-testid={`capability-group-${group}`}>
      <h3 className="mb-1 flex items-baseline justify-between gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span>{t(`capabilities.group.${group}`)}</span>
        {uniformSource ? (
          <span
            className="text-[11px] font-normal normal-case"
            data-testid={`capability-group-source-${group}`}
          >
            {t(`capabilities.source.${uniformSource}`)}
          </span>
        ) : null}
        {showCount ? (
          <span className="text-[11px] font-normal normal-case tabular-nums">
            {t("capabilities.reportedCount", {
              reported: totals.reported,
              total: cells.length,
            })}
          </span>
        ) : null}
      </h3>
      {/* Columns as soon as the pane can seat one ~340px wide. A platform
          vocabulary runs to ~20 single-line entries, and one tall column in a
          wide pane is both all scroll and unreadable sideways: the id sits
          left, the verdict sits right, and the eye has to cross several
          hundred pixels of nothing to bind them. Narrower columns put the two
          back within a glance of each other. Per-row borders rather than
          `divide-y`, which draws down the grid's flow order, not down each
          column. */}
      <ul className="grid gap-x-6 @xl/device-card:grid-cols-2 @4xl/device-card:grid-cols-3">
        {sorted.map((cell) => (
          <li
            key={cell.id}
            className="flex items-baseline gap-2 border-b border-border/50 py-1"
            data-testid={`capability-${cell.id}`}
            /* Where the answer came from, at every width. The visible token
               below needs room the narrowest pane does not have, and a fact
               this load-bearing must not be reachable only on a wide monitor. */
            title={t(`capabilities.source.${cell.source}`)}
          >
            <CapabilityDot state={cell.state} className="translate-y-[-1px]" />
            <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{cell.id}</span>
            {cell.detail ? (
              /* Sized off the pane, not the window — a 300px rail-heavy pane
                 must not seat this just because the monitor is wide. */
              <span className="hidden max-w-[45%] truncate text-[11px] text-muted-foreground @lg/device-card:inline">
                {cell.detail}
              </span>
            ) : null}
            {/*
              The distinction the whole matrix rests on is unreadable without
              this. `expected` from a platform baseline and `reported` from the
              device are different kinds of claim, and until now the cell said
              only which one it was, never who said it. `source` was computed
              for every cell from the start and rendered nowhere.
            */}
            {uniformSource ? null : (
              <span
                className="hidden shrink-0 text-[11px] text-muted-foreground @2xl/device-card:inline"
                data-testid={`capability-source-${cell.id}`}
              >
                {t(`capabilities.source.${cell.source}`)}
              </span>
            )}
            <span className={cn("shrink-0 text-[11px]", capabilityToneClass(cell.state))}>
              {t(`capabilityState.${cell.state}`)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function CapabilitiesSection({ row }: { row: DeviceRow }) {
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

  // The overall fraction belongs in the card header, where it is legible
  // without reading a single row.
  const reported = row.capabilities.filter((cell) => cell.state === "reported").length

  if (byGroup.length === 0) {
    return (
      <DeviceSection id="capabilities" title={t("capabilities.title")} icon={LayersIcon} wide>
        <Alert data-testid="device-capabilities">
          <AlertTitle>{t("capabilities.noVocabularyTitle")}</AlertTitle>
          <AlertDescription>{t(`capabilities.noVocabulary.${row.kind}`)}</AlertDescription>
        </Alert>
      </DeviceSection>
    )
  }

  return (
    <DeviceSection
      id="capabilities"
      title={t("capabilities.title")}
      icon={LayersIcon}
      wide
      meta={t("capabilities.reportedCount", { reported, total: row.capabilities.length })}
    >
      <div className="space-y-4" data-testid="device-capabilities">
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
          <CapabilityGroup
            key={entry.group}
            group={entry.group}
            cells={entry.cells}
            showCount={byGroup.length > 1}
          />
        ))}
      </div>
    </DeviceSection>
  )
}
