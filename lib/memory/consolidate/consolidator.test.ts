import type { Memory } from "@/types/memory/memory"
import type { MemoryCandidate } from "@/lib/memory/extract/extractor"
import { consolidate, type ConsolidateDeps } from "./consolidator"

let seq = 0
function existing(text: string, over: Partial<Memory> = {}): Memory {
  seq += 1
  const now = 1_700_000_000_000
  return {
    id: over.id ?? `e${seq}`,
    scope: "global",
    type: "semantic",
    text,
    tags: [],
    importance: 5,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    accessCount: 0,
    version: 1,
    status: "active",
    pinned: false,
    provenance: "user",
    ...over,
  }
}

function cand(text: string, over: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return { type: "semantic", text, importance: 6, ...over }
}

function makeDeps(over: Partial<ConsolidateDeps> = {}): ConsolidateDeps & {
  persisted: Memory[]
  persistInputs: Parameters<ConsolidateDeps["persist"]>[0][]
  updates: { id: string; text: string }[]
  invalidations: { id: string; supersededById?: string }[]
} {
  const persisted: Memory[] = []
  const persistInputs: Parameters<ConsolidateDeps["persist"]>[0][] = []
  const updates: { id: string; text: string }[] = []
  const invalidations: { id: string; supersededById?: string }[] = []
  let n = 0
  return {
    persisted,
    persistInputs,
    updates,
    invalidations,
    client: { complete: jest.fn(async () => "{}") },
    findSimilar: async () => [],
    persist: async (input) => {
      persistInputs.push(input)
      n += 1
      const row = existing(input.text, {
        id: `new${n}`,
        type: input.type,
        importance: input.importance,
        scope: input.scope,
        characterId: input.characterId,
      })
      persisted.push(row)
      return row
    },
    update: async (id, text) => {
      updates.push({ id, text })
    },
    invalidate: async (id, supersededById) => {
      invalidations.push({ id, supersededById })
    },
    ...over,
  }
}

const baseInput = { scope: "global" as const, provenance: "user" as const }

describe("consolidate", () => {
  it("ADDs directly (no LLM) when there are no similar memories", async () => {
    const deps = makeDeps()
    const res = await consolidate({ ...baseInput, candidates: [cand("I use pnpm")] }, deps)
    expect(res.applied[0].op).toBe("ADD")
    expect(deps.persisted).toHaveLength(1)
    expect(deps.client.complete).not.toHaveBeenCalled()
  })

  it("UPDATEs an existing memory with merged text", async () => {
    const target = existing("The user uses pnpm", { id: "t1" })
    const deps = makeDeps({
      findSimilar: async () => [target],
      client: {
        complete: jest.fn(async () =>
          JSON.stringify({ op: "UPDATE", targetId: "t1", mergedText: "The user uses pnpm v9" })
        ),
      },
    })
    const res = await consolidate({ ...baseInput, candidates: [cand("pnpm v9")] }, deps)
    expect(res.applied).toEqual([{ op: "UPDATE", targetId: "t1" }])
    expect(deps.updates).toEqual([{ id: "t1", text: "The user uses pnpm v9" }])
  })

  it("DELETE soft-invalidates the contradicted memory and adds the new fact", async () => {
    const target = existing("The user uses npm", { id: "t1" })
    const deps = makeDeps({
      findSimilar: async () => [target],
      client: { complete: jest.fn(async () => JSON.stringify({ op: "DELETE", targetId: "t1" })) },
    })
    const res = await consolidate(
      { ...baseInput, candidates: [cand("The user now uses pnpm")] },
      deps
    )
    expect(res.applied.find((a) => a.op === "DELETE")).toEqual({ op: "DELETE", targetId: "t1" })
    expect(deps.persisted).toHaveLength(1)
    // invalidation links the new memory as superseder (no hard delete)
    expect(deps.invalidations).toEqual([{ id: "t1", supersededById: deps.persisted[0].id }])
  })

  it("NOOP leaves everything untouched", async () => {
    const deps = makeDeps({
      findSimilar: async () => [existing("The user uses pnpm", { id: "t1" })],
      client: { complete: jest.fn(async () => JSON.stringify({ op: "NOOP" })) },
    })
    const res = await consolidate({ ...baseInput, candidates: [cand("uses pnpm")] }, deps)
    expect(res.applied).toEqual([{ op: "NOOP" }])
    expect(deps.persisted).toHaveLength(0)
    expect(deps.updates).toHaveLength(0)
    expect(deps.invalidations).toHaveLength(0)
  })

  it("falls back to ADD when the decision JSON is unparseable", async () => {
    const deps = makeDeps({
      findSimilar: async () => [existing("similar", { id: "t1" })],
      client: { complete: jest.fn(async () => "garbage not json") },
    })
    const res = await consolidate({ ...baseInput, candidates: [cand("new fact")] }, deps)
    expect(res.applied[0].op).toBe("ADD")
  })

  it("keeps the new fact (ADD) when UPDATE/DELETE names an unknown targetId", async () => {
    // Regression: a hallucinated id used to fall through to NOOP, silently
    // discarding a genuinely new memory. The safe default is to ADD.
    const deps = makeDeps({
      findSimilar: async () => [existing("x", { id: "t1" })],
      client: {
        complete: jest.fn(async () => JSON.stringify({ op: "UPDATE", targetId: "ghost" })),
      },
    })
    const res = await consolidate({ ...baseInput, candidates: [cand("y")] }, deps)
    expect(res.applied[0].op).toBe("ADD")
    expect(deps.persisted).toHaveLength(1)
    expect(deps.updates).toHaveLength(0)
  })

  it("keeps the new fact (ADD) when DELETE names an unknown targetId", async () => {
    const deps = makeDeps({
      findSimilar: async () => [existing("x", { id: "t1" })],
      client: {
        complete: jest.fn(async () => JSON.stringify({ op: "DELETE", targetId: "ghost" })),
      },
    })
    const res = await consolidate({ ...baseInput, candidates: [cand("z")] }, deps)
    expect(res.applied[0].op).toBe("ADD")
    expect(deps.persisted).toHaveLength(1)
    expect(deps.invalidations).toHaveLength(0)
  })

  it("passes character scope + characterId through to persist", async () => {
    const deps = makeDeps()
    await consolidate(
      { scope: "character", characterId: "charA", provenance: "user", candidates: [cand("x")] },
      deps
    )
    expect(deps.persistInputs[0].scope).toBe("character")
    expect(deps.persistInputs[0].characterId).toBe("charA")
    expect(deps.persistInputs[0].provenance).toBe("user")
  })

  it("drops characterId for global-scope persists", async () => {
    const deps = makeDeps()
    await consolidate(
      { scope: "global", characterId: "charA", provenance: "user", candidates: [cand("x")] },
      deps
    )
    expect(deps.persistInputs[0].scope).toBe("global")
    expect(deps.persistInputs[0].characterId).toBeUndefined()
  })

  it("skips blank candidates", async () => {
    const deps = makeDeps()
    const res = await consolidate({ ...baseInput, candidates: [cand("   ")] }, deps)
    expect(res.applied).toHaveLength(0)
    expect(deps.persisted).toHaveLength(0)
  })

  it("swallows findSimilar errors and ADDs", async () => {
    const deps = makeDeps({
      findSimilar: async () => {
        throw new Error("vector down")
      },
    })
    const res = await consolidate({ ...baseInput, candidates: [cand("fact")] }, deps)
    expect(res.applied[0].op).toBe("ADD")
  })
})
