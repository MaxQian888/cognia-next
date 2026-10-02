import { beforeEach, describe, expect, it } from "vitest"

import { LATE_OBSERVATION_MS, SIGNATURE_WINDOW_MS } from "../../../../../lib/status/contract"
import {
  batch,
  check,
  currentMinute,
  EXT_KEY_ID,
  executionContext,
  minuteMs,
  OTHER_KEY_ID,
  OTHER_SECRET,
  resetCore,
  seedRegistry,
  signedObservationRequest,
  testEnv,
} from "../../test/helpers"
import worker from "../index"

const db = () => testEnv.DB
const now = Date.now()
const minute = currentMinute(now) - 1
const scheduledAtMs = minuteMs(minute)

async function call(request: Request) {
  const ctx = executionContext()
  const response = await worker.fetch(request, testEnv, ctx)
  await ctx.settle()
  return response
}

beforeEach(async () => {
  await resetCore()
  await seedRegistry(
    [
      {
        id: "ext-a",
        enrolledAtMs: minuteMs(minute - 60),
        keyId: EXT_KEY_ID,
        profiles: [
          { id: "native", http: 60, protocol: 60 },
          { id: "android", http: null, protocol: 300 },
        ],
      },
      { id: "ext-b", enrolledAtMs: minuteMs(minute - 60), keyId: OTHER_KEY_ID },
    ],
    [{ probeId: "ext-a", effectiveMinute: minute - 60 }]
  )
})

describe("POST /api/status/v1/observations", () => {
  it("accepts a signed reference run, fills its minute slot and marks the hour dirty", async () => {
    const response = await call(
      await signedObservationRequest(batch({ probeId: "ext-a", runId: "run_1", scheduledAtMs }))
    )
    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toEqual({ status: "accepted", runId: "run_1" })
    const slot = await db()
      .prepare("SELECT http, auth, data, http_ms, probe_id FROM reference_slots WHERE minute = ?")
      .bind(minute)
      .first()
    expect(slot).toMatchObject({
      http: "pass",
      auth: "pass",
      data: "pass",
      http_ms: 120,
      probe_id: "ext-a",
    })
    const dirty = await db().prepare("SELECT hour FROM dirty_hours").all()
    expect(dirty.results).toEqual([{ hour: Math.floor(scheduledAtMs / 3_600_000) }])
  })

  it("treats an exact replay as an idempotent duplicate", async () => {
    const body = batch({ probeId: "ext-a", runId: "run_dup", scheduledAtMs })
    expect((await call(await signedObservationRequest(body))).status).toBe(202)
    const replay = await call(await signedObservationRequest(body))
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toEqual({ status: "duplicate", runId: "run_dup" })
    const runs = await db().prepare("SELECT COUNT(*) AS n FROM probe_runs").first<{ n: number }>()
    expect(runs?.n).toBe(1)
  })

  it("rejects the same run identity with a different body as a conflict", async () => {
    await call(
      await signedObservationRequest(batch({ probeId: "ext-a", runId: "run_c", scheduledAtMs }))
    )
    const conflicting = batch({
      probeId: "ext-a",
      runId: "run_c",
      scheduledAtMs,
      checks: [check("signalingHttp", "fail", { reason: "http_status" })],
    })
    const response = await call(await signedObservationRequest(conflicting))
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ code: "conflict" })
  })

  it("keeps the first observation of a minute when a second run arrives", async () => {
    await call(
      await signedObservationRequest(batch({ probeId: "ext-a", runId: "run_first", scheduledAtMs }))
    )
    const later = batch({
      probeId: "ext-a",
      runId: "run_second",
      scheduledAtMs,
      checks: [
        check("signalingHttp", "fail", { reason: "http_status" }),
        check("signalingAuth", "pass"),
        check("relayData", "pass"),
      ],
    })
    expect((await call(await signedObservationRequest(later))).status).toBe(202)
    const slot = await db()
      .prepare("SELECT run_id, http FROM reference_slots WHERE minute = ?")
      .bind(minute)
      .first()
    expect(slot).toEqual({ run_id: "run_first", http: "pass" })
  })

  it("records missing checks in a reference minute as unknown, never pass", async () => {
    const httpOnly = batch({
      probeId: "ext-a",
      runId: "run_h",
      scheduledAtMs,
      checks: [check("signalingHttp", "pass")],
    })
    expect((await call(await signedObservationRequest(httpOnly))).status).toBe(202)
    const slot = await db()
      .prepare("SELECT auth, data, auth_reason FROM reference_slots WHERE minute = ?")
      .bind(minute)
      .first()
    expect(slot).toEqual({ auth: "unknown", data: "unknown", auth_reason: "missing" })
  })

  it("does not let a non-reference profile fill the reference minute", async () => {
    const android = batch({
      probeId: "ext-a",
      runId: "run_android",
      scheduledAtMs: minuteMs(minute - (minute % 5)),
      profileId: "android",
      checks: [
        check("signalingAuth", "fail", { reason: "origin_rejected" }),
        check("relayData", "unknown", { dependsOn: "signalingAuth" }),
      ],
    })
    expect((await call(await signedObservationRequest(android))).status).toBe(202)
    const slots = await db()
      .prepare("SELECT COUNT(*) AS n FROM reference_slots")
      .first<{ n: number }>()
    expect(slots?.n).toBe(0)
  })

  it("refuses a key speaking for another probe", async () => {
    const response = await call(
      await signedObservationRequest(batch({ probeId: "ext-a", runId: "run_x", scheduledAtMs }), {
        keyId: OTHER_KEY_ID,
        secret: OTHER_SECRET,
      })
    )
    expect(response.status).toBe(403)
  })

  it("refuses a tampered body, a wrong key and an expired signature", async () => {
    const good = await signedObservationRequest(
      batch({ probeId: "ext-a", runId: "run_t", scheduledAtMs })
    )
    const tampered = new Request(good, {
      body: JSON.stringify(
        batch({ probeId: "ext-a", runId: "run_t", scheduledAtMs: scheduledAtMs - 60_000 })
      ),
    })
    expect((await call(tampered)).status).toBe(401)
    expect(
      (
        await call(
          await signedObservationRequest(
            batch({ probeId: "ext-a", runId: "run_w", scheduledAtMs }),
            { secret: OTHER_SECRET }
          )
        )
      ).status
    ).toBe(401)
    expect(
      (
        await call(
          await signedObservationRequest(
            batch({ probeId: "ext-a", runId: "run_o", scheduledAtMs }),
            {
              nowMs: Date.now() - SIGNATURE_WINDOW_MS - 5_000,
            }
          )
        )
      ).status
    ).toBe(401)
  })

  it("refuses observations older than the late-acceptance window", async () => {
    const old = minuteMs(currentMinute() - Math.ceil(LATE_OBSERVATION_MS / 60_000) - 2)
    const response = await call(
      await signedObservationRequest(
        batch({ probeId: "ext-a", runId: "run_late", scheduledAtMs: old })
      )
    )
    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({ code: "too_late" })
  })

  it("refuses checks the registry does not assign to the profile", async () => {
    const android = batch({
      probeId: "ext-a",
      runId: "run_unassigned",
      scheduledAtMs,
      profileId: "android",
      checks: [check("signalingHttp", "pass")],
    })
    expect((await call(await signedObservationRequest(android))).status).toBe(403)
    const statusChecks = batch({
      probeId: "ext-a",
      runId: "run_web",
      scheduledAtMs,
      profileId: "web",
      checks: [check("signalingAuth", "pass")],
    })
    expect((await call(await signedObservationRequest(statusChecks))).status).toBe(403)
  })

  it("refuses a run ID header that disagrees with the body", async () => {
    const response = await call(
      await signedObservationRequest(
        batch({ probeId: "ext-a", runId: "run_body", scheduledAtMs }),
        { runId: "run_header" }
      )
    )
    expect(response.status).toBe(400)
  })

  it("refuses oversized and malformed bodies without echoing them", async () => {
    const huge = await signedObservationRequest("x".repeat(40 * 1024))
    expect((await call(huge)).status).toBe(413)
    const malformed = await call(
      await signedObservationRequest('{"schemaVersion":1}', { runId: "run_m" })
    )
    expect(malformed.status).toBe(400)
    const text = await malformed.text()
    expect(text).not.toContain("schemaVersion")
  })

  it("answers other methods and query strings with JSON errors", async () => {
    const get = await call(new Request("https://status.test/api/status/v1/observations"))
    expect(get.status).toBe(405)
    expect(get.headers.get("content-type")).toContain("application/json")
    const withQuery = await signedObservationRequest(
      batch({ probeId: "ext-a", runId: "run_q", scheduledAtMs })
    )
    const queried = new Request(`${withQuery.url}?probe=ext-b`, withQuery)
    expect((await call(queried)).status).toBe(400)
  })

  it("refuses a disabled probe", async () => {
    await db().prepare("UPDATE probes SET disabled = 1 WHERE id = 'ext-a'").run()
    const response = await call(
      await signedObservationRequest(batch({ probeId: "ext-a", runId: "run_d", scheduledAtMs }))
    )
    expect(response.status).toBe(403)
  })
})
