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
import { cn } from "@/lib/utils"
import { detectLocalCapabilities, type CapabilityId } from "@/lib/platform/capabilities"
import { missingCapabilities, type NodeCatalogEntry } from "@/lib/workflow/nodes/catalog"

export interface MissingCapabilityInfo {
  missing: CapabilityId[]
  /** Short badge text ("Unavailable here"). */
  badgeLabel: string
  /** Full sentence listing the localized capability names. */
  tooltip: string
}

/**
 * Missing-capability info for `entry` on the local runtime, or `null` when
 * everything it requires is available. Plugin-scoped capability ids
 * (`plugin:<id>`) have no display-name table and surface verbatim.
 */
export function useMissingNodeCapabilities(
  entry: Pick<NodeCatalogEntry, "requires" | "desktopOnly">
): MissingCapabilityInfo | null {
  const t = useTranslations("workflows.capabilities")
  return useMemo(() => {
    const missing = missingCapabilities(entry, detectLocalCapabilities())
    if (missing.length === 0) return null
    const caps = missing
      .map((cap) => (cap.startsWith("plugin:") ? cap : t(`names.${cap}`)))
      .join(", ")
    return { missing, badgeLabel: t("unavailable"), tooltip: t("tooltip", { caps }) }
  }, [entry, t])
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
      className={cn(
        "text-[9px] uppercase tracking-wide text-wf-status-running whitespace-nowrap",
        className
      )}
    >
      {info.badgeLabel}
    </span>
  )
}
