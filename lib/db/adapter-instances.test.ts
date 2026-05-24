/**
 * Tests for lib/db/adapter-instances.ts — CRUD for the v18 adapterInstances table.
 */

import "fake-indexeddb/auto"
import {
  createAdapterInstance,
  getAdapterInstance,
  listAdapterInstances,
  listEnabledAdapterInstances,
  listAdapterInstancesByType,
  updateAdapterInstance,
  deleteAdapterInstance,
} from "./adapter-instances"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

function baseInput() {
  return {
    type: "telegram" as const,
    displayName: "My Bot",
    enabled: true,
    transportMode: "longpoll" as const,
    settings: { token: "redacted" },
    credentialsRef: { keyringService: "cognia", accounts: ["telegram_token"] },
    trigger: {
      rules: [{ kind: "private-default" as const }],
      blockers: [],
      storeUnmatchedInDraftMode: true,
    },
    defaultMode: "auto" as const,
  }
}

describe("adapter-instances", () => {
  it("creates an instance with generated id and timestamps", async () => {
    const row = await createAdapterInstance(baseInput())
    expect(row.id).toMatch(/^cai_/)
    expect(row.createdAt).toBeGreaterThan(0)
    expect(row.updatedAt).toBe(row.createdAt)
    expect(row.type).toBe("telegram")
    expect(row.displayName).toBe("My Bot")
  })

  it("getAdapterInstance returns the row", async () => {
    const row = await createAdapterInstance(baseInput())
    const found = await getAdapterInstance(row.id)
    expect(found).toEqual(row)
  })

  it("getAdapterInstance returns undefined for unknown id", async () => {
    expect(await getAdapterInstance("nope")).toBeUndefined()
  })

  it("listAdapterInstances returns all rows", async () => {
    await createAdapterInstance(baseInput())
    await createAdapterInstance({ ...baseInput(), displayName: "Bot B", type: "discord" })
    const all = await listAdapterInstances()
    expect(all).toHaveLength(2)
  })

  it("listEnabledAdapterInstances returns only enabled rows", async () => {
    await createAdapterInstance(baseInput())
    await createAdapterInstance({ ...baseInput(), displayName: "Disabled", enabled: false })
    const enabled = await listEnabledAdapterInstances()
    expect(enabled).toHaveLength(1)
    expect(enabled[0].displayName).toBe("My Bot")
  })

  it("listAdapterInstancesByType filters by type", async () => {
    await createAdapterInstance(baseInput())
    await createAdapterInstance({ ...baseInput(), displayName: "Discord Bot", type: "discord" })
    const telegram = await listAdapterInstancesByType("telegram")
    expect(telegram).toHaveLength(1)
    expect(telegram[0].type).toBe("telegram")
  })

  it("updateAdapterInstance patches fields and bumps updatedAt", async () => {
    const row = await createAdapterInstance(baseInput())
    await new Promise((r) => setTimeout(r, 2))
    await updateAdapterInstance(row.id, { displayName: "Updated Bot", enabled: false })
    const updated = await getAdapterInstance(row.id)
    expect(updated?.displayName).toBe("Updated Bot")
    expect(updated?.enabled).toBe(false)
    expect(updated?.updatedAt).toBeGreaterThan(row.updatedAt)
  })

  it("deleteAdapterInstance removes the row", async () => {
    const row = await createAdapterInstance(baseInput())
    await deleteAdapterInstance(row.id)
    expect(await getAdapterInstance(row.id)).toBeUndefined()
  })

  it("deleteAdapterInstance reaps the adapter's connectorHeartbeats but leaves other adapters' rows", async () => {
    const row = await createAdapterInstance(baseInput())
    const other = await createAdapterInstance(baseInput())
    const now = Date.now()
    await getDb().connectorHeartbeats.bulkPut([
      { id: "hb-del-1", adapterId: row.id, kind: "adapter.heartbeat", at: now - 1_000 },
      { id: "hb-del-2", adapterId: row.id, kind: "adapter.heartbeat", at: now - 2_000 },
      { id: "hb-keep", adapterId: other.id, kind: "adapter.heartbeat", at: now - 1_000 },
    ])

    await deleteAdapterInstance(row.id)

    expect(await getDb().connectorHeartbeats.where("adapterId").equals(row.id).count()).toBe(0)
    // The other adapter's heartbeats are untouched.
    const remaining = await getDb().connectorHeartbeats.toArray()
    expect(remaining.map((r) => r.id)).toEqual(["hb-keep"])
  })

  it("optional fields (defaultCharacterId, webhookPath, publicUrl, quietHours, muted) round-trip", async () => {
    const row = await createAdapterInstance({
      ...baseInput(),
      defaultCharacterId: "char_1",
      webhookPath: "/connectors/tg",
      publicUrl: "https://example.com",
      quietHours: { from: "22:00", to: "08:00", tz: "Asia/Shanghai" },
      muted: true,
    })
    const found = await getAdapterInstance(row.id)
    expect(found?.defaultCharacterId).toBe("char_1")
    expect(found?.webhookPath).toBe("/connectors/tg")
    expect(found?.publicUrl).toBe("https://example.com")
    expect(found?.quietHours).toEqual({ from: "22:00", to: "08:00", tz: "Asia/Shanghai" })
    expect(found?.muted).toBe(true)
  })
})
