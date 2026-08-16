/**
 * @jest-environment jsdom
 */

import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import {
  allocateIssueNumber,
  deleteIssueCounter,
  ensureIssueNumberAbove,
  peekIssueNumber,
} from "./issue-counters"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

describe("allocateIssueNumber", () => {
  it("starts at 1 and increments", async () => {
    expect(await allocateIssueNumber("p1")).toBe(1)
    expect(await allocateIssueNumber("p1")).toBe(2)
    expect(await allocateIssueNumber("p1")).toBe(3)
  })

  it("numbers each project independently", async () => {
    expect(await allocateIssueNumber("p1")).toBe(1)
    expect(await allocateIssueNumber("p2")).toBe(1)
    expect(await allocateIssueNumber("p1")).toBe(2)
  })

  it("never hands out the same number twice under concurrent allocation", async () => {
    // The whole reason the allocator lives in a Dexie `rw` transaction: two
    // windows (or a window plus the pet popup) allocating at once must not
    // both get MERC-4. A read-modify-write outside a transaction fails here.
    const numbers = await Promise.all(Array.from({ length: 25 }, () => allocateIssueNumber("race")))
    expect(new Set(numbers).size).toBe(25)
    expect([...numbers].sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1))
  })

  it("keeps counting up after the issue holding a number is deleted", async () => {
    await allocateIssueNumber("p1")
    await allocateIssueNumber("p1")
    // Nothing releases 1 or 2 back — identifiers are stable references.
    expect(await allocateIssueNumber("p1")).toBe(3)
  })

  it("persists the watermark", async () => {
    await allocateIssueNumber("p1")
    expect(await getDb().issueCounters.get("p1")).toEqual({ scopeId: "p1", next: 2 })
  })
})

describe("peekIssueNumber", () => {
  it("reports 1 for an untouched project without consuming it", async () => {
    expect(await peekIssueNumber("fresh")).toBe(1)
    expect(await peekIssueNumber("fresh")).toBe(1)
    expect(await allocateIssueNumber("fresh")).toBe(1)
  })

  it("reports the next number after allocations", async () => {
    await allocateIssueNumber("p1")
    expect(await peekIssueNumber("p1")).toBe(2)
  })
})

describe("ensureIssueNumberAbove", () => {
  it("raises the watermark past an imported number", async () => {
    await ensureIssueNumberAbove("p1", 42)
    expect(await allocateIssueNumber("p1")).toBe(43)
  })

  it("never lowers an existing watermark", async () => {
    await allocateIssueNumber("p1")
    await allocateIssueNumber("p1")
    await ensureIssueNumberAbove("p1", 1)
    expect(await allocateIssueNumber("p1")).toBe(3)
  })

  it("raises when the observed number equals the current watermark", async () => {
    await allocateIssueNumber("p1") // next is now 2
    await ensureIssueNumberAbove("p1", 2)
    expect(await allocateIssueNumber("p1")).toBe(3)
  })
})

describe("deleteIssueCounter", () => {
  it("drops the counter so a reused key starts over", async () => {
    await allocateIssueNumber("p1")
    await deleteIssueCounter("p1")
    expect(await getDb().issueCounters.get("p1")).toBeUndefined()
    expect(await allocateIssueNumber("p1")).toBe(1)
  })

  it("is a no-op for an unknown project", async () => {
    await expect(deleteIssueCounter("nope")).resolves.toBeUndefined()
  })
})
