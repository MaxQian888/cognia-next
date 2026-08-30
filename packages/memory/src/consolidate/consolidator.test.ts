import type { Memory } from "../types/memory"
import type { MemoryCandidate } from "../extract/extractor"
import {
  consolidate,
  consolidationAuditAction,
  consolidationOpMemoryId,
  sameMemoryNamespace,
  type ConsolidateDeps,
  type ConsolidationOp,
} from "./consolidator"

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
  conflicts: { targetId: string; conflictId: string }[]
} {
  const persisted: Memory[] = []
  const persistInputs: Parameters<ConsolidateDeps["persist"]>[0][] = []
  const updates: { id: string; text: string }[] = []
  const invalidations: { id: string; supersededById?: string }[] = []
  const conflicts: { targetId: string; conflictId: string }[] = []
  let n = 0
  return {
    persisted,
    persistInputs,
    updates,
    invalidations,
    conflicts,
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
        reviewStatus: input.reviewStatus,
        conflictWithIds: input.conflictWithIds,
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
    markConflict: async (targetId, conflictId) => {
      conflicts.push({ targetId, conflictId })
    },
    ...over,
  }
}

const baseInput = { scope: "global" as const, provenance: "user" as const }

describe("sameMemoryNamespace", () => {
  it("prevents consolidation across workspaces, agents, branches, and paths", () => {
    const memory = existing("fact", {
      scope: "agent",
      projectId: "project-a",
      agentId: "agent-a",
      branch: "main",
      pathPattern: "src/memory",
    })
    expect(
      sameMemoryNamespace(memory, {
        scope: "agent",
        projectId: "project-a",
        agentId: "agent-a",
        branch: "main",
        pathPattern: "src/memory",
      })
    ).toBe(true)
    expect(
      sameMemoryNamespace(memory, {
        scope: "agent",
        projectId: "project-b",
        agentId: "agent-a",
        branch: "main",
        pathPattern: "src/memory",
      })
    ).toBe(false)
    expect(
      sameMemoryNamespace(memory, {
        scope: "agent",
        projectId: "project-a",
        agentId: "agent-b",
        branch: "main",
        pathPattern: "src/memory",
      })
    ).toBe(false)
  })
})

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

  it("CONFLICT retains the candidate for review without invalidating the existing fact", async () => {
    const target = existing("The user prefers npm", { id: "t1" })
    const deps = makeDeps({
      findSimilar: async () => [target],
      client: {
        complete: jest.fn(async () => JSON.stringify({ op: "CONFLICT", targetId: "t1" })),
      },
    })

    const result = await consolidate(
      { ...baseInput, candidates: [cand("The user prefers pnpm")] },
      deps
    )

    expect(result.applied).toEqual([expect.objectContaining({ op: "CONFLICT", targetId: "t1" })])
    expect(deps.persisted[0]).toMatchObject({
      reviewStatus: "conflict",
      conflictWithIds: ["t1"],
    })
    expect(deps.invalidations).toEqual([])
    expect(deps.conflicts).toEqual([{ targetId: "t1", conflictId: deps.persisted[0].id }])
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

  it("withholds unsafe existing rows from the consolidation LLM", async () => {
    const complete = jest.fn(async () => JSON.stringify({ op: "NOOP" }))
    const deps = makeDeps({
      findSimilar: async () => [existing("Contact alice@example.com", { id: "unsafe" })],
      client: { complete },
    })
    const result = await consolidate(
      { ...baseInput, candidates: [cand("The user uses pnpm")] },
      deps
    )
    expect(complete).not.toHaveBeenCalled()
    expect(result.applied[0].op).toBe("ADD")
  })

  it("does not persist an unsafe candidate or send it to the LLM", async () => {
    const complete = jest.fn(async () => JSON.stringify({ op: "ADD" }))
    const deps = makeDeps({
      findSimilar: async () => [existing("A similar fact")],
      client: { complete },
    })
    const result = await consolidate(
      { ...baseInput, candidates: [cand("Email bob@example.com")] },
      deps
    )
    expect(result.applied).toEqual([])
    expect(deps.persisted).toEqual([])
    expect(complete).not.toHaveBeenCalled()
  })

  it("rejects PII introduced by a consolidation merge", async () => {
    const deps = makeDeps({
      findSimilar: async () => [existing("The user uses pnpm", { id: "t1" })],
      client: {
        complete: jest.fn(async () =>
          JSON.stringify({
            op: "UPDATE",
            targetId: "t1",
            mergedText: "The user uses pnpm; email bob@example.com",
          })
        ),
      },
    })
    await consolidate({ ...baseInput, candidates: [cand("The user uses pnpm v9")] }, deps)
    expect(deps.updates).toEqual([{ id: "t1", text: "The user uses pnpm v9" }])
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

describe("failureMode", () => {
  const neighbour = () => [existing("Prefers pnpm")]

  it("defaults to ADD, keeping personal-memory behavior bit-for-bit", async () => {
    // No `failureMode` at any existing call site, so none of them change.
    const deps = makeDeps({
      findSimilar: async () => neighbour(),
      client: {
        complete: jest.fn(async () => {
          throw new Error("judge down")
        }),
      },
    })
    const { applied } = await consolidate(
      { candidates: [cand("Uses turbo")], scope: "global", provenance: "user" },
      deps
    )
    expect(applied).toEqual([
      expect.objectContaining({
        op: "ADD",
        candidate: expect.objectContaining({ text: "Uses turbo" }),
      }),
    ])
    expect(deps.persistInputs[0]?.trustState).toBeUndefined()
  })

  it("quarantines instead of adding when the judge call fails", async () => {
    const deps = makeDeps({
      findSimilar: async () => neighbour(),
      client: {
        complete: jest.fn(async () => {
          throw new Error("judge down")
        }),
      },
    })
    const { applied } = await consolidate(
      {
        candidates: [cand("Uses turbo")],
        scope: "global",
        provenance: "user",
        failureMode: "quarantine",
      },
      deps
    )
    expect(applied).toEqual([
      expect.objectContaining({ op: "QUARANTINE", reason: "judge_unavailable" }),
    ])
    // Persisted, not dropped: the row stays reviewable in the console while
    // `isMemoryEligibleForRetrieval` keeps it out of every prompt.
    expect(deps.persisted).toHaveLength(1)
    expect(deps.persistInputs[0]).toMatchObject({
      trustState: "quarantined",
      reviewStatus: "unreviewed",
    })
  })

  it("quarantines when the judge returns unparsable JSON", async () => {
    const deps = makeDeps({
      findSimilar: async () => neighbour(),
      client: { complete: jest.fn(async () => "not json at all") },
    })
    const { applied } = await consolidate(
      {
        candidates: [cand("Uses turbo")],
        scope: "global",
        provenance: "user",
        failureMode: "quarantine",
      },
      deps
    )
    expect(applied[0]).toMatchObject({ op: "QUARANTINE", reason: "judge_unavailable" })
  })

  it("quarantines when the judge names a target id that does not exist", async () => {
    const deps = makeDeps({
      findSimilar: async () => neighbour(),
      client: {
        complete: jest.fn(async () => JSON.stringify({ op: "UPDATE", targetId: "ghost" })),
      },
    })
    const { applied } = await consolidate(
      {
        candidates: [cand("Uses turbo")],
        scope: "global",
        provenance: "user",
        failureMode: "quarantine",
      },
      deps
    )
    expect(applied[0]).toMatchObject({ op: "QUARANTINE", reason: "unresolvable_target" })
    expect(deps.updates).toEqual([])
  })

  it("quarantines an unrecognised operation name", async () => {
    const deps = makeDeps({
      findSimilar: async () => neighbour(),
      client: { complete: jest.fn(async () => JSON.stringify({ op: "MERGE_EVERYTHING" })) },
    })
    const { applied } = await consolidate(
      {
        candidates: [cand("Uses turbo")],
        scope: "global",
        provenance: "user",
        failureMode: "quarantine",
      },
      deps
    )
    expect(applied[0]).toMatchObject({ op: "QUARANTINE", reason: "unresolvable_target" })
  })

  it("does NOT quarantine the unambiguous no-neighbour ADD", async () => {
    // Nothing to judge against is not a judge failure — it is a clean insert,
    // and quarantining it would bury every genuinely new fact.
    const deps = makeDeps({ findSimilar: async () => [] })
    const { applied } = await consolidate(
      {
        candidates: [cand("Uses turbo")],
        scope: "global",
        provenance: "user",
        failureMode: "quarantine",
      },
      deps
    )
    expect(applied[0]).toMatchObject({ op: "ADD" })
    expect(deps.client.complete).not.toHaveBeenCalled()
    expect(deps.persistInputs[0]?.trustState).toBeUndefined()
  })

  it("still honours a decidable judgement under quarantine mode", async () => {
    const deps = makeDeps({
      findSimilar: async () => [existing("Prefers pnpm", { id: "keep" })],
      client: { complete: jest.fn(async () => JSON.stringify({ op: "NOOP" })) },
    })
    const { applied } = await consolidate(
      {
        candidates: [cand("Prefers pnpm")],
        scope: "global",
        provenance: "user",
        failureMode: "quarantine",
      },
      deps
    )
    expect(applied).toEqual([{ op: "NOOP" }])
    expect(deps.persisted).toEqual([])
  })
})

describe("project claim attributes", () => {
  const claim = {
    projectMemoryKind: "constraint" as const,
    observedAt: 1_600_000_000_000,
    observedAtMessageId: "m2",
    confidence: 0.8,
    scopeRationale: "only in this repo",
    extractor: { provider: "anthropic", model: "haiku", promptVersion: "project-v1" },
    evidenceHash: "abc_3",
    sourceRevision: "7",
    evidence: [{ kind: "message" as const, sourceId: "m2" }],
  }

  it("forwards the claim vocabulary onto the persisted row", async () => {
    const deps = makeDeps({ findSimilar: async () => [] })
    await consolidate(
      {
        candidates: [{ ...cand("Rust is pinned to 1.77.2"), projectClaim: claim }],
        scope: "workspace",
        projectId: "p1",
        provenance: "user",
      },
      deps
    )
    expect(deps.persistInputs[0]).toMatchObject({
      projectMemoryKind: "constraint",
      observedAt: 1_600_000_000_000,
      confidence: 0.8,
      scopeRationale: "only in this repo",
      extractor: { promptVersion: "project-v1" },
      evidenceHash: "abc_3",
      sourceRevision: "7",
    })
  })

  it("does not persist the caller's evidence bookkeeping as row columns", async () => {
    // Evidence rows can only be written once `persist` has produced an id, so
    // the refs ride on the candidate and are the CALLER's job — writing them
    // here would produce rows pointing at a memory that does not exist yet.
    const deps = makeDeps({ findSimilar: async () => [] })
    await consolidate(
      {
        candidates: [{ ...cand("x"), projectClaim: claim }],
        scope: "workspace",
        projectId: "p1",
        provenance: "user",
      },
      deps
    )
    expect(deps.persistInputs[0]).not.toHaveProperty("evidence")
    expect(deps.persistInputs[0]).not.toHaveProperty("observedAtMessageId")
  })

  it("leaves a personal candidate's row untouched", async () => {
    // The partition contract is "absent means personal". A plain candidate must
    // not acquire a `projectMemoryKind` key at all, not even an undefined one —
    // that column is indexed and its presence is what splits the two corpora.
    const deps = makeDeps({ findSimilar: async () => [] })
    await consolidate(
      { candidates: [cand("I prefer dark mode")], scope: "global", provenance: "user" },
      deps
    )
    expect(deps.persistInputs[0]).not.toHaveProperty("projectMemoryKind")
  })

  it("carries the claim through a quarantine, so the caller can still bind evidence", async () => {
    const deps = makeDeps({
      findSimilar: async () => [existing("Rust is pinned")],
      client: {
        complete: async () => {
          throw new Error("judge down")
        },
      },
    })
    const { applied } = await consolidate(
      {
        candidates: [{ ...cand("Rust is pinned to 1.77.2"), projectClaim: claim }],
        scope: "workspace",
        projectId: "p1",
        provenance: "user",
        failureMode: "quarantine",
      },
      deps
    )
    expect(applied[0]!.op).toBe("QUARANTINE")
    expect(
      applied[0]!.op === "QUARANTINE" ? applied[0]!.candidate.projectClaim?.evidence : undefined
    ).toEqual([{ kind: "message", sourceId: "m2" }])
  })
})

describe("consolidation op projections", () => {
  const memory = existing("x", { id: "m1" })
  const candidate = cand("x")

  it.each<[ConsolidationOp, string | undefined]>([
    [{ op: "ADD", memory, candidate }, "m1"],
    [{ op: "CONFLICT", memory, targetId: "t1", candidate }, "m1"],
    [{ op: "QUARANTINE", memory, candidate, reason: "judge_unavailable" }, "m1"],
    [{ op: "UPDATE", targetId: "t1" }, "t1"],
    [{ op: "DELETE", targetId: "t1" }, undefined],
    [{ op: "NOOP" }, undefined],
  ])("maps %p to memory id %p", (op, expected) => {
    expect(consolidationOpMemoryId(op)).toBe(expected)
  })

  it.each<[ConsolidationOp, string | undefined]>([
    [{ op: "ADD", memory, candidate }, "created"],
    // A quarantined row was CREATED, not revised — the old copy-pasted ternary
    // fell through to "revised" for any arm it did not name.
    [{ op: "QUARANTINE", memory, candidate, reason: "judge_unavailable" }, "created"],
    [{ op: "CONFLICT", memory, targetId: "t1", candidate }, "conflict"],
    [{ op: "UPDATE", targetId: "t1" }, "revised"],
    [{ op: "DELETE", targetId: "t1" }, undefined],
    [{ op: "NOOP" }, undefined],
  ])("maps %p to audit action %p", (op, expected) => {
    expect(consolidationAuditAction(op)).toBe(expected)
  })
})
