"use client"

/**
 * Capability-affinity badge for workflow node surfaces (ADR 0060).
 *
 * Shows "unavailable on this device" wherever a node's `requires` set is not
 * satisfied by the local runtime (`detectLocalCapabilities()`), matching the
 * orchestrator's run preflight so authors see the failure before pressing
 * Run. Rendered by the node search sidebar, the editor command palette, and
 * the inspector header — one component so the wording/threshold can't drift.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { cn } from "@/lib/utils"
import { detectLocalCapabilities, type CapabilityId } from "@/lib/platform/capabilities"
import { missingCapabilities, type NodeCatalogEntry } from "@/lib/workflow/nodes/catalog"
import { listPairedDevices } from "@/lib/db/paired-devices"

export interface MissingCapabilityInfo {
  missing: CapabilityId[]
  /** Short badge text ("Unavailable here" / "Runs on phone"). */
  badgeLabel: string
  /** Full sentence listing the localized capability names. */
  tooltip: string
  /**
   * True when every missing capability is covered by an active paired
   * device's reported manifest (ADR 0061 P3) — the node runs, remotely.
   */
  satisfiedRemotely: boolean
}

/**
 * Missing-capability info for `entry` on the local runtime, or `null` when
 * everything it requires is available locally. Requirements covered by an
 * active paired device return `satisfiedRemotely: true` (informational
 * badge, matching the orchestrator's remote-aware preflight). Plugin-scoped
 * capability ids (`plugin:<id>`) have no display-name table and surface
 * verbatim.
 */
export function useMissingNodeCapabilities(
  entry: Pick<NodeCatalogEntry, "requires" | "desktopOnly">
): MissingCapabilityInfo | null {
  const t = useTranslations("workflows.capabilities")
  const devices = useLiveQuery(() => listPairedDevices().catch(() => []), [])
  return useMemo(() => {
    const missing = missingCapabilities(entry, detectLocalCapabilities())
    if (missing.length === 0) return null
    const remote = new Set<string>()
    for (const row of devices ?? []) {
      if (row.revokedAt !== undefined || row.pausedAt !== undefined) continue
      for (const cap of row.capabilities ?? []) remote.add(cap)
    }
    const caps = missing
      .map((cap) => (cap.startsWith("plugin:") ? cap : t(`names.${cap}`)))
      .join(", ")
    const satisfiedRemotely = missing.every((cap) => remote.has(cap))
    return satisfiedRemotely
      ? {
          missing,
          satisfiedRemotely,
          badgeLabel: t("viaDevice"),
          tooltip: t("tooltipRemote", { caps }),
        }
      : {
          missing,
          satisfiedRemotely,
          badgeLabel: t("unavailable"),
          tooltip: t("tooltip", { caps }),
        }
  }, [entry, t, devices])
}

/** Compact inline badge; render only when `info` is non-null. */
export function CapabilityBadge({
  info,
  className,
}: {
  info: MissingCapabilityInfo
  className?: string
}) {
  return (
    <span
      title={info.tooltip}
      data-testid="wf-capability-badge"
      data-remote={info.satisfiedRemotely ? "true" : undefined}
      className={cn(
        "text-[9px] uppercase tracking-wide whitespace-nowrap",
        info.satisfiedRemotely ? "text-sky-600 dark:text-sky-400" : "text-wf-status-running",
        className
      )}
    >
      {info.badgeLabel}
    </span>
  )
}
