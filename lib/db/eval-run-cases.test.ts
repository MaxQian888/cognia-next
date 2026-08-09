import { saveCaseResult, listCaseResults, deleteCaseResultsForRun } from "./eval-run-cases"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().evalRunCaseResults.clear()
})
afterAll(dbFixture.dispose)

describe("eval-run-cases", () => {
  it("persists and reads back compact per-case verdicts", async () => {
    await saveCaseResult({
      runId: "r1",
      caseId: "c1",
      scores: { "tool-selection": { value: 1, passed: true } },
      passAt1: true,
    })
    const rows = await listCaseResults("r1")
    expect(rows).toHaveLength(1)
    expect(rows[0].caseId).toBe("c1")
    expect(rows[0].id).toBe("r1::c1")
    expect(rows[0].passAt1).toBe(true)
    expect(rows[0].scores["tool-selection"].value).toBe(1)
  })

  it("upserts on the same (run, case)", async () => {
    await saveCaseResult({ runId: "r1", caseId: "c1", scores: {}, passAt1: false })
    await saveCaseResult({ runId: "r1", caseId: "c1", scores: {}, passAt1: true })
    const rows = await listCaseResults("r1")
    expect(rows).toHaveLength(1)
    expect(rows[0].passAt1).toBe(true)
  })

  it("ignores rows without runId or caseId", async () => {
    await saveCaseResult({ runId: "", caseId: "c1", scores: {}, passAt1: false })
    await saveCaseResult({ runId: "r1", caseId: "", scores: {}, passAt1: false })
    expect(await listCaseResults("r1")).toHaveLength(0)
  })

  it("returns [] for a missing runId", async () => {
    expect(await listCaseResults("")).toEqual([])
    expect(await listCaseResults("nope")).toEqual([])
  })

  it("deletes all rows for a run", async () => {
    await saveCaseResult({ runId: "r2", caseId: "c1", scores: {}, passAt1: false })
    await saveCaseResult({ runId: "r2", caseId: "c2", scores: {}, passAt1: true })
    await saveCaseResult({ runId: "r3", caseId: "c1", scores: {}, passAt1: true })
    await deleteCaseResultsForRun("r2")
    expect(await listCaseResults("r2")).toHaveLength(0)
    expect(await listCaseResults("r3")).toHaveLength(1)
    // no-op on empty id
    await deleteCaseResultsForRun("")
    expect(await listCaseResults("r3")).toHaveLength(1)
  })
})
