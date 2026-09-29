import {
  MAX_BROWSER_DOWNLOAD_ROWS,
  browserDownloadKey,
  clearBrowserDownloads,
  listBrowserDownloads,
  removeBrowserDownload,
  summaryToDownloadUpdate,
  upsertBrowserDownload,
  type BrowserDownloadRow,
} from "./browser-downloads"
import { policyForTable } from "@/lib/data-governance/table-catalog"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})
afterAll(dbFixture.dispose)

describe("browserDownloadKey", () => {
  it("namespaces the backend id so two backends cannot collide", () => {
    expect(browserDownloadKey("embedded", "1")).toBe("embedded:1")
    expect(browserDownloadKey("local-chromium", "1")).toBe("local-chromium:1")
  })
})

describe("summaryToDownloadUpdate", () => {
  it("maps a runtime summary and defaults the backend to the cloud runtime", () => {
    expect(
      summaryToDownloadUpdate({
        id: "r1",
        sessionId: "s",
        filename: "x.csv",
        size: 3,
        state: "quarantined",
      })
    ).toMatchObject({ downloadId: "r1", backend: "remote", state: "quarantined", size: 3 })
    expect(
      summaryToDownloadUpdate({
        id: "l1",
        sessionId: "s",
        filename: "y",
        size: 0,
        state: "in_progress",
        backend: "user-chrome",
        receivedBytes: 4,
      })
    ).toMatchObject({ backend: "user-chrome", receivedBytes: 4 })
  })
})

describe("upsertBrowserDownload", () => {
  it("creates a row on first sight with defaults", async () => {
    const row = await upsertBrowserDownload(
      {
        backend: "embedded",
        downloadId: "d1",
        filename: "a.zip",
        url: "https://example.com/a.zip",
      },
      1_000
    )
    expect(row).toEqual({
      id: "embedded:d1",
      downloadId: "d1",
      backend: "embedded",
      sessionId: "embedded",
      state: "in_progress",
      filename: "a.zip",
      url: "https://example.com/a.zip",
      size: 0,
      startedAt: 1_000,
      updatedAt: 1_000,
    })
  })

  it("merges progress and stamps finishedAt on the terminal event", async () => {
    await upsertBrowserDownload(
      { backend: "local-chromium", downloadId: "d2", sessionId: "s1", filename: "b.pdf" },
      1_000
    )
    await upsertBrowserDownload(
      { backend: "local-chromium", downloadId: "d2", receivedBytes: 10, totalBytes: 20 },
      1_500
    )
    const done = await upsertBrowserDownload(
      {
        backend: "local-chromium",
        downloadId: "d2",
        state: "completed",
        receivedBytes: 20,
        savedPath: "/Users/me/Downloads/b.pdf",
      },
      2_000
    )
    expect(done).toMatchObject({
      sessionId: "s1",
      filename: "b.pdf",
      state: "completed",
      startedAt: 1_000,
      finishedAt: 2_000,
      size: 20,
      totalBytes: 20,
      savedPath: "/Users/me/Downloads/b.pdf",
    })
  })

  it("keeps the first startedAt and ignores undefined fields", async () => {
    await upsertBrowserDownload(
      { backend: "embedded", downloadId: "d3", filename: "c", startedAt: 500 },
      1_000
    )
    const row = await upsertBrowserDownload(
      { backend: "embedded", downloadId: "d3", filename: undefined, startedAt: 9_000 },
      2_000
    )
    expect(row.startedAt).toBe(500)
    expect(row.filename).toBe("c")
  })

  it("does not let a late progress tick resurrect a finished download", async () => {
    await upsertBrowserDownload(
      { backend: "embedded", downloadId: "d4", state: "cancelled" },
      1_000
    )
    const row = await upsertBrowserDownload(
      { backend: "embedded", downloadId: "d4", state: "in_progress", receivedBytes: 5 },
      2_000
    )
    expect(row.state).toBe("cancelled")
    expect(row.finishedAt).toBe(1_000)
  })

  it("trims the oldest finished rows past the cap but never a running one", async () => {
    const db = getDb()
    const rows: BrowserDownloadRow[] = []
    for (let i = 0; i < MAX_BROWSER_DOWNLOAD_ROWS; i += 1) {
      rows.push({
        id: `embedded:old-${i}`,
        downloadId: `old-${i}`,
        sessionId: "embedded",
        backend: "embedded",
        state: i === 0 ? "in_progress" : "completed",
        filename: `f${i}`,
        size: 1,
        startedAt: i,
        updatedAt: i,
      })
    }
    await db.browserDownloads.bulkPut(rows)
    await upsertBrowserDownload({ backend: "embedded", downloadId: "new" }, 5_000_000)
    expect(await db.browserDownloads.count()).toBe(MAX_BROWSER_DOWNLOAD_ROWS)
    expect(await getDb().browserDownloads.get("embedded:old-0")).toBeDefined()
    expect(await getDb().browserDownloads.get("embedded:old-1")).toBeUndefined()
    expect(await getDb().browserDownloads.get("embedded:new")).toBeDefined()
  })
})

describe("listing and clearing", () => {
  beforeEach(async () => {
    await upsertBrowserDownload({ backend: "embedded", downloadId: "a", sessionId: "x" }, 1)
    await upsertBrowserDownload(
      { backend: "local-chromium", downloadId: "b", sessionId: "y", state: "completed" },
      2
    )
    await upsertBrowserDownload(
      { backend: "local-chromium", downloadId: "c", sessionId: "y", state: "failed" },
      3
    )
  })

  it("lists newest first, optionally per session and limited", async () => {
    expect((await listBrowserDownloads()).map((row) => row.downloadId)).toEqual(["c", "b", "a"])
    expect((await listBrowserDownloads({ sessionId: "y" })).map((row) => row.downloadId)).toEqual([
      "c",
      "b",
    ])
    expect((await listBrowserDownloads({ limit: 1 })).map((row) => row.downloadId)).toEqual(["c"])
  })

  it("removes one entry", async () => {
    await removeBrowserDownload("local-chromium:b")
    expect(await getDb().browserDownloads.get("local-chromium:b")).toBeUndefined()
  })

  it("clears only finished entries", async () => {
    expect(await clearBrowserDownloads()).toBe(2)
    expect((await listBrowserDownloads()).map((row) => row.downloadId)).toEqual(["a"])
  })
})

describe("governance", () => {
  it("declares the table capped and domain-trimmed", () => {
    expect(policyForTable("browserDownloads")?.retentionPolicy).toMatchObject({
      mode: "cap",
      maxRows: MAX_BROWSER_DOWNLOAD_ROWS,
      enforcement: "domain",
    })
  })
})
