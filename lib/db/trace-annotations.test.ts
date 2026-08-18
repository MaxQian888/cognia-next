import {
  upsertAnnotation,
  getAnnotationByTrace,
  listAnnotations,
  listAnnotationsWithTraceState,
  orphanedAnnotationCount,
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

describe("listAnnotationsWithTraceState", () => {
  async function seedSpan(traceId: string): Promise<void> {
    await getDb().agentTraces.put({
      id: `span-${traceId}`,
      traceId,
      spanId: `span-${traceId}`,
      startTime: 1,
      operationName: "chat",
      providerName: "anthropic",
      sessionId: "s1",
      surface: "chat",
    })
  }

  beforeEach(async () => {
    await getDb().agentTraces.clear()
  })

  it("marks an annotation whose trace still exists as live", async () => {
    await seedSpan("t-live")
    await upsertAnnotation({ traceId: "t-live", sessionId: "s1", firstFailureNote: "n" })
    const rows = await listAnnotationsWithTraceState()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.orphaned).toBe(false)
  })

  it("marks an annotation whose trace was pruned as orphaned", async () => {
    // The annotation deliberately outlives the 30-day span window, so this is
    // the normal steady state — not a corruption.
    await upsertAnnotation({ traceId: "t-gone", sessionId: "s1", firstFailureNote: "n" })
    const rows = await listAnnotationsWithTraceState()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.orphaned).toBe(true)
  })

  it("resolves a mixed set in one pass and preserves newest-first order", async () => {
    await seedSpan("t-live")
    await upsertAnnotation({
      traceId: "t-gone",
      sessionId: "s1",
      firstFailureNote: "older",
      createdAt: 100,
    })
    await upsertAnnotation({
      traceId: "t-live",
      sessionId: "s1",
      firstFailureNote: "newer",
      createdAt: 200,
    })
    const rows = await listAnnotationsWithTraceState()
    expect(rows.map((r) => r.traceId)).toEqual(["t-live", "t-gone"])
    expect(rows.map((r) => r.orphaned)).toEqual([false, true])
  })

  it("returns an empty list when there are no annotations", async () => {
    expect(await listAnnotationsWithTraceState()).toEqual([])
  })

  it("preserves every annotation field alongside the orphan flag", async () => {
    await upsertAnnotation({
      traceId: "t-gone",
      sessionId: "s9",
      firstFailureNote: "bad tool arg",
      failureMode: "tool-misuse",
    })
    const [row] = await listAnnotationsWithTraceState()
    expect(row).toMatchObject({
      traceId: "t-gone",
      sessionId: "s9",
      firstFailureNote: "bad tool arg",
      failureMode: "tool-misuse",
      orphaned: true,
    })
  })
})

describe("orphanedAnnotationCount", () => {
  beforeEach(async () => {
    await getDb().agentTraces.clear()
  })

  it("counts only annotations whose trace is gone", async () => {
    await getDb().agentTraces.put({
      id: "span-live",
      traceId: "t-live",
      spanId: "span-live",
      startTime: 1,
      operationName: "chat",
      providerName: "anthropic",
      sessionId: "s1",
      surface: "chat",
    })
    await upsertAnnotation({ traceId: "t-live", sessionId: "s1", firstFailureNote: "a" })
    await upsertAnnotation({ traceId: "t-gone-1", sessionId: "s1", firstFailureNote: "b" })
    await upsertAnnotation({ traceId: "t-gone-2", sessionId: "s1", firstFailureNote: "c" })
    expect(await orphanedAnnotationCount()).toBe(2)
  })

  it("is 0 when there are no annotations", async () => {
    expect(await orphanedAnnotationCount()).toBe(0)
  })
})
