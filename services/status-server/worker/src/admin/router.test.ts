import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { IncidentDetail } from "../../../../../lib/status/contract"
import { parseIncidentDetail } from "../../../../../lib/status/validate"
import { reconcileIncidents } from "../incidents/reconcile"
import { resetAccessKeyCache } from "./access"
import { handleAdminRoutes } from "./index"
import {
  T0,
  MINUTE,
  accessKeys,
  adminCall,
  baseEnv,
  count,
  evaluation,
  jobAt,
  jwksFetch,
  operationId,
  operatorToken,
  readJson,
  resetOwnerE,
  type AccessKeys,
} from "./test-support"

let keys: AccessKeys

beforeAll(async () => {
  keys = await accessKeys("router-kid")
})

const createBody = () => ({
  operationId: operationId("create"),
  title: { en: "Relay degraded", "zh-CN": "中继降级" },
  message: { en: "We are investigating reports.", "zh-CN": "我们正在调查。" },
  impact: "partial_outage",
  componentIds: ["relayData"],
  state: "investigating",
})

async function createIncident(): Promise<IncidentDetail> {
  const response = await adminCall(handleAdminRoutes, {
    keys,
    nowMs: T0,
    method: "POST",
    path: "/admin/incidents",
    body: createBody(),
  })
  expect(response.status).toBe(201)
  return (await readJson<{ incident: IncidentDetail }>(response)).incident
}

describe("admin router", () => {
  beforeEach(async () => {
    await resetOwnerE()
    resetAccessKeyCache()
    vi.spyOn(globalThis, "fetch").mockImplementation(jwksFetch([keys]))
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("ignores non-admin paths", async () => {
    const request = new Request("https://status.test/api/status/v1/incidents")
    expect(
      await handleAdminRoutes(request, baseEnv, {
        requestId: "r",
        nowMs: T0,
        url: new URL(request.url),
        waitUntil: () => {},
      })
    ).toBeNull()
  })

  it("denies every route without a valid identity, on any host", async () => {
    for (const host of ["status.test", "cognia-status.workers.dev"]) {
      const missing = await adminCall(handleAdminRoutes, {
        keys,
        nowMs: T0,
        method: "POST",
        path: "/admin/incidents",
        body: createBody(),
        token: null,
        host,
      })
      expect(missing.status).toBe(401)
      expect(await readJson(missing)).toMatchObject({ code: "unauthorized" })
    }
    const unknownPath = await adminCall(handleAdminRoutes, {
      keys,
      nowMs: T0,
      method: "GET",
      path: "/admin/nothing",
      token: null,
    })
    expect(unknownPath.status).toBe(401)
    const stranger = await adminCall(handleAdminRoutes, {
      keys,
      nowMs: T0,
      method: "POST",
      path: "/admin/incidents",
      body: createBody(),
      token: await operatorToken(keys, T0, { email: "intruder@example.test" }),
    })
    expect(stranger.status).toBe(403)
    const unconfigured = await adminCall(handleAdminRoutes, {
      keys,
      nowMs: T0,
      method: "GET",
      path: "/admin/incidents",
      env: { ...baseEnv, ACCESS_AUD: "" },
    })
    expect(unconfigured.status).toBe(503)
    expect(await count("incidents")).toBe(0)
    expect(await count("audit_events")).toBe(0)
  })

  it("answers JSON 404 / 405 for unknown routes and methods once authenticated", async () => {
    const notFound = await adminCall(handleAdminRoutes, {
      keys,
      nowMs: T0,
      method: "GET",
      path: "/admin/unknown",
    })
    expect(notFound.status).toBe(404)
    expect(await readJson(notFound)).toMatchObject({ code: "not_found" })
    const wrongMethod = await adminCall(handleAdminRoutes, {
      keys,
      nowMs: T0,
      method: "DELETE",
      path: "/admin/incidents",
    })
    expect(wrongMethod.status).toBe(405)
  })

  it("creates an incident, audits the operator and replays the same operation", async () => {
    const body = createBody()
    const first = await adminCall(handleAdminRoutes, {
      keys,
      nowMs: T0,
      method: "POST",
      path: "/admin/incidents",
      body,
    })
    expect(first.status).toBe(201)
    const created = await readJson<{ incident: IncidentDetail }>(first)
    expect(parseIncidentDetail(created).ok).toBe(true)
    expect(created.incident).toMatchObject({
      source: "manual",
      state: "investigating",
      revision: 1,
    })

    const replay = await adminCall(handleAdminRoutes, {
      keys,
      nowMs: T0 + MINUTE,
      method: "POST",
      path: "/admin/incidents",
      body,
    })
    expect(replay.status).toBe(201)
    expect(replay.headers.get("x-idempotent-replay")).toBe("true")
    expect(await readJson(replay)).toEqual(created)
    expect(await count("incidents")).toBe(1)

    const conflicting = await adminCall(handleAdminRoutes, {
      keys,
      nowMs: T0,
      method: "POST",
      path: "/admin/incidents",
      body: { ...body, impact: "major_outage" },
    })
    expect(conflicting.status).toBe(409)
    expect(await readJson(conflicting)).toMatchObject({ code: "conflict" })

    const audit = await baseEnv.DB.prepare(
      "SELECT actor, action, target_id, detail_json FROM audit_events"
    ).all<{
      actor: string
      action: string
      target_id: string
      detail_json: string
    }>()
    expect(audit.results).toHaveLength(1)
    expect(audit.results[0]).toMatchObject({
      actor: "operator@cognia.test",
      action: "incident.create",
      target_id: created.incident.id,
    })
    expect(JSON.parse(audit.results[0]!.detail_json)).toMatchObject({
      operationId: body.operationId,
    })
    expect(await count("notification_events", "kind = 'incident.opened'")).toBe(1)
  })

  it("rejects invalid bodies without recording anything", async () => {
    const response = await adminCall(handleAdminRoutes, {
      keys,
      nowMs: T0,
      method: "POST",
      path: "/admin/incidents",
      body: { ...createBody(), title: { en: "" } },
    })
    expect(response.status).toBe(400)
    expect(await count("admin_operations")).toBe(0)
  })

  it("resolves competing edits with a revision conflict carrying the current revision", async () => {
    const incident = await createIncident()
    const update = (label: string) => ({
      operationId: operationId(label),
      expectedRevision: 1,
      state: "identified",
      message: { en: `Edit ${label}` },
    })
    const first = await adminCall(handleAdminRoutes, {
      keys,
      nowMs: T0 + MINUTE,
      method: "POST",
      path: `/admin/incidents/${incident.id}/updates`,
      body: update("a"),
    })
    expect(first.status).toBe(200)
    const second = await adminCall(handleAdminRoutes, {
      keys,
      nowMs: T0 + MINUTE,
      method: "POST",
      path: `/admin/incidents/${incident.id}/updates`,
      body: update("b"),
    })
    expect(second.status).toBe(409)
    expect(await readJson(second)).toMatchObject({ code: "revision_conflict", currentRevision: 2 })
    expect(await count("incident_updates")).toBe(2)
    expect(await count("audit_events", "action = 'incident.update'")).toBe(1)
    expect(await count("admin_operations")).toBe(2)
  })

  it("appends corrections without notifying and keeps the original in history", async () => {
    const incident = await createIncident()
    const original = incident.updates[0]!.id
    const response = await adminCall(handleAdminRoutes, {
      keys,
      nowMs: T0 + MINUTE,
      method: "POST",
      path: `/admin/incidents/${incident.id}/updates`,
      body: {
        operationId: operationId("fix"),
        expectedRevision: 1,
        message: { en: "We are investigating reports of relay errors." },
        correctionOf: original,
      },
    })
    expect(response.status).toBe(200)
    const detail = (await readJson<{ incident: IncidentDetail }>(response)).incident
    expect(detail.updates).toHaveLength(2)
    expect(detail.updates[0]!.message.en).toBe("We are investigating reports.")
    expect(detail.updates[1]!.correctionOf).toBe(original)
    expect(await count("notification_events")).toBe(1)
    const audit = await baseEnv.DB.prepare(
      "SELECT detail_json FROM audit_events WHERE action = 'incident.correct'"
    ).first<{ detail_json: string }>()
    expect(JSON.parse(audit!.detail_json)).toMatchObject({ correctedUpdateId: original })

    const bogus = await adminCall(handleAdminRoutes, {
      keys,
      nowMs: T0 + MINUTE,
      method: "POST",
      path: `/admin/incidents/${incident.id}/updates`,
      body: {
        operationId: operationId("bogus"),
        expectedRevision: 2,
        message: { en: "x" },
        correctionOf: "upd_nope",
      },
    })
    expect(bogus.status).toBe(400)
  })

  it("resolves with an audited reason, refuses reopening and lists resolved incidents", async () => {
    const incident = await createIncident()
    const viaUpdate = await adminCall(handleAdminRoutes, {
      keys,
      nowMs: T0 + MINUTE,
      method: "POST",
      path: `/admin/incidents/${incident.id}/updates`,
      body: {
        operationId: operationId("res"),
        expectedRevision: 1,
        state: "resolved",
        message: { en: "done" },
      },
    })
    expect(viaUpdate.status).toBe(400)

    const resolved = await adminCall(handleAdminRoutes, {
      keys,
      nowMs: T0 + 2 * MINUTE,
      method: "POST",
      path: `/admin/incidents/${incident.id}/resolve`,
      body: {
        operationId: operationId("resolve"),
        expectedRevision: 1,
        message: { en: "Recovered." },
        reason: "Provider fixed routing",
      },
    })
    expect(resolved.status).toBe(200)
    expect((await readJson<{ incident: IncidentDetail }>(resolved)).incident).toMatchObject({
      state: "resolved",
      revision: 2,
    })
    const audit = await baseEnv.DB.prepare(
      "SELECT detail_json FROM audit_events WHERE action = 'incident.resolve'"
    ).first<{ detail_json: string }>()
    expect(JSON.parse(audit!.detail_json)).toMatchObject({ reason: "Provider fixed routing" })

    const reopen = await adminCall(handleAdminRoutes, {
      keys,
      nowMs: T0 + 3 * MINUTE,
      method: "POST",
      path: `/admin/incidents/${incident.id}/updates`,
      body: {
        operationId: operationId("reopen"),
        expectedRevision: 2,
        state: "investigating",
        message: { en: "again" },
      },
    })
    expect(reopen.status).toBe(409)
    const again = await adminCall(handleAdminRoutes, {
      keys,
      nowMs: T0 + 3 * MINUTE,
      method: "POST",
      path: `/admin/incidents/${incident.id}/resolve`,
      body: {
        operationId: operationId("again"),
        expectedRevision: 2,
        message: { en: "x" },
        reason: "x",
      },
    })
    expect(again.status).toBe(409)

    const list = await adminCall(handleAdminRoutes, {
      keys,
      nowMs: T0 + 3 * MINUTE,
      method: "GET",
      path: "/admin/incidents",
    })
    const page = await readJson<{
      incidents: Array<{ id: string; state: string; pinned: boolean }>
    }>(list)
    expect(page.incidents).toEqual([
      expect.objectContaining({ id: incident.id, state: "resolved", pinned: true }),
    ])
    const show = await adminCall(handleAdminRoutes, {
      keys,
      nowMs: T0,
      method: "GET",
      path: `/admin/incidents/${incident.id}`,
    })
    expect(show.status).toBe(200)
    const missing = await adminCall(handleAdminRoutes, {
      keys,
      nowMs: T0,
      method: "GET",
      path: "/admin/incidents/inc_none",
    })
    expect(missing.status).toBe(404)
  })

  it("pins an automated incident so automation stops changing it", async () => {
    const job = await jobAt("aggregate", T0)
    const observer = { referenceProbeId: "ext-1", referenceHealthy: true, lastReferenceAtMs: T0 }
    await reconcileIncidents(job, { evaluations: [evaluation({ failures: 3 })], observer })
    const row = await baseEnv.DB.prepare("SELECT id FROM incidents").first<{ id: string }>()
    const pinned = await adminCall(handleAdminRoutes, {
      keys,
      nowMs: T0 + MINUTE,
      method: "POST",
      path: `/admin/incidents/${row!.id}/updates`,
      body: {
        operationId: operationId("pin"),
        expectedRevision: 1,
        state: "identified",
        pin: true,
        message: { en: "Upstream provider issue confirmed." },
      },
    })
    expect(pinned.status).toBe(200)
    const later = await jobAt("aggregate", T0 + 8 * MINUTE)
    await reconcileIncidents(later, {
      evaluations: [evaluation({ passes: 8, evaluatedAtMs: T0 + 8 * MINUTE })],
      observer,
    })
    expect(await count("incident_updates")).toBe(2)
    // Control: an unpinned automated incident would have moved on.
    await baseEnv.DB.prepare("UPDATE incidents SET pinned = 0").run()
    const control = await jobAt("aggregate", T0 + 9 * MINUTE)
    await reconcileIncidents(control, {
      evaluations: [evaluation({ passes: 9, evaluatedAtMs: T0 + 9 * MINUTE })],
      observer,
    })
    expect(await count("incident_updates")).toBe(3)
    await baseEnv.DB.prepare("UPDATE incidents SET pinned = 1").run()
    expect(await count("incidents", "pinned = 1")).toBe(1)
  })
  it("routes probe registry operations to the registry module with idempotency", async () => {
    const probeId = `ext-${crypto.randomUUID().slice(0, 8)}`
    const enroll = {
      operationId: operationId("enroll"),
      probeId,
      source: "external",
      label: { en: "Hong Kong VPS" },
      location: { en: "Hong Kong" },
      provider: "Example Cloud",
      enrolledAt: new Date(T0 + MINUTE).toISOString(),
      profiles: [{ id: "native", httpCadenceSeconds: 60, protocolCadenceSeconds: 60 }],
      keyId: `${probeId}-k1`,
    }
    const created = await adminCall(handleAdminRoutes, {
      keys,
      nowMs: T0,
      method: "POST",
      path: "/admin/probes",
      body: enroll,
    })
    expect(created.status).toBe(201)
    const replay = await adminCall(handleAdminRoutes, {
      keys,
      nowMs: T0,
      method: "POST",
      path: "/admin/probes",
      body: enroll,
    })
    expect(replay.status).toBe(201)
    expect(replay.headers.get("x-idempotent-replay")).toBe("true")

    const list = await adminCall(handleAdminRoutes, {
      keys,
      nowMs: T0 + MINUTE,
      method: "GET",
      path: "/admin/probes",
    })
    const probes = (await readJson<{ probes: Array<{ id: string; keyIds: string[] }> }>(list))
      .probes
    expect(probes.find((probe) => probe.id === probeId)?.keyIds).toEqual([`${probeId}-k1`])

    const disabled = await adminCall(handleAdminRoutes, {
      keys,
      nowMs: T0 + MINUTE,
      method: "POST",
      path: "/admin/probes/disable",
      body: {
        operationId: operationId("disable"),
        probeId,
        disabled: true,
        reason: "maintenance of the VPS",
      },
    })
    expect(disabled.status).toBe(200)
    const missing = await adminCall(handleAdminRoutes, {
      keys,
      nowMs: T0 + MINUTE,
      method: "POST",
      path: "/admin/probes/disable",
      body: {
        operationId: operationId("disable"),
        probeId: "ext-missing",
        disabled: true,
        reason: "x",
      },
    })
    expect(missing.status).toBe(404)
    expect(await readJson(missing)).toMatchObject({
      code: "not_found",
      requestId: expect.any(String),
    })
    const pastReference = await adminCall(handleAdminRoutes, {
      keys,
      nowMs: T0 + MINUTE,
      method: "POST",
      path: "/admin/probes/set-reference",
      body: {
        operationId: operationId("ref"),
        probeId,
        effectiveAt: new Date(T0).toISOString(),
        reason: "x",
      },
    })
    expect(pastReference.status).toBe(400)
    const audit = await baseEnv.DB.prepare(
      "SELECT action, actor FROM audit_events WHERE target_id = ? ORDER BY id"
    )
      .bind(probeId)
      .all<{ action: string; actor: string }>()
    expect(audit.results).toEqual([
      { action: "probe.enroll", actor: "operator@cognia.test" },
      { action: "probe.disable", actor: "operator@cognia.test" },
    ])
  })
})
