import assert from "node:assert/strict"
import test from "node:test"

import { analyzeDbTestSource, auditResultPasses, parseArgs } from "./audit-db-fixtures.mjs"

test("parseArgs validates audit modes", () => {
  assert.deepEqual(parseArgs([]), { listCandidates: false, strict: false })
  assert.deepEqual(parseArgs(["--strict"]), { listCandidates: false, strict: true })
  assert.deepEqual(parseArgs(["--list-candidates"]), { listCandidates: true, strict: false })
  assert.throws(() => parseArgs(["--list-candidates", "--strict"]), /cannot be combined/)
  assert.throws(() => parseArgs(["--unknown"]), /unknown option/i)
})

test("recognizes the legacy per-test database recreation hook", () => {
  const result = analyzeDbTestSource(`
    beforeEach(async () => {
      await getDb().delete()
      __resetDbForTesting()
      getDb()
      await whenSeeded()
    })
  `)

  assert.equal(result.hasLegacyReset, true)
  assert.equal(result.usesFastFixture, false)
  assert.deepEqual(result.forbiddenReasons, [])
})

test("rejects lifecycle-sensitive operations in a fast-fixture suite", () => {
  const result = analyzeDbTestSource(`
    import { createDbTestFixture } from "@/lib/db/test-fixture"
    const fixture = createDbTestFixture()
    const db = new CogniaDB("migration-test")
    jest.resetModules()
  `)

  assert.equal(result.usesFastFixture, true)
  assert.deepEqual(
    result.forbiddenReasons.map((entry) => entry.code),
    ["constructs-database", "resets-modules"]
  )
})

test("does not confuse a blocked domain status with an IndexedDB lifecycle assertion", () => {
  const result = analyzeDbTestSource(`
    import { createDbTestFixture } from "./test-fixture"
    const fixture = createDbTestFixture()
    expect((await getAgentTask("task"))?.status).toBe("blocked")
  `)

  assert.equal(result.usesFastFixture, true)
  assert.deepEqual(result.forbiddenReasons, [])
})

test("recognizes concrete IndexedDB lifecycle APIs", () => {
  const result = analyzeDbTestSource(`
    import { createDbTestFixture } from "./test-fixture"
    const fixture = createDbTestFixture()
    db.on("blocked").fire({ oldVersion: 1, newVersion: 2 })
    indexedDB.deleteDatabase("cognia-claude")
  `)

  assert.deepEqual(
    result.forbiddenReasons.map((entry) => entry.code),
    ["connection-lifecycle"]
  )
})

test("rejects fake timers in a fast-fixture suite", () => {
  const result = analyzeDbTestSource(`
    import { createDbTestFixture } from "./test-fixture"
    const fixture = createDbTestFixture()
    jest.useFakeTimers()
  `)

  assert.deepEqual(
    result.forbiddenReasons.map((entry) => entry.code),
    ["fake-timers"]
  )
})

test("accepts an ordinary CRUD suite using the full-database fixture", () => {
  const result = analyzeDbTestSource(`
    import { createDbTestFixture } from "./test-fixture"
    const fixture = createDbTestFixture({ emptyTables: ["settings"] })
    beforeAll(fixture.initialize)
    beforeEach(fixture.restore)
    afterAll(fixture.dispose)
    it("writes settings", async () => getDb().settings.put(row))
  `)

  assert.equal(result.usesFastFixture, true)
  assert.deepEqual(result.forbiddenReasons, [])
})

test("flags auto-increment identity tables for individual review", () => {
  const result = analyzeDbTestSource(`
    import { createDbTestFixture } from "./test-fixture"
    await getDb().chatInputHistory.add(row)
  `)

  assert.deepEqual(
    result.forbiddenReasons.map((entry) => entry.code),
    ["auto-increment-table"]
  )
})

test("fails non-strict audits only when the migration baseline regresses", () => {
  assert.equal(
    auditResultPasses({
      unsafeCount: 0,
      remainingCount: 259,
      strict: false,
      maxLegacyResets: 259,
    }),
    true
  )
  assert.equal(
    auditResultPasses({
      unsafeCount: 0,
      remainingCount: 260,
      strict: false,
      maxLegacyResets: 259,
    }),
    false
  )
})

test("requires zero remaining migrations in strict mode", () => {
  assert.equal(
    auditResultPasses({
      unsafeCount: 0,
      remainingCount: 1,
      strict: true,
      maxLegacyResets: 259,
    }),
    false
  )
  assert.equal(
    auditResultPasses({
      unsafeCount: 0,
      remainingCount: 0,
      strict: true,
      maxLegacyResets: 259,
    }),
    true
  )
})
