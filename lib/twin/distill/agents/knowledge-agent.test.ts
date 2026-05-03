import { runKnowledgeAgent } from "./knowledge-agent"
import type { LlmClient } from "../llm"
import type { TwinChunk } from "@/types/twin"

function makeChunk(id: string, content: string): TwinChunk {
  return {
    id,
    twinId: "twin_alice",
    sourceId: "src_1",
    content,
    contentRedacted: content,
    charStart: 0,
    charEnd: content.length,
    vectorBackend: "qdrant",
    vectorCollection: "c",
    vectorDocId: `vec_${id}`,
    strategy: "paragraph",
    tokenCount: 10,
    metadata: {},
    createdAt: 1,
  }
}

function mockLlm(response: string): LlmClient {
  return { complete: jest.fn(async () => response) }
}

describe("runKnowledgeAgent", () => {
  it("short-circuits with no chunks", async () => {
    const llm = mockLlm("{}")
    const result = await runKnowledgeAgent(llm, { chunks: [] })
    expect(result).toEqual({ entities: [], perChunk: {} })
    expect(llm.complete).not.toHaveBeenCalled()
  })

  it("preserves valid roles and falls back to 'concept' for unknown roles", async () => {
    const chunks = [makeChunk("c1", "alice mentions x")]
    const llm = mockLlm(`{
      "entities": [
        {"name": "Alice", "role": "person", "firstSeenChunkId": "c1"},
        {"name": "WeirdThing", "role": "alien", "firstSeenChunkId": "c1"},
        {"name": "X", "role": "team", "firstSeenChunkId": "c1"},
        {"name": "Y", "role": "project", "firstSeenChunkId": "c1"},
        {"name": "Z", "role": "system", "firstSeenChunkId": "c1"}
      ],
      "perChunk": []
    }`)
    const result = await runKnowledgeAgent(llm, { chunks })
    const byName = Object.fromEntries(result.entities.map((e) => [e.name, e]))
    expect(byName["Alice"].role).toBe("person")
    expect(byName["WeirdThing"].role).toBe("concept")
    expect(byName["X"].role).toBe("team")
    expect(byName["Y"].role).toBe("project")
    expect(byName["Z"].role).toBe("system")
  })

  it("falls back firstSeenChunkId to chunks[0].id when the supplied id is unknown", async () => {
    const chunks = [makeChunk("c1", "x"), makeChunk("c2", "y")]
    const llm = mockLlm(`{
      "entities": [
        {"name": "Alpha", "role": "concept", "firstSeenChunkId": "ghost"},
        {"name": "Beta", "role": "concept"}
      ]
    }`)
    const result = await runKnowledgeAgent(llm, { chunks })
    expect(result.entities[0].firstSeenChunkId).toBe("c1")
    expect(result.entities[1].firstSeenChunkId).toBe("c1")
  })

  it("drops entities with no name and trims whitespace", async () => {
    const chunks = [makeChunk("c1", "x")]
    const llm = mockLlm(`{
      "entities": [
        {"name": "  Bob  ", "role": "person", "firstSeenChunkId": "c1"},
        {"role": "person", "firstSeenChunkId": "c1"}
      ]
    }`)
    const result = await runKnowledgeAgent(llm, { chunks })
    expect(result.entities).toHaveLength(1)
    expect(result.entities[0].name).toBe("Bob")
  })

  it("filters non-string aliases and propagates trimmed relation", async () => {
    const chunks = [makeChunk("c1", "x")]
    const llm = mockLlm(`{
      "entities": [
        {
          "name": "Project Phoenix",
          "aliases": ["Phoenix", 42, null, "phx"],
          "relation": "  drives revenue  ",
          "role": "project",
          "firstSeenChunkId": "c1"
        }
      ]
    }`)
    const result = await runKnowledgeAgent(llm, { chunks })
    expect(result.entities[0].aliases).toEqual(["Phoenix", "phx"])
    expect(result.entities[0].relation).toBe("drives revenue")
  })

  it("strips perChunk rows whose chunkId isn't in the input batch", async () => {
    const chunks = [makeChunk("c1", "x"), makeChunk("c2", "y")]
    const llm = mockLlm(`{
      "entities": [],
      "perChunk": [
        {"chunkId": "c1", "entityNames": ["A", "B"]},
        {"chunkId": "ghost", "entityNames": ["C"]},
        {"chunkId": "c2", "entityNames": []}
      ]
    }`)
    const result = await runKnowledgeAgent(llm, { chunks })
    expect(result.perChunk).toEqual({ c1: ["A", "B"] })
    // c2 has empty entityNames → omitted (line 95 filter).
    expect(result.perChunk["c2"]).toBeUndefined()
    expect(result.perChunk["ghost"]).toBeUndefined()
  })

  it("filters non-string entityNames out of perChunk", async () => {
    const chunks = [makeChunk("c1", "x")]
    const llm = mockLlm(`{
      "entities": [],
      "perChunk": [{"chunkId": "c1", "entityNames": ["A", 1, null, "B"]}]
    }`)
    const result = await runKnowledgeAgent(llm, { chunks })
    expect(result.perChunk).toEqual({ c1: ["A", "B"] })
  })

  it("respects the maxChunks cap (default 100, custom override)", async () => {
    const chunks = Array.from({ length: 250 }, (_, i) => makeChunk(`c${i}`, `body ${i}`))
    const completeMock = jest.fn(async (_prompt: string) => `{"entities": [], "perChunk": []}`)
    await runKnowledgeAgent({ complete: completeMock }, { chunks })
    const promptArg = completeMock.mock.calls[0]?.[0] ?? ""
    // Default cap = 100 → c99 included, c100 not.
    expect(promptArg).toContain("[c99]")
    expect(promptArg).not.toContain("[c100]")

    completeMock.mockClear()
    await runKnowledgeAgent({ complete: completeMock }, { chunks, maxChunks: 5 })
    const promptArg2 = completeMock.mock.calls[0]?.[0] ?? ""
    expect(promptArg2).toContain("[c4]")
    expect(promptArg2).not.toContain("[c5]")
  })

  it("treats a non-array `entities` or `perChunk` as empty", async () => {
    const chunks = [makeChunk("c1", "x")]
    const llm = mockLlm(`{"entities": "oops", "perChunk": "also oops"}`)
    const result = await runKnowledgeAgent(llm, { chunks })
    expect(result.entities).toEqual([])
    expect(result.perChunk).toEqual({})
  })

  it("handles an empty `aliases` field as []", async () => {
    const chunks = [makeChunk("c1", "x")]
    const llm = mockLlm(`{
      "entities": [{"name": "Solo", "role": "concept", "firstSeenChunkId": "c1"}]
    }`)
    const result = await runKnowledgeAgent(llm, { chunks })
    expect(result.entities[0].aliases).toEqual([])
    expect(result.entities[0].relation).toBeUndefined()
  })
})
