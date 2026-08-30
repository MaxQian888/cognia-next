import { recallAboutUser } from "./recall"
import type { MemoryRetrieverDeps } from "@/lib/memory/retrieve/retriever"
import type { Memory } from "@/types/memory/memory"

function memory(id: string, text: string): Memory {
  return {
    id,
    scope: "global",
    type: "semantic",
    text,
    tags: [],
    importance: 5,
    createdAt: 1,
    updatedAt: 1,
    lastAccessedAt: 1,
    accessCount: 0,
    version: 1,
    status: "active",
    pinned: false,
    provenance: "user",
  } as unknown as Memory
}

function deps(candidates: Memory[]): MemoryRetrieverDeps {
  return {
    loadCandidates: async () => candidates,
  }
}

describe("recallAboutUser", () => {
  it("returns top facts as dash lines", async () => {
    const text = await recallAboutUser(deps([memory("m1", "Drinks matcha every morning")]), {
      queryText: "matcha morning drink",
    })
    expect(text).toBe("- Drinks matcha every morning")
  })

  it("never surfaces a mined project claim as something the user shared", async () => {
    // The pet renders this straight into its prompt as knowledge ABOUT the
    // user. A claim about the repository reaching that line would read as if
    // the user had told the pet about their build system. Deleting the
    // `claimFilter` in `recall.ts` makes this test fail.
    const claim = {
      ...memory("m2", "The repo pins Rust to 1.77.2"),
      projectMemoryKind: "constraint",
    } as Memory
    const text = await recallAboutUser(deps([memory("m1", "Drinks matcha every morning"), claim]), {
      queryText: "repo rust pins matcha",
      relevanceFloor: 0,
    })
    expect(text).toBe("- Drinks matcha every morning")
  })

  it("returns '' when deps are missing, query empty, or nothing matches", async () => {
    expect(await recallAboutUser(undefined, { queryText: "x" })).toBe("")
    expect(await recallAboutUser(deps([memory("m1", "a")]), { queryText: "   " })).toBe("")
    expect(await recallAboutUser(deps([]), { queryText: "anything at all" })).toBe("")
  })

  it("accepts a recency half-life without changing single-hit recall", async () => {
    const text = await recallAboutUser(deps([memory("m1", "Drinks matcha every morning")]), {
      queryText: "matcha morning drink",
      recencyHalfLifeDays: 12,
    })
    expect(text).toBe("- Drinks matcha every morning")
  })

  it("swallows retriever failures", async () => {
    const broken: MemoryRetrieverDeps = {
      loadCandidates: async () => {
        throw new Error("boom")
      },
    }
    expect(await recallAboutUser(broken, { queryText: "hello" })).toBe("")
  })
})
