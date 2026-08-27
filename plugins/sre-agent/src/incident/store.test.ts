import type { PluginDexieAPI } from "@/lib/plugin/api/dexie-api"
import { createIncident, type SreIncident } from "./model"
import {
  clearIncidents,
  deleteIncident,
  getIncident,
  INCIDENTS_TABLE,
  listIncidents,
  listIncidentsForSession,
  putIncident,
} from "./store"

const NOW = "2026-08-04T12:10:00.000Z"
const WINDOW = { startTime: "2026-08-04T12:02:00.000Z", endTime: "2026-08-04T12:05:20.000Z" }

/**
 * Map-backed stand-in for one namespaced plugin table (strix-security's `db`
 * suite sets the precedent). What is under test is the ordering rule and the
 * session-scoping rule, neither of which needs a real IndexedDB.
 */
function fakeDexie() {
  const tables = new Map<string, Map<string, SreIncident>>()
  const rows = (name: string) => {
    const existing = tables.get(name)
    if (existing) return existing
    const created = new Map<string, SreIncident>()
    tables.set(name, created)
    return created
  }
  const api = {
    table: (name: string) => ({
      put: async (row: SreIncident) => {
        rows(name).set(row.id, row)
      },
      get: async (id: string) => rows(name).get(id),
      delete: async (id: string) => {
        rows(name).delete(id)
      },
      clear: async () => {
        rows(name).clear()
      },
      toArray: async () => [...rows(name).values()],
    }),
  } as unknown as PluginDexieAPI
  return { api, rows }
}

function incident(overrides: Partial<SreIncident>): SreIncident {
  return {
    ...createIncident({
      id: "inc",
      now: NOW,
      title: "t",
      environment: "prod",
      window: WINDOW,
    }),
    ...overrides,
  }
}

describe("incident store", () => {
  it("writes into the plugin-private incidents table", async () => {
    const { api, rows } = fakeDexie()
    await putIncident(api, incident({ id: "a" }))
    expect([...rows(INCIDENTS_TABLE).keys()]).toEqual(["a"])
    await expect(getIncident(api, "a")).resolves.toMatchObject({ id: "a" })
    await expect(getIncident(api, "missing")).resolves.toBeUndefined()
  })

  it("lists open work before closed work", async () => {
    const { api } = fakeDexie()
    await putIncident(api, incident({ id: "closed", status: "resolved", updatedAt: NOW }))
    await putIncident(api, incident({ id: "open", status: "investigating", updatedAt: NOW }))
    await expect(listIncidents(api).then((rows) => rows.map((row) => row.id))).resolves.toEqual([
      "open",
      "closed",
    ])
  })

  it("scopes to one session but keeps session-less incidents visible", async () => {
    const { api } = fakeDexie()
    await putIncident(api, incident({ id: "mine", sessionId: "sess_1" }))
    await putIncident(api, incident({ id: "theirs", sessionId: "sess_2" }))
    await putIncident(api, incident({ id: "from-alert" }))

    const rows = await listIncidentsForSession(api, "sess_1")
    expect(rows.map((row) => row.id).sort()).toEqual(["from-alert", "mine"])
  })

  it("deletes one incident and clears the table", async () => {
    const { api, rows } = fakeDexie()
    await putIncident(api, incident({ id: "a" }))
    await putIncident(api, incident({ id: "b" }))
    await deleteIncident(api, "a")
    expect([...rows(INCIDENTS_TABLE).keys()]).toEqual(["b"])
    await clearIncidents(api)
    expect(rows(INCIDENTS_TABLE).size).toBe(0)
  })
})
