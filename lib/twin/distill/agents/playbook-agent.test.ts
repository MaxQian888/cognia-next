import { runPlaybookAgent } from "./playbook-agent"
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

describe("runPlaybookAgent", () => {
  it("returns no playbooks when fewer than 3 chunks are supplied", async () => {
    const llm = mockLlm(`{"playbooks": []}`)
    const result = await runPlaybookAgent(llm, {
      chunks: [makeChunk("c1", "x"), makeChunk("c2", "y")],
    })
    expect(result.playbooks).toEqual([])
  })

  it("normalises steps from raw strings + objects, drops invalid steps", async () => {
    const chunks = [makeChunk("c1", "x"), makeChunk("c2", "y"), makeChunk("c3", "z")]
    const llm = mockLlm(`{
      "playbooks": [
        {
          "title": "Triage",
          "trigger": "Outage reported",
          "steps": [
            "Acknowledge",
            { "order": 2, "action": "Page oncall", "rationale": "fast response" },
            { "action": "" },
            null
          ],
          "examples": [{"sourceChunkIds": ["c1"], "outcome": "resolved"}],
          "confidence": 0.8
        }
      ]
    }`)
    const result = await runPlaybookAgent(llm, { chunks })
    expect(result.playbooks).toHaveLength(1)
    const pb = result.playbooks[0]
    expect(pb.steps).toHaveLength(2)
    expect(pb.steps[0].action).toBe("Acknowledge")
    expect(pb.steps[1].rationale).toBe("fast response")
  })

  it("filters playbooks below the confidence floor", async () => {
    const chunks = [makeChunk("c1", "x"), makeChunk("c2", "y"), makeChunk("c3", "z")]
    const llm = mockLlm(`{
      "playbooks": [
        { "title": "Strong", "trigger": "...", "steps": [{"order":1,"action":"a"}], "examples": [], "confidence": 0.9 },
        { "title": "Weak",   "trigger": "...", "steps": [{"order":1,"action":"a"}], "examples": [], "confidence": 0.3 }
      ]
    }`)
    const result = await runPlaybookAgent(llm, { chunks, minConfidence: 0.5 })
    expect(result.playbooks.map((p) => p.title)).toEqual(["Strong"])
  })

  it("clamps confidence into [0, 1]", async () => {
    const chunks = [makeChunk("c1", "x"), makeChunk("c2", "y"), makeChunk("c3", "z")]
    const llm = mockLlm(`{
      "playbooks": [
        { "title": "Wild", "trigger": "...", "steps": [{"order":1,"action":"a"}], "examples": [], "confidence": 1.5 }
      ]
    }`)
    const result = await runPlaybookAgent(llm, { chunks, minConfidence: 0 })
    expect(result.playbooks[0].confidence).toBe(1)
  })
})
