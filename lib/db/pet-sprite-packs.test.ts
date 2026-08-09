import {
  addPetSpritePack,
  deletePetSpritePack,
  getPetSpritePack,
  getPetSpritePackStorageUsage,
  listPetSpritePacks,
} from "./pet-sprite-packs"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().petSpritePacks.clear()
})
afterAll(dbFixture.dispose)

function pack(id: string, displayName = id, bytes = "sprite") {
  return {
    id,
    displayName,
    description: `${displayName} description`,
    spriteVersionNumber: 2 as const,
    spritesheet: new Blob([bytes], { type: "image/webp" }),
  }
}

describe("pet sprite pack CRUD", () => {
  it("adds and gets a complete v2 pack row", async () => {
    const input = pack("momo", "Momo", "12345")
    const row = await addPetSpritePack(input, 123)

    expect(row).toMatchObject({
      id: "momo",
      displayName: "Momo",
      description: "Momo description",
      spriteVersionNumber: 2,
      totalBytes: 5,
      createdAt: 123,
    })
    expect(row.spritesheet).toBe(input.spritesheet)
    await expect(getPetSpritePack("momo")).resolves.toMatchObject({ id: "momo", totalBytes: 5 })
  })

  it("returns undefined for a missing pack", async () => {
    await expect(getPetSpritePack("missing")).resolves.toBeUndefined()
  })

  it("lists packs oldest-first using the createdAt index", async () => {
    await addPetSpritePack(pack("latest", "Latest"), 300)
    await addPetSpritePack(pack("first", "First"), 100)
    await addPetSpritePack(pack("middle", "Middle"), 200)

    await expect(listPetSpritePacks()).resolves.toEqual([
      expect.objectContaining({ id: "first" }),
      expect.objectContaining({ id: "middle" }),
      expect.objectContaining({ id: "latest" }),
    ])
  })

  it("rejects duplicate ids without replacing the installed pack", async () => {
    await addPetSpritePack(pack("momo", "Original"), 100)

    await expect(addPetSpritePack(pack("momo", "Replacement"), 200)).rejects.toThrow(
      "already installed"
    )
    await expect(getPetSpritePack("momo")).resolves.toMatchObject({
      displayName: "Original",
      createdAt: 100,
    })
  })

  it("rejects malformed ids and non-v2 rows at the persistence boundary", async () => {
    await expect(addPetSpritePack(pack("../momo"), 100)).rejects.toThrow(
      "Invalid pet sprite pack id"
    )
    await expect(
      addPetSpritePack({ ...pack("momo"), spriteVersionNumber: 1 as never }, 100)
    ).rejects.toThrow("spriteVersionNumber")
  })

  it("deletes an installed pack and treats a missing id as a no-op", async () => {
    await addPetSpritePack(pack("momo"), 100)
    await addPetSpritePack(pack("nori"), 200)

    await deletePetSpritePack("momo")
    await deletePetSpritePack("missing")

    await expect(getPetSpritePack("momo")).resolves.toBeUndefined()
    await expect(listPetSpritePacks()).resolves.toEqual([expect.objectContaining({ id: "nori" })])
  })

  it("clears global and per-character selection when deleting an active pack", async () => {
    await addPetSpritePack(pack("momo"), 100)
    await getDb().settings.put({
      id: "singleton",
      petSettings: {
        enabled: true,
        anchor: "bottom-right",
        motion: "auto",
        mutedBubbles: false,
        size: 96,
        skinId: "sprite-v2",
        activeSpritePackId: "momo",
      },
    } as never)
    await getDb().petCharacterBindings.put({
      characterId: "sprite-character",
      skin: { skinId: "sprite-v2", packId: "momo" },
      updatedAt: "old",
    })

    await deletePetSpritePack("momo")

    expect((await getDb().settings.get("singleton"))?.petSettings).toMatchObject({ skinId: "svg" })
    expect(
      (await getDb().settings.get("singleton"))?.petSettings?.activeSpritePackId
    ).toBeUndefined()
    expect((await getDb().petCharacterBindings.get("sprite-character"))?.skin).toBeUndefined()
  })

  it("reports pack count and total persisted sprite bytes", async () => {
    await expect(getPetSpritePackStorageUsage()).resolves.toEqual({ packs: 0, totalBytes: 0 })
    await addPetSpritePack(pack("momo", "Momo", "12345"), 100)
    await addPetSpritePack(pack("nori", "Nori", "1234567"), 200)
    await expect(getPetSpritePackStorageUsage()).resolves.toEqual({ packs: 2, totalBytes: 12 })
  })
})
