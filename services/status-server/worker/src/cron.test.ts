import { beforeEach, describe, expect, it } from "vitest"

import type { ComponentId, IncidentSummary, MaintenanceView } from "../../../../lib/status/contract"
import type { MinuteWindow } from "../../../../lib/status/derive"
import { parsePublicSnapshot } from "../../../../lib/status/validate"
import { FakeRelay } from "../../probe/src/testing/fake-relay"
import { currentMinute, minuteMs, resetCore, seedRegistry, testEnv } from "../test/helpers"
import { runAggregation, runScheduled, RETENTION_MINUTE, type CronModules } from "./cron"
import { acquireLease } from "./platform/lease"
import { runCloudflareProbe } from "./probe/cron-probe"
import { loadRegistry } from "./registry/registry"
import type { ReconcileInput } from "./seams"

const db = () => testEnv.DB

interface Recorder {
  modules: CronModules
  reconciled: ReconcileInput[]
  calls: string[]
}

function fakeModules(
  overrides: { maintenance?: ComponentId[]; windows?: Record<ComponentId, MinuteWindow[]> } = {}
): Recorder {
  const recorder: Recorder = {
    reconciled: [],
    calls: [],
    modules: undefined as unknown as CronModules,
  }
  const empty: Record<ComponentId, MinuteWindow[]> = {
    signalingHttp: [],
    signalingAuth: [],
    relayData: [],
  }
  recorder.modules = {
    incidents: {
      reconcileIncidents: async (_job, input) => {
        recorder.calls.push("reconcile")
        recorder.reconciled.push(input)
      },
      loadIncidentsForSnapshot: async () => ({
        active: [] as IncidentSummary[],
        past: [] as IncidentSummary[],
      }),
    },
    maintenance: {
      advanceMaintenance: async () => {
        recorder.calls.push("advanceMaintenance")
      },
      loadExclusionWindows: async () => overrides.windows ?? empty,
      activeMaintenanceComponents: async () => new Set(overrides.maintenance ?? []),
      loadMaintenanceForSnapshot: async () => [] as MaintenanceView[],
    },
    notifications: {
      runDelivery: async () => {
        recorder.calls.push("delivery")
      },
      runNotificationRetention: async () => {
        recorder.calls.push("notificationRetention")
      },
    },
    subscriptions: {
      emailCapability: () => false,
      runSubscriptionRetention: async () => {
        recorder.calls.push("subscriptionRetention")
      },
    },
  }
  return recorder
}

const envWith = (overrides: Partial<typeof testEnv> = {}) => ({ ...testEnv, ...overrides })

async function snapshotBody(range = "24h") {
  const row = await db()
    .prepare("SELECT body FROM snapshots WHERE range = ?")
    .bind(range)
    .first<{ body: string }>()
  return row ? JSON.parse(row.body) : null
}

beforeEach(async () => {
  await resetCore()
})

describe("Cloudflare Cron observer", () => {
  const minute = currentMinute() - 1
  const scheduled = minuteMs(minute - (minute % 5))
  // The Cron fires at its scheduled minute; a clock pinned just after it
  // keeps the run inside the ingestion skew window.
  const clock = () => scheduled + 1_000

  beforeEach(async () => {
    await seedRegistry(
      [
        {
          id: "cf-cron",
          source: "cloudflare",
          enrolledAtMs: minuteMs(minute - 60),
          profiles: [
            { id: "native", http: 60, protocol: 60 },
            { id: "android", http: null, protocol: 300 },
          ],
        },
      ],
      [{ probeId: "cf-cron", effectiveMinute: minute - 60 }]
    )
  })

  it("runs every due profile through the real protocol core and records the reference minute", async () => {
    const relay = new FakeRelay({ allowedOrigins: ["https://localhost"] })
    const runs = await runCloudflareProbe({
      env: testEnv,
      registry: await loadRegistry(db()),
      scheduledTimeMs: scheduled,
      transport: relay,
      now: clock,
    })
    expect(runs.map((run) => [run.profileId, run.outcome.ok])).toEqual([
      ["native", true],
      ["android", true],
    ])
    expect(relay.origins).toEqual(expect.arrayContaining([null, "https://localhost"]))
    const slot = await db()
      .prepare("SELECT http, auth, data FROM reference_slots WHERE minute = ?")
      .bind(scheduled / 60_000)
      .first()
    expect(slot).toEqual({ http: "pass", auth: "pass", data: "pass" })
  })

  it("records a refused Origin as an observed failure of that profile only", async () => {
    const relay = new FakeRelay({ allowedOrigins: [] })
    await runCloudflareProbe({
      env: testEnv,
      registry: await loadRegistry(db()),
      scheduledTimeMs: scheduled,
      transport: relay,
      now: clock,
    })
    const android = await db()
      .prepare("SELECT checks_json FROM probe_runs WHERE profile_id = 'android'")
      .first<{ checks_json: string }>()
    const checks = JSON.parse(android!.checks_json)
    expect(checks[0]).toMatchObject({ checkId: "signalingAuth", result: "fail" })
    expect(checks[1]).toMatchObject({
      checkId: "relayData",
      result: "unknown",
      reason: "dependency_failed",
    })
    const slot = await db().prepare("SELECT auth FROM reference_slots").first()
    expect(slot).toEqual({ auth: "pass" })
  })

  it("skips Origin profiles whose Origin is not configured", async () => {
    const runs = await runCloudflareProbe({
      env: envWith({ PROBE_ORIGIN_PROFILES: "{}" }),
      registry: await loadRegistry(db()),
      scheduledTimeMs: scheduled,
      transport: new FakeRelay(),
    })
    expect(runs.find((run) => run.profileId === "android")?.outcome).toMatchObject({
      ok: false,
      reason: "origin_unconfigured",
    })
  })

  it("records an observer failure, not an outage, when the runner itself breaks", async () => {
    const broken = {
      getJson: () => {
        throw new TypeError("runtime feature missing")
      },
      openSocket: () => {
        throw new TypeError("runtime feature missing")
      },
    }
    await runCloudflareProbe({
      env: testEnv,
      registry: await loadRegistry(db()),
      scheduledTimeMs: minuteMs(minute - (minute % 5) + 1),
      transport: broken as never,
      now: () => minuteMs(minute - (minute % 5) + 1) + 1_000,
    })
    const slot = await db()
      .prepare("SELECT http, auth, data, http_reason FROM reference_slots")
      .first()
    expect(slot).toMatchObject({
      http: "unknown",
      auth: "unknown",
      data: "unknown",
      http_reason: "runner_error",
    })
  })

  it("does nothing for a disabled observer", async () => {
    await db().prepare("UPDATE probes SET disabled = 1").run()
    const runs = await runCloudflareProbe({
      env: testEnv,
      registry: await loadRegistry(db()),
      scheduledTimeMs: scheduled,
      transport: new FakeRelay(),
    })
    expect(runs).toEqual([])
  })
})

describe("aggregation and publication", () => {
  const now = Date.now()
  const minute = currentMinute(now)

  async function seedSlots(results: Array<[string, string, string]>) {
    const start = minute - results.length
    const statements = results.map(([http, auth, data], index) =>
      db()
        .prepare(
          `INSERT INTO reference_slots (minute, reference_revision, probe_id, run_id, http, auth, data, http_ms, auth_ms, data_ms, received_at)
           VALUES (?, 1, 'cf-cron', ?, ?, ?, ?, 40, 800, 300, 0)`
        )
        .bind(start + index, `r${index}`, http, auth, data)
    )
    statements.push(
      db()
        .prepare("INSERT INTO dirty_hours (hour, seq) VALUES (?, 1)")
        .bind(Math.floor(minuteMs(start) / 3_600_000)),
      db()
        .prepare("INSERT OR REPLACE INTO dirty_hours (hour, seq) VALUES (?, 1)")
        .bind(Math.floor(minuteMs(minute - 1) / 3_600_000))
    )
    await db().batch(statements)
  }

  beforeEach(async () => {
    await seedRegistry(
      [{ id: "cf-cron", source: "cloudflare", enrolledAtMs: minuteMs(minute - 30) }],
      [{ probeId: "cf-cron", effectiveMinute: minute - 30 }]
    )
  })

  it("publishes a valid snapshot for every range with evaluated components", async () => {
    await seedSlots([
      ["pass", "pass", "pass"],
      ["pass", "fail", "unknown"],
      ["pass", "fail", "unknown"],
      ["pass", "fail", "unknown"],
    ])
    const recorder = fakeModules()
    const lease = (await acquireLease(db(), "aggregate", now))!
    const revision = await runAggregation({ env: testEnv, lease, nowMs: now }, recorder.modules)
    expect(revision).toBe(1)
    for (const range of ["24h", "7d", "30d", "90d"]) {
      const body = await snapshotBody(range)
      expect(parsePublicSnapshot(body)).toMatchObject({ ok: true })
    }
    const snapshot = await snapshotBody("24h")
    const status = Object.fromEntries(
      snapshot.components.map((component: { id: string; status: string }) => [
        component.id,
        component.status,
      ])
    )
    expect(status).toEqual({
      signalingHttp: "operational",
      signalingAuth: "major_outage",
      relayData: "unknown",
    })
    expect(snapshot.overallStatus).toBe("major_outage")
    expect(snapshot.monitoringStatus).toBe("degraded") // no fresh runs from the observer itself
    expect(recorder.calls).toEqual(["advanceMaintenance", "reconcile"])
    expect(
      recorder.reconciled[0].evaluations.find((item) => item.componentId === "signalingAuth")
        ?.referenceStreaks.failures
    ).toBe(3)
  })

  it("refuses to publish after losing the lease", async () => {
    await seedSlots([["pass", "pass", "pass"]])
    const lease = (await acquireLease(db(), "aggregate", now, 1_000))!
    await acquireLease(db(), "aggregate", now + 1_000)
    await runAggregation({ env: testEnv, lease, nowMs: now + 1_001 }, fakeModules().modules)
    expect(await snapshotBody()).toBeNull()
  })

  it("never lets an older revision overwrite a newer snapshot", async () => {
    await seedSlots([["pass", "pass", "pass"]])
    await db()
      .prepare(
        "INSERT INTO snapshots (range, revision, generated_at, etag, body) VALUES ('24h', 999, 0, 'x', '{}')"
      )
      .run()
    const lease = (await acquireLease(db(), "aggregate", now))!
    await runAggregation({ env: testEnv, lease, nowMs: now }, fakeModules().modules)
    expect(
      (await db().prepare("SELECT revision FROM snapshots WHERE range = '24h'").first())?.revision
    ).toBe(999)
  })

  it("continues to publish when reconciliation fails", async () => {
    await seedSlots([["pass", "pass", "pass"]])
    const recorder = fakeModules()
    recorder.modules.incidents.reconcileIncidents = async () => {
      throw new Error("incident store down")
    }
    const lease = (await acquireLease(db(), "aggregate", now))!
    await runAggregation({ env: testEnv, lease, nowMs: now }, recorder.modules)
    expect(await snapshotBody()).not.toBeNull()
  })
})

describe("runScheduled", () => {
  it("runs probe, aggregation and delivery each minute and retention once an hour", async () => {
    const minute = currentMinute()
    await seedRegistry(
      [{ id: "cf-cron", source: "cloudflare", enrolledAtMs: minuteMs(minute - 5) }],
      [{ probeId: "cf-cron", effectiveMinute: minute - 5 }]
    )
    const recorder = fakeModules()
    const scheduledTime = minuteMs(minute - (minute % 60) + RETENTION_MINUTE)
    await runScheduled(testEnv, scheduledTime, recorder.modules, {
      transport: new FakeRelay(),
      now: () => scheduledTime + 1_000,
    })
    expect(recorder.calls).toEqual(
      expect.arrayContaining([
        "advanceMaintenance",
        "reconcile",
        "delivery",
        "subscriptionRetention",
        "notificationRetention",
      ])
    )
    expect(await snapshotBody()).not.toBeNull()
  })
})
