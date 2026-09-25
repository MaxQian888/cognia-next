/** @jest-environment jsdom */
import type { BrowserSubmissionRow } from "./browser-submissions-types"
import {
  BROWSER_SUBMISSION_MAX_AGE_MS,
  MAX_BROWSER_SUBMISSIONS_PER_DEVICE,
  MAX_BROWSER_SUBMISSIONS_TOTAL,
  clearBrowserSubmissions,
  getBrowserSubmission,
  listBrowserSubmissions,
  pruneBrowserSubmissions,
  putBrowserSubmission,
  summarizeBrowserSubmissions,
} from "./browser-submissions"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().browserSubmissions.clear()
})
afterAll(dbFixture.dispose)

/**
 * A fixed "now" for every write, with timestamps offset from it.
 *
 * Retention is measured against the clock, so rows stamped at epoch 1000 — as
 * these fixtures once were — would be ninety days stale on arrival and pruned
 * by their neighbours' writes.
 */
const NOW = 1_800_000_000_000
const at = (offset: number) => NOW - 1_000_000 + offset
const put = (entry: BrowserSubmissionRow) => putBrowserSubmission(entry, NOW)

function row(overrides: Partial<BrowserSubmissionRow> = {}): BrowserSubmissionRow {
  return {
    submissionId: "sub-1",
    deviceId: "browser-a",
    sessionId: "session-1",
    title: "A guide",
    sourceHost: "example.com",
    captureMode: "selection",
    contentBytes: 120,
    truncated: false,
    status: "queued",
    submittedAt: at(1_000),
    updatedAt: at(1_000),
    ...overrides,
  }
}

describe("browserSubmissions", () => {
  it("stores and reads back a submission", async () => {
    await put(row())
    expect(await getBrowserSubmission("sub-1")).toMatchObject({
      sessionId: "session-1",
      sourceHost: "example.com",
    })
  })

  it("never returns another device's submissions", async () => {
    // `browser.read-own` is not "read submissions" — it is "read the ones this
    // device made". A second paired browser must not be able to enumerate the
    // first one's history.
    await put(row({ submissionId: "mine", deviceId: "browser-a" }))
    await put(row({ submissionId: "theirs", deviceId: "browser-b" }))
    const mine = await listBrowserSubmissions("browser-a")
    expect(mine.map((entry) => entry.submissionId)).toEqual(["mine"])
  })

  it("lists newest first and honours the limit", async () => {
    for (const index of [1, 2, 3]) {
      await put(row({ submissionId: `sub-${index}`, submittedAt: at(index * 1_000) }))
    }
    expect((await listBrowserSubmissions("browser-a")).map((r) => r.submissionId)).toEqual([
      "sub-3",
      "sub-2",
      "sub-1",
    ])
    expect((await listBrowserSubmissions("browser-a", 2)).map((r) => r.submissionId)).toEqual([
      "sub-3",
      "sub-2",
    ])
  })

  it("overwrites rather than throwing when a submission is replayed", async () => {
    // The RPC layer replays the original receipt for a repeated idempotency
    // key; a constraint error here would turn a correct replay into a failure.
    await put(row())
    await expect(put(row({ title: "Renamed" }))).resolves.toBeUndefined()
    expect(await getBrowserSubmission("sub-1")).toMatchObject({ title: "Renamed" })
  })

  it("trims a device's history to the cap, oldest first", async () => {
    for (let index = 0; index < MAX_BROWSER_SUBMISSIONS_PER_DEVICE + 5; index += 1) {
      await put(row({ submissionId: `sub-${index}`, submittedAt: at(index) }))
    }
    const remaining = await getDb()
      .browserSubmissions.where("deviceId")
      .equals("browser-a")
      .toArray()
    expect(remaining).toHaveLength(MAX_BROWSER_SUBMISSIONS_PER_DEVICE)
    expect(remaining.some((entry) => entry.submissionId === "sub-0")).toBe(false)
    expect(remaining.some((entry) => entry.submissionId === "sub-104")).toBe(true)
  })

  it("does not trim another device's rows", async () => {
    await put(row({ submissionId: "other", deviceId: "browser-b", submittedAt: at(1) }))
    for (let index = 0; index < MAX_BROWSER_SUBMISSIONS_PER_DEVICE + 2; index += 1) {
      await put(row({ submissionId: `sub-${index}`, submittedAt: at(index + 10) }))
    }
    expect(await getBrowserSubmission("other")).toBeDefined()
  })

  it("summarizes every device that has history, for the Host-side control", async () => {
    await put(row({ submissionId: "a" }))
    await put(row({ submissionId: "b" }))
    await put(row({ submissionId: "c", deviceId: "browser-b" }))
    const summary = await summarizeBrowserSubmissions()
    expect(summary.total).toBe(3)
    expect([...summary.deviceIds].sort()).toEqual(["browser-a", "browser-b"])
  })

  it("clears one device's history and leaves the others", async () => {
    await put(row({ submissionId: "mine" }))
    await put(row({ submissionId: "theirs", deviceId: "browser-b" }))
    expect(await clearBrowserSubmissions("browser-a")).toBe(1)
    expect(await getBrowserSubmission("theirs")).toBeDefined()
  })

  it("drops rows past the age ceiling when anything is written", async () => {
    const old = NOW - BROWSER_SUBMISSION_MAX_AGE_MS - 1
    await getDb().browserSubmissions.bulkPut([
      row({ submissionId: "ancient", submittedAt: old, updatedAt: old }),
      row({ submissionId: "ancient-b", deviceId: "browser-b", submittedAt: old, updatedAt: old }),
      row({ submissionId: "recent", submittedAt: at(5) }),
    ])
    await put(row({ submissionId: "new", submittedAt: at(10) }))

    expect(await getBrowserSubmission("ancient")).toBeUndefined()
    // Every device's, not only the writer's: an abandoned identity never
    // writes again, which is exactly the row this exists to reach.
    expect(await getBrowserSubmission("ancient-b")).toBeUndefined()
    expect(await getBrowserSubmission("recent")).toBeDefined()
    expect(await getBrowserSubmission("new")).toBeDefined()
  })

  it("keeps an old row that was redriven recently", async () => {
    const old = NOW - BROWSER_SUBMISSION_MAX_AGE_MS - 1
    await getDb().browserSubmissions.put(
      row({ submissionId: "redriven", submittedAt: old, updatedAt: at(1) })
    )
    await put(row({ submissionId: "new" }))
    expect(await getBrowserSubmission("redriven")).toBeDefined()
  })

  it("never prunes the row it is writing, however old", async () => {
    // A redrive rewrites the row with its original `submittedAt`. Deleting it
    // on the way in would lose the record the retry exists to finish.
    const old = NOW - BROWSER_SUBMISSION_MAX_AGE_MS * 2
    await put(row({ submissionId: "redrive", submittedAt: old, updatedAt: old }))
    expect(await getBrowserSubmission("redrive")).toBeDefined()
  })

  it("caps the whole table across devices, oldest first", async () => {
    // One device's cap does not bound the table: every re-pairing is a new
    // device id, each allowed its own hundred rows forever.
    const perDevice = MAX_BROWSER_SUBMISSIONS_PER_DEVICE
    const devices = Math.ceil(MAX_BROWSER_SUBMISSIONS_TOTAL / perDevice) + 1
    const rows: BrowserSubmissionRow[] = []
    for (let device = 0; device < devices; device += 1) {
      for (let index = 0; index < perDevice; index += 1) {
        rows.push(
          row({
            submissionId: `d${device}-${index}`,
            deviceId: `browser-${device}`,
            submittedAt: at(device * perDevice + index),
          })
        )
      }
    }
    await getDb().browserSubmissions.bulkPut(rows)
    await put(row({ submissionId: "newest", deviceId: "browser-new", submittedAt: at(1_000_000) }))

    expect(await getDb().browserSubmissions.count()).toBe(MAX_BROWSER_SUBMISSIONS_TOTAL)
    expect(await getBrowserSubmission("d0-0")).toBeUndefined()
    expect(await getBrowserSubmission("newest")).toBeDefined()
    expect(await getBrowserSubmission(`d${devices - 1}-${perDevice - 1}`)).toBeDefined()
  })

  it("prunes on demand for a Host that has stopped receiving submissions", async () => {
    const old = NOW - BROWSER_SUBMISSION_MAX_AGE_MS - 1
    await getDb().browserSubmissions.bulkPut([
      row({ submissionId: "stale", submittedAt: old, updatedAt: old }),
      row({ submissionId: "fresh", submittedAt: at(1) }),
    ])
    expect(await pruneBrowserSubmissions(NOW)).toBe(1)
    expect(await getBrowserSubmission("stale")).toBeUndefined()
    expect(await getBrowserSubmission("fresh")).toBeDefined()
    expect(await pruneBrowserSubmissions(NOW)).toBe(0)
  })
})
