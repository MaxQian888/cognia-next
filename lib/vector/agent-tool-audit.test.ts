import {
  VECTOR_TOOL_AUDIT_CAP,
  clearVectorToolAudit,
  getVectorToolAudit,
  recordVectorToolAudit,
  subscribeVectorToolAudit,
} from "./agent-tool-audit"

beforeEach(() => {
  clearVectorToolAudit()
})

describe("recordVectorToolAudit", () => {
  it("stamps an id and timestamp", () => {
    const entry = recordVectorToolAudit({
      projectId: "p1",
      collection: "documents",
      operation: "search",
      ok: true,
      count: 3,
    })
    expect(entry.id).toMatch(/^va-/)
    expect(entry.ts).toEqual(expect.any(Number))
    expect(getVectorToolAudit()).toEqual([entry])
  })

  it("orders newest first", () => {
    recordVectorToolAudit({ projectId: "p1", collection: "a", operation: "add", ok: true })
    recordVectorToolAudit({ projectId: "p1", collection: "b", operation: "add", ok: true })
    expect(getVectorToolAudit().map((e) => e.collection)).toEqual(["b", "a"])
  })

  it("omits optional fields that were not supplied", () => {
    const entry = recordVectorToolAudit({
      projectId: "p1",
      collection: "documents",
      operation: "delete",
      ok: false,
      reason: "permission",
    })
    expect(entry).not.toHaveProperty("count")
    expect(entry).not.toHaveProperty("documentId")
    expect(entry.reason).toBe("permission")
  })

  it("keeps count and documentId when supplied", () => {
    const entry = recordVectorToolAudit({
      projectId: "p1",
      collection: "documents",
      operation: "add",
      ok: true,
      count: 1,
      documentId: "doc-9",
    })
    expect(entry.count).toBe(1)
    expect(entry.documentId).toBe("doc-9")
  })

  it("never carries content, metadata or embeddings through structural typing", () => {
    const draft = {
      projectId: "p1",
      collection: "documents",
      operation: "add" as const,
      ok: true,
      count: 1,
      documentId: "doc-1",
      // Extra keys a careless call site might spread in.
      content: "my social security number is 000-00-0000",
      metadata: { author: "Ada" },
      embedding: [0.1, 0.2],
    }
    const entry = recordVectorToolAudit(draft)
    expect(Object.keys(entry).sort()).toEqual(
      ["collection", "count", "documentId", "id", "ok", "operation", "projectId", "ts"].sort()
    )
    expect(JSON.stringify(entry)).not.toContain("000-00-0000")
    expect(JSON.stringify(entry)).not.toContain("Ada")
  })

  it("caps the ring and drops the oldest", () => {
    for (let i = 0; i < VECTOR_TOOL_AUDIT_CAP + 25; i++) {
      recordVectorToolAudit({
        projectId: "p1",
        collection: `c${i}`,
        operation: "search",
        ok: true,
      })
    }
    const all = getVectorToolAudit()
    expect(all).toHaveLength(VECTOR_TOOL_AUDIT_CAP)
    expect(all[0].collection).toBe(`c${VECTOR_TOOL_AUDIT_CAP + 24}`)
    expect(all.at(-1)?.collection).toBe(`c25`)
  })
})

describe("getVectorToolAudit", () => {
  it("honours the limit", () => {
    for (let i = 0; i < 5; i++) {
      recordVectorToolAudit({ projectId: "p", collection: `c${i}`, operation: "add", ok: true })
    }
    expect(getVectorToolAudit(2).map((e) => e.collection)).toEqual(["c4", "c3"])
  })

  it("clamps a negative limit to empty", () => {
    recordVectorToolAudit({ projectId: "p", collection: "c", operation: "add", ok: true })
    expect(getVectorToolAudit(-1)).toEqual([])
  })
})

describe("subscribeVectorToolAudit", () => {
  it("notifies on record and clear, and stops after unsubscribe", () => {
    const listener = jest.fn()
    const unsubscribe = subscribeVectorToolAudit(listener)

    recordVectorToolAudit({ projectId: "p", collection: "c", operation: "add", ok: true })
    expect(listener).toHaveBeenCalledTimes(1)

    clearVectorToolAudit()
    expect(listener).toHaveBeenCalledTimes(2)
    expect(getVectorToolAudit()).toEqual([])

    unsubscribe()
    recordVectorToolAudit({ projectId: "p", collection: "c", operation: "add", ok: true })
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
