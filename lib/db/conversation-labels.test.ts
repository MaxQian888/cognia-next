import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import {
  createLabel,
  updateLabel,
  listLabels,
  deleteLabel,
  seedBuiltinLabels,
} from "./conversation-labels"
import { upsertByConversationKey } from "./conversation-overrides"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

describe("conversation-labels", () => {
  it("creates, lists (sorted), and updates labels", async () => {
    const a = await createLabel({ name: "Beta", sortOrder: 1 })
    await createLabel({ name: "Alpha", sortOrder: 0 })
    const list = await listLabels()
    expect(list.map((l) => l.name)).toEqual(["Alpha", "Beta"])

    await updateLabel(a.id, { name: "Beta-2", color: "#000" })
    const reloaded = (await listLabels()).find((l) => l.id === a.id)
    expect(reloaded).toMatchObject({ name: "Beta-2", color: "#000" })
  })

  it("defaults sortOrder to the current label count", async () => {
    await createLabel({ name: "one" })
    const second = await createLabel({ name: "two" })
    expect(second.sortOrder).toBe(1)
  })

  it("deleteLabel strips the id from every tagged conversation in a transaction", async () => {
    const lbl = await createLabel({ name: "VIP" })
    await upsertByConversationKey({
      conversationKey: "k1",
      sessionId: "s1",
      labelIds: [lbl.id, "other"],
    })
    await upsertByConversationKey({ conversationKey: "k2", sessionId: "s2", labelIds: [lbl.id] })

    await deleteLabel(lbl.id)

    // v170: the catalogue lives in the shared, scope-discriminated `labels`
    // table; `conversationLabels` is retained but no longer written.
    expect(await getDb().labels.get(lbl.id)).toBeUndefined()
    const k1 = await getDb().conversationOverrides.where("conversationKey").equals("k1").first()
    const k2 = await getDb().conversationOverrides.where("conversationKey").equals("k2").first()
    expect(k1?.labelIds).toEqual(["other"])
    expect(k2?.labelIds).toEqual([])
  })

  it("refuses to delete a built-in label (transaction aborts)", async () => {
    await seedBuiltinLabels()
    const builtin = (await listLabels()).find((l) => l.builtin)!
    await expect(deleteLabel(builtin.id)).rejects.toThrow(/built-in/i)
    expect(await getDb().labels.get(builtin.id)).toBeDefined()
  })

  it("seedBuiltinLabels is idempotent", async () => {
    await seedBuiltinLabels()
    const first = await listLabels()
    await seedBuiltinLabels()
    const second = await listLabels()
    expect(second).toHaveLength(first.length)
    expect(first.every((l) => l.builtin)).toBe(true)
  })

  it("seeds each built-in once when multiple consumers initialize concurrently", async () => {
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => seedBuiltinLabels()))

    expect(results).toEqual(
      Array.from({ length: 4 }, () => ({ status: "fulfilled", value: undefined }))
    )
    expect((await listLabels()).map((label) => label.id)).toEqual([
      "lbl-builtin-follow-up",
      "lbl-builtin-vip",
      "lbl-builtin-bug",
      "lbl-builtin-resolved",
    ])
  })

  it("preserves existing label fields while concurrent initialization fills missing starters", async () => {
    await seedBuiltinLabels()
    await updateLabel("lbl-builtin-vip", { name: "Priority", color: "#123456", sortOrder: 8 })
    const existing = await getDb().labels.get("lbl-builtin-vip")
    await getDb().labels.delete("lbl-builtin-bug")

    await Promise.all(Array.from({ length: 4 }, () => seedBuiltinLabels()))

    expect(await getDb().labels.get("lbl-builtin-vip")).toEqual(existing)
    expect(await listLabels()).toHaveLength(4)
    expect(await getDb().labels.get("lbl-builtin-bug")).toMatchObject({
      name: "Bug",
      builtin: true,
    })
  })

  it("deleteLabel is a no-op for an unknown id", async () => {
    await expect(deleteLabel("nope")).resolves.toBeUndefined()
  })
})
