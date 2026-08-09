// Per-capability circuit breaking (ADR-0090 Phase 5).
//
// Runtime failures classify per CAPABILITY, never per provider: three
// consecutive failures open that capability's circuit for a bounded window,
// which the compatibility gate treats as `unknown` (hard-required →
// fail-before-spend; preferred → disabled + trace). Successes close the
// circuit. The overlay is UNSIGNED by design and can only DOWN-rank.

import type { CapabilityHealthEntry } from "./certification-store"
import { isExplicitlyUnsupportedCapabilityError } from "../external/session-capabilities"

export const CIRCUIT_OPEN_THRESHOLD = 3
export const CIRCUIT_OPEN_MS = 10 * 60 * 1000

/** Only failures proving that the frozen capability contract is wrong count. */
export function isCapabilityProtocolFailure(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return false
  return isExplicitlyUnsupportedCapabilityError(error)
}

export function recordCapabilityFailure(
  entries: CapabilityHealthEntry[],
  keyId: string,
  capability: string,
  now: Date = new Date()
): CapabilityHealthEntry[] {
  const next = entries.filter((e) => !(e.keyId === keyId && e.capability === capability))
  const existing = entries.find((e) => e.keyId === keyId && e.capability === capability)
  const failures = (existing?.consecutiveFailures ?? 0) + 1
  next.push({
    keyId,
    capability,
    consecutiveFailures: failures,
    ...(failures >= CIRCUIT_OPEN_THRESHOLD
      ? { openUntil: new Date(now.getTime() + CIRCUIT_OPEN_MS).toISOString() }
      : {}),
  })
  return next
}

export function recordCapabilitySuccess(
  entries: CapabilityHealthEntry[],
  keyId: string,
  capability: string
): CapabilityHealthEntry[] {
  return entries.filter((e) => !(e.keyId === keyId && e.capability === capability))
}

export function isCircuitOpen(
  entries: CapabilityHealthEntry[],
  keyId: string,
  capability: string,
  now: Date = new Date()
): boolean {
  const entry = entries.find((e) => e.keyId === keyId && e.capability === capability)
  if (!entry?.openUntil) return false
  return now.getTime() < Date.parse(entry.openUntil)
}
