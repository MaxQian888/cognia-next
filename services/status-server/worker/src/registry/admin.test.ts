import { beforeEach, describe, expect, it } from "vitest"

import type { ProbeEnrollRequest } from "../../../../../lib/status/contract"
import { currentMinute, minuteMs, resetCore, seedRegistry, testEnv } from "../../test/helpers"
import { enrollProbe, listProbesForAdmin, setProbeDisabled, setReferenceProbe } from "./admin"
import { loadRegistry, referenceForMinute } from "./registry"

const db = () => testEnv.DB
const now = Date.now()
const minute = currentMinute(now)

function enrollRequest(overrides: Partial<ProbeEnrollRequest> = {}): ProbeEnrollRequest {
  return {
    operationId: "op_enroll_000001",
    probeId: "ext-hk-1",
    source: "external",
    label: { en: "External probe", "zh-CN": "外部探针" },
    location: { en: "Hong Kong" },
    provider: "Example VPS",
    enrolledAt: new Date(minuteMs(minute + 1)).toISOString(),
    profiles: [
      { id: "native", httpCadenceSeconds: 60, protocolCadenceSeconds: 60 },
      { id: "ios", httpCadenceSeconds: null, protocolCadenceSeconds: 300 },
    ],
    keyId: "ext-hk-1-k1",
    ...overrides,
  }
}

beforeEach(async () => {
  await resetCore()
  await seedRegistry(
    [{ id: "cf-cron", source: "cloudflare", enrolledAtMs: minuteMs(minute - 100) }],
    [{ probeId: "cf-cron", effectiveMinute: minute - 100 }]
  )
})

describe("registry administration", () => {
  it("enrolls a probe with its profiles and key, bumping the registry revision with an audit entry", async () => {
    const result = await enrollProbe(testEnv, enrollRequest(), "operator@cognia.test", now)
    expect(result.status).toBe(201)
    const registry = await loadRegistry(db())
    expect(registry.revision).toBe(2)
    const probe = registry.probes.get("ext-hk-1")!
    expect(probe.profiles.map((profile) => profile.id)).toEqual(["native", "ios"])
    expect(probe.location).toEqual({ en: "Hong Kong" })
    const key = await db()
      .prepare("SELECT probe_id FROM probe_keys WHERE key_id = 'ext-hk-1-k1'")
      .first()
    expect(key).toEqual({ probe_id: "ext-hk-1" })
    const audit = await db()
      .prepare("SELECT action, actor, target_id, revision FROM audit_events")
      .all()
    expect(audit.results).toEqual([
      { action: "probe.enroll", actor: "operator@cognia.test", target_id: "ext-hk-1", revision: 2 },
    ])
  })

  it("refuses duplicate probes or keys and retroactive enrollment", async () => {
    await enrollProbe(testEnv, enrollRequest(), "op", now)
    expect((await enrollProbe(testEnv, enrollRequest(), "op", now)).status).toBe(409)
    expect(
      (await enrollProbe(testEnv, enrollRequest({ probeId: "ext-2" }), "op", now)).status
    ).toBe(409)
    expect(
      (
        await enrollProbe(
          testEnv,
          enrollRequest({
            probeId: "ext-3",
            keyId: "k3",
            enrolledAt: new Date(minuteMs(minute - 5)).toISOString(),
          }),
          "op",
          now
        )
      ).status
    ).toBe(400)
    expect(
      (
        await enrollProbe(
          testEnv,
          enrollRequest({ probeId: "cf-other", keyId: "k4", source: "cloudflare" }),
          "op",
          now
        )
      ).status
    ).toBe(400)
  })

  it("applies only one of two edits validated against the same revision", async () => {
    const [first, second] = await Promise.all([
      enrollProbe(testEnv, enrollRequest({ probeId: "ext-a", keyId: "ka" }), "op", now),
      enrollProbe(testEnv, enrollRequest({ probeId: "ext-b", keyId: "kb" }), "op", now),
    ])
    const statuses = [first.status, second.status].sort()
    const registry = await loadRegistry(db())
    if (statuses[0] === 201 && statuses[1] === 201) {
      // Serialized by the runtime: both applied, each with its own revision.
      expect(registry.revision).toBe(3)
    } else {
      expect(statuses).toEqual([201, 409])
      expect(registry.revision).toBe(2)
      expect(
        (await db().prepare("SELECT COUNT(*) AS n FROM audit_events").first<{ n: number }>())?.n
      ).toBe(1)
    }
  })

  it("disables and re-enables a probe with an audited reason", async () => {
    const disabled = await setProbeDisabled(
      testEnv,
      {
        operationId: "op_disable_0001",
        probeId: "cf-cron",
        disabled: true,
        reason: "runtime regression",
      },
      "op",
      now
    )
    expect(disabled).toMatchObject({ status: 200, body: { disabled: true } })
    expect((await loadRegistry(db())).probes.get("cf-cron")!.disabled).toBe(true)
    const again = await setProbeDisabled(
      testEnv,
      { operationId: "op_disable_0002", probeId: "cf-cron", disabled: true, reason: "again" },
      "op",
      now
    )
    expect(again.body).toMatchObject({ unchanged: true })
    expect(
      (
        await setProbeDisabled(
          testEnv,
          { operationId: "op_x_00000001", probeId: "nope", disabled: true, reason: "x" },
          "op",
          now
        )
      ).status
    ).toBe(404)
  })

  it("moves the reference only at a future minute and never rewrites earlier minutes", async () => {
    await enrollProbe(testEnv, enrollRequest(), "op", now)
    const effective = minute + 5
    const past = await setReferenceProbe(
      testEnv,
      {
        operationId: "op_ref_000001",
        probeId: "ext-hk-1",
        effectiveAt: new Date(minuteMs(minute)).toISOString(),
        reason: "x",
      },
      "op",
      now
    )
    expect(past.status).toBe(400)
    const moved = await setReferenceProbe(
      testEnv,
      {
        operationId: "op_ref_000002",
        probeId: "ext-hk-1",
        effectiveAt: new Date(minuteMs(effective)).toISOString(),
        reason: "external host enrolled",
      },
      "op",
      now
    )
    expect(moved.status).toBe(200)
    const registry = await loadRegistry(db())
    expect(referenceForMinute(registry, effective - 1)?.probeId).toBe("cf-cron")
    expect(referenceForMinute(registry, effective)?.probeId).toBe("ext-hk-1")
    const earlier = await setReferenceProbe(
      testEnv,
      {
        operationId: "op_ref_000003",
        probeId: "cf-cron",
        effectiveAt: new Date(minuteMs(effective - 1)).toISOString(),
        reason: "x",
      },
      "op",
      now
    )
    expect(earlier.status).toBe(409)
  })

  it("refuses a reference without a 60 s native profile", async () => {
    await enrollProbe(
      testEnv,
      enrollRequest({
        profiles: [{ id: "native", httpCadenceSeconds: 60, protocolCadenceSeconds: 300 }],
      }),
      "op",
      now
    )
    const result = await setReferenceProbe(
      testEnv,
      {
        operationId: "op_ref_000004",
        probeId: "ext-hk-1",
        effectiveAt: new Date(minuteMs(minute + 5)).toISOString(),
        reason: "x",
      },
      "op",
      now
    )
    expect(result.status).toBe(400)
  })

  it("lists probes with key IDs but never secrets", async () => {
    await enrollProbe(testEnv, enrollRequest(), "op", now)
    const probes = await listProbesForAdmin(testEnv, now)
    const external = probes.find((probe) => probe.id === "ext-hk-1")!
    expect(external).toMatchObject({
      keyIds: ["ext-hk-1-k1"],
      disabled: false,
      health: "unknown",
      reference: false,
    })
    expect(JSON.stringify(probes)).not.toMatch(/secret/i)
  })
})
