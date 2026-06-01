/**
 * Branch coverage for the eval Dexie CRUD guards + optional-field paths that
 * the happy-path suites don't exercise (empty-id early returns, missing-row
 * updates, optional case fields, list limits).
 */
import "fake-indexeddb/auto"
import {
  createDataset,
  getDataset,
  listCases,
  getCase,
  updateDataset,
  updateCase,
  deleteCase,
  deleteDataset,
  addCase,
} from "./eval-datasets"
import {
  saveRun,
  getRun,
  listRunsByDataset,
  listRecentRuns,
  deleteRun,
  deleteRunsForDataset,
} from "./eval-runs"
import {
  getAnnotationByTrace,
  markSavedAsCase,
  deleteAnnotation,
  upsertAnnotation,
} from "./trace-annotations"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("eval-datasets guards + optional fields", () => {
  it("returns falsy for empty ids and missing rows", async () => {
    expect(await getDataset("")).toBeUndefined()
    expect(await getCase("")).toBeUndefined()
    expect(await listCases("")).toEqual([])
    expect(await updateDataset("nope", { name: "x" })).toBeUndefined()
    expect(await updateCase("nope", { input: "x" })).toBeUndefined()
    await expect(deleteCase("nope")).resolves.toBeUndefined()
    await expect(deleteDataset("")).resolves.toBeUndefined()
  })

  it("throws when adding a case to a missing dataset", async () => {
    await expect(addCase("ghost", { input: "x", source: "handwritten" })).rejects.toThrow(
      /not found/
    )
  })

  it("persists every optional case field", async () => {
    const ds = await createDataset({ name: "A", capability: "chat.tool-use" })
    const c = await addCase(ds.id, {
      input: "x",
      source: "real-trace",
      history: [{ role: "user", content: "hi" }],
      reference: { expectedTools: ["Read"] },
      failureMode: "wrong-tool",
      sourceTraceId: "tr1",
      notes: "n",
    })
    const stored = await getCase(c.id)
    expect(stored).toMatchObject({
      history: [{ role: "user", content: "hi" }],
      failureMode: "wrong-tool",
      sourceTraceId: "tr1",
      notes: "n",
    })
  })

  it("creates a dataset with an explicit description + id", async () => {
    const ds = await createDataset({
      id: "fixed",
      name: "A",
      description: "desc",
      capability: "c",
    })
    expect(ds.id).toBe("fixed")
    expect(ds.description).toBe("desc")
  })
})

describe("eval-runs guards", () => {
  it("no-ops on empty ids and honors a zero limit", async () => {
    await saveRun({ runId: "" } as never)
    expect(await getRun("")).toBeUndefined()
    expect(await listRunsByDataset("")).toEqual([])
    expect(await listRecentRuns(0)).toEqual([])
    await expect(deleteRun("")).resolves.toBeUndefined()
    await expect(deleteRunsForDataset("")).resolves.toBeUndefined()
  })
})

describe("trace-annotations guards", () => {
  it("returns falsy for empty trace ids and no-ops on missing rows", async () => {
    expect(await getAnnotationByTrace("")).toBeUndefined()
    await expect(markSavedAsCase("missing", "c1")).resolves.toBeUndefined()
    await expect(deleteAnnotation("")).resolves.toBeUndefined()
  })

  it("clears a failure mode back to undefined on re-upsert", async () => {
    await upsertAnnotation({
      traceId: "t1",
      sessionId: "s",
      firstFailureNote: "a",
      failureMode: "x",
    })
    const cleared = await upsertAnnotation({
      traceId: "t1",
      sessionId: "s",
      firstFailureNote: "a",
      failureMode: undefined,
    })
    expect(cleared.failureMode).toBeUndefined()
  })
})
