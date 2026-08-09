import { ensurePetProfile, hatchPet } from "./init-pet"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getPetProfile } from "@/lib/db/pet"

// Cold fake-indexeddb open of the full schema can exceed jest's 5s default
// under parallel suite load — same allowance as the other Dexie-cold suites.
const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().petProfile.clear()
}, 30_000)

afterAll(dbFixture.dispose)

describe("ensurePetProfile", () => {
  it("creates a fresh egg the first time", async () => {
    const p = await ensurePetProfile("acct-1", 1000)
    expect(p).toMatchObject({
      id: "global",
      soul: null,
      stage: "egg",
      accountFingerprint: "acct-1",
    })
  })

  it("returns the existing profile without overwriting", async () => {
    await ensurePetProfile("acct-1", 1000)
    const again = await ensurePetProfile("acct-2", 2000)
    expect(again.accountFingerprint).toBe("acct-1") // unchanged
  })
})

describe("hatchPet", () => {
  it("generates a soul and advances the stage", async () => {
    await ensurePetProfile("acct-1", 0)
    const hatched = await hatchPet(null, 5000)
    expect(hatched?.soul).not.toBeNull()
    expect(hatched?.soul?.name).toBeTruthy()
    expect(hatched?.stage).toBe("baby")
    expect((await getPetProfile())?.soul).not.toBeNull()
  })

  it("is a no-op once already hatched", async () => {
    await ensurePetProfile("acct-1", 0)
    const first = await hatchPet(null, 5000)
    const second = await hatchPet(null, 9000)
    expect(second?.soul?.name).toBe(first?.soul?.name)
  })

  it("is a no-op when there is no profile", async () => {
    expect(await hatchPet(null)).toBeUndefined()
  })
})
