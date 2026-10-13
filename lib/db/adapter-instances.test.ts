/**
 * Tests for lib/db/adapter-instances.ts — CRUD for the v18 adapterInstances table.
 */

import {
  createAdapterInstance,
  getAdapterInstance,
  listAdapterInstances,
  listEnabledAdapterInstances,
  listAdapterInstancesByType,
  updateAdapterInstance,
  updateAdapterConfigSection,
  patchAdapterInstanceSettings,
  deleteAdapterInstance,
  setAdapterInstanceOwner,
} from "./adapter-instances"
import {
  completeAdapterInstanceCreate,
  setAdapterInstanceRemoteWriter,
  type AdapterInstanceRemoteWriter,
} from "./adapter-instance-remote-writer"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

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

  it("atomically records a redaction-safe section audit", async () => {
    const row = await createAdapterInstance(baseInput())
    await updateAdapterConfigSection(
      row.id,
      "responder",
      { defaultCharacterId: "char_1", defaultWorkflowId: "wf_1" },
      "conversation-promotion"
    )
    await expect(getAdapterInstance(row.id)).resolves.toMatchObject({
      defaultCharacterId: "char_1",
      defaultWorkflowId: "wf_1",
    })
    const audit = await getDb().connectorAudit.where("adapterId").equals(row.id).first()
    expect(audit).toMatchObject({
      kind: "adapter.config_changed",
      fields: {
        scope: "adapter",
        section: "responder",
        changedKeys: ["defaultCharacterId", "defaultWorkflowId"],
        source: "conversation-promotion",
      },
    })
  })

  it("atomically merges concurrent settings patches against the latest row", async () => {
    const row = await createAdapterInstance(baseInput())

    await Promise.all([
      patchAdapterInstanceSettings(row.id, { larkChatTab: true }),
      patchAdapterInstanceSettings(row.id, { larkWebSso: true }),
    ])

    await expect(getAdapterInstance(row.id)).resolves.toMatchObject({
      settings: { larkChatTab: true, larkWebSso: true },
    })
  })

  it("deleteAdapterInstance removes the row", async () => {
    const row = await createAdapterInstance(baseInput())
    await deleteAdapterInstance(row.id)
    expect(await getAdapterInstance(row.id)).toBeUndefined()
  })

  it("deleteAdapterInstance tombstones the adapter id for paired clients", async () => {
    const row = await createAdapterInstance(baseInput())
    const other = await createAdapterInstance(baseInput())

    await deleteAdapterInstance(row.id)

    const tombstones = await getDb()
      .syncTombstones.where("table")
      .equals("adapterInstances")
      .toArray()
    expect(tombstones).toEqual([
      expect.objectContaining({
        table: "adapterInstances",
        id: row.id,
        deletedAt: expect.any(Number),
      }),
    ])
    expect(tombstones.map((t) => t.id)).not.toContain(other.id)
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

  describe("ownership (ADR-0224)", () => {
    const moved = {
      kind: "remote-host" as const,
      hostId: "mini",
      hostLabel: "Mac mini",
      remoteItemId: "cai_remote",
      operationId: "op-1",
      movedAt: 1,
    }

    it("fences an instance that moved away and restores it on take-back", async () => {
      const row = await createAdapterInstance(baseInput())
      const fenced = await setAdapterInstanceOwner(row.id, moved)
      expect(fenced).toMatchObject({ enabled: false, owner: moved })
      expect((await listEnabledAdapterInstances()).map((r) => r.id)).not.toContain(row.id)

      const back = await setAdapterInstanceOwner(row.id, undefined, { enabled: true })
      expect(back?.enabled).toBe(true)
      expect(back && "owner" in back).toBe(false)
      expect(await setAdapterInstanceOwner("cai_missing", moved)).toBeUndefined()
    })

    it("refuses every edit of a placeholder, which would not reach the host", async () => {
      const row = await createAdapterInstance(baseInput())
      await setAdapterInstanceOwner(row.id, moved)
      await expect(updateAdapterInstance(row.id, { enabled: true })).rejects.toThrow(
        /item_owned_elsewhere: this connector instance runs on Mac mini/
      )
      await expect(updateAdapterConfigSection(row.id, "behavior", { muted: true })).rejects.toThrow(
        /item_owned_elsewhere/
      )
      await expect(patchAdapterInstanceSettings(row.id, { a: 1 })).rejects.toThrow(
        /item_owned_elsewhere/
      )
      expect((await getAdapterInstance(row.id))?.enabled).toBe(false)
    })

    it("never creates a placeholder from a copied row", async () => {
      const row = await createAdapterInstance({ ...baseInput(), owner: moved } as never)
      expect("owner" in row).toBe(false)
    })
  })
})

describe("on a shell whose connections live on a Host (ADR-0224)", () => {
  function hostWriter(applies = true) {
    const writer = {
      applies: jest.fn(() => applies),
      create: jest.fn(async (row: { id: string }) => ({
        id: row.id,
        enabled: false,
        updatedAt: 7,
      })),
      configure: jest.fn(async () => undefined),
      remove: jest.fn(async () => undefined),
      completeCreate: jest.fn(async () => undefined),
    }
    const restore = setAdapterInstanceRemoteWriter(writer as unknown as AdapterInstanceRemoteWriter)
    return { writer, restore }
  }

  it("creates on the Host and mirrors what the Host stored", async () => {
    const { writer, restore } = hostWriter()
    try {
      const row = await createAdapterInstance(baseInput())
      expect(writer.create).toHaveBeenCalledWith(
        expect.objectContaining({ id: row.id, type: "telegram" })
      )
      expect(row).toMatchObject({ enabled: false, updatedAt: 7, displayName: "My Bot" })
      expect(await getAdapterInstance(row.id)).toEqual(row)

      await completeAdapterInstanceCreate(row.id)
      expect(writer.completeCreate).toHaveBeenCalledWith(row.id)
    } finally {
      restore()
    }
  })

  it("edits on the Host and keeps the mirror in step", async () => {
    const local = await createAdapterInstance(baseInput())
    const { writer, restore } = hostWriter()
    try {
      await updateAdapterInstance(local.id, { displayName: "Renamed" })
      expect(writer.configure).toHaveBeenLastCalledWith(local.id, { displayName: "Renamed" })

      await updateAdapterConfigSection(local.id, "behavior", { muted: true })
      expect(writer.configure).toHaveBeenLastCalledWith(local.id, { muted: true })
      // The Host keeps the audit trail; the mirror writes none.
      expect(await getDb().connectorAudit.where("adapterId").equals(local.id).count()).toBe(0)

      await patchAdapterInstanceSettings(local.id, { extra: 1 })
      expect(writer.configure).toHaveBeenLastCalledWith(local.id, {
        settings: { token: "redacted", extra: 1 },
      })
      expect(await getAdapterInstance(local.id)).toMatchObject({
        displayName: "Renamed",
        muted: true,
        settings: { token: "redacted", extra: 1 },
      })

      await deleteAdapterInstance(local.id)
      expect(writer.remove).toHaveBeenCalledWith(local.id)
      expect(await getAdapterInstance(local.id)).toBeUndefined()
    } finally {
      restore()
    }
  })

  it("leaves a write local when the writer does not apply", async () => {
    const { writer, restore } = hostWriter(false)
    try {
      const row = await createAdapterInstance(baseInput())
      await updateAdapterInstance(row.id, { displayName: "Local" })
      await completeAdapterInstanceCreate(row.id)
      await deleteAdapterInstance(row.id)
      expect(writer.create).not.toHaveBeenCalled()
      expect(writer.configure).not.toHaveBeenCalled()
      expect(writer.completeCreate).not.toHaveBeenCalled()
      expect(writer.remove).not.toHaveBeenCalled()
      expect(row.enabled).toBe(true)
    } finally {
      restore()
    }
  })

  it("does not write locally when the Host refuses", async () => {
    const { writer, restore } = hostWriter()
    writer.create.mockRejectedValueOnce(new Error("refused"))
    try {
      await expect(createAdapterInstance(baseInput())).rejects.toThrow("refused")
      expect(await listAdapterInstances()).toHaveLength(0)
    } finally {
      restore()
    }
  })
})
