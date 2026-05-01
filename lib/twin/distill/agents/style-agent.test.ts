import { runStyleAgent } from "./style-agent"
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
    vectorCollection: "cognia_twin_alice",
    vectorDocId: `vec_${id}`,
    strategy: "paragraph",
    tokenCount: content.length / 4,
    metadata: {},
    createdAt: 1,
  }
}

function mockLlm(response: string): LlmClient {
  return { complete: jest.fn(async () => response) }
}

describe("runStyleAgent", () => {
  it("returns no samples for an empty chunk pool", async () => {
    const llm = mockLlm("{}")
    const result = await runStyleAgent(llm, { chunks: [] })
    expect(result.samples).toEqual([])
  })

  it("parses the LLM JSON envelope and stamps ids + sourceChunkId", async () => {
    const chunks = [
      makeChunk("c1", "Sorry, but we can't accommodate this request right now."),
      makeChunk("c2", "Hey team — quick PR description for the cache cleanup work."),
    ]
    const llm = mockLlm(`{
      "samples": [
        {
          "contextLabel": "rejection-email",
          "original": "Sorry, but we can't accommodate this request right now.",
          "summary": "polite rejection",
          "tone": ["professional", "concise"]
        },
        {
          "contextLabel": "pr-description",
          "original": "Hey team — quick PR description for the cache cleanup work.",
          "summary": "casual PR description",
          "tone": ["casual"]
        }
      ]
    }`)

    const result = await runStyleAgent(llm, { chunks })

    expect(result.samples).toHaveLength(2)
    expect(result.samples[0].id).toMatch(/^ss_/)
    expect(result.samples[0].sourceChunkId).toBe("c1")
    expect(result.samples[1].sourceChunkId).toBe("c2")
    expect(result.samples[0].tone).toEqual(["professional", "concise"])
    expect(result.samples[0].addedBy).toBe("distill")
  })

  it("falls back to first chunk when no original-text overlap is found", async () => {
    const chunks = [makeChunk("c1", "Some other unrelated content")]
    const llm = mockLlm(
      `{"samples": [{"contextLabel": "x", "original": "completely different text", "summary": "stub", "tone": []}]}`
    )
    const result = await runStyleAgent(llm, { chunks })
    expect(result.samples[0].sourceChunkId).toBe("c1")
  })

  it("tolerates missing `samples` field in the response", async () => {
    const chunks = [makeChunk("c1", "ignored")]
    const llm = mockLlm("{}")
    const result = await runStyleAgent(llm, { chunks })
    expect(result.samples).toEqual([])
  })

  it("respects the maxChunks cap", async () => {
    const chunks = Array.from({ length: 100 }, (_, i) => makeChunk(`c${i}`, `body ${i}`))
    const completeMock = jest.fn(async () => `{"samples": []}`)
    await runStyleAgent({ complete: completeMock }, { chunks, maxChunks: 5 })
    const promptArg = completeMock.mock.calls[0][0]
    // The prompt should only contain the first 5 chunk ids.
    expect(promptArg).toContain("[c0]")
    expect(promptArg).toContain("[c4]")
    expect(promptArg).not.toContain("[c5]")
  })
})
