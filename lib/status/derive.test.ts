import {
  LATENCY_MIN_SAMPLES,
  MINUTE_MS,
  REFERENCE_FRESH_MS,
  type CheckResult,
  type ProfileId,
  type ProbeSource,
} from "./contract"
import {
  addLatencySample,
  bucketStatus,
  deriveComponentStatus,
  deriveMonitoringStatus,
  deriveOverallStatus,
  dueEndMinute,
  emptyLatencyHistogram,
  emptySlotCounts,
  enumerateRangeBuckets,
  excludedMinuteCount,
  expectedMinutesInBucket,
  formatPercent,
  histogramPercentile,
  isMinuteExcluded,
  joinOverallResult,
  latencyBucketView,
  mergeLatencyHistograms,
  mergeMinuteWindows,
  minuteOf,
  normalizeStatusLocale,
  parseIsoMs,
  pickLocalized,
  slotStreaks,
  snapshotFreshness,
  summarizeAvailability,
  type SlotOutcome,
  type WitnessEvidence,
} from "./derive"

const NOW = Date.parse("2026-10-02T10:00:30.000Z")

function witness(
  recent: SlotOutcome[],
  overrides: Partial<WitnessEvidence> & { latestAgeMs?: number } = {}
): WitnessEvidence {
  const last = [...recent].reverse().find((outcome) => outcome !== "missing") as
    CheckResult | undefined
  const { latestAgeMs = 30_000, ...rest } = overrides
  return {
    probeId: "ref",
    profileId: "native" as ProfileId,
    source: "cloudflare" as ProbeSource,
    reference: true,
    freshMs: REFERENCE_FRESH_MS,
    latest: last
      ? {
          result: last,
          reason: last === "pass" ? null : "auth_timeout",
          checkedAtMs: NOW - latestAgeMs,
        }
      : null,
    recent,
    ...rest,
  }
}

describe("availability counts", () => {
  it("reports null availability and coverage when nothing was observed or expected", () => {
    const summary = summarizeAvailability(emptySlotCounts())
    expect(summary.observedAvailability).toBeNull()
    expect(summary.coverage).toBeNull()
    expect(bucketStatus(summary)).toBe("no_data")
  })

  it("computes availability from counts and coverage against expected slots", () => {
    const summary = summarizeAvailability({
      passCount: 57,
      failCount: 1,
      expectedSlots: 60,
      excludedSlots: 0,
      excludedPassCount: 0,
      excludedFailCount: 0,
    })
    expect(summary.unknownCount).toBe(2)
    expect(summary.observedAvailability).toBeCloseTo((100 * 57) / 58)
    expect(summary.coverage).toBeCloseTo((100 * 58) / 60)
  })

  it("weights totals by counts instead of averaging uneven days", () => {
    // Day A: 1 of 1 passes (100 %). Day B: 0 of 99 pass (0 %).
    const total = summarizeAvailability({
      passCount: 1,
      failCount: 99,
      expectedSlots: 100,
      excludedSlots: 0,
      excludedPassCount: 0,
      excludedFailCount: 0,
    })
    expect(total.observedAvailability).toBe(1)
  })

  it("keeps raw counts and reports a maintenance-adjusted view separately", () => {
    const summary = summarizeAvailability({
      passCount: 50,
      failCount: 10,
      expectedSlots: 60,
      excludedSlots: 10,
      excludedPassCount: 0,
      excludedFailCount: 10,
    })
    expect(summary.failCount).toBe(10)
    expect(summary.excludedSlots).toBe(10)
    expect(summary.maintenanceAdjusted.failCount).toBe(0)
    expect(summary.maintenanceAdjusted.expectedSlots).toBe(50)
    expect(summary.maintenanceAdjusted.observedAvailability).toBe(100)
    expect(bucketStatus(summary)).toBe("maintenance")
  })

  it("grades failing buckets by adjusted availability", () => {
    const grade = (pass: number, fail: number) =>
      bucketStatus(
        summarizeAvailability({
          passCount: pass,
          failCount: fail,
          expectedSlots: pass + fail,
          excludedSlots: 0,
          excludedPassCount: 0,
          excludedFailCount: 0,
        })
      )
    expect(grade(1440, 0)).toBe("operational")
    expect(grade(1439, 1)).toBe("degraded")
    expect(grade(1400, 40)).toBe("partial_outage")
    expect(grade(1000, 440)).toBe("major_outage")
  })

  it("never rounds a non-perfect figure up to 100", () => {
    expect(formatPercent(99.9999)).toBe("99.99")
    expect(formatPercent(100)).toBe("100.00")
    expect(formatPercent(null)).toBeNull()
  })

  it("fails the overall minute on any failure and passes it only when all pass", () => {
    expect(joinOverallResult(["pass", "pass", "pass"])).toBe("pass")
    expect(joinOverallResult(["pass", "fail", "unknown"])).toBe("fail")
    expect(joinOverallResult(["pass", "unknown", "pass"])).toBe("unknown")
    expect(joinOverallResult([])).toBe("unknown")
  })
})

describe("UTC buckets and expected slots", () => {
  it("aligns hourly and daily buckets to UTC with the open bucket last", () => {
    const hourly = enumerateRangeBuckets("24h", NOW)
    expect(hourly).toHaveLength(24)
    expect(new Date(hourly[23].startMs).toISOString()).toBe("2026-10-02T10:00:00.000Z")
    const daily = enumerateRangeBuckets("90d", NOW)
    expect(daily).toHaveLength(90)
    expect(new Date(daily[89].startMs).toISOString()).toBe("2026-10-02T00:00:00.000Z")
    expect(daily[89].startMs - daily[88].startMs).toBe(86_400_000)
  })

  it("expects nothing before observation started and nothing not yet due", () => {
    const day = {
      startMs: Date.parse("2026-10-02T00:00:00Z"),
      endMs: Date.parse("2026-10-03T00:00:00Z"),
    }
    expect(expectedMinutesInBucket(day, null, NOW).count).toBe(0)
    const start = minuteOf(Date.parse("2026-10-02T09:00:00Z"))
    // 09:00 .. 09:59 are due at 10:00:30 because of the one-minute grace.
    expect(expectedMinutesInBucket(day, start, NOW).count).toBe(59)
    expect(dueEndMinute(NOW)).toBe(minuteOf(Date.parse("2026-10-02T09:59:00Z")))
  })

  it("parses only full ISO timestamps", () => {
    expect(parseIsoMs("2026-10-02T10:00:00.000Z")).toBe(Date.parse("2026-10-02T10:00:00.000Z"))
    expect(parseIsoMs("2026-10-02")).toBeNull()
    expect(parseIsoMs("yesterday")).toBeNull()
  })
})

describe("maintenance windows", () => {
  it("unions overlapping windows so a minute is excluded once", () => {
    const merged = mergeMinuteWindows([
      { startMinute: 10, endMinute: 20 },
      { startMinute: 15, endMinute: 30 },
      { startMinute: 40, endMinute: 45 },
      { startMinute: 50, endMinute: 50 },
    ])
    expect(merged).toEqual([
      { startMinute: 10, endMinute: 30 },
      { startMinute: 40, endMinute: 45 },
    ])
    expect(excludedMinuteCount(0, 100, merged)).toBe(25)
    expect(excludedMinuteCount(25, 42, merged)).toBe(7)
  })

  it("treats windows as half-open", () => {
    const merged = mergeMinuteWindows([{ startMinute: 10, endMinute: 20 }])
    expect(isMinuteExcluded(10, merged)).toBe(true)
    expect(isMinuteExcluded(19, merged)).toBe(true)
    expect(isMinuteExcluded(20, merged)).toBe(false)
  })
})

describe("latency histograms", () => {
  it("reads percentiles from merged histograms", () => {
    const fast = emptyLatencyHistogram()
    const slow = emptyLatencyHistogram()
    for (let index = 0; index < 19; index += 1) addLatencySample(fast, 40)
    addLatencySample(slow, 2_500)
    const merged = mergeLatencyHistograms([fast, slow])
    expect(histogramPercentile(merged, 0.5)).toBe(50)
    expect(histogramPercentile(merged, 0.95)).toBe(50)
    expect(histogramPercentile(merged, 1)).toBe(3_000)
    expect(histogramPercentile(emptyLatencyHistogram(), 0.5)).toBeNull()
  })

  it("withholds percentiles below the minimum sample count", () => {
    const histogram = emptyLatencyHistogram()
    for (let index = 0; index < LATENCY_MIN_SAMPLES - 1; index += 1) addLatencySample(histogram, 80)
    const view = latencyBucketView({ startMs: 0, endMs: 3_600_000 }, histogram)
    expect(view.sampleCount).toBe(LATENCY_MIN_SAMPLES - 1)
    expect(view.p50Ms).toBeNull()
    addLatencySample(histogram, 80)
    expect(latencyBucketView({ startMs: 0, endMs: 3_600_000 }, histogram).p50Ms).toBe(100)
  })
})

describe("slot streaks", () => {
  it("counts consecutive failures and tolerates a single gap", () => {
    expect(slotStreaks(["pass", "fail", "fail", "fail"]).failures).toBe(3)
    expect(slotStreaks(["pass", "fail", "missing", "fail", "fail"]).failures).toBe(3)
  })

  it("breaks the sequence on two consecutive gaps", () => {
    expect(slotStreaks(["fail", "fail", "missing", "unknown", "fail"]).failures).toBe(1)
  })

  it("reports the failures that preceded a recovery", () => {
    const streaks = slotStreaks(["fail", "fail", "fail", "pass"])
    expect(streaks.passes).toBe(1)
    expect(streaks.failuresBeforePasses).toBe(3)
  })
})

describe("deriveComponentStatus", () => {
  const base = { witnesses: [], inMaintenance: false, nowMs: NOW }

  it("is unknown without usable fresh evidence, even inside maintenance", () => {
    expect(deriveComponentStatus({ ...base, reference: null }).status).toBe("unknown")
    const stale = witness(["pass"], { latestAgeMs: REFERENCE_FRESH_MS + 1 })
    expect(deriveComponentStatus({ ...base, reference: stale }).status).toBe("unknown")
    expect(deriveComponentStatus({ ...base, reference: stale, inMaintenance: true }).status).toBe(
      "unknown"
    )
    const runnerError = witness(["pass", "unknown"])
    expect(deriveComponentStatus({ ...base, reference: runnerError }).status).toBe("unknown")
  })

  it("reports a passing single witness as operational with limited confidence", () => {
    const result = deriveComponentStatus({ ...base, reference: witness(["pass", "pass"]) })
    expect(result.status).toBe("operational")
    expect(result.confidence).toBe("single_witness")
  })

  it("marks corroboration only from another native witness", () => {
    const origin = witness(["pass"], { probeId: "ext", profileId: "web", reference: false })
    const native = witness(["pass"], { probeId: "ext", source: "external", reference: false })
    expect(
      deriveComponentStatus({ ...base, reference: witness(["pass"]), witnesses: [origin] })
        .confidence
    ).toBe("single_witness")
    expect(
      deriveComponentStatus({ ...base, reference: witness(["pass"]), witnesses: [native] })
        .confidence
    ).toBe("corroborated")
  })

  it("degrades on an isolated failure and declares a major outage after three", () => {
    expect(deriveComponentStatus({ ...base, reference: witness(["pass", "fail"]) }).status).toBe(
      "degraded"
    )
    expect(
      deriveComponentStatus({ ...base, reference: witness(["fail", "fail", "fail"]) }).status
    ).toBe("major_outage")
  })

  it("labels a single-witness outage and corroborates with a second failing native witness", () => {
    const failing = witness(["fail", "fail", "fail"])
    expect(deriveComponentStatus({ ...base, reference: failing }).confidence).toBe("single_witness")
    const second = witness(["fail", "fail"], {
      probeId: "ext",
      source: "external",
      reference: false,
    })
    const result = deriveComponentStatus({ ...base, reference: failing, witnesses: [second] })
    expect(result.status).toBe("major_outage")
    expect(result.confidence).toBe("corroborated")
  })

  it("reports a partial outage when fresh witnesses disagree", () => {
    const passing = witness(["pass"], { probeId: "ext", source: "external", reference: false })
    expect(
      deriveComponentStatus({
        ...base,
        reference: witness(["fail", "fail", "fail"]),
        witnesses: [passing],
      }).status
    ).toBe("partial_outage")
    const failingOrigin = witness(["fail", "fail"], {
      probeId: "ext",
      profileId: "android",
      reference: false,
      freshMs: 900_000,
    })
    expect(
      deriveComponentStatus({ ...base, reference: witness(["pass"]), witnesses: [failingOrigin] })
        .status
    ).toBe("partial_outage")
  })

  it("stays degraded until two passes follow an outage", () => {
    expect(
      deriveComponentStatus({ ...base, reference: witness(["fail", "fail", "fail", "pass"]) })
        .status
    ).toBe("degraded")
    expect(
      deriveComponentStatus({
        ...base,
        reference: witness(["fail", "fail", "fail", "pass", "pass"]),
      }).status
    ).toBe("operational")
  })

  it("shows maintenance over fresh evidence in scope", () => {
    expect(
      deriveComponentStatus({
        ...base,
        reference: witness(["fail", "fail", "fail"]),
        inMaintenance: true,
      }).status
    ).toBe("maintenance")
  })

  it("falls back to a fresh native witness when the reference is stale", () => {
    const stale = witness(["pass"], { latestAgeMs: REFERENCE_FRESH_MS * 2 })
    const external = witness(["fail", "fail", "fail"], {
      probeId: "ext",
      source: "external",
      reference: false,
    })
    const result = deriveComponentStatus({ ...base, reference: stale, witnesses: [external] })
    expect(result.status).toBe("major_outage")
    expect(result.decidedBy).toBe("ext")
    expect(result.confidence).toBe("single_witness")
  })
})

describe("overall and monitoring status", () => {
  it("lets the worst failing component win", () => {
    expect(deriveOverallStatus(["operational", "degraded", "major_outage"])).toBe("major_outage")
    expect(deriveOverallStatus(["unknown", "partial_outage"])).toBe("partial_outage")
  })

  it("is unknown when a component is unknown and none fails", () => {
    expect(deriveOverallStatus(["operational", "unknown"])).toBe("unknown")
    expect(deriveOverallStatus(["maintenance", "unknown"])).toBe("unknown")
    expect(deriveOverallStatus([])).toBe("unknown")
  })

  it("lets maintenance show through healthy components", () => {
    expect(deriveOverallStatus(["operational", "maintenance"])).toBe("maintenance")
    expect(deriveOverallStatus(["operational", "operational"])).toBe("operational")
  })

  it("separates observer health from service health", () => {
    expect(deriveMonitoringStatus([])).toBe("unknown")
    expect(deriveMonitoringStatus([{ reference: true, health: "healthy" }])).toBe("limited")
    expect(
      deriveMonitoringStatus([
        { reference: true, health: "healthy" },
        { reference: false, health: "healthy" },
      ])
    ).toBe("healthy")
    expect(deriveMonitoringStatus([{ reference: true, health: "stale" }])).toBe("degraded")
    expect(deriveMonitoringStatus([{ reference: false, health: "healthy" }])).toBe("degraded")
  })
})

describe("snapshotFreshness", () => {
  const generatedAtMs = Date.parse("2026-10-02T10:00:00Z")

  it("calibrates age with the server clock observed at fetch time", () => {
    // Client clock is ten minutes behind the server.
    const result = snapshotFreshness({
      generatedAtMs,
      serverTimeMs: generatedAtMs + 10_000,
      staleAfterMs: 180_000,
      fetchedAtClientMs: generatedAtMs + 10_000 - 600_000,
      nowClientMs: generatedAtMs + 10_000 - 600_000 + 200_000,
    })
    expect(result.ageMs).toBe(210_000)
    expect(result.stale).toBe(true)
    expect(result.clockUncertain).toBe(false)
  })

  it("treats an implausible future snapshot as uncertain and stale", () => {
    const result = snapshotFreshness({
      generatedAtMs: generatedAtMs + 10 * MINUTE_MS,
      serverTimeMs: generatedAtMs,
      staleAfterMs: 180_000,
      fetchedAtClientMs: generatedAtMs,
      nowClientMs: generatedAtMs,
    })
    expect(result.clockUncertain).toBe(true)
    expect(result.stale).toBe(true)
  })
})

describe("localized text", () => {
  it("falls back to English for a missing or blank translation", () => {
    expect(pickLocalized({ en: "Up", "zh-CN": "正常" }, "zh-CN")).toBe("正常")
    expect(pickLocalized({ en: "Up", "zh-CN": " " }, "zh-CN")).toBe("Up")
    expect(pickLocalized({ en: "Up" }, "zh")).toBe("Up")
    expect(pickLocalized({ en: "Up", "zh-CN": "正常" }, "en")).toBe("Up")
  })

  it("normalises arbitrary locales to the two supported ones", () => {
    expect(normalizeStatusLocale("zh-Hans")).toBe("zh-CN")
    expect(normalizeStatusLocale("fr")).toBe("en")
    expect(normalizeStatusLocale(undefined)).toBe("en")
  })
})
