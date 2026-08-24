/**
 * The four-or-fewer numbers that summarise a device at a glance.
 *
 * Derived rather than stored, and adaptive rather than fixed-width: a phone
 * has grants and no shell tiers, a worker has neither, and a strip that
 * reserved a slot for every kind would spend most of its width printing "—".
 * Only stats the row can actually answer are returned, so an empty slot never
 * has to be explained.
 *
 * Pure and free of React so the thresholds that decide a tone are testable
 * without rendering — the tone is the part that makes a claim.
 */

import { summarizeCapabilityCells } from "./capability-cells"
import type { DeviceRow } from "./types"

export type DeviceStatId = "capabilities" | "grants" | "shellTiers" | "placement"

/**
 * `attention` is not "bad" — it is "this number is why the device behaves the
 * way it does". A phone that has never reported and a device that provides
 * nothing to placement are both working as built; they are just the reason
 * the next question gets the answer it does.
 */
export type DeviceStatTone = "positive" | "attention" | "neutral"

export interface DeviceStat {
  id: DeviceStatId
  value: number
  /** Present when the stat is a fraction. Omitted for a plain count. */
  total?: number
  tone: DeviceStatTone
}

export function buildDeviceStats(row: DeviceRow): DeviceStat[] {
  const stats: DeviceStat[] = []

  if (row.capabilities.length > 0) {
    const totals = summarizeCapabilityCells(row.capabilities)
    stats.push({
      id: "capabilities",
      value: totals.reported,
      total: row.capabilities.length,
      // Never having reported is the fact worth flagging: every cell below is
      // inference, not evidence.
      tone: row.capabilityReportMissing
        ? "attention"
        : totals.reported > 0
          ? "positive"
          : "neutral",
    })
  }

  if (row.grants.length > 0) {
    // Only grants this build can hand out count towards the denominator — an
    // intentionally inert one is not a permission the owner withheld.
    const available = row.grants.filter((grant) => grant.available)
    const granted = available.filter((grant) => grant.state === "granted").length
    const partial = available.some((grant) => grant.state === "partial")
    stats.push({
      id: "grants",
      value: granted,
      total: available.length,
      // A partial grant outranks the count: it is the state the console was
      // built to expose, and it reads identically to "off" everywhere else.
      tone: partial ? "attention" : granted > 0 ? "positive" : "neutral",
    })
  }

  if (row.runtime.shellTiers.length > 0) {
    const available = row.runtime.shellTiers.filter((tier) => tier.available).length
    stats.push({
      id: "shellTiers",
      value: available,
      total: row.runtime.shellTiers.length,
      tone: available > 0 ? "positive" : "attention",
    })
  }

  // Distinct dimensions, not requirement count: two `platform` requirements
  // still answer exactly one kind of question a caller can ask.
  const dimensions = new Set(row.placement.provides.map((requirement) => requirement.dimension))
  stats.push({
    id: "placement",
    value: dimensions.size,
    // Zero means no requirement can ever match it, so it will never be picked
    // automatically — the single most useful thing this strip can say.
    tone: dimensions.size === 0 ? "attention" : "neutral",
  })

  return stats
}
