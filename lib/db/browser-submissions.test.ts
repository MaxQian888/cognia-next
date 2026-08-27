/** @jest-environment jsdom */
import type { BrowserSubmissionRow } from "./browser-submissions-types"
import {
  MAX_BROWSER_SUBMISSIONS_PER_DEVICE,
  clearBrowserSubmissions,
  getBrowserSubmission,
  listBrowserSubmissions,
  putBrowserSubmission,
  updateBrowserSubmissionStatus,
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
    submittedAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

describe("browserSubmissions", () => {
  it("stores and reads back a submission", async () => {
    await putBrowserSubmission(row())
    expect(await getBrowserSubmission("sub-1")).toMatchObject({
      sessionId: "session-1",
      sourceHost: "example.com",
    })
  })

  it("never returns another device's submissions", async () => {
    // `browser.read-own` is not "read submissions" — it is "read the ones this
    // device made". A second paired browser must not be able to enumerate the
    // first one's history.
    await putBrowserSubmission(row({ submissionId: "mine", deviceId: "browser-a" }))
    await putBrowserSubmission(row({ submissionId: "theirs", deviceId: "browser-b" }))
    const mine = await listBrowserSubmissions("browser-a")
    expect(mine.map((entry) => entry.submissionId)).toEqual(["mine"])
  })

  it("lists newest first and honours the limit", async () => {
    for (const index of [1, 2, 3]) {
      await putBrowserSubmission(row({ submissionId: `sub-${index}`, submittedAt: index * 1_000 }))
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
    await putBrowserSubmission(row())
    await expect(putBrowserSubmission(row({ title: "Renamed" }))).resolves.toBeUndefined()
    expect(await getBrowserSubmission("sub-1")).toMatchObject({ title: "Renamed" })
  })

  it("trims a device's history to the cap, oldest first", async () => {
    for (let index = 0; index < MAX_BROWSER_SUBMISSIONS_PER_DEVICE + 5; index += 1) {
      await putBrowserSubmission(row({ submissionId: `sub-${index}`, submittedAt: index }))
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
    await putBrowserSubmission(
      row({ submissionId: "other", deviceId: "browser-b", submittedAt: 1 })
    )
    for (let index = 0; index < MAX_BROWSER_SUBMISSIONS_PER_DEVICE + 2; index += 1) {
      await putBrowserSubmission(row({ submissionId: `sub-${index}`, submittedAt: index + 10 }))
    }
    expect(await getBrowserSubmission("other")).toBeDefined()
  })

  it("advances a status and records an error code only when there is one", async () => {
    await putBrowserSubmission(row())
    await updateBrowserSubmissionStatus("sub-1", "running", 2_000)
    expect(await getBrowserSubmission("sub-1")).toMatchObject({
      status: "running",
      updatedAt: 2_000,
    })
    expect(await getBrowserSubmission("sub-1")).not.toHaveProperty("errorCode")
    await updateBrowserSubmissionStatus("sub-1", "failed", 3_000, "runtime_unavailable")
    expect(await getBrowserSubmission("sub-1")).toMatchObject({
      status: "failed",
      errorCode: "runtime_unavailable",
    })
  })

  it("does not resurrect a trimmed-away submission as a partial row", async () => {
    await expect(updateBrowserSubmissionStatus("gone", "completed", 9_000)).resolves.toBeUndefined()
    expect(await getBrowserSubmission("gone")).toBeUndefined()
  })

  it("clears one device's history and leaves the others", async () => {
    await putBrowserSubmission(row({ submissionId: "mine" }))
    await putBrowserSubmission(row({ submissionId: "theirs", deviceId: "browser-b" }))
    expect(await clearBrowserSubmissions("browser-a")).toBe(1)
    expect(await getBrowserSubmission("theirs")).toBeDefined()
  })
})
