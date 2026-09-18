/**
 * Tests for lib/db/run-result-summaries.ts — the immutable, content-addressed
 * result revision log. Covers monotonic revision allocation, latest/specific
 * reads, and the oldest-first history.
 */

import { createDbTestFixture } from "./test-fixture"
import {
  appendRunResultSummary,
  getLatestRunResultSummary,
  getRunResultSummary,
  listRunResultSummaries,
} from "./run-result-summaries"
import type { RunResultSummary } from "@/types/notifications/result"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

function content(
  runId: string,
  materialHash: string
): Omit<RunResultSummary, "id" | "revision" | "createdAt"> {
  return {
    runId,
    scopeKey: "scope-A",
    scope: { namespaceId: "n", accountId: "a", authorityHostId: "h" },
    terminalStatus: "completed",
    derivedFromSeq: 5,
    headline: "T",
    facts: [],
    digest: "B",
    maxClassification: "internal",
    materialHash,
    conclusive: true,
    schemaVersion: 1,
  }
}

describe("appendRunResultSummary", () => {
  it("allocates revision 1 for a run's first summary", async () => {
    const row = await appendRunResultSummary(content("r1", "h1"))
    expect(row.revision).toBe(1)
    expect(row.runId).toBe("r1")
    expect(row.materialHash).toBe("h1")
  })

  it("allocates monotonically increasing revisions per run", async () => {
    const a = await appendRunResultSummary(content("r1", "h1"))
    const b = await appendRunResultSummary(content("r1", "h2"))
    const other = await appendRunResultSummary(content("r2", "hx"))
    expect([a.revision, b.revision]).toEqual([1, 2])
    expect(other.revision).toBe(1) // independent sequence per run
  })
})

describe("getLatestRunResultSummary", () => {
  it("returns the highest revision", async () => {
    await appendRunResultSummary(content("r1", "h1"))
    await appendRunResultSummary(content("r1", "h2"))
    const latest = await getLatestRunResultSummary("r1")
    expect(latest?.revision).toBe(2)
    expect(latest?.materialHash).toBe("h2")
  })

  it("returns undefined for a run with no summaries", async () => {
    expect(await getLatestRunResultSummary("none")).toBeUndefined()
  })
})

describe("getRunResultSummary", () => {
  it("reads a specific revision", async () => {
    await appendRunResultSummary(content("r1", "h1"))
    await appendRunResultSummary(content("r1", "h2"))
    const v1 = await getRunResultSummary("r1", 1)
    expect(v1?.materialHash).toBe("h1")
    expect(await getRunResultSummary("r1", 99)).toBeUndefined()
  })
})

describe("listRunResultSummaries", () => {
  it("returns the immutable history oldest-first", async () => {
    await appendRunResultSummary(content("r1", "h1"))
    await appendRunResultSummary(content("r1", "h2"))
    await appendRunResultSummary(content("r1", "h3"))
    const rows = await listRunResultSummaries("r1")
    expect(rows.map((r) => r.revision)).toEqual([1, 2, 3])
  })
})
