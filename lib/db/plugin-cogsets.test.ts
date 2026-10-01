import {
  createCogset,
  deleteCogset,
  getCogset,
  getCogsetState,
  listCogsets,
  normalizeCogsetMembers,
  updateCogset,
  updateCogsetState,
} from "./plugin-cogsets"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})
afterAll(dbFixture.dispose)

describe("normalizeCogsetMembers", () => {
  it("dedupes by plugin id (last wins), trims, drops blanks and sorts", () => {
    expect(
      normalizeCogsetMembers([
        { pluginId: " b ", expectedVersion: "1.0.0" },
        { pluginId: "a", optional: false },
        { pluginId: "" },
        { pluginId: "b", config: { x: 1 }, optional: true },
      ])
    ).toEqual([{ pluginId: "a" }, { pluginId: "b", config: { x: 1 }, optional: true }])
  })
})

describe("cogsets", () => {
  it("creates, lists by name, updates and refuses an empty name", async () => {
    const writing = await createCogset(
      { name: " Writing ", members: [{ pluginId: "pdf" }], source: { kind: "manual" } },
      10
    )
    await createCogset({ name: "Alpha", members: [], source: { kind: "manual" } }, 11)
    expect(writing.name).toBe("Writing")
    expect((await listCogsets()).map((c) => c.name)).toEqual(["Alpha", "Writing"])

    const updated = await updateCogset(
      writing.id,
      { description: "Long form", members: [{ pluginId: "office" }, { pluginId: "pdf" }] },
      20
    )
    expect(updated).toMatchObject({
      description: "Long form",
      members: [{ pluginId: "office" }, { pluginId: "pdf" }],
      updatedAt: 20,
      createdAt: 10,
    })
    const cleared = await updateCogset(writing.id, { description: "  " }, 21)
    expect(cleared && "description" in cleared).toBe(false)

    await expect(
      createCogset({ name: " ", members: [], source: { kind: "manual" } })
    ).rejects.toThrow("A cogset needs a name")
    await expect(updateCogset(writing.id, { name: "" })).rejects.toThrow("A cogset needs a name")
    expect(await updateCogset("nope", { name: "x" })).toBeUndefined()
  })

  it("deleting a cogset clears every reference to it", async () => {
    const doomed = await createCogset({ name: "Doomed", members: [], source: { kind: "manual" } })
    const kept = await createCogset({ name: "Kept", members: [], source: { kind: "manual" } })
    await updateCogsetState({
      globalCogsetId: doomed.id,
      appliedCogsetId: doomed.id,
      appliedAt: 5,
      pending: { cogsetId: doomed.id, reason: "runs-in-flight", since: 1 },
    })
    await getDb().projects.bulkPut([
      { id: "w1", name: "W1", pluginCogsetId: doomed.id } as never,
      { id: "w2", name: "W2", pluginCogsetId: kept.id } as never,
    ])
    const install = (id: string, cogsetId: string) =>
      ({
        id,
        cogpackId: "pack",
        version: "1.0.0",
        cogsetId,
        installedAt: 1,
      }) as never
    await getDb().cogpackInstalls.bulkPut([install("i1", doomed.id), install("i2", kept.id)])

    await deleteCogset(doomed.id)

    expect(await getCogset(doomed.id)).toBeUndefined()
    const state = await getCogsetState()
    expect(state.globalCogsetId).toBeUndefined()
    expect(state.appliedCogsetId).toBeUndefined()
    expect(state.appliedAt).toBeUndefined()
    expect(state.pending).toBeUndefined()
    expect((await getDb().projects.get("w1"))?.pluginCogsetId).toBeUndefined()
    expect((await getDb().projects.get("w2"))?.pluginCogsetId).toBe(kept.id)
    expect((await getDb().cogpackInstalls.toArray()).map((row) => row.id)).toEqual(["i2"])
    const tombstones = await getDb().syncTombstones.where("table").equals("pluginCogsets").toArray()
    expect(tombstones.map((row) => row.id)).toEqual([doomed.id])
  })
})

describe("cogset state", () => {
  it("defaults to an empty always-on set", async () => {
    expect(await getCogsetState()).toMatchObject({ id: "host", alwaysOn: [] })
  })

  it("merges patches, removes keys set to undefined and normalizes always-on", async () => {
    await updateCogsetState({ globalCogsetId: "a", alwaysOn: ["b", " a ", "b", ""] }, 1)
    const next = await updateCogsetState({ globalCogsetId: undefined, appliedCogsetId: "a" }, 2)
    expect(next).toEqual({
      id: "host",
      alwaysOn: ["a", "b"],
      appliedCogsetId: "a",
      updatedAt: 2,
    })
  })
})
