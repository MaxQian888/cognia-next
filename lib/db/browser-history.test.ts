import {
  MAX_BROWSER_HISTORY_ROWS,
  browserHistoryKey,
  clearBrowserHistory,
  listRecentBrowserVisits,
  recordBrowserVisit,
} from "./browser-history"
import { policyForTable } from "@/lib/data-governance/table-catalog"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})
afterAll(dbFixture.dispose)

describe("browserHistoryKey", () => {
  it("canonicalizes an http(s) address", () => {
    expect(browserHistoryKey("https://example.com")).toBe("https://example.com/")
    expect(browserHistoryKey("http://localhost:3000/a?b=1#c")).toBe("http://localhost:3000/a?b=1#c")
  })

  it("declines anything that is not a place to return to", () => {
    expect(browserHistoryKey("about:blank")).toBeNull()
    expect(browserHistoryKey("file:///tmp/x.html")).toBeNull()
    expect(browserHistoryKey("not a url")).toBeNull()
  })
})

describe("recordBrowserVisit", () => {
  it("adds one row per address", async () => {
    await recordBrowserVisit("https://example.com", 1_000)
    const rows = await getDb().browserHistory.toArray()
    expect(rows).toEqual([
      { id: "https://example.com/", url: "https://example.com/", visitedAt: 1_000, visits: 1 },
    ])
  })

  it("moves a revisit to the top rather than duplicating it", async () => {
    await recordBrowserVisit("https://a.example/", 1_000)
    await recordBrowserVisit("https://b.example/", 2_000)
    await recordBrowserVisit("https://a.example/", 3_000)

    const recent = await listRecentBrowserVisits(10)
    expect(recent.map((row) => row.url)).toEqual(["https://a.example/", "https://b.example/"])
    expect(recent[0]).toMatchObject({ visitedAt: 3_000, visits: 2 })
  })

  it("ignores addresses that are not http(s)", async () => {
    await recordBrowserVisit("about:blank", 1_000)
    expect(await getDb().browserHistory.count()).toBe(0)
  })

  it("trims the oldest rows past the cap", async () => {
    const db = getDb()
    await db.browserHistory.bulkPut(
      Array.from({ length: MAX_BROWSER_HISTORY_ROWS }, (_, index) => ({
        id: `https://site.example/${index}`,
        url: `https://site.example/${index}`,
        visitedAt: index,
        visits: 1,
      }))
    )

    await recordBrowserVisit("https://new.example/", 10_000)

    expect(await db.browserHistory.count()).toBe(MAX_BROWSER_HISTORY_ROWS)
    expect(await db.browserHistory.get("https://site.example/0")).toBeUndefined()
    expect(await db.browserHistory.get("https://site.example/1")).toBeDefined()
    expect(await db.browserHistory.get("https://new.example/")).toBeDefined()
  })
})

describe("listRecentBrowserVisits", () => {
  it("returns the newest visits first, up to the limit", async () => {
    for (const [index, url] of [
      "https://a.example/",
      "https://b.example/",
      "https://c.example/",
    ].entries()) {
      await recordBrowserVisit(url, index)
    }
    const recent = await listRecentBrowserVisits(2)
    expect(recent.map((row) => row.url)).toEqual(["https://c.example/", "https://b.example/"])
  })
})

describe("clearBrowserHistory", () => {
  it("forgets every visited page", async () => {
    await recordBrowserVisit("https://a.example/", 1)
    await recordBrowserVisit("https://b.example/", 2)
    await clearBrowserHistory()
    expect(await listRecentBrowserVisits(10)).toEqual([])
  })
})

// The governance catalog states the cap in its own words; the two must agree or
// retention reporting describes a table that behaves differently.
describe("governance", () => {
  it("declares the same cap the writer enforces, and keeps the table off-device", () => {
    const entry = policyForTable("browserHistory")
    expect(entry?.retentionPolicy).toMatchObject({
      mode: "cap",
      maxRows: MAX_BROWSER_HISTORY_ROWS,
      enforcement: "domain",
    })
    expect(entry?.backupPolicy.mode).not.toBe("portable")
  })
})
