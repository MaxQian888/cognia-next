import { describe, expect, it } from "vitest"

import { DAY_MS, HOUR_MS, MINUTE_MS, type ComponentId } from "../../../../../lib/status/contract"
import { parsePublicSnapshot } from "../../../../../lib/status/validate"
import type { EvaluatedComponent } from "./evaluate"
import {
  computeRollup,
  mergeExclusions,
  sumRollups,
  type ExclusionWindows,
  type Rollup,
} from "./rollup"
import { buildSnapshot, snapshotEtag, type SnapshotInputs } from "./snapshot"

const NOW = Date.parse("2026-10-02T10:30:20.000Z")
const NO_WINDOWS: ExclusionWindows = { signalingHttp: [], signalingAuth: [], relayData: [] }

function evaluated(status: EvaluatedComponent["evaluation"]["status"]): EvaluatedComponent[] {
  return (["signalingHttp", "signalingAuth", "relayData"] as ComponentId[]).map((componentId) => ({
    evaluation: {
      componentId,
      evaluatedAtMs: NOW,
      status,
      confidence: status === "unknown" ? "none" : "single_witness",
      inMaintenance: false,
      referenceFresh: status !== "unknown",
      referenceProbeId: "cf-cron",
      referenceRecent: [],
      referenceStreaks: { failures: 0, passes: 3, failuresBeforePasses: 0 },
      latestEvidenceAtMs: status === "unknown" ? null : NOW - 30_000,
      witnesses: [],
      latencyDegraded: false,
    },
    evidence: [],
  }))
}

function inputs(overrides: Partial<SnapshotInputs> = {}): SnapshotInputs {
  return {
    nowMs: NOW,
    revision: 7,
    range: "24h",
    observationStartMinute: null,
    hourly: new Map(),
    daily: new Map(),
    exclusions: mergeExclusions(NO_WINDOWS),
    evaluated: evaluated("unknown"),
    probes: [],
    incidents: { active: [], past: [] },
    maintenance: [],
    capabilities: {
      email: false,
      feeds: true,
      locales: ["en", "zh-CN"],
      historyRanges: ["24h", "7d", "30d", "90d"],
      mirrorUrl: null,
      primaryUrl: "https://status.test/status/",
    },
    ...overrides,
  }
}

function fullHour(hour: number, failMinutes = 0): Rollup {
  const slots = Array.from({ length: 60 }, (_, index) => ({
    minute: hour * 60 + index,
    http: index < failMinutes ? ("fail" as const) : ("pass" as const),
    auth: "pass" as const,
    data: "pass" as const,
    http_ms: 50,
    auth_ms: 900,
    data_ms: 400,
  }))
  return computeRollup(slots, mergeExclusions(NO_WINDOWS), true)
}

describe("buildSnapshot", () => {
  it("publishes unknown with null availability before anything is observed", () => {
    const snapshot = buildSnapshot(inputs())
    expect(parsePublicSnapshot(snapshot).ok).toBe(true)
    expect(snapshot.overallStatus).toBe("unknown")
    expect(snapshot.monitoringStatus).toBe("unknown")
    expect(snapshot.overall.availability.observedAvailability).toBeNull()
    expect(snapshot.overall.availability.coverage).toBeNull()
    expect(
      snapshot.components.every((component) =>
        component.history.every((bucket) => bucket.status === "no_data")
      )
    ).toBe(true)
  })

  it("counts unknown coverage for due minutes with no evidence", () => {
    const currentHour = Math.floor(NOW / HOUR_MS)
    const previous = currentHour - 1
    const hourly = new Map([[previous, fullHour(previous, 0)]])
    const snapshot = buildSnapshot(
      inputs({
        observationStartMinute: (currentHour - 2) * 60,
        hourly,
        evaluated: evaluated("operational"),
      })
    )
    const http = snapshot.components.find((component) => component.id === "signalingHttp")!
    // Two hours ago: expected 60, observed 0. Previous hour: 60/60. Current
    // hour: 29 due minutes (10:00..10:28) with no rollup yet.
    expect(http.availability.expectedSlots).toBe(60 + 60 + 29)
    expect(http.availability.passCount).toBe(60)
    expect(http.availability.observedAvailability).toBe(100)
    expect(http.availability.coverage).toBeCloseTo((100 * 60) / 149)
    const buckets = http.history.slice(-3)
    expect(buckets.map((bucket) => bucket.status)).toEqual(["no_data", "operational", "no_data"])
    expect(buckets[2].partial).toBe(true)
  })

  it("never reports coverage above 100 when an early minute already arrived", () => {
    const currentHour = Math.floor(NOW / HOUR_MS)
    const early = computeRollup(
      Array.from({ length: 31 }, (_, index) => ({
        minute: currentHour * 60 + index,
        http: "pass" as const,
        auth: "pass" as const,
        data: "pass" as const,
        http_ms: 10,
        auth_ms: 10,
        data_ms: 10,
      })),
      mergeExclusions(NO_WINDOWS),
      true
    )
    const snapshot = buildSnapshot(
      inputs({
        observationStartMinute: currentHour * 60,
        hourly: new Map([[currentHour, early]]),
        evaluated: evaluated("operational"),
      })
    )
    expect(snapshot.components[0].availability.coverage).toBe(100)
    expect(parsePublicSnapshot(snapshot).ok).toBe(true)
  })

  it("marks the bucket in which observation started as partial", () => {
    const start = Math.floor(NOW / DAY_MS) * 1440 - 1440 + 600
    const snapshot = buildSnapshot(
      inputs({ range: "7d", observationStartMinute: start, evaluated: evaluated("operational") })
    )
    const history = snapshot.components[0].history
    expect(history[5].partial).toBe(true)
    expect(history[5].availability.expectedSlots).toBe(1440 - 600)
    expect(history[4].availability.expectedSlots).toBe(0)
  })

  it("reports maintenance-adjusted availability and excluded slots", () => {
    const hour = Math.floor(NOW / HOUR_MS) - 1
    const windows: ExclusionWindows = {
      signalingHttp: [{ startMinute: hour * 60, endMinute: hour * 60 + 10 }],
      signalingAuth: [],
      relayData: [],
    }
    const exclusions = mergeExclusions(windows)
    const slots = Array.from({ length: 60 }, (_, index) => ({
      minute: hour * 60 + index,
      http: index < 10 ? ("fail" as const) : ("pass" as const),
      auth: "pass" as const,
      data: "pass" as const,
      http_ms: 50,
      auth_ms: 50,
      data_ms: 50,
    }))
    const snapshot = buildSnapshot(
      inputs({
        observationStartMinute: hour * 60,
        hourly: new Map([[hour, computeRollup(slots, exclusions, true)]]),
        exclusions,
        evaluated: evaluated("operational"),
      })
    )
    const http = snapshot.components[0]
    const bucket = http.history[http.history.length - 2]
    expect(bucket.availability.failCount).toBe(10)
    expect(bucket.availability.excludedSlots).toBe(10)
    expect(bucket.availability.maintenanceAdjusted.failCount).toBe(0)
    expect(bucket.status).toBe("maintenance")
    expect(
      snapshot.overall.history[snapshot.overall.history.length - 2].availability.excludedSlots
    ).toBe(10)
  })

  it("derives latency percentiles from merged hourly histograms", () => {
    const currentHour = Math.floor(NOW / HOUR_MS)
    const hourly = new Map([
      [currentHour - 2, fullHour(currentHour - 2)],
      [currentHour - 1, fullHour(currentHour - 1)],
    ])
    const snapshot = buildSnapshot(
      inputs({
        observationStartMinute: (currentHour - 2) * 60,
        hourly,
        evaluated: evaluated("operational"),
      })
    )
    const auth = snapshot.components.find((component) => component.id === "signalingAuth")!
    expect(auth.latency.phase).toBe("auth")
    expect(auth.latency.summary.sampleCount).toBe(120)
    expect(auth.latency.summary.p50Ms).toBe(1_000)
    expect(auth.latency.buckets).toHaveLength(24)
    expect(auth.latency.buckets[23].p50Ms).toBeNull()
  })

  it("aggregates daily history from daily rollups for longer ranges", () => {
    const today = Math.floor(NOW / DAY_MS)
    const yesterday = sumRollups(
      Array.from({ length: 24 }, (_, index) =>
        fullHour((today - 1) * 24 + index, index === 0 ? 3 : 0)
      ),
      false
    )
    const snapshot = buildSnapshot(
      inputs({
        range: "30d",
        observationStartMinute: (today - 1) * 1440,
        daily: new Map([[today - 1, yesterday]]),
        evaluated: evaluated("degraded"),
      })
    )
    const http = snapshot.components[0]
    expect(http.history).toHaveLength(30)
    expect(http.history[28].availability).toMatchObject({
      passCount: 1437,
      failCount: 3,
      expectedSlots: 1440,
    })
    expect(http.history[28].status).toBe("degraded")
    expect(snapshot.overallStatus).toBe("degraded")
  })

  it("carries the revision, range and generation time it was built with", () => {
    const snapshot = buildSnapshot(inputs({ nowMs: NOW + MINUTE_MS, range: "7d", revision: 42 }))
    expect(snapshot).toMatchObject({
      revision: 42,
      range: "7d",
      generatedAt: new Date(NOW + MINUTE_MS).toISOString(),
    })
    expect(snapshotEtag(42, "7d")).toBe('"r42-7d"')
  })
})
