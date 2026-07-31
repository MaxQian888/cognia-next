/**
 * @jest-environment node
 */
import {
  CATCHUP_GRACE_WINDOW_MS,
  CATCHUP_MAX_REPLAYED_RUNS,
  catchupDefaultsForTier,
  isLateDelivery,
  resolveCatchupDefaults,
  resolveCatchupTier,
  type CatchupTier,
} from "./catchup-policy"
import { DEFAULT_EXECUTION_CONFIG } from "@/types/scheduler"

describe("resolveCatchupTier", () => {
  it("keeps liveness refreshes out of catch-up", () => {
    expect(resolveCatchupTier("connection:presence:refresh")).toBe("never")
  })

  it("puts operator-visible deliverables on the grace tier", () => {
    for (const type of [
      "connection:scheduled:digest",
      "connection:outbound:send",
      "chat",
      "agent",
      "skill",
      "external-agent",
      "agent-team",
      "goal",
      "plan",
    ]) {
      expect(resolveCatchupTier(type)).toBe("grace")
    }
  })

  it("replays state-rebuilding work", () => {
    for (const type of ["backup", "wiki-rebuild", "wiki-lint", "radar-report", "twin"]) {
      expect(resolveCatchupTier(type)).toBe("all")
    }
  })

  // Executor names are an open string (ADR-0079), so an unlisted type must fall to
  // the pre-existing behaviour rather than start replaying user-defined side
  // effects on its own.
  it("falls back to never for unlisted and open task types", () => {
    for (const type of ["script", "plugin", "custom", "workflow", "solar:sunrise", ""]) {
      expect(resolveCatchupTier(type)).toBe("never")
    }
  })
})

describe("catchupDefaultsForTier", () => {
  it("drops missed slots on the never tier", () => {
    expect(catchupDefaultsForTier("never")).toEqual({
      runMissedOnStartup: false,
      maxMissedRuns: 1,
    })
  })

  it("delivers exactly one still-fresh slot on the grace tier", () => {
    expect(catchupDefaultsForTier("grace")).toEqual({
      runMissedOnStartup: true,
      catchupWindowMs: CATCHUP_GRACE_WINDOW_MS,
      maxMissedRuns: 1,
    })
  })

  it("replays up to the runaway bound on the all tier", () => {
    expect(catchupDefaultsForTier("all")).toEqual({
      runMissedOnStartup: true,
      maxMissedRuns: CATCHUP_MAX_REPLAYED_RUNS,
    })
  })

  // The trap this module exists to prevent: `catchupWindowMs` is evaluated before
  // `runMissedOnStartup` and only ever REMOVES slots, so a window without
  // `runMissedOnStartup: true` is completely inert — it can only relabel a skip.
  // Any tier that sets a window MUST also enable catch-up.
  it("never ships a catch-up window without enabling catch-up", () => {
    const tiers: CatchupTier[] = ["never", "grace", "all"]
    for (const tier of tiers) {
      const defaults = catchupDefaultsForTier(tier)
      if (defaults.catchupWindowMs !== undefined) {
        expect(defaults.runMissedOnStartup).toBe(true)
      }
    }
  })

  it("is the trap the global default falls into", () => {
    // Documents why the table is needed at all: the repo-wide default drops
    // everything, so a window alone would have been meaningless.
    expect(DEFAULT_EXECUTION_CONFIG.runMissedOnStartup).toBe(false)
    expect(DEFAULT_EXECUTION_CONFIG.catchupWindowMs).toBeUndefined()
  })

  it("bounds every tier so a long outage cannot replay without limit", () => {
    const tiers: CatchupTier[] = ["never", "grace", "all"]
    for (const tier of tiers) {
      const { maxMissedRuns } = catchupDefaultsForTier(tier)
      expect(maxMissedRuns).toBeGreaterThan(0)
      expect(maxMissedRuns).toBeLessThanOrEqual(CATCHUP_MAX_REPLAYED_RUNS)
    }
  })
})

describe("resolveCatchupDefaults", () => {
  it("composes tier lookup with the tier's defaults", () => {
    expect(resolveCatchupDefaults("connection:scheduled:digest")).toEqual(
      catchupDefaultsForTier("grace")
    )
    expect(resolveCatchupDefaults("backup")).toEqual(catchupDefaultsForTier("all"))
    expect(resolveCatchupDefaults("script")).toEqual(catchupDefaultsForTier("never"))
  })

  it("merges over the global defaults without losing unrelated fields", () => {
    const merged = { ...DEFAULT_EXECUTION_CONFIG, ...resolveCatchupDefaults("chat") }
    expect(merged.runMissedOnStartup).toBe(true)
    expect(merged.catchupWindowMs).toBe(CATCHUP_GRACE_WINDOW_MS)
    // Untouched by the policy.
    expect(merged.timeout).toBe(DEFAULT_EXECUTION_CONFIG.timeout)
    expect(merged.maxRetries).toBe(DEFAULT_EXECUTION_CONFIG.maxRetries)
    expect(merged.overlapPolicy).toBe(DEFAULT_EXECUTION_CONFIG.overlapPolicy)
  })
})

describe("isLateDelivery", () => {
  it("marks slots that fired from catch-up or a backfill", () => {
    expect(isLateDelivery("catch-up")).toBe(true)
    expect(isLateDelivery("backfill")).toBe(true)
  })

  it("leaves on-time and manual runs unmarked", () => {
    for (const source of ["schedule", "run-now", "retry", "event", "dependency", "remote"]) {
      expect(isLateDelivery(source)).toBe(false)
    }
    expect(isLateDelivery(undefined)).toBe(false)
  })
})
