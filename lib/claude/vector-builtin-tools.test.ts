import type { PluginAPIPermission } from "@/types/plugin/plugin"
import { clearVectorToolAudit, getVectorToolAudit } from "@/lib/vector/agent-tool-audit"
import { VectorServiceError, type AgentVectorService } from "@/lib/vector/agent-vector-service"
import {
  DEFAULT_VECTOR_TOOL_TIMEOUT_MS,
  VECTOR_ADD_DOCUMENT_TOOL_NAME,
  VECTOR_BUILTIN_PLUGIN_ID,
  VECTOR_DELETE_DOCUMENT_TOOL_NAME,
  VECTOR_SEARCH_TOOL_NAME,
  VECTOR_TOOL_PERMISSIONS,
  buildVectorManifestEntries,
  isVectorBuiltinTool,
  runVectorBuiltinTool,
  type VectorToolRunDeps,
} from "./vector-builtin-tools"

const ALL_PERMISSIONS: PluginAPIPermission[] = ["vector:read", "vector:write", "ai:embed"]

function makeService(overrides: Partial<AgentVectorService> = {}) {
  const service: AgentVectorService = {
    search: jest.fn(async () => [
      { id: "d1", content: "hello", score: 0.9, metadata: { kind: "note" } },
    ]),
    addDocument: jest.fn(async (_c, input) => ({ id: input.id, createdCollection: false })),
    deleteDocument: jest.fn(async () => ({ deleted: true })),
    ...overrides,
  }
  return service
}

function makeDeps(overrides: Partial<VectorToolRunDeps> = {}): VectorToolRunDeps {
  return {
    service: makeService(),
    resolveProjectId: () => "p1",
    hasPermission: () => true,
    newDocumentId: () => "generated-id",
    ...overrides,
  }
}

const CTX = { sessionId: "s1" }

beforeEach(() => {
  clearVectorToolAudit()
})

describe("manifest", () => {
  it("exposes exactly the three tools, tagged with the built-in plugin id", () => {
    const entries = buildVectorManifestEntries()
    expect(entries.map((e) => e.name)).toEqual([
      VECTOR_SEARCH_TOOL_NAME,
      VECTOR_ADD_DOCUMENT_TOOL_NAME,
      VECTOR_DELETE_DOCUMENT_TOOL_NAME,
    ])
    for (const entry of entries) {
      expect(entry.pluginId).toBe(VECTOR_BUILTIN_PLUGIN_ID)
      expect(entry.description.length).toBeGreaterThan(20)
      expect(entry.jsonSchema).toMatchObject({ type: "object" })
    }
  })

  it("never exposes a project field the agent could set", () => {
    for (const entry of buildVectorManifestEntries()) {
      const props = (entry.jsonSchema as { properties: Record<string, unknown> }).properties
      expect(Object.keys(props)).not.toContain("projectId")
      expect(Object.keys(props)).not.toContain("project")
      expect(JSON.stringify(entry.jsonSchema)).not.toContain("projectId")
    }
  })

  it("recognises its own tool names and nothing else", () => {
    expect(isVectorBuiltinTool(VECTOR_SEARCH_TOOL_NAME)).toBe(true)
    expect(isVectorBuiltinTool(VECTOR_ADD_DOCUMENT_TOOL_NAME)).toBe(true)
    expect(isVectorBuiltinTool(VECTOR_DELETE_DOCUMENT_TOOL_NAME)).toBe(true)
    expect(isVectorBuiltinTool("web_search")).toBe(false)
    expect(isVectorBuiltinTool("vector_")).toBe(false)
  })
})

describe("project isolation", () => {
  it("refuses when the session has no linked project", async () => {
    const deps = makeDeps({ resolveProjectId: () => null })
    const result = await runVectorBuiltinTool(VECTOR_SEARCH_TOOL_NAME, { query: "hi" }, deps, CTX)
    expect(result).toMatchObject({ ok: false, code: "no-project" })
    expect(deps.service.search).not.toHaveBeenCalled()
  })

  it("treats a resolver failure as no project", async () => {
    const deps = makeDeps({
      resolveProjectId: () => {
        throw new Error("dexie down")
      },
    })
    await expect(
      runVectorBuiltinTool(VECTOR_SEARCH_TOOL_NAME, { query: "hi" }, deps, CTX)
    ).resolves.toMatchObject({ ok: false, code: "no-project" })
  })

  it("prefixes the collection with the context project id", async () => {
    const deps = makeDeps({ resolveProjectId: () => "proj-42" })
    await runVectorBuiltinTool(VECTOR_SEARCH_TOOL_NAME, { query: "hi" }, deps, CTX)
    expect(deps.service.search).toHaveBeenCalledWith(
      "project_proj-42__documents",
      "hi",
      expect.anything()
    )
  })

  it("ignores a projectId smuggled into the arguments", async () => {
    const deps = makeDeps({ resolveProjectId: () => "p1" })
    await runVectorBuiltinTool(
      VECTOR_SEARCH_TOOL_NAME,
      { query: "hi", projectId: "p2", project: "p2" },
      deps,
      CTX
    )
    expect(deps.service.search).toHaveBeenCalledWith(
      "project_p1__documents",
      "hi",
      expect.anything()
    )
  })

  it("refuses a collection name that tries to reopen the namespace separator", async () => {
    const deps = makeDeps()
    const result = await runVectorBuiltinTool(
      VECTOR_SEARCH_TOOL_NAME,
      { query: "hi", collection: "project_p2__documents" },
      deps,
      CTX
    )
    expect(result).toMatchObject({ ok: false, code: "invalid-argument" })
    expect(deps.service.search).not.toHaveBeenCalled()
  })

  it("defaults to the documents collection", async () => {
    const deps = makeDeps()
    await runVectorBuiltinTool(VECTOR_SEARCH_TOOL_NAME, { query: "hi" }, deps, CTX)
    expect(deps.service.search).toHaveBeenCalledWith(
      "project_p1__documents",
      "hi",
      expect.anything()
    )
  })

  it("rejects a non-string collection", async () => {
    const deps = makeDeps()
    await expect(
      runVectorBuiltinTool(VECTOR_SEARCH_TOOL_NAME, { query: "hi", collection: 7 }, deps, CTX)
    ).resolves.toMatchObject({ ok: false, code: "invalid-argument" })
  })
})

describe("permissions", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    [VECTOR_SEARCH_TOOL_NAME, { query: "hi" }],
    [VECTOR_ADD_DOCUMENT_TOOL_NAME, { content: "hi" }],
    [VECTOR_DELETE_DOCUMENT_TOOL_NAME, { id: "d1" }],
  ]

  it.each(cases)("%s succeeds with every permission granted", async (name, args) => {
    const deps = makeDeps()
    await expect(runVectorBuiltinTool(name, args, deps, CTX)).resolves.toMatchObject({ ok: true })
  })

  // Exhaustive: every subset of the three permissions, against every tool.
  const subsets: PluginAPIPermission[][] = []
  for (let mask = 0; mask < 1 << ALL_PERMISSIONS.length; mask++) {
    subsets.push(ALL_PERMISSIONS.filter((_p, i) => mask & (1 << i)))
  }

  it.each(cases)("%s enforces exactly its declared permission set", async (name, args) => {
    const required = VECTOR_TOOL_PERMISSIONS[name]
    for (const granted of subsets) {
      const deps = makeDeps({ hasPermission: (p) => granted.includes(p) })
      const result = await runVectorBuiltinTool(name, args, deps, CTX)
      const shouldPass = required.every((p) => granted.includes(p))
      if (shouldPass) {
        expect(result).toMatchObject({ ok: true })
      } else {
        expect(result).toMatchObject({ ok: false, code: "permission" })
      }
    }
  })

  it("names the missing permissions in the error and never touches the store", async () => {
    const deps = makeDeps({ hasPermission: () => false })
    const result = await runVectorBuiltinTool(
      VECTOR_ADD_DOCUMENT_TOOL_NAME,
      { content: "hi" },
      deps,
      CTX
    )
    expect(result).toMatchObject({ ok: false, code: "permission" })
    expect((result as { error: string }).error).toContain("vector:write")
    expect((result as { error: string }).error).toContain("ai:embed")
    expect(deps.service.addDocument).not.toHaveBeenCalled()
  })

  it("does not require ai:embed to delete", async () => {
    const deps = makeDeps({ hasPermission: (p) => p === "vector:write" })
    await expect(
      runVectorBuiltinTool(VECTOR_DELETE_DOCUMENT_TOOL_NAME, { id: "d1" }, deps, CTX)
    ).resolves.toMatchObject({ ok: true })
  })
})

describe("PII gate", () => {
  it("blocks a query before it reaches the embedder", async () => {
    const deps = makeDeps({ gateText: () => false })
    const result = await runVectorBuiltinTool(
      VECTOR_SEARCH_TOOL_NAME,
      { query: "my ssn is 000-00-0000" },
      deps,
      CTX
    )
    expect(result).toMatchObject({ ok: false, code: "pii" })
    expect(deps.service.search).not.toHaveBeenCalled()
  })

  it("blocks document content before it is embedded", async () => {
    const deps = makeDeps({ gateText: () => false })
    const result = await runVectorBuiltinTool(
      VECTOR_ADD_DOCUMENT_TOOL_NAME,
      { content: "leaky" },
      deps,
      CTX
    )
    expect(result).toMatchObject({ ok: false, code: "pii" })
    expect(deps.service.addDocument).not.toHaveBeenCalled()
  })

  it("blocks leaky metadata even when the content is clean", async () => {
    const deps = makeDeps({ gateText: () => true, gateDeep: () => false })
    const result = await runVectorBuiltinTool(
      VECTOR_ADD_DOCUMENT_TOOL_NAME,
      { content: "clean", metadata: { email: "a@b.c" } },
      deps,
      CTX
    )
    expect(result).toMatchObject({ ok: false, code: "pii" })
    expect(deps.service.addDocument).not.toHaveBeenCalled()
  })

  it("blocks leaky search filters", async () => {
    const deps = makeDeps({ gateText: () => true, gateDeep: () => false })
    const result = await runVectorBuiltinTool(
      VECTOR_SEARCH_TOOL_NAME,
      { query: "hi", filters: [{ key: "email", value: "a@b.c" }] },
      deps,
      CTX
    )
    expect(result).toMatchObject({ ok: false, code: "pii" })
    expect(deps.service.search).not.toHaveBeenCalled()
  })

  it("does not gate the delete path (nothing is embedded or stored)", async () => {
    const deps = makeDeps({ gateText: () => false, gateDeep: () => false })
    await expect(
      runVectorBuiltinTool(VECTOR_DELETE_DOCUMENT_TOOL_NAME, { id: "d1" }, deps, CTX)
    ).resolves.toMatchObject({ ok: true, deleted: true })
  })

  it("uses the real redaction gate by default", async () => {
    const deps = makeDeps()
    delete (deps as { gateText?: unknown }).gateText
    const result = await runVectorBuiltinTool(
      VECTOR_ADD_DOCUMENT_TOOL_NAME,
      { content: "Reach me at alice@example.com" },
      deps,
      CTX
    )
    expect(result).toMatchObject({ ok: false, code: "pii" })
  })
})

describe("vector_search", () => {
  it("returns hits under the logical collection name", async () => {
    const deps = makeDeps()
    const result = await runVectorBuiltinTool(
      VECTOR_SEARCH_TOOL_NAME,
      { query: "hi", collection: "notes" },
      deps,
      CTX
    )
    expect(result).toEqual({
      ok: true,
      collection: "notes",
      results: [{ id: "d1", content: "hello", score: 0.9, metadata: { kind: "note" } }],
    })
  })

  it("forwards topK, threshold and normalised filters", async () => {
    const deps = makeDeps()
    await runVectorBuiltinTool(
      VECTOR_SEARCH_TOOL_NAME,
      {
        query: "hi",
        topK: 3,
        threshold: 0.5,
        filters: [
          { key: "kind", value: "note" },
          { key: "year", value: 2024, operation: "greater_than" },
          { value: "no key" },
          "garbage",
        ],
      },
      deps,
      CTX
    )
    expect(deps.service.search).toHaveBeenCalledWith("project_p1__documents", "hi", {
      topK: 3,
      threshold: 0.5,
      filters: [
        { key: "kind", value: "note", operation: "equals" },
        { key: "year", value: 2024, operation: "greater_than" },
      ],
      signal: expect.any(AbortSignal),
    })
  })

  it("drops a non-positive topK rather than passing it through", async () => {
    const deps = makeDeps()
    await runVectorBuiltinTool(VECTOR_SEARCH_TOOL_NAME, { query: "hi", topK: 0 }, deps, CTX)
    expect(deps.service.search).toHaveBeenCalledWith(
      "project_p1__documents",
      "hi",
      expect.not.objectContaining({ topK: expect.anything() })
    )
  })

  it("rejects a blank query", async () => {
    const deps = makeDeps()
    await expect(
      runVectorBuiltinTool(VECTOR_SEARCH_TOOL_NAME, { query: "   " }, deps, CTX)
    ).resolves.toMatchObject({ ok: false, code: "invalid-argument" })
    await expect(
      runVectorBuiltinTool(VECTOR_SEARCH_TOOL_NAME, {}, deps, CTX)
    ).resolves.toMatchObject({ ok: false, code: "invalid-argument" })
  })

  it("returns an empty result set for a missing collection", async () => {
    const deps = makeDeps({ service: makeService({ search: jest.fn(async () => []) }) })
    await expect(
      runVectorBuiltinTool(VECTOR_SEARCH_TOOL_NAME, { query: "hi" }, deps, CTX)
    ).resolves.toEqual({ ok: true, collection: "documents", results: [] })
  })
})

describe("vector_add_document", () => {
  it("uses the model-supplied id", async () => {
    const deps = makeDeps()
    const result = await runVectorBuiltinTool(
      VECTOR_ADD_DOCUMENT_TOOL_NAME,
      { content: "hello", id: " doc-7 " },
      deps,
      CTX
    )
    expect(result).toMatchObject({ ok: true, id: "doc-7" })
    expect(deps.service.addDocument).toHaveBeenCalledWith(
      "project_p1__documents",
      expect.objectContaining({ id: "doc-7", content: "hello" })
    )
  })

  it("generates an id when one is not supplied", async () => {
    const deps = makeDeps()
    await expect(
      runVectorBuiltinTool(VECTOR_ADD_DOCUMENT_TOOL_NAME, { content: "hello" }, deps, CTX)
    ).resolves.toMatchObject({ ok: true, id: "generated-id" })
  })

  it("generates a unique fallback id when no generator is injected", async () => {
    const deps = makeDeps()
    delete (deps as { newDocumentId?: unknown }).newDocumentId
    const a = await runVectorBuiltinTool(VECTOR_ADD_DOCUMENT_TOOL_NAME, { content: "a" }, deps, CTX)
    const b = await runVectorBuiltinTool(VECTOR_ADD_DOCUMENT_TOOL_NAME, { content: "b" }, deps, CTX)
    expect((a as { id: string }).id).toMatch(/^vdoc_/)
    expect((a as { id: string }).id).not.toBe((b as { id: string }).id)
  })

  it("reports lazy collection creation", async () => {
    const deps = makeDeps({
      service: makeService({
        addDocument: jest.fn(async (_c, input) => ({ id: input.id, createdCollection: true })),
      }),
    })
    await expect(
      runVectorBuiltinTool(VECTOR_ADD_DOCUMENT_TOOL_NAME, { content: "x" }, deps, CTX)
    ).resolves.toMatchObject({ createdCollection: true })
  })

  it.each([
    ["blank content", { content: "  " }],
    ["missing content", {}],
    ["blank id", { content: "x", id: "  " }],
    ["non-string id", { content: "x", id: 5 }],
    ["array metadata", { content: "x", metadata: [1, 2] }],
    ["scalar metadata", { content: "x", metadata: "nope" }],
  ])("rejects %s", async (_label, args) => {
    const deps = makeDeps()
    await expect(
      runVectorBuiltinTool(VECTOR_ADD_DOCUMENT_TOOL_NAME, args, deps, CTX)
    ).resolves.toMatchObject({ ok: false, code: "invalid-argument" })
    expect(deps.service.addDocument).not.toHaveBeenCalled()
  })
})

describe("vector_delete_document", () => {
  it("reports deleted:false for a missing document", async () => {
    const deps = makeDeps({
      service: makeService({ deleteDocument: jest.fn(async () => ({ deleted: false })) }),
    })
    await expect(
      runVectorBuiltinTool(VECTOR_DELETE_DOCUMENT_TOOL_NAME, { id: "nope" }, deps, CTX)
    ).resolves.toEqual({ ok: true, collection: "documents", id: "nope", deleted: false })
  })

  it("rejects a blank id", async () => {
    const deps = makeDeps()
    await expect(
      runVectorBuiltinTool(VECTOR_DELETE_DOCUMENT_TOOL_NAME, { id: " " }, deps, CTX)
    ).resolves.toMatchObject({ ok: false, code: "invalid-argument" })
  })
})

describe("cancellation and timeout", () => {
  it("surfaces caller cancellation as cancelled", async () => {
    const deps = makeDeps({
      service: makeService({
        search: jest.fn(async () => {
          throw new VectorServiceError("cancelled", "vector operation cancelled")
        }),
      }),
    })
    await expect(
      runVectorBuiltinTool(VECTOR_SEARCH_TOOL_NAME, { query: "hi" }, deps, CTX)
    ).resolves.toMatchObject({ ok: false, code: "cancelled" })
  })

  it("aborts the service signal when the caller aborts", async () => {
    const controller = new AbortController()
    let observed: AbortSignal | undefined
    const deps = makeDeps({
      signal: controller.signal,
      service: makeService({
        search: jest.fn(async (_c, _q, options) => {
          observed = options?.signal
          controller.abort()
          throw new VectorServiceError("cancelled", "cancelled")
        }),
      }),
    })
    const result = await runVectorBuiltinTool(VECTOR_SEARCH_TOOL_NAME, { query: "hi" }, deps, CTX)
    expect(observed?.aborted).toBe(true)
    expect(result).toMatchObject({ ok: false, code: "cancelled" })
  })

  it("starts already-aborted when the caller's signal is aborted up front", async () => {
    let observed: AbortSignal | undefined
    const deps = makeDeps({
      signal: AbortSignal.abort(),
      service: makeService({
        search: jest.fn(async (_c, _q, options) => {
          observed = options?.signal
          return []
        }),
      }),
    })
    await runVectorBuiltinTool(VECTOR_SEARCH_TOOL_NAME, { query: "hi" }, deps, CTX)
    expect(observed?.aborted).toBe(true)
  })

  it("classifies a budget expiry as timeout, not cancelled", async () => {
    jest.useFakeTimers()
    try {
      const deps = makeDeps({
        timeoutMs: 10,
        service: makeService({
          search: jest.fn(async (_c, _q, options) => {
            jest.advanceTimersByTime(20)
            expect(options?.signal?.aborted).toBe(true)
            throw new VectorServiceError("cancelled", "vector operation cancelled")
          }),
        }),
      })
      const result = await runVectorBuiltinTool(VECTOR_SEARCH_TOOL_NAME, { query: "hi" }, deps, CTX)
      expect(result).toMatchObject({ ok: false, code: "timeout" })
    } finally {
      jest.useRealTimers()
    }
  })

  it("exposes a sane default budget", () => {
    expect(DEFAULT_VECTOR_TOOL_TIMEOUT_MS).toBeGreaterThan(1000)
  })
})

describe("error handling", () => {
  it("returns a structured failure for a store error", async () => {
    const deps = makeDeps({
      service: makeService({
        search: jest.fn(async () => {
          throw new VectorServiceError("store-error", "sqlite exploded")
        }),
      }),
    })
    await expect(
      runVectorBuiltinTool(VECTOR_SEARCH_TOOL_NAME, { query: "hi" }, deps, CTX)
    ).resolves.toEqual({ ok: false, code: "error", error: "sqlite exploded" })
  })

  it("returns a structured failure for an unexpected throw", async () => {
    const deps = makeDeps({
      service: makeService({
        search: jest.fn(async () => {
          throw new Error("kaboom")
        }),
      }),
    })
    await expect(
      runVectorBuiltinTool(VECTOR_SEARCH_TOOL_NAME, { query: "hi" }, deps, CTX)
    ).resolves.toEqual({ ok: false, code: "error", error: "kaboom" })
  })

  it("stringifies a non-Error throw", async () => {
    const deps = makeDeps({
      service: makeService({
        search: jest.fn(async () => {
          throw "plain string"
        }),
      }),
    })
    await expect(
      runVectorBuiltinTool(VECTOR_SEARCH_TOOL_NAME, { query: "hi" }, deps, CTX)
    ).resolves.toMatchObject({ ok: false, error: "plain string" })
  })

  it("surfaces unsupported-platform from the service", async () => {
    const deps = makeDeps({
      service: makeService({
        search: jest.fn(async () => {
          throw new VectorServiceError("unsupported-platform", "desktop only")
        }),
      }),
    })
    await expect(
      runVectorBuiltinTool(VECTOR_SEARCH_TOOL_NAME, { query: "hi" }, deps, CTX)
    ).resolves.toMatchObject({ ok: false, code: "error", error: "desktop only" })
  })
})

describe("audit", () => {
  it("records a successful search with its hit count and no content", async () => {
    await runVectorBuiltinTool(
      VECTOR_SEARCH_TOOL_NAME,
      { query: "hi", collection: "notes" },
      makeDeps(),
      CTX
    )
    const [entry] = getVectorToolAudit()
    expect(entry).toMatchObject({
      projectId: "p1",
      collection: "notes",
      operation: "search",
      ok: true,
      count: 1,
    })
    expect(JSON.stringify(entry)).not.toContain("hi")
    expect(JSON.stringify(entry)).not.toContain("hello")
  })

  it("records the logical collection, never the native one", async () => {
    await runVectorBuiltinTool(VECTOR_SEARCH_TOOL_NAME, { query: "hi" }, makeDeps(), CTX)
    expect(getVectorToolAudit()[0].collection).toBe("documents")
  })

  it("records an add with the document id", async () => {
    await runVectorBuiltinTool(
      VECTOR_ADD_DOCUMENT_TOOL_NAME,
      { content: "hello", id: "doc-1", metadata: { kind: "note" } },
      makeDeps(),
      CTX
    )
    const [entry] = getVectorToolAudit()
    expect(entry).toMatchObject({ operation: "add", ok: true, count: 1, documentId: "doc-1" })
    expect(JSON.stringify(entry)).not.toContain("hello")
    expect(JSON.stringify(entry)).not.toContain("kind")
  })

  it("records a delete miss as count 0", async () => {
    const deps = makeDeps({
      service: makeService({ deleteDocument: jest.fn(async () => ({ deleted: false })) }),
    })
    await runVectorBuiltinTool(VECTOR_DELETE_DOCUMENT_TOOL_NAME, { id: "d9" }, deps, CTX)
    expect(getVectorToolAudit()[0]).toMatchObject({
      operation: "delete",
      ok: true,
      count: 0,
      documentId: "d9",
    })
  })

  it("records a permission denial", async () => {
    await runVectorBuiltinTool(
      VECTOR_SEARCH_TOOL_NAME,
      { query: "hi" },
      makeDeps({ hasPermission: () => false }),
      CTX
    )
    expect(getVectorToolAudit()[0]).toMatchObject({ ok: false, reason: "permission" })
  })

  it("records a PII denial", async () => {
    await runVectorBuiltinTool(
      VECTOR_SEARCH_TOOL_NAME,
      { query: "hi" },
      makeDeps({ gateText: () => false }),
      CTX
    )
    expect(getVectorToolAudit()[0]).toMatchObject({ ok: false, reason: "pii" })
  })

  it("records an invalid-argument denial", async () => {
    await runVectorBuiltinTool(VECTOR_SEARCH_TOOL_NAME, { query: "" }, makeDeps(), CTX)
    expect(getVectorToolAudit()[0]).toMatchObject({ ok: false, reason: "invalid-argument" })
  })

  it("records a store error", async () => {
    const deps = makeDeps({
      service: makeService({
        search: jest.fn(async () => {
          throw new VectorServiceError("store-error", "boom")
        }),
      }),
    })
    await runVectorBuiltinTool(VECTOR_SEARCH_TOOL_NAME, { query: "hi" }, deps, CTX)
    expect(getVectorToolAudit()[0]).toMatchObject({ ok: false, reason: "error" })
  })

  it("does not record an unattributable call (no project)", async () => {
    await runVectorBuiltinTool(
      VECTOR_SEARCH_TOOL_NAME,
      { query: "hi" },
      makeDeps({ resolveProjectId: () => null }),
      CTX
    )
    expect(getVectorToolAudit()).toEqual([])
  })

  it("does not record a malformed collection (no project resolved yet)", async () => {
    await runVectorBuiltinTool(
      VECTOR_SEARCH_TOOL_NAME,
      { query: "hi", collection: "bad__name" },
      makeDeps(),
      CTX
    )
    expect(getVectorToolAudit()).toEqual([])
  })
})
