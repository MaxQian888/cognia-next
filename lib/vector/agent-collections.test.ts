import {
  AGENT_COLLECTION_SEPARATOR,
  DEFAULT_AGENT_VECTOR_COLLECTION,
  MAX_LOGICAL_COLLECTION_LENGTH,
  agentCollectionPrefix,
  checkLogicalCollection,
  describeLogicalCollectionRejection,
  isAgentCollectionOfProject,
  logicalNameOf,
  resolveAgentCollection,
} from "./agent-collections"

describe("checkLogicalCollection", () => {
  it("accepts the default collection", () => {
    expect(checkLogicalCollection(DEFAULT_AGENT_VECTOR_COLLECTION)).toEqual({
      ok: true,
      name: "documents",
    })
  })

  it("trims surrounding whitespace", () => {
    expect(checkLogicalCollection("  notes  ")).toEqual({ ok: true, name: "notes" })
  })

  it.each([
    ["letters and digits", "docs2024"],
    ["single underscore", "meeting_notes"],
    ["hyphen", "meeting-notes"],
    ["digit start", "2024archive"],
    ["max length", "a".repeat(MAX_LOGICAL_COLLECTION_LENGTH)],
  ])("accepts %s", (_label, name) => {
    expect(checkLogicalCollection(name)).toEqual({ ok: true, name })
  })

  it.each([
    ["undefined", undefined, "empty"],
    ["null", null, "empty"],
    ["empty string", "", "empty"],
    ["whitespace only", "   ", "empty"],
  ] as const)("rejects %s", (_label, input, reason) => {
    expect(checkLogicalCollection(input)).toEqual({ ok: false, reason })
  })

  it("rejects a name longer than the cap", () => {
    expect(checkLogicalCollection("a".repeat(MAX_LOGICAL_COLLECTION_LENGTH + 1))).toEqual({
      ok: false,
      reason: "too-long",
    })
  })

  it("rejects the reserved separator before the charset check", () => {
    expect(checkLogicalCollection("a__b")).toEqual({ ok: false, reason: "reserved-separator" })
  })

  it.each([
    ["path traversal", "../other"],
    ["slash", "a/b"],
    ["leading underscore", "_hidden"],
    ["leading hyphen", "-hidden"],
    ["space", "my docs"],
    ["dot", "docs.v1"],
    ["unicode", "笔记"],
  ])("rejects %s as invalid characters", (_label, name) => {
    expect(checkLogicalCollection(name)).toEqual({ ok: false, reason: "invalid-characters" })
  })

  it("describes every rejection reason", () => {
    for (const reason of [
      "empty",
      "too-long",
      "invalid-characters",
      "reserved-separator",
    ] as const) {
      expect(describeLogicalCollectionRejection(reason)).toEqual(expect.any(String))
      expect(describeLogicalCollectionRejection(reason).length).toBeGreaterThan(0)
    }
  })
})

describe("resolveAgentCollection", () => {
  it("prefixes the logical name with the project namespace", () => {
    expect(resolveAgentCollection("p1", "documents")).toBe("project_p1__documents")
  })

  it("uses the trimmed logical name", () => {
    expect(resolveAgentCollection("p1", " notes ")).toBe("project_p1__notes")
  })

  it("throws on an invalid logical name rather than building a namespace", () => {
    expect(() => resolveAgentCollection("p1", "../escape")).toThrow(/invalid logical collection/)
  })

  it("throws when the project id is missing", () => {
    expect(() => resolveAgentCollection("", "documents")).toThrow(/requires a project id/)
  })

  it("cannot be tricked into another project's namespace", () => {
    // The only lever the agent has is the logical name; `__` is refused, so a
    // crafted value can never re-open the separator.
    expect(() => resolveAgentCollection("p1", "project_p2__documents")).toThrow(
      /invalid logical collection/
    )
    // And a single-underscore name stays inside p1.
    expect(resolveAgentCollection("p1", "project_p2")).toBe("project_p1__project_p2")
  })

  it("keeps distinct projects disjoint even when ids share a prefix", () => {
    const a = resolveAgentCollection("p1", "documents")
    const b = resolveAgentCollection("p10", "documents")
    expect(a).not.toBe(b)
    expect(isAgentCollectionOfProject("p1", b)).toBe(false)
    expect(isAgentCollectionOfProject("p10", a)).toBe(false)
  })
})

describe("agentCollectionPrefix", () => {
  it("ends with the reserved separator", () => {
    expect(agentCollectionPrefix("p1")).toBe(`project_p1${AGENT_COLLECTION_SEPARATOR}`)
  })
})

describe("isAgentCollectionOfProject", () => {
  it("matches collections in the project namespace", () => {
    expect(isAgentCollectionOfProject("p1", "project_p1__documents")).toBe(true)
  })

  it("rejects another project's collection", () => {
    expect(isAgentCollectionOfProject("p1", "project_p2__documents")).toBe(false)
  })

  it("rejects the plugin namespace", () => {
    expect(isAgentCollectionOfProject("p1", "plugin_acme_documents")).toBe(false)
  })

  it("rejects an empty project id", () => {
    expect(isAgentCollectionOfProject("", "project___documents")).toBe(false)
  })
})

describe("logicalNameOf", () => {
  it("recovers the logical name", () => {
    expect(logicalNameOf("p1", "project_p1__documents")).toBe("documents")
  })

  it("returns undefined for another project", () => {
    expect(logicalNameOf("p1", "project_p2__documents")).toBeUndefined()
  })

  it("returns undefined when the suffix is empty", () => {
    expect(logicalNameOf("p1", "project_p1__")).toBeUndefined()
  })
})
