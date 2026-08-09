import {
  upsertAnnotation,
  getAnnotationByTrace,
  listAnnotations,
  failureModeCounts,
  markSavedAsCase,
  deleteAnnotation,
} from "./trace-annotations"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().traceAnnotations.clear()
})
afterAll(dbFixture.dispose)

describe("trace annotations (error analysis)", () => {
  it("creates an annotation keyed by traceId", async () => {
    const a = await upsertAnnotation({
      traceId: "t1",
      sessionId: "s1",
      firstFailureNote: "called wrong tool",
    })
    expect(a.id).toMatch(/^evan_/)
    expect(await getAnnotationByTrace("t1")).toMatchObject({
      firstFailureNote: "called wrong tool",
    })
  })

  it("upserts in place for the same trace (one annotation per trace)", async () => {
    await upsertAnnotation({ traceId: "t1", sessionId: "s1", firstFailureNote: "first" })
    const updated = await upsertAnnotation({
      traceId: "t1",
      sessionId: "s1",
      firstFailureNote: "revised",
      failureMode: "wrong-tool",
    })
    expect(updated.firstFailureNote).toBe("revised")
    expect(updated.failureMode).toBe("wrong-tool")
    expect(await listAnnotations()).toHaveLength(1)
  })

  it("lists annotations newest-first", async () => {
    await upsertAnnotation({ traceId: "t1", sessionId: "s1", firstFailureNote: "a", createdAt: 1 })
    await upsertAnnotation({ traceId: "t2", sessionId: "s1", firstFailureNote: "b", createdAt: 2 })
    expect((await listAnnotations()).map((a) => a.traceId)).toEqual(["t2", "t1"])
  })

  it("rolls up failure-mode counts for the taxonomy view, ignoring unlabeled", async () => {
    await upsertAnnotation({
      traceId: "t1",
      sessionId: "s1",
      firstFailureNote: "a",
      failureMode: "wrong-tool",
    })
    await upsertAnnotation({
      traceId: "t2",
      sessionId: "s1",
      firstFailureNote: "b",
      failureMode: "wrong-tool",
    })
    await upsertAnnotation({
      traceId: "t3",
      sessionId: "s1",
      firstFailureNote: "c",
      failureMode: "hallucination",
    })
    await upsertAnnotation({ traceId: "t4", sessionId: "s1", firstFailureNote: "d" })
    expect(await failureModeCounts()).toEqual({ "wrong-tool": 2, hallucination: 1 })
  })

  it("records the eval case a trace was saved into", async () => {
    await upsertAnnotation({ traceId: "t1", sessionId: "s1", firstFailureNote: "a" })
    await markSavedAsCase("t1", "evc_123")
    expect((await getAnnotationByTrace("t1"))?.savedAsCaseId).toBe("evc_123")
  })

  it("deletes an annotation by id", async () => {
    const a = await upsertAnnotation({ traceId: "t1", sessionId: "s1", firstFailureNote: "a" })
    await deleteAnnotation(a.id)
    expect(await getAnnotationByTrace("t1")).toBeUndefined()
  })
})
