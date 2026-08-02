import {
  MANIFEST_VERSION,
  createManifest,
  isSessionManifest,
  mergeUsage,
  parseManifest,
  serializeManifest,
  validateManifest,
  type SessionManifest,
} from "./manifest"

function manifest(overrides: Partial<SessionManifest> = {}): SessionManifest {
  return {
    manifestVersion: 1,
    sessionId: "s1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    workspace: "/repo",
    turnCount: 2,
    sequenceDigest: "seq1-deadbeef",
    eventCount: 7,
    ...overrides,
  }
}

describe("validateManifest", () => {
  it("accepts a minimal valid manifest", () => {
    expect(validateManifest(manifest())).toEqual([])
    expect(isSessionManifest(manifest())).toBe(true)
  })

  it("rejects non-objects and the wrong version", () => {
    expect(validateManifest("nope")).toEqual(["manifest must be an object"])
    expect(validateManifest(manifest({ manifestVersion: 2 as 1 }))).toContain(
      `manifestVersion must be ${MANIFEST_VERSION}`
    )
  })

  it("requires the identity and digest strings", () => {
    for (const key of [
      "sessionId",
      "createdAt",
      "updatedAt",
      "workspace",
      "sequenceDigest",
    ] as const) {
      expect(validateManifest(manifest({ [key]: "" }))).toContain(
        `${key} must be a non-empty string`
      )
    }
  })

  it("requires non-negative integer counters", () => {
    expect(validateManifest(manifest({ turnCount: -1 }))).toContain(
      "turnCount must be a non-negative integer"
    )
    expect(validateManifest(manifest({ eventCount: 1.5 }))).toContain(
      "eventCount must be a non-negative integer"
    )
  })

  it("validates lineage and runtime binding shapes when present", () => {
    expect(
      validateManifest(manifest({ lineage: { parentSessionId: "", kind: "fork" } }))
    ).toContain("lineage must carry parentSessionId and kind fork|clone")
    expect(
      validateManifest(manifest({ lineage: { parentSessionId: "p", kind: "branch" as "fork" } }))
    ).toContain("lineage must carry parentSessionId and kind fork|clone")
    expect(validateManifest(manifest({ runtimeBinding: { backend: "" } }))).toContain(
      "runtimeBinding.backend must be a non-empty string"
    )
    expect(
      validateManifest(
        manifest({
          lineage: { parentSessionId: "p", parentTurnId: "t", kind: "clone" },
          runtimeBinding: { backend: "builtin", nativeSessionId: "n1" },
        })
      )
    ).toEqual([])
  })
})

describe("parseManifest / serializeManifest", () => {
  it("round-trips a manifest through its serialized form", () => {
    const original = manifest({ name: "my session" })
    expect(parseManifest(serializeManifest(original))).toEqual(original)
  })

  it("returns null for missing, unparsable, or invalid bodies", () => {
    expect(parseManifest(null)).toBeNull()
    expect(parseManifest("{ not json")).toBeNull()
    expect(parseManifest(JSON.stringify({ manifestVersion: 9 }))).toBeNull()
  })

  it("ends the serialized form with a newline", () => {
    expect(serializeManifest(manifest()).endsWith("\n")).toBe(true)
  })
})

describe("createManifest", () => {
  it("stamps createdAt and updatedAt from the same instant and defaults the counters", () => {
    const created = createManifest({
      sessionId: "s2",
      workspace: "/repo",
      at: "2026-02-02T00:00:00.000Z",
      sequenceDigest: "seq1-0",
    })
    expect(created.createdAt).toBe(created.updatedAt)
    expect(created.turnCount).toBe(0)
    expect(created.eventCount).toBe(0)
    expect(created.name).toBeUndefined()
    expect(isSessionManifest(created)).toBe(true)
  })

  it("carries the optional name, lineage, binding and legacy provenance", () => {
    const created = createManifest({
      sessionId: "s3",
      workspace: "/repo",
      at: "2026-02-02T00:00:00.000Z",
      sequenceDigest: "seq1-0",
      name: "named",
      lineage: { parentSessionId: "s1", parentTurnId: "t1", kind: "fork" },
      runtimeBinding: { backend: "codex" },
      legacy: {
        sourcePath: "/home/u/.cognia/sessions/s3.jsonl",
        invalidLines: 2,
        fidelity: "contextual",
        importedAt: "2026-02-02T00:00:00.000Z",
      },
      turnCount: 4,
      eventCount: 9,
    })
    expect(created).toMatchObject({
      name: "named",
      lineage: { parentSessionId: "s1", kind: "fork" },
      runtimeBinding: { backend: "codex" },
      legacy: { invalidLines: 2 },
      turnCount: 4,
      eventCount: 9,
    })
  })
})

describe("mergeUsage", () => {
  it("returns the other side when one is absent", () => {
    expect(mergeUsage(undefined, { inputTokens: 5 })).toEqual({ inputTokens: 5 })
    expect(mergeUsage({ inputTokens: 5 }, undefined)).toEqual({ inputTokens: 5 })
    expect(mergeUsage(undefined, undefined)).toBeUndefined()
  })

  it("sums each counter and keeps counters only one side reported", () => {
    expect(
      mergeUsage(
        { inputTokens: 10, outputTokens: 2, costUsd: 0.5 },
        { inputTokens: 5, cacheReadTokens: 3 }
      )
    ).toEqual({ inputTokens: 15, outputTokens: 2, cacheReadTokens: 3, costUsd: 0.5 })
  })

  it("omits a counter neither side reported", () => {
    expect(mergeUsage({ inputTokens: 1 }, { inputTokens: 1 })).toEqual({ inputTokens: 2 })
  })
})
