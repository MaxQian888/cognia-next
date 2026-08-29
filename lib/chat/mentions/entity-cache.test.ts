import {
  ENTITY_CACHE_MAX_KEYS,
  __entityMentionCacheKeysForTests,
  invalidateEntityMentionCaches,
  loadEntityCandidates,
} from "./entity-cache"
import type {
  EntityMentionCandidate,
  EntityMentionContext,
  EntityMentionSource,
} from "./entity-sources"
import type { EntitySelectionKind } from "@/types/artifact/artifact"

function row(id: string): EntityMentionCandidate {
  return { entityKind: "memory", id, title: id, searchText: id }
}

/** A source that counts how many times its store was actually read. */
function countingSource(
  kind = "memory",
  rows: (ctx: EntityMentionContext) => EntityMentionCandidate[] = () => [row("a")]
): EntityMentionSource & { calls: number } {
  const source = {
    calls: 0,
    entityKind: kind as EntitySelectionKind,
    prefix: `${kind}:`,
    async load(ctx: EntityMentionContext) {
      source.calls++
      return rows(ctx)
    },
    async snapshot() {
      return null
    },
  }
  return source
}

beforeEach(() => {
  invalidateEntityMentionCaches()
})

describe("loadEntityCandidates", () => {
  it("reads the store once for repeated keystrokes in one context", async () => {
    const source = countingSource()
    const ctx = { projectId: "p1", sessionId: "s1" }
    await loadEntityCandidates(source, ctx)
    await loadEntityCandidates(source, ctx)
    await loadEntityCandidates(source, ctx)
    expect(source.calls).toBe(1)
  })

  it("shares one in-flight read between concurrent callers", async () => {
    const source = countingSource()
    const ctx = { projectId: "p1", sessionId: "s1" }
    await Promise.all([
      loadEntityCandidates(source, ctx),
      loadEntityCandidates(source, ctx),
      loadEntityCandidates(source, ctx),
    ])
    expect(source.calls).toBe(1)
  })

  // The bug a single-slot cache would ship: `@chat:` excludes the conversation
  // you are composing in, so the previous conversation's list is wrong here.
  it("does not serve one conversation's candidates to another", async () => {
    const source = countingSource("session", (ctx) =>
      [row("a"), row("b")].filter((r) => r.id !== ctx.sessionId)
    )
    const inA = await loadEntityCandidates(source, { projectId: "p", sessionId: "a" })
    const inB = await loadEntityCandidates(source, { projectId: "p", sessionId: "b" })
    expect(inA.map((r) => r.id)).toEqual(["b"])
    expect(inB.map((r) => r.id)).toEqual(["a"])
    expect(source.calls).toBe(2)
  })

  it("keys on the workspace as well as the conversation", async () => {
    const source = countingSource()
    await loadEntityCandidates(source, { projectId: "p1", sessionId: "s" })
    await loadEntityCandidates(source, { projectId: "p2", sessionId: "s" })
    expect(source.calls).toBe(2)
  })

  it("treats a missing projectId and a null one as the same context", async () => {
    const source = countingSource()
    await loadEntityCandidates(source, { sessionId: "s" })
    await loadEntityCandidates(source, { projectId: null, sessionId: "s" })
    expect(source.calls).toBe(1)
  })

  it("propagates a failed read instead of resolving to an empty list", async () => {
    const source: EntityMentionSource = {
      entityKind: "memory",
      prefix: "memory:",
      async load() {
        throw new Error("db closed")
      },
      async snapshot() {
        return null
      },
    }
    await expect(loadEntityCandidates(source, {})).rejects.toThrow("db closed")
  })

  it("refuses a source that has no load()", () => {
    const source: EntityMentionSource = {
      entityKind: "memory",
      prefix: "memory:",
      search: async () => [],
      snapshot: async () => null,
    }
    expect(() => loadEntityCandidates(source, {})).toThrow(/no load\(\)/)
  })

  it("evicts the oldest context rather than growing without bound", async () => {
    const source = countingSource()
    for (let i = 0; i < ENTITY_CACHE_MAX_KEYS + 3; i++) {
      await loadEntityCandidates(source, { projectId: "p", sessionId: `s${i}` })
    }
    const keys = __entityMentionCacheKeysForTests()
    expect(keys).toHaveLength(ENTITY_CACHE_MAX_KEYS)
    const sessionOf = (k: string) => k.split("\u0000")[2]
    expect(keys.map(sessionOf)).not.toContain("s0")
    expect(keys.map(sessionOf)).toContain(`s${ENTITY_CACHE_MAX_KEYS + 2}`)
  })
})

describe("invalidateEntityMentionCaches", () => {
  it("makes the next read hit the store again", async () => {
    const source = countingSource()
    const ctx = { projectId: "p", sessionId: "s" }
    await loadEntityCandidates(source, ctx)
    invalidateEntityMentionCaches()
    await loadEntityCandidates(source, ctx)
    expect(source.calls).toBe(2)
  })

  it("drops every key", async () => {
    const source = countingSource()
    await loadEntityCandidates(source, { sessionId: "s1" })
    await loadEntityCandidates(source, { sessionId: "s2" })
    invalidateEntityMentionCaches()
    expect(__entityMentionCacheKeysForTests()).toEqual([])
  })
})
