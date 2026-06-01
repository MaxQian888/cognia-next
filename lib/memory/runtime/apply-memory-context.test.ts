import type { Memory } from "@/types/memory/memory"
import { applyMemoryContext, type ApplyMemoryContextDeps } from "./apply-memory-context"

let seq = 0
function mem(text: string, over: Partial<Memory> = {}): Memory {
  seq += 1
  const now = 1_700_000_000_000
  return {
    id: over.id ?? `m${seq}`,
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

function deps(over: Partial<ApplyMemoryContextDeps> = {}): ApplyMemoryContextDeps {
  return {
    loadCandidates: async () => [],
    loadProcedural: async () => [],
    ...over,
  }
}

const base = { topK: 5, relevanceFloor: 0 }

describe("applyMemoryContext", () => {
  it("returns null section when nothing is recalled or procedural", async () => {
    const res = await applyMemoryContext({ userMessage: "hi", ...base, deps: deps() })
    expect(res.systemPromptSection).toBeNull()
    expect(res.retrievedMemories).toEqual([])
    expect(res.proceduralCount).toBe(0)
    expect(res.degraded).toBe(false)
  })

  it("injects a recall section for semantic/episodic hits", async () => {
    const res = await applyMemoryContext({
      userMessage: "pnpm",
      ...base,
      deps: deps({ loadCandidates: async () => [mem("The user prefers pnpm", { id: "hit" })] }),
    })
    expect(res.systemPromptSection).toContain("## What you remember about the user")
    expect(res.systemPromptSection).toContain("- The user prefers pnpm")
    expect(res.retrievedMemories.map((m) => m.id)).toEqual(["hit"])
  })

  it("only recalls semantic/episodic (procedural goes to its own block)", async () => {
    const res = await applyMemoryContext({
      userMessage: "pnpm",
      ...base,
      deps: deps({
        loadCandidates: async () => [
          mem("pnpm semantic", { id: "s", type: "semantic" }),
          mem("pnpm procedural", { id: "p", type: "procedural" }),
        ],
        loadProcedural: async () => [mem("Always use pnpm", { id: "p", type: "procedural" })],
      }),
    })
    expect(res.retrievedMemories.map((m) => m.id)).not.toContain("p")
    expect(res.systemPromptSection).toContain("Working preferences you've learned")
    expect(res.proceduralCount).toBe(1)
  })

  it("appends the procedural block alongside recall", async () => {
    const res = await applyMemoryContext({
      userMessage: "pnpm",
      ...base,
      deps: deps({
        loadCandidates: async () => [mem("pnpm fact", { id: "s" })],
        loadProcedural: async () => [mem("Reply in Chinese", { type: "procedural" })],
      }),
    })
    expect(res.systemPromptSection).toContain("## What you remember about the user")
    expect(res.systemPromptSection).toContain("## Working preferences you've learned")
    expect(res.systemPromptSection).toContain("- Reply in Chinese")
  })

  it("dedupes recalled memories that overlap a Twin chunk", async () => {
    const res = await applyMemoryContext({
      userMessage: "shanghai",
      ...base,
      twinChunkTexts: ["The user lives in Shanghai and works in tech"],
      deps: deps({
        loadCandidates: async () => [mem("lives in Shanghai", { id: "dup" })],
      }),
    })
    expect(res.retrievedMemories).toEqual([])
    expect(res.systemPromptSection).toBeNull()
  })

  it("skips retrieval when the message is blank but still emits procedural", async () => {
    const res = await applyMemoryContext({
      userMessage: "   ",
      ...base,
      deps: deps({
        loadCandidates: async () => [mem("should not be retrieved")],
        loadProcedural: async () => [mem("Reply in Chinese", { type: "procedural" })],
      }),
    })
    expect(res.retrievedMemories).toEqual([])
    expect(res.systemPromptSection).toContain("## Working preferences you've learned")
  })

  it("degrades (degraded=true, empty) when a dep throws", async () => {
    const res = await applyMemoryContext({
      userMessage: "pnpm",
      ...base,
      deps: deps({
        loadProcedural: async () => {
          throw new Error("db down")
        },
      }),
    })
    expect(res.degraded).toBe(true)
    expect(res.systemPromptSection).toBeNull()
  })
})
