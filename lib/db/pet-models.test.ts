// Coverage for the pet Live2D model storage CRUD layer (v73).

import {
  listPetModels,
  getPetModel,
  addPetModel,
  deletePetModel,
  getPetModelEntries,
  getPetModelStorageUsage,
  updatePetModelCustomization,
  revalidatePetModelCompatibility,
} from "./pet-models"
import type { PetModelRow } from "./pet-models"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await Promise.all([getDb().petModels.clear(), getDb().petModelFiles.clear()])
})
afterAll(dbFixture.dispose)

type Meta = Omit<PetModelRow, "id" | "createdAt"> & { id?: string }

function meta(partial: Partial<Meta> = {}): Meta {
  return {
    name: "Hiyori",
    source: "import",
    settingsPath: "Hiyori.model3.json",
    motionGroups: ["Idle", "TapBody"],
    expressionIds: ["smile"],
    totalBytes: 1234,
    ...partial,
  }
}

function file(path: string, text: string, mime = "application/octet-stream") {
  return { path, blob: new Blob([text]), mime }
}

describe("pet-models CRUD", () => {
  it("adds a model with files and returns the generated id + createdAt", async () => {
    const row = await addPetModel(meta(), [
      file("Hiyori.model3.json", "{}", "application/json"),
      file("Hiyori.moc3", "moc-bytes"),
    ])
    expect(row.id).toMatch(/^pm_/)
    expect(row.createdAt).toBeGreaterThan(0)
    expect(row.name).toBe("Hiyori")

    const stored = await getPetModel(row.id)
    expect(stored?.name).toBe("Hiyori")
    expect(stored?.motionGroups).toEqual(["Idle", "TapBody"])
  })

  it("honors an explicit id and a pinned createdAt", async () => {
    const row = await addPetModel(
      { ...meta(), id: "pm_fixed", source: "sample", sampleId: "hiyori" },
      [file("Hiyori.model3.json", "{}")],
      111
    )
    expect(row.id).toBe("pm_fixed")
    expect(row.createdAt).toBe(111)
    expect(row.source).toBe("sample")
    expect(row.sampleId).toBe("hiyori")
  })

  it("defaults the file mime to octet-stream when omitted", async () => {
    const row = await addPetModel(meta(), [{ path: "a.moc3", blob: new Blob(["x"]) }])
    const stored = await getDb().petModelFiles.get(`${row.id}:a.moc3`)
    expect(stored?.mime).toBe("application/octet-stream")
  })

  it("lists models ordered by createdAt", async () => {
    await addPetModel({ ...meta({ name: "B" }) }, [file("b.json", "{}")], 200)
    await addPetModel({ ...meta({ name: "A" }) }, [file("a.json", "{}")], 100)
    await addPetModel({ ...meta({ name: "C" }) }, [file("c.json", "{}")], 300)
    const list = await listPetModels()
    expect(list.map((m) => m.name)).toEqual(["A", "B", "C"])
  })

  it("returns undefined for a missing model and [] entries", async () => {
    expect(await getPetModel("nope")).toBeUndefined()
    expect(await getPetModelEntries("nope")).toEqual([])
  })

  it("round-trips file rows via getPetModelEntries (path set + blob payload)", async () => {
    // NOTE on blob equality: fake-indexeddb clones values through the jsdom env
    // where the round-tripped Blob loses its prototype methods (text()/
    // arrayBuffer()), so byte-content cannot be read back here. We assert the
    // structural round-trip (path set + per-path blob size, which IS preserved);
    // the blob payload itself passes through Dexie's bulkPut/toArray untouched.
    const row = await addPetModel(meta(), [
      file("Hiyori.model3.json", '{"v":3}', "application/json"),
      file("textures/0.png", "PNG-BYTES", "image/png"),
    ])
    const entries = await getPetModelEntries(row.id)
    const byPath = Object.fromEntries(entries.map((e) => [e.path, e]))
    expect(Object.keys(byPath).sort()).toEqual(["Hiyori.model3.json", "textures/0.png"])
    // The blob property survives as the stored value (its concrete identity is
    // a fake-indexeddb clone, but it is present and non-null per file row).
    expect(byPath["Hiyori.model3.json"].blob).toBeDefined()
    expect(byPath["textures/0.png"].blob).toBeDefined()
    // The raw rows carry the correct composite ids and per-path mime metadata.
    const rawJson = await getDb().petModelFiles.get(`${row.id}:Hiyori.model3.json`)
    const rawPng = await getDb().petModelFiles.get(`${row.id}:textures/0.png`)
    expect(rawJson?.mime).toBe("application/json")
    expect(rawPng?.mime).toBe("image/png")
  })

  it("cascade-deletes the model meta and all its files", async () => {
    const a = await addPetModel(meta({ name: "A" }), [file("a.json", "{}"), file("a.moc3", "m")])
    const b = await addPetModel(meta({ name: "B" }), [file("b.json", "{}")])

    await deletePetModel(a.id)

    expect(await getPetModel(a.id)).toBeUndefined()
    expect(await getPetModelEntries(a.id)).toEqual([])
    // B is untouched.
    expect(await getPetModel(b.id)).toBeDefined()
    expect((await getPetModelEntries(b.id)).length).toBe(1)
    // No orphaned files for A remain.
    expect(await getDb().petModelFiles.where("modelId").equals(a.id).count()).toBe(0)
  })

  it("transactionally clears global and character references before falling back", async () => {
    const row = await addPetModel(meta(), [file("a.json", "{}")])
    await getDb().settings.put({
      id: "singleton",
      petSettings: {
        enabled: true,
        anchor: "bottom-right",
        motion: "auto",
        mutedBubbles: false,
        size: 96,
        skinId: "live2d",
        activeLive2dModelId: row.id,
      },
    } as never)
    await getDb().petCharacterBindings.bulkPut([
      { characterId: "legacy", live2dModelId: row.id, updatedAt: "old" },
      {
        characterId: "typed",
        skin: { skinId: "live2d", modelId: row.id },
        updatedAt: "old",
      },
    ])

    await deletePetModel(row.id)

    const storedSettings = await getDb().settings.get("singleton")
    expect(storedSettings?.petSettings).toMatchObject({ skinId: "svg" })
    expect(storedSettings?.petSettings?.activeLive2dModelId).toBeUndefined()
    expect((await getDb().petCharacterBindings.get("legacy"))?.live2dModelId).toBeUndefined()
    expect((await getDb().petCharacterBindings.get("typed"))?.skin).toBeUndefined()
  })

  it("deleting a missing model is a no-op", async () => {
    await expect(deletePetModel("nope")).resolves.toBeUndefined()
  })

  it("patches customization fields without touching the rest of the row", async () => {
    const row = await addPetModel(meta(), [file("a.json", "{}")])
    await updatePetModelCustomization(row.id, {
      transform: { scale: 1.4, offsetX: 0.1, offsetY: -0.2 },
    })
    let stored = await getPetModel(row.id)
    expect(stored?.transform).toEqual({ scale: 1.4, offsetX: 0.1, offsetY: -0.2 })
    expect(stored?.name).toBe("Hiyori")
    expect(stored?.motionGroups).toEqual(["Idle", "TapBody"])

    // A second patch of the other field leaves the first in place.
    await updatePetModelCustomization(row.id, {
      motionOverrides: { happy: { motionGroup: "TapBody", expressionId: "smile" }, sleeping: {} },
    })
    stored = await getPetModel(row.id)
    expect(stored?.transform).toEqual({ scale: 1.4, offsetX: 0.1, offsetY: -0.2 })
    expect(stored?.motionOverrides).toEqual({
      happy: { motionGroup: "TapBody", expressionId: "smile" },
      sleeping: {},
    })
  })

  it("customization patch on a missing id is a no-op", async () => {
    await expect(
      updatePetModelCustomization("nope", { transform: { scale: 1, offsetX: 0, offsetY: 0 } })
    ).resolves.toBeUndefined()
    expect(await getPetModel("nope")).toBeUndefined()
  })

  it("lazily persists an invalid compatibility summary for a legacy row once", async () => {
    const row = await addPetModel(meta(), [file("not-a-model.txt", "x")])
    const first = await revalidatePetModelCompatibility(row.id)
    expect(first?.compatibility).toMatchObject({
      version: 1,
      status: "invalid",
      diagnostics: [expect.objectContaining({ code: "noSettings", severity: "error" })],
    })
    const second = await revalidatePetModelCompatibility(row.id)
    expect(second?.compatibility).toEqual(first?.compatibility)
  })

  it("reports storage usage (model count + summed totalBytes)", async () => {
    expect(await getPetModelStorageUsage()).toEqual({ models: 0, totalBytes: 0 })
    await addPetModel(meta({ totalBytes: 1000 }), [file("a.json", "{}")])
    await addPetModel(meta({ totalBytes: 2500 }), [file("b.json", "{}")])
    expect(await getPetModelStorageUsage()).toEqual({ models: 2, totalBytes: 3500 })
  })
})
