/**
 * Turning Router + Fusion on for a user of the legacy Auto ladder (ADR-0188
 * D31/D37), and the one-click way back.
 *
 * The first enable carries the ladder's intent over: an Auto user gets the
 * economy rule row approved (labelled "migrated from legacy Auto", not
 * eval-proven) and their per-request cost limit becomes the direct run cap.
 * `autoRouting` itself is never modified, and the settings it had at that
 * moment are snapshotted, so "restore" puts back exactly what was there and
 * switches Router + Fusion off.
 *
 * Pure functions over plain settings; the settings UI saves the results.
 */

import type { AutoRoutingSettings } from "@cognia/provider-types/auto-router"
import { microusdToUsd } from "@cognia/router-fusion/money/microusd"
import {
  normalizeRouterFusionSettings,
  type RouterFusionSettings,
} from "@cognia/router-fusion/settings/settings"

export const MIGRATED_RULE_ROW = "economy_simple" as const

/** The legacy limit is in USD cents; the run cap is a six-decimal USD string. */
function centsToRunCap(cents: unknown): string | null {
  if (typeof cents !== "number" || !Number.isFinite(cents) || cents <= 0) return null
  // Round up to the next microusd: a cap is a ceiling, never loosened by rounding.
  return microusdToUsd(Math.ceil(cents * 10_000))
}

/**
 * The settings after the user switches the master on. Migrates only the first
 * time (no snapshot yet); a later re-enable just flips the switch.
 */
export function enableRouterFusion(
  current: RouterFusionSettings,
  autoRouting: AutoRoutingSettings | undefined,
  now: number
): RouterFusionSettings {
  if (current.legacyAutoSnapshot)
    return normalizeRouterFusionSettings({ ...current, enabled: true })
  const next: RouterFusionSettings = {
    ...structuredClone(current),
    enabled: true,
    legacyAutoSnapshot: {
      capturedAt: now,
      autoRouting: autoRouting ? structuredClone(autoRouting) : null,
    },
  }
  if (autoRouting?.enabled) {
    if (!next.approvedRuleRows.includes(MIGRATED_RULE_ROW)) {
      next.approvedRuleRows = [...next.approvedRuleRows, MIGRATED_RULE_ROW]
      next.ruleRowProvenance = {
        ...next.ruleRowProvenance,
        [MIGRATED_RULE_ROW]: "migrated_legacy_auto",
      }
    }
    const cap = centsToRunCap(autoRouting.maxCostPerRequest)
    if (cap) next.runCapUsdByMode = { ...next.runCapUsdByMode, direct: cap }
    next.migrationNoticeDismissed = false
  } else {
    // Nothing was carried over, so there is nothing to announce.
    next.migrationNoticeDismissed = true
  }
  return normalizeRouterFusionSettings(next)
}

/** Whether the one-time "migrated from legacy Auto" notice should show. */
export function showsLegacyAutoNotice(settings: RouterFusionSettings): boolean {
  return (
    settings.enabled &&
    !settings.migrationNoticeDismissed &&
    Object.values(settings.ruleRowProvenance).includes("migrated_legacy_auto")
  )
}

export interface LegacyAutoRestore {
  routerFusion: RouterFusionSettings
  /** The Auto settings to put back; absent when nothing was captured. */
  autoRouting?: AutoRoutingSettings
}

/**
 * One-click restore: Router + Fusion off, the migrated rule rows withdrawn, and
 * `autoRouting` back to the snapshot. The snapshot is consumed, so enabling
 * again migrates from whatever Auto looks like then.
 */
export function restoreLegacyAuto(current: RouterFusionSettings): LegacyAutoRestore {
  const migrated = new Set(
    Object.entries(current.ruleRowProvenance)
      .filter(([, provenance]) => provenance === "migrated_legacy_auto")
      .map(([row]) => row)
  )
  const { legacyAutoSnapshot, ...rest } = structuredClone(current)
  const routerFusion = normalizeRouterFusionSettings({
    ...rest,
    enabled: false,
    approvedRuleRows: current.approvedRuleRows.filter((row) => !migrated.has(row)),
    ruleRowProvenance: Object.fromEntries(
      Object.entries(current.ruleRowProvenance).filter(([row]) => !migrated.has(row))
    ),
    migrationNoticeDismissed: true,
  })
  const captured = legacyAutoSnapshot?.autoRouting
  return captured && typeof captured === "object"
    ? { routerFusion, autoRouting: captured as AutoRoutingSettings }
    : { routerFusion }
}
