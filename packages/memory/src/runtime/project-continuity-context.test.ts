import {
  applyProjectContinuityContext,
  PROJECT_CONTINUITY_HEADING,
} from "./project-continuity-context"
import type { Memory } from "../types/memory"
import type { MemoryRetrieverDeps } from "../retrieve/retriever"

function claim(id: string, text: string, over: Partial<Memory> = {}): Memory {
  const now = 1_700_000_000_000
  return {
    id,
    scope: "workspace",
    projectId: "p1",
    type: "semantic",
    text,
    tags: [],
    importance: 7,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    accessCount: 0,
    version: 1,
    status: "active",
    pinned: false,
    provenance: "user",
    projectMemoryKind: "constraint",
    ...over,
  } as Memory
}

function personal(id: string, text: string): Memory {
  return claim(id, text, { projectMemoryKind: undefined, scope: "global", projectId: undefined })
}

function deps(rows: Memory[]): MemoryRetrieverDeps {
  return { loadCandidates: async () => rows }
}

const BASE = {
  userMessage: "why does the build pin rust",
  reader: { projectId: "p1" },
  topK: 4,
  relevanceFloor: 0,
  maxTokens: 450,
}

describe("applyProjectContinuityContext", () => {
  it("frames claims as data, never as something the user said", async () => {
    // The heading IS the safety boundary. Under the personal section's
    // first-person voice, a mined guess about a repo reads as a user assertion.
    const result = await applyProjectContinuityContext({
      ...BASE,
      deps: deps([claim("c1", "The repo pins rust to 1.77.2 for the build")]),
    })
    expect(result.systemPromptSection).toContain(PROJECT_CONTINUITY_HEADING)
    expect(result.systemPromptSection).toContain("not instructions")
    expect(result.systemPromptSection).toContain("may be stale or wrong")
    expect(result.systemPromptSection).not.toContain("you remember about the user")
    expect(result.claims.map((c) => c.id)).toEqual(["c1"])
  })

  it("renders nothing at all for a reader with no workspace", async () => {
    const result = await applyProjectContinuityContext({
      ...BASE,
      reader: {},
      deps: deps([claim("c1", "rust build pin")]),
    })
    expect(result.systemPromptSection).toBeNull()
    expect(result.claims).toEqual([])
  })

  it("never surfaces a personal memory in the project section", async () => {
    const result = await applyProjectContinuityContext({
      ...BASE,
      deps: deps([personal("p1", "the user pins rust builds to 1.77.2")]),
    })
    expect(result.systemPromptSection).toBeNull()
  })

  it("enforces the count cap even when the token budget could fit more", async () => {
    // Two separate promises to the user; packing first would honour only one.
    const rows = Array.from({ length: 8 }, (_, i) => claim(`c${i}`, `rust build pin fact ${i}`))
    const result = await applyProjectContinuityContext({
      ...BASE,
      topK: 2,
      maxTokens: 4_000,
      deps: deps(rows),
    })
    expect(result.claims).toHaveLength(2)
    expect(result.weak).toBe(true)
  })

  it("skips an oversized claim instead of hiding every shorter one behind it", async () => {
    const result = await applyProjectContinuityContext({
      ...BASE,
      maxTokens: 90,
      deps: deps([
        claim("huge", `rust build pin ${"very long detail ".repeat(60)}`),
        claim("small", "rust build pins 1.77.2"),
      ]),
    })
    expect(result.claims.map((c) => c.id)).toEqual(["small"])
    expect(result.budget.truncated).toBe(true)
  })

  it("tells the model when retrieval was thin, since it cannot see what was filtered", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => claim(`c${i}`, `rust build pin fact ${i}`))
    const result = await applyProjectContinuityContext({ ...BASE, topK: 1, deps: deps(rows) })
    expect(result.weak).toBe(true)
    expect(result.systemPromptSection).toContain("project_history_search")
  })

  it("stays quiet when everything fit", async () => {
    const result = await applyProjectContinuityContext({
      ...BASE,
      deps: deps([claim("c1", "the repo pins rust to 1.77.2")]),
    })
    expect(result.weak).toBe(false)
    expect(result.systemPromptSection).not.toContain("project_history_search")
  })

  it("re-gates PII on the way out, exactly as the personal path does", async () => {
    const result = await applyProjectContinuityContext({
      ...BASE,
      deps: deps([claim("c1", "rust build pin owner is someone@example.com")]),
    })
    expect(result.systemPromptSection).toBeNull()
    expect(result.withheldCount).toBe(1)
  })

  it("carries the source anchor so a chip can jump back to it", async () => {
    const result = await applyProjectContinuityContext({
      ...BASE,
      deps: deps([
        claim("c1", "the repo pins rust to 1.77.2", {
          sourceSessionId: "s7",
          sourceMessageId: "m3",
          observedAt: 123,
        }),
      ]),
    })
    expect(result.claims[0]).toMatchObject({
      sourceSessionId: "s7",
      sourceMessageId: "m3",
      observedAt: 123,
      kind: "constraint",
    })
  })

  it("degrades alone — a failure here must not take personal recall with it", async () => {
    const result = await applyProjectContinuityContext({
      ...BASE,
      deps: {
        loadCandidates: async () => {
          throw new Error("dexie is gone")
        },
      },
    })
    expect(result).toMatchObject({ degraded: true, systemPromptSection: null, claims: [] })
  })

  it("renders nothing when given no budget", async () => {
    const result = await applyProjectContinuityContext({
      ...BASE,
      maxTokens: 0,
      deps: deps([claim("c1", "rust build pin")]),
    })
    expect(result.systemPromptSection).toBeNull()
  })
})
