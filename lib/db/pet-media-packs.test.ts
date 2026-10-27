import {
  addPetMediaPack,
  deletePetMediaPack,
  getPetMediaPack,
  listPetMediaPacks,
} from "./pet-media-packs"
import { createDbTestFixture } from "./test-fixture"
import { getDb, activateAccountDatabase, clearAccountDatabaseSelection } from "./schema"
import type { MediaPackAsset } from "@/lib/pet/media-packs/manifest"
const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  await getDb().petMediaPacks.clear()
})
afterAll(fixture.dispose)
const pack = (): MediaPackAsset => ({
  id: "mp_test",
  manifest: {
    version: 1,
    displayName: "Whale",
    source: "dsh-frames",
    width: 412,
    height: 344,
    clips: { idle: { kind: "frames", frames: ["a.webp"], frameMs: 42, loop: true } },
    states: { idle: ["idle"] },
    ambient: [],
  },
  entries: [{ path: "a.webp", blob: new Blob(["abc"]) }],
  totalBytes: 3,
  createdAt: 123,
})
it("persists full blobs but lists metadata only", async () => {
  await addPetMediaPack(pack())
  expect(await getPetMediaPack("mp_test")).toMatchObject({
    displayName: "Whale",
    totalBytes: 3,
    createdAt: 123,
  })
  expect(await (await getPetMediaPack("mp_test"))!.entries[0].blob.text()).toBe("abc")
  const rows = await listPetMediaPacks()
  expect(rows).toHaveLength(1)
  expect(rows[0]).not.toHaveProperty("entries")
  await expect(addPetMediaPack(pack())).rejects.toThrow()
})

it("keeps media bytes and deletion inside the active account database", async () => {
  await addPetMediaPack(pack())
  activateAccountDatabase("acct_media_other")
  try {
    expect(await getPetMediaPack("mp_test")).toBeUndefined()
    await addPetMediaPack({ ...pack(), entries: [{ path: "a.webp", blob: new Blob(["xyz"]) }] })
    expect(await (await getPetMediaPack("mp_test"))!.entries[0].blob.text()).toBe("xyz")
    await deletePetMediaPack("mp_test")
    expect(await listPetMediaPacks()).toEqual([])
  } finally {
    await getDb().delete()
    clearAccountDatabaseSelection()
  }
  expect(await (await getPetMediaPack("mp_test"))!.entries[0].blob.text()).toBe("abc")
})
it("rejects invalid or missing media before storage", async () => {
  await expect(addPetMediaPack({ ...pack(), entries: [] })).rejects.toThrow("Invalid media pack")
  expect(await listPetMediaPacks()).toEqual([])
})
it("deletes the pack and clears its active setting and character binding atomically", async () => {
  await addPetMediaPack(pack())
  const db = getDb()
  await db.settings.put({
    id: "singleton",
    petSettings: {
      enabled: true,
      anchor: "bottom-right",
      motion: "auto",
      mutedBubbles: false,
      size: 96,
      skinId: "media",
      activeMediaPackId: "mp_test",
    },
  } as never)
  await db.petCharacterBindings.put({
    characterId: "test",
    skin: { skinId: "media", packId: "mp_test" },
    updatedAt: "",
  })
  await deletePetMediaPack("mp_test")
  expect(await getPetMediaPack("mp_test")).toBeUndefined()
  expect((await db.settings.get("singleton"))?.petSettings).toMatchObject({ skinId: "svg" })
  expect((await db.petCharacterBindings.get("test"))?.skin).toBeUndefined()
})
