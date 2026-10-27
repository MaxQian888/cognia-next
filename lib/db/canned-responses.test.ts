import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import {
  createCanned,
  updateCanned,
  deleteCanned,
  listCanned,
  incrementUsage,
  seedBuiltinCanned,
} from "./canned-responses"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

describe("canned-responses", () => {
  it("creates, lists (sorted), and updates", async () => {
    await createCanned({ title: "Bravo", body: "b", sortOrder: 1 })
    const a = await createCanned({ title: "Alpha", body: "a", sortOrder: 0 })
    expect((await listCanned()).map((c) => c.title)).toEqual(["Alpha", "Bravo"])

    await updateCanned(a.id, { body: "a2", category: "greetings" })
    const reloaded = (await listCanned()).find((c) => c.id === a.id)
    expect(reloaded).toMatchObject({ body: "a2", category: "greetings" })
  })

  it("defaults sortOrder to the current count and usageCount to 0", async () => {
    await createCanned({ title: "one", body: "1" })
    const second = await createCanned({ title: "two", body: "2" })
    expect(second.sortOrder).toBe(1)
    expect(second.usageCount).toBe(0)
  })

  it("incrementUsage bumps the counter and is a no-op for unknown ids", async () => {
    const c = await createCanned({ title: "x", body: "y" })
    await incrementUsage(c.id)
    await incrementUsage(c.id)
    expect((await getDb().cannedResponses.get(c.id))?.usageCount).toBe(2)
    await expect(incrementUsage("nope")).resolves.toBeUndefined()
  })

  it("deleteCanned removes user entries but protects built-ins", async () => {
    const c = await createCanned({ title: "tmp", body: "z" })
    await deleteCanned(c.id)
    expect(await getDb().cannedResponses.get(c.id)).toBeUndefined()

    await seedBuiltinCanned()
    const builtin = (await listCanned()).find((r) => r.isBuiltIn)!
    await expect(deleteCanned(builtin.id)).rejects.toThrow(/built-in/i)
    expect(await getDb().cannedResponses.get(builtin.id)).toBeDefined()
  })

  it("seedBuiltinCanned is idempotent", async () => {
    await seedBuiltinCanned()
    const first = await listCanned()
    await seedBuiltinCanned()
    expect(await listCanned()).toHaveLength(first.length)
  })

  it("seeds each starter once when multiple consumers initialize concurrently", async () => {
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => seedBuiltinCanned()))

    expect(results).toEqual(
      Array.from({ length: 4 }, () => ({ status: "fulfilled", value: undefined }))
    )
    expect((await listCanned()).map((response) => response.id)).toEqual([
      "can-builtin-greeting",
      "can-builtin-ack",
      "can-builtin-resolved",
    ])
  })

  it("preserves edited starters and usage while concurrent initialization fills missing entries", async () => {
    await seedBuiltinCanned()
    await updateCanned("can-builtin-greeting", {
      title: "Welcome",
      body: "Custom greeting",
      category: "Support",
      sortOrder: 8,
    })
    await incrementUsage("can-builtin-greeting")
    const existing = await getDb().cannedResponses.get("can-builtin-greeting")
    await getDb().cannedResponses.delete("can-builtin-ack")

    await Promise.all(Array.from({ length: 4 }, () => seedBuiltinCanned()))

    expect(await getDb().cannedResponses.get("can-builtin-greeting")).toEqual(existing)
    expect(await listCanned()).toHaveLength(3)
    expect(await getDb().cannedResponses.get("can-builtin-ack")).toMatchObject({
      title: "Acknowledge",
      isBuiltIn: true,
    })
  })

  it("deleteCanned is a no-op for an unknown id", async () => {
    await expect(deleteCanned("missing")).resolves.toBeUndefined()
  })
})
