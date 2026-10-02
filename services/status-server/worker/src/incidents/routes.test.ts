import { beforeEach, describe, expect, it } from "vitest"

import { parseIncidentDetail, parseIncidentPage } from "../../../../../lib/status/validate"
import { T0, MINUTE, baseEnv, context, readJson, resetOwnerE } from "../admin/test-support"
import { handleIncidentRoutes, loadIncidentsForSnapshot } from "./index"
import {
  decodeCursor,
  encodeCursor,
  planCreateIncident,
  planIncidentTransition,
  readIncidentRow,
  readUpdates,
} from "./store"

async function createIncident(startedAtMs: number, title = "Outage"): Promise<string> {
  const plan = planCreateIncident(baseEnv.DB, {
    title: { en: title, "zh-CN": `${title}（中文）` },
    state: "investigating",
    impact: "major_outage",
    componentIds: ["signalingHttp"],
    source: "manual",
    fingerprint: null,
    pinned: true,
    manualOwner: "operator@cognia.test",
    predecessorId: null,
    update: {
      message: { en: "Looking into it" },
      source: "manual",
      atMs: startedAtMs,
      evidenceAtMs: null,
      correctionOf: null,
    },
  })
  await baseEnv.DB.batch(plan.statements)
  return plan.incidentId
}

async function resolve(id: string, atMs: number): Promise<void> {
  const row = (await readIncidentRow(baseEnv.DB, id))!
  const plan = planIncidentTransition(baseEnv.DB, {
    current: row,
    currentUpdates: await readUpdates(baseEnv.DB, id),
    expectedRevision: row.revision,
    state: "resolved",
    impact: row.impact,
    componentIds: ["signalingHttp"],
    pinned: true,
    manualOwner: row.manual_owner,
    update: {
      message: { en: "Fixed" },
      source: "manual",
      atMs,
      evidenceAtMs: null,
      correctionOf: null,
    },
    notify: true,
    automationOnly: false,
  })
  await baseEnv.DB.batch(plan.statements)
}

async function get(path: string, method = "GET"): Promise<Response | null> {
  const request = new Request(`https://status.test/api/status/v1${path}`, { method })
  return handleIncidentRoutes(request, baseEnv, context(request, T0 + 60 * MINUTE))
}

describe("public incident routes", () => {
  beforeEach(async () => {
    await resetOwnerE()
  })

  it("ignores paths it does not own", async () => {
    expect(await get("/snapshot")).toBeNull()
    const other = new Request("https://status.test/elsewhere/incidents")
    expect(await handleIncidentRoutes(other, baseEnv, context(other, T0))).toBeNull()
  })

  it("pages newest first with a stable cursor and an ID tie-break", async () => {
    const ids: string[] = []
    for (let index = 0; index < 5; index += 1)
      ids.push(await createIncident(T0 + (index < 2 ? 0 : index) * MINUTE, `I${index}`))
    const first = await get("/incidents?limit=2")
    expect(first!.status).toBe(200)
    expect(first!.headers.get("access-control-allow-origin")).toBe("*")
    expect(first!.headers.get("cache-control")).toBe("public, max-age=30")
    const page1 = parseIncidentPage(await readJson(first!))
    expect(page1.ok).toBe(true)
    if (!page1.ok) return
    expect(page1.value.incidents.map((incident) => incident.title.en)).toEqual(["I4", "I3"])
    expect(page1.value.incidents[0]!.latestUpdate?.message.en).toBe("Looking into it")

    const seen = [...page1.value.incidents.map((incident) => incident.id)]
    let cursor = page1.value.nextCursor
    while (cursor) {
      const next = parseIncidentPage(
        await readJson((await get(`/incidents?limit=2&cursor=${cursor}`))!)
      )
      if (!next.ok) throw new Error(next.error)
      seen.push(...next.value.incidents.map((incident) => incident.id))
      cursor = next.value.nextCursor
    }
    expect(new Set(seen).size).toBe(5)
    expect(seen.sort()).toEqual([...ids].sort())
  })

  it("rejects bad limits and cursors", async () => {
    expect((await get("/incidents?limit=51"))!.status).toBe(400)
    expect((await get("/incidents?limit=0"))!.status).toBe(400)
    expect((await get("/incidents?cursor=%%%"))!.status).toBe(400)
    expect(decodeCursor(encodeCursor({ startedAt: T0, id: "inc_1" }))).toEqual({
      startedAt: T0,
      id: "inc_1",
    })
    expect(decodeCursor("bm90LWpzb24")).toBeNull()
  })

  it("serves detail with updates oldest first and 404 for unknown IDs", async () => {
    const id = await createIncident(T0)
    await resolve(id, T0 + 5 * MINUTE)
    const response = await get(`/incidents/${id}`)
    expect(response!.status).toBe(200)
    const body = await readJson<{ schemaVersion: number; incident: unknown }>(response!)
    const detail = parseIncidentDetail(body)
    expect(detail.ok).toBe(true)
    if (!detail.ok) return
    expect(detail.value.updates.map((update) => update.state)).toEqual([
      "investigating",
      "resolved",
    ])
    expect(detail.value.resolvedAt).toBe(new Date(T0 + 5 * MINUTE).toISOString())
    expect(detail.value.revision).toBe(2)

    const missing = await get("/incidents/inc_missing")
    expect(missing!.status).toBe(404)
    expect(await readJson(missing!)).toMatchObject({ code: "not_found" })
    expect((await get("/incidents/..%2f"))!.status).toBe(404)
  })

  it("refuses writes on public paths", async () => {
    expect((await get("/incidents", "POST"))!.status).toBe(405)
  })

  it("splits active and recent past incidents for the snapshot", async () => {
    const active = await createIncident(T0)
    const recent = await createIncident(T0 - 5 * MINUTE)
    await resolve(recent, T0)
    const ancient = await createIncident(T0 - 200 * 86_400_000)
    await resolve(ancient, T0 - 199 * 86_400_000)
    const { active: activeList, past } = await loadIncidentsForSnapshot(baseEnv, T0 + MINUTE)
    expect(activeList.map((incident) => incident.id)).toEqual([active])
    expect(past.map((incident) => incident.id)).toEqual([recent])
  })
})
