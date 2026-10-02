import { describe, expect, it } from "vitest"

import {
  HOUR_MS,
  type CheckObservation,
  type CheckResult,
  type ProfileId,
} from "../../../../../lib/status/contract"
import { addLatencySample, emptyLatencyHistogram } from "../../../../../lib/status/derive"
import type { ProbeRecord, Registry } from "../registry/registry"
import { evaluateComponents, latencyDegraded } from "./evaluate"
import type { RecentEvidence, RecentRun, ReferenceSlot } from "./evidence"
import { emptyRollup, type Rollup } from "./rollup"

const NOW = Date.parse("2026-10-02T10:00:30.000Z")
const NOW_MINUTE = Math.floor(NOW / 60_000)

function probe(id: string, overrides: Partial<ProbeRecord> = {}): ProbeRecord {
  return {
    id,
    source: id.startsWith("cf") ? "cloudflare" : "external",
    label: { en: id },
    location: null,
    provider: null,
    enrolledAtMs: NOW - 86_400_000,
    retiredAtMs: null,
    disabled: false,
    disabledReason: null,
    registryRevision: 1,
    profiles: [{ id: "native", httpCadenceSeconds: 60, protocolCadenceSeconds: 60 }],
    ...overrides,
  }
}

function registry(probes: ProbeRecord[], referenceId = "cf-cron"): Registry {
  return {
    revision: 1,
    probes: new Map(probes.map((item) => [item.id, item])),
    epochs: [{ revision: 1, probeId: referenceId, effectiveMinute: NOW_MINUTE - 1440 }],
  }
}

/** Reference slots for the last N minutes, oldest first (ending at minute NOW-1). */
function slots(
  results: Array<[CheckResult, CheckResult, CheckResult] | null>
): Map<number, ReferenceSlot> {
  const map = new Map<number, ReferenceSlot>()
  results.forEach((result, index) => {
    const minute = NOW_MINUTE - results.length + index
    if (!result) return
    const [http, auth, data] = result
    map.set(minute, {
      minute,
      probeId: "cf-cron",
      results: {
        http: { result: http, reason: http === "pass" ? null : "http_status", ms: 50 },
        auth: { result: auth, reason: auth === "pass" ? null : "auth_timeout", ms: 900 },
        data: { result: data, reason: data === "pass" ? null : "dependency_failed", ms: 300 },
      },
    })
  })
  return map
}

function run(
  probeId: string,
  profileId: ProfileId,
  minute: number,
  checks: CheckObservation[]
): RecentRun {
  return {
    probeId,
    profileId,
    scheduledMinute: minute,
    scheduledAtMs: minute * 60_000,
    finishedAtMs: minute * 60_000 + 3_000,
    checks,
  }
}

const ok = (checkId: CheckObservation["checkId"]): CheckObservation => ({
  checkId,
  result: "pass",
  durationMs: 100,
  reason: null,
  attempted: true,
  dependsOn: null,
})
const bad = (checkId: CheckObservation["checkId"]): CheckObservation => ({
  checkId,
  result: "fail",
  durationMs: 100,
  reason: "origin_rejected",
  attempted: true,
  dependsOn: null,
})

const PASS: [CheckResult, CheckResult, CheckResult] = ["pass", "pass", "pass"]
const AUTH_DOWN: [CheckResult, CheckResult, CheckResult] = ["pass", "fail", "unknown"]

function evaluate(
  evidence: RecentEvidence,
  reg = registry([probe("cf-cron")]),
  maintenance = new Set<never>()
) {
  return evaluateComponents({
    registry: reg,
    evidence,
    hourly: new Map(),
    maintenanceComponents: maintenance,
    nowMs: NOW,
  })
}

function byId(results: ReturnType<typeof evaluate>, id: string) {
  return results.find((item) => item.evaluation.componentId === id)!
}

describe("evaluateComponents", () => {
  it("reports operational single-witness evidence from passing reference minutes", () => {
    const results = evaluate({ runs: [], slots: slots([PASS, PASS, PASS]) })
    for (const item of results) {
      expect(item.evaluation.status).toBe("operational")
      expect(item.evaluation.confidence).toBe("single_witness")
      expect(item.evaluation.referenceFresh).toBe(true)
      expect(item.evidence[0]).toMatchObject({ reference: true, result: "pass", fresh: true })
    }
  })

  it("keeps HTTP operational while authentication is down and leaves data unknown", () => {
    const results = evaluate({ runs: [], slots: slots([AUTH_DOWN, AUTH_DOWN, AUTH_DOWN]) })
    expect(byId(results, "signalingHttp").evaluation.status).toBe("operational")
    expect(byId(results, "signalingAuth").evaluation.status).toBe("major_outage")
    expect(byId(results, "signalingAuth").evaluation.referenceStreaks.failures).toBe(3)
    expect(byId(results, "relayData").evaluation.status).toBe("unknown")
  })

  it("goes unknown, not green, when the reference stops reporting", () => {
    const results = evaluate({ runs: [], slots: slots([PASS, null, null, null, null]) })
    for (const item of results) {
      expect(item.evaluation.status).toBe("unknown")
      expect(item.evidence[0]).toMatchObject({ result: "unknown", reason: "stale", fresh: false })
    }
  })

  it("counts missing due minutes as gaps that break a failure streak", () => {
    const results = evaluate({
      runs: [],
      slots: slots([AUTH_DOWN, null, null, AUTH_DOWN, AUTH_DOWN]),
    })
    const auth = byId(results, "signalingAuth").evaluation
    expect(auth.referenceStreaks.failures).toBe(2)
    expect(auth.status).toBe("degraded")
    expect(
      auth.referenceRecent.slice(-5).filter((point) => point.result === "missing")
    ).toHaveLength(2)
  })

  it("reports a partial outage when a simulated Origin profile repeatedly fails", () => {
    const reg = registry([
      probe("cf-cron", {
        profiles: [
          { id: "native", httpCadenceSeconds: 60, protocolCadenceSeconds: 60 },
          { id: "android", httpCadenceSeconds: null, protocolCadenceSeconds: 300 },
        ],
      }),
    ])
    const last5 = Math.floor(NOW_MINUTE / 5) * 5
    const runs = [last5 - 5, last5].map((minute) =>
      run("cf-cron", "android", minute, [bad("signalingAuth")])
    )
    const results = evaluate({ runs, slots: slots([PASS, PASS, PASS]) }, reg)
    const auth = byId(results, "signalingAuth")
    expect(auth.evaluation.status).toBe("partial_outage")
    expect(auth.evidence.find((item) => item.profileId === "android")).toMatchObject({
      simulatedOrigin: true,
      result: "fail",
      reason: "origin_rejected",
      consecutiveFailures: 2,
    })
    // HTTP is not part of the Origin profile and stays operational.
    expect(byId(results, "signalingHttp").evaluation.status).toBe("operational")
  })

  it("is corroborated when an external native witness agrees", () => {
    const reg = registry([probe("cf-cron"), probe("ext-1")])
    const runs = [NOW_MINUTE - 2, NOW_MINUTE - 1].map((minute) =>
      run("ext-1", "native", minute, [ok("signalingHttp"), ok("signalingAuth"), ok("relayData")])
    )
    const results = evaluate({ runs, slots: slots([PASS, PASS]) }, reg)
    expect(byId(results, "relayData").evaluation.confidence).toBe("corroborated")
    expect(byId(results, "relayData").evaluation.witnesses).toEqual([
      {
        probeId: "ext-1",
        profileId: "native",
        source: "external",
        result: "pass",
        consecutiveFailures: 0,
      },
    ])
  })

  it("ignores disabled witnesses", () => {
    const reg = registry([probe("cf-cron"), probe("ext-1", { disabled: true })])
    const runs = [run("ext-1", "native", NOW_MINUTE - 1, [bad("signalingAuth")])]
    const results = evaluate({ runs, slots: slots([PASS, PASS]) }, reg)
    expect(byId(results, "signalingAuth").evidence.map((item) => item.probeId)).toEqual(["cf-cron"])
  })

  it("shows maintenance only for components in scope", () => {
    const results = evaluateComponents({
      registry: registry([probe("cf-cron")]),
      evidence: { runs: [], slots: slots([AUTH_DOWN, AUTH_DOWN, AUTH_DOWN]) },
      hourly: new Map(),
      maintenanceComponents: new Set(["signalingAuth"]),
      nowMs: NOW,
    })
    expect(byId(results, "signalingAuth").evaluation.status).toBe("maintenance")
    expect(byId(results, "signalingHttp").evaluation.inMaintenance).toBe(false)
  })
})

describe("latencyDegraded", () => {
  function slowHour(samples: number, ms: number): Rollup {
    const rollup = emptyRollup(true)
    const histogram = emptyLatencyHistogram()
    for (let index = 0; index < samples; index += 1) addLatencySample(histogram, ms)
    rollup.c.signalingAuth.h = histogram
    return rollup
  }
  const hour = Math.floor(NOW / HOUR_MS)

  it("trips after three complete slow hours with enough samples", () => {
    const hourly = new Map([1, 2, 3].map((offset) => [hour - offset, slowHour(60, 2_500)] as const))
    expect(latencyDegraded("signalingAuth", hourly, NOW)).toBe(true)
  })

  it("does not trip on thin samples or a fast hour", () => {
    const thin = new Map([1, 2, 3].map((offset) => [hour - offset, slowHour(10, 2_500)] as const))
    expect(latencyDegraded("signalingAuth", thin, NOW)).toBe(false)
    const mixed = new Map([
      [hour - 1, slowHour(60, 2_500)],
      [hour - 2, slowHour(60, 200)],
      [hour - 3, slowHour(60, 2_500)],
    ])
    expect(latencyDegraded("signalingAuth", mixed, NOW)).toBe(false)
  })

  it("lowers an operational verdict to degraded", () => {
    const hourly = new Map([1, 2, 3].map((offset) => [hour - offset, slowHour(60, 2_500)] as const))
    const results = evaluateComponents({
      registry: registry([probe("cf-cron")]),
      evidence: { runs: [], slots: slots([PASS, PASS, PASS]) },
      hourly,
      maintenanceComponents: new Set(),
      nowMs: NOW,
    })
    expect(byId(results, "signalingAuth").evaluation).toMatchObject({
      status: "degraded",
      latencyDegraded: true,
    })
    expect(byId(results, "signalingHttp").evaluation.status).toBe("operational")
  })
})
