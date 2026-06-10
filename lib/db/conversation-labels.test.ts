import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "./schema"
import {
  createLabel,
  updateLabel,
  listLabels,
  deleteLabel,
  seedBuiltinLabels,
} from "./conversation-labels"
import { upsertByConversationKey } from "./conversation-overrides"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
})

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

    expect(await getDb().conversationLabels.get(lbl.id)).toBeUndefined()
    const k1 = await getDb().conversationOverrides.where("conversationKey").equals("k1").first()
    const k2 = await getDb().conversationOverrides.where("conversationKey").equals("k2").first()
    expect(k1?.labelIds).toEqual(["other"])
    expect(k2?.labelIds).toEqual([])
  })

  it("refuses to delete a built-in label (transaction aborts)", async () => {
    await seedBuiltinLabels()
    const builtin = (await listLabels()).find((l) => l.builtin)!
    await expect(deleteLabel(builtin.id)).rejects.toThrow(/built-in/i)
    expect(await getDb().conversationLabels.get(builtin.id)).toBeDefined()
  })

  it("seedBuiltinLabels is idempotent", async () => {
    await seedBuiltinLabels()
    const first = await listLabels()
    await seedBuiltinLabels()
    const second = await listLabels()
    expect(second).toHaveLength(first.length)
    expect(first.every((l) => l.builtin)).toBe(true)
  })

  it("deleteLabel is a no-op for an unknown id", async () => {
    await expect(deleteLabel("nope")).resolves.toBeUndefined()
  })
})
