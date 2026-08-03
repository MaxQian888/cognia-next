import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

describe("createDbTestFixture", () => {
  it("keeps getDb unavailable in an ordinary Node test runtime", () => {
    expect(() => getDb()).toThrow("getDb() called on the server — wrap usage in a client component")
  })

  it("opens the seeded database only while the fixture is active", async () => {
    const fixture = createDbTestFixture()

    await fixture.initialize()

    expect(await getDb().skills.count()).toBeGreaterThan(0)

    await fixture.dispose()
    expect(() => getDb()).toThrow("getDb() called on the server — wrap usage in a client component")
  })

  it("restores every table to the captured seeded baseline", async () => {
    const fixture = createDbTestFixture()
    await fixture.initialize()
    const seededSkillCount = await getDb().skills.count()

    await getDb().skills.clear()
    await getDb().table("settings").put({ id: "leaked-setting" })
    await fixture.restore()

    expect(await getDb().skills.count()).toBe(seededSkillCount)
    expect(await getDb().table("settings").get("leaked-setting")).toBeUndefined()
    await fixture.dispose()
  })

  it("captures requested seed tables as empty", async () => {
    const fixture = createDbTestFixture({ emptyTables: ["skills"] })
    await fixture.initialize()

    expect(await getDb().skills.count()).toBe(0)
    await getDb().skills.put({ id: "temporary-skill", name: "Temporary" } as never)
    await fixture.restore()
    expect(await getDb().skills.count()).toBe(0)

    await fixture.dispose()
  })

  it("runs registered cleanup before restoring database state", async () => {
    const fixture = createDbTestFixture()
    await fixture.initialize()
    const cleanup = jest.fn()
    fixture.registerCleanup(async () => {
      await Promise.resolve()
      cleanup()
    })

    await fixture.restore()

    expect(cleanup).toHaveBeenCalledTimes(1)
    await fixture.dispose()
  })

  it("poisons the fixture and deletes the database after a restore transaction fails", async () => {
    const fixture = createDbTestFixture()
    await fixture.initialize()
    const db = getDb()
    const failure = new Error("restore transaction failed")
    const transaction = jest.spyOn(db, "transaction").mockRejectedValueOnce(failure as never)

    try {
      await expect(fixture.restore()).rejects.toBe(failure)
      await expect(fixture.restore()).rejects.toThrow(
        "Database test fixture cannot recover after a failed restore"
      )
      expect((await indexedDB.databases()).some(({ name }) => name === db.name)).toBe(false)
    } finally {
      transaction.mockRestore()
      await fixture.dispose()
    }
  })

  it("poisons the fixture when cleanup makes a restore fail", async () => {
    const fixture = createDbTestFixture()
    await fixture.initialize()
    fixture.registerCleanup(() => {
      throw new Error("late writer did not stop")
    })

    await expect(fixture.restore()).rejects.toThrow("late writer did not stop")
    await expect(fixture.restore()).rejects.toThrow(
      "Database test fixture cannot recover after a failed restore"
    )
    await fixture.dispose()
  })

  it("supports an entirely empty baseline", async () => {
    const fixture = createDbTestFixture({ seeded: false })
    await fixture.initialize()

    expect(await getDb().skills.count()).toBe(0)

    await fixture.dispose()
  })

  it("cleans up the runtime when initialization rejects an unknown table", async () => {
    const fixture = createDbTestFixture({ emptyTables: ["missing-table"] })

    await expect(fixture.initialize()).rejects.toThrow(
      "Unknown CogniaDB table in test fixture: missing-table"
    )
    expect(() => getDb()).toThrow("getDb() called on the server — wrap usage in a client component")
  })

  it("rejects invalid lifecycle ordering and duplicate initialization", async () => {
    const fixture = createDbTestFixture()

    await expect(fixture.restore()).rejects.toThrow(
      "Database test fixture must be initialized before restore"
    )
    expect(() => fixture.registerCleanup(() => undefined)).toThrow(
      "Database test fixture must be initialized before registering cleanup"
    )
    await fixture.dispose()

    await fixture.initialize()
    await expect(fixture.initialize()).rejects.toThrow(
      "Database test fixture is already initialized"
    )
    await fixture.dispose()
    await fixture.dispose()
  })

  it("allows a registered cleanup to be withdrawn", async () => {
    const fixture = createDbTestFixture()
    await fixture.initialize()
    const cleanup = jest.fn()
    const unregister = fixture.registerCleanup(cleanup)

    unregister()
    await fixture.restore()

    expect(cleanup).not.toHaveBeenCalled()
    await fixture.dispose()
  })

  describe("shared Jest hook integration", () => {
    const fixture = createDbTestFixture({ emptyTables: ["settings"] })

    beforeAll(fixture.initialize)
    beforeEach(fixture.restore)
    afterAll(fixture.dispose)

    it("allows a test body to leave indirect writes behind", async () => {
      await getDb().table("settings").put({ id: "cross-test-leak", value: true })
      expect(await getDb().table("settings").get("cross-test-leak")).toBeDefined()
    })

    describe("nested describe", () => {
      it("restores the baseline before the next nested test", async () => {
        expect(await getDb().table("settings").get("cross-test-leak")).toBeUndefined()
      })
    })
  })
})
