import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  T0,
  MINUTE,
  baseEnv,
  count,
  evaluation,
  jobAt,
  resetOwnerE,
  stealLease,
} from "../admin/test-support"
import type { ReconcileInput } from "../seams"
import { decideAutomation, reconcileIncidents, RESOLVE_CONSECUTIVE_PASSES } from "./reconcile"
import {
  committed,
  planIncidentTransition,
  readOpenIncidentByFingerprint,
  readUpdates,
} from "./store"

const healthyObserver: ReconcileInput["observer"] = {
  referenceProbeId: "ext-1",
  referenceHealthy: true,
  lastReferenceAtMs: T0 - MINUTE,
}

async function reconcileAt(
  nowMs: number,
  evaluations: ReconcileInput["evaluations"],
  env = baseEnv
) {
  const job = await jobAt("aggregate", nowMs, env)
  await reconcileIncidents(job, { evaluations, observer: healthyObserver })
  await env.DB.prepare(
    "UPDATE leases SET owner = NULL, expires_at = 0 WHERE job = 'aggregate'"
  ).run()
  return job
}

describe("decideAutomation", () => {
  const context = { nowMs: T0, manualIncidentCovers: false }

  it("opens only after three consecutive fresh reference failures outside maintenance", () => {
    expect(decideAutomation(evaluation({ failures: 2 }), null, context).kind).toBe("none")
    expect(decideAutomation(evaluation({ failures: 3 }), null, context)).toEqual({
      kind: "open",
      impact: "major_outage",
    })
    expect(
      decideAutomation(evaluation({ failures: 3, inMaintenance: true }), null, context).kind
    ).toBe("none")
    expect(
      decideAutomation(evaluation({ failures: 3, referenceFresh: false }), null, context).kind
    ).toBe("none")
    expect(
      decideAutomation(evaluation({ failures: 3 }), null, {
        ...context,
        manualIncidentCovers: true,
      }).kind
    ).toBe("none")
  })

  it("never acts on an old evaluation (no historic opens)", () => {
    const old = evaluation({ failures: 5, evaluatedAtMs: T0 - 10 * MINUTE })
    expect(decideAutomation(old, null, context)).toEqual({
      kind: "none",
      reason: "stale_evaluation",
    })
  })

  it("is partial when a fresh witness still passes", () => {
    const decision = decideAutomation(
      evaluation({
        failures: 3,
        witnesses: [
          {
            probeId: "cf",
            profileId: "native",
            source: "cloudflare",
            result: "pass",
            consecutiveFailures: 0,
          },
        ],
      }),
      null,
      context
    )
    expect(decision).toEqual({ kind: "open", impact: "partial_outage" })
  })

  it("leaves pinned and manual incidents alone", () => {
    const open = {
      state: "investigating" as const,
      impact: "major_outage" as const,
      source: "automated" as const,
      pinned: true,
      updatedAtMs: T0 - MINUTE,
    }
    expect(decideAutomation(evaluation({ passes: 9 }), open, context).kind).toBe("none")
    expect(
      decideAutomation(
        evaluation({ passes: 9 }),
        { ...open, pinned: false, source: "manual" },
        context
      ).kind
    ).toBe("none")
  })

  it("holds resolution while a native witness fails and labels corroboration", () => {
    const open = {
      state: "monitoring" as const,
      impact: "major_outage" as const,
      source: "automated" as const,
      pinned: false,
      updatedAtMs: T0 - MINUTE,
    }
    const failingWitness = {
      probeId: "cf",
      profileId: "native" as const,
      source: "cloudflare" as const,
      result: "fail" as const,
      consecutiveFailures: 2,
    }
    const passingWitness = { ...failingWitness, result: "pass" as const, consecutiveFailures: 0 }
    const passes = RESOLVE_CONSECUTIVE_PASSES
    expect(
      decideAutomation(evaluation({ passes, witnesses: [failingWitness] }), open, context).kind
    ).toBe("none")
    expect(
      decideAutomation(evaluation({ passes, witnesses: [passingWitness] }), open, context)
    ).toEqual({
      kind: "resolve",
      corroborated: true,
    })
    expect(decideAutomation(evaluation({ passes }), open, context)).toEqual({
      kind: "resolve",
      corroborated: false,
    })
  })

  it("escalates a partial outage once no witness passes, never de-escalates", () => {
    const open = {
      state: "investigating" as const,
      impact: "partial_outage" as const,
      source: "automated" as const,
      pinned: false,
      updatedAtMs: T0 - MINUTE,
    }
    expect(decideAutomation(evaluation({ failures: 4 }), open, context)).toEqual({
      kind: "escalate",
    })
    expect(
      decideAutomation(evaluation({ failures: 4 }), { ...open, impact: "major_outage" }, context)
        .kind
    ).toBe("none")
  })
})

describe("reconcileIncidents", () => {
  beforeEach(async () => {
    await resetOwnerE()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("opens one automated incident with one update and one event, even when replayed", async () => {
    const failing = evaluation({ failures: 3 })
    await reconcileAt(T0, [failing])
    await reconcileAt(T0, [failing])
    await reconcileAt(T0 + 1_000, [
      {
        ...failing,
        evaluatedAtMs: T0 + 1_000,
        referenceStreaks: { failures: 4, passes: 0, failuresBeforePasses: 0 },
      },
    ])

    expect(await count("incidents")).toBe(1)
    const open = await readOpenIncidentByFingerprint(baseEnv.DB, "signalingAuth")
    expect(open).toMatchObject({
      source: "automated",
      state: "investigating",
      impact: "major_outage",
      revision: 1,
    })
    expect(await count("incident_updates")).toBe(1)
    expect(await count("notification_events", "kind = 'incident.opened'")).toBe(1)
    const [update] = await readUpdates(baseEnv.DB, open!.id)
    const message = JSON.parse(update!.message_json) as { en: string; "zh-CN": string }
    // Observed facts only: counts and witnesses, no invented cause.
    expect(message.en).toContain("3 consecutive failed checks")
    expect(message.en).toContain("single-witness")
    expect(message["zh-CN"]).toContain("连续失败 3 次")
  })

  it("does nothing when automation is off", async () => {
    await reconcileAt(T0, [evaluation({ failures: 5 })], {
      ...baseEnv,
      FEATURE_INCIDENT_AUTOMATION: "off",
    })
    expect(await count("incidents")).toBe(0)
  })

  it("still alerts the operator about a silent observer when automation is off", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))
    const env = {
      ...baseEnv,
      FEATURE_INCIDENT_AUTOMATION: "off",
      OPERATOR_ALERT_WEBHOOK: "https://alerts.example.test/hook",
    }
    const job = await jobAt("aggregate", T0, env)
    await reconcileIncidents(job, {
      evaluations: [evaluation({ failures: 6, evaluatedAtMs: T0 })],
      observer: { referenceProbeId: "cf-cron", referenceHealthy: false, lastReferenceAtMs: null },
    })
    expect(await count("incidents")).toBe(0)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://alerts.example.test/hook")
    fetchSpy.mockRestore()
    await baseEnv.DB.prepare(
      "UPDATE leases SET owner = NULL, expires_at = 0 WHERE job = 'aggregate'"
    ).run()
  })

  it("never opens from unknown or stale reference evidence; it alerts the operator instead", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))
    const env = { ...baseEnv, OPERATOR_ALERT_WEBHOOK: "https://alerts.example.test/hook" }
    for (const offset of [0, MINUTE]) {
      const job = await jobAt("aggregate", T0 + offset, env)
      await reconcileIncidents(job, {
        evaluations: [
          evaluation({ failures: 6, referenceFresh: false, evaluatedAtMs: T0 + offset }),
        ],
        observer: {
          referenceProbeId: "ext-1",
          referenceHealthy: false,
          lastReferenceAtMs: T0 - 10 * MINUTE,
        },
      })
      await baseEnv.DB.prepare(
        "UPDATE leases SET owner = NULL, expires_at = 0 WHERE job = 'aggregate'"
      ).run()
    }
    expect(await count("incidents")).toBe(0)
    expect(await count("operator_alerts", "key = 'observer:ext-1'")).toBe(1)
    // De-duplicated: one webhook call for two unhealthy minutes.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toBe("https://alerts.example.test/hook")
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      key: "observer:ext-1",
      severity: "warning",
    })
  })

  it("moves through monitoring to an uncorroborated resolution", async () => {
    await reconcileAt(T0, [evaluation({ failures: 3 })])
    const id = (await readOpenIncidentByFingerprint(baseEnv.DB, "signalingAuth"))!.id

    await reconcileAt(T0 + 2 * MINUTE, [evaluation({ passes: 2, evaluatedAtMs: T0 + 2 * MINUTE })])
    expect((await readUpdates(baseEnv.DB, id)).map((row) => row.state)).toEqual([
      "investigating",
      "monitoring",
    ])

    // Not yet stable: no change.
    await reconcileAt(T0 + 3 * MINUTE, [evaluation({ passes: 3, evaluatedAtMs: T0 + 3 * MINUTE })])
    expect(await count("incident_updates")).toBe(2)

    await reconcileAt(T0 + 5 * MINUTE, [evaluation({ passes: 5, evaluatedAtMs: T0 + 5 * MINUTE })])
    const updates = await readUpdates(baseEnv.DB, id)
    expect(updates.map((row) => row.state)).toEqual(["investigating", "monitoring", "resolved"])
    expect(JSON.parse(updates[2]!.message_json).en).toContain("uncorroborated")
    expect(await readOpenIncidentByFingerprint(baseEnv.DB, "signalingAuth")).toBeNull()
    expect(await count("notification_events", "kind = 'incident.resolved'")).toBe(1)
  })

  it("returns to investigating once on a fresh failure while monitoring", async () => {
    await reconcileAt(T0, [evaluation({ failures: 3 })])
    await reconcileAt(T0 + 2 * MINUTE, [evaluation({ passes: 2, evaluatedAtMs: T0 + 2 * MINUTE })])
    await reconcileAt(T0 + 3 * MINUTE, [
      evaluation({ failures: 1, evaluatedAtMs: T0 + 3 * MINUTE }),
    ])
    await reconcileAt(T0 + 4 * MINUTE, [
      evaluation({ failures: 2, evaluatedAtMs: T0 + 4 * MINUTE }),
    ])
    const id = (await readOpenIncidentByFingerprint(baseEnv.DB, "signalingAuth"))!.id
    expect((await readUpdates(baseEnv.DB, id)).map((row) => row.state)).toEqual([
      "investigating",
      "monitoring",
      "investigating",
    ])
  })

  it("opens a new incident linked to its predecessor after resolution, never reopening", async () => {
    await reconcileAt(T0, [evaluation({ failures: 3 })])
    const first = (await readOpenIncidentByFingerprint(baseEnv.DB, "signalingAuth"))!.id
    await reconcileAt(T0 + 2 * MINUTE, [evaluation({ passes: 2, evaluatedAtMs: T0 + 2 * MINUTE })])
    await reconcileAt(T0 + 5 * MINUTE, [evaluation({ passes: 5, evaluatedAtMs: T0 + 5 * MINUTE })])
    await reconcileAt(T0 + 9 * MINUTE, [
      evaluation({ failures: 3, evaluatedAtMs: T0 + 9 * MINUTE }),
    ])

    const second = await readOpenIncidentByFingerprint(baseEnv.DB, "signalingAuth")
    expect(second!.id).not.toBe(first)
    expect(second!.predecessor_id).toBe(first)
    const old = await baseEnv.DB.prepare("SELECT state FROM incidents WHERE id = ?")
      .bind(first)
      .first<{ state: string }>()
    expect(old!.state).toBe("resolved")
  })

  it("never changes a pinned incident", async () => {
    await reconcileAt(T0, [evaluation({ failures: 3 })])
    await baseEnv.DB.prepare(
      "UPDATE incidents SET pinned = 1, manual_owner = 'operator@cognia.test'"
    ).run()
    await reconcileAt(T0 + 2 * MINUTE, [evaluation({ passes: 2, evaluatedAtMs: T0 + 2 * MINUTE })])
    await reconcileAt(T0 + 6 * MINUTE, [evaluation({ passes: 6, evaluatedAtMs: T0 + 6 * MINUTE })])
    expect(await count("incident_updates")).toBe(1)
    expect(await count("incidents", "state = 'investigating'")).toBe(1)
  })

  it("does not duplicate an open manual incident for the same component", async () => {
    await baseEnv.DB.prepare(
      `INSERT INTO incidents (id, title_json, state, impact, component_ids_json, source, fingerprint, pinned,
         manual_owner, started_at, resolved_at, updated_at, revision, predecessor_id, write_token)
       VALUES ('inc_manual', '{"en":"Manual"}', 'identified', 'major_outage', '["signalingAuth"]', 'manual', NULL, 1,
         'operator@cognia.test', ?, NULL, ?, 1, NULL, 'w')`
    )
      .bind(T0 - MINUTE, T0 - MINUTE)
      .run()
    await reconcileAt(T0, [evaluation({ failures: 4 })])
    expect(await count("incidents")).toBe(1)
  })

  it("commits nothing once the lease is lost", async () => {
    const job = await jobAt("aggregate", T0)
    await stealLease(job.lease)
    await reconcileIncidents(job, {
      evaluations: [evaluation({ failures: 3 })],
      observer: healthyObserver,
    })
    expect(await count("incidents")).toBe(0)
    expect(await count("incident_updates")).toBe(0)
    expect(await count("notification_events")).toBe(0)
  })

  it("does not append an update when the revision moved under it (zero-row CAS)", async () => {
    await reconcileAt(T0, [evaluation({ failures: 3 })])
    const open = (await readOpenIncidentByFingerprint(baseEnv.DB, "signalingAuth"))!
    // A concurrent writer moves the revision after this runner read it.
    await baseEnv.DB.prepare("UPDATE incidents SET revision = revision + 1 WHERE id = ?")
      .bind(open.id)
      .run()
    const plan = planIncidentTransition(baseEnv.DB, {
      current: open,
      currentUpdates: await readUpdates(baseEnv.DB, open.id),
      expectedRevision: 1,
      state: "monitoring",
      impact: open.impact,
      componentIds: ["signalingAuth"],
      pinned: false,
      manualOwner: null,
      update: {
        message: { en: "stale" },
        source: "automated",
        atMs: T0 + MINUTE,
        evidenceAtMs: null,
        correctionOf: null,
      },
      notify: true,
      automationOnly: true,
    })
    expect(committed(await baseEnv.DB.batch(plan.statements))).toBe(false)
    expect(await count("incident_updates")).toBe(1)
    expect(await count("notification_events")).toBe(1)
  })
})
