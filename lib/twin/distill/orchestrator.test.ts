/**
 * End-to-end coverage for the distill orchestrator. Uses a single mocked
 * `LlmClient` whose `complete` is queued with five canned responses (one
 * per agent, in pipeline order).
 */

import { runOrchestrator, SynthesizerError } from "./orchestrator"
import type { LlmClient } from "./llm"
import type { TwinChunk, TwinProfile } from "@/types/twin"

function makeChunk(id: string, content = "lorem ipsum"): TwinChunk {
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
    tokenCount: 5,
    metadata: {},
    createdAt: 1,
  }
}

function emptyProfile(): TwinProfile {
  return {
    id: "twin_alice",
    twinId: "twin_alice",
    styleSamples: [],
    playbooks: [],
    entities: [],
    decisions: [],
    voiceSummary: "",
    updatedAt: 1,
  }
}

function queuedLlm(responses: string[]): LlmClient {
  let i = 0
  return {
    complete: jest.fn(async () => {
      if (i >= responses.length) {
        throw new Error(`mockLlm: out of responses at call ${i + 1}`)
      }
      return responses[i++]
    }),
  }
}

describe("runOrchestrator", () => {
  it("threads the five agents and returns a merged result", async () => {
    const chunks = [
      makeChunk("c1", "Sorry, can't do that."),
      makeChunk("c2", "Triage step one."),
      makeChunk("c3", "Triage step two."),
      makeChunk("c4", "Triage step three."),
    ]
    const llm = queuedLlm([
      // Knowledge response (one batch of 4 chunks → 1 call)
      `{
        "entities": [
          { "name": "ProjectX", "aliases": ["px"], "role": "project", "firstSeenChunkId": "c2" }
        ],
        "perChunk": [
          { "chunkId": "c2", "entityNames": ["ProjectX"] }
        ]
      }`,
      // Style response
      `{
        "samples": [
          { "contextLabel": "rejection", "original": "Sorry, can't do that.", "summary": "polite rejection", "tone": ["concise"] }
        ]
      }`,
      // Playbook response
      `{
        "playbooks": [
          { "title": "Triage", "trigger": "outage", "steps": [{"order":1,"action":"Ack"}], "examples": [], "confidence": 0.8 }
        ]
      }`,
      // Synthesizer response
      `{
        "character": {
          "name": "Twin Alice",
          "description": "alice",
          "systemPrompt": "You are Alice.",
          "voiceSummary": "Concise."
        },
        "skills": [
          { "name": "Triage P1", "description": "outage triage", "content": "## Steps\\n1. Ack", "rationale": "from playbook" }
        ]
      }`,
      // Evaluator response (placeholder draft ids tmp_0 / tmp_1)
      `{
        "evaluations": [
          { "draftId": "tmp_0", "qualityScore": 0.8, "concerns": [], "suggestions": ["add examples"] },
          { "draftId": "tmp_1", "qualityScore": 0.6, "concerns": ["thin"], "suggestions": [] }
        ]
      }`,
    ])

    const phases: string[] = []
    const result = await runOrchestrator({
      llm,
      profile: emptyProfile(),
      chunks,
      onProgress: (phase) => {
        phases.push(phase)
      },
    })

    // Phase callbacks were invoked in pipeline order.
    expect(phases).toContain("knowledge-agent")
    expect(phases).toContain("style-agent")
    expect(phases).toContain("playbook-agent")
    expect(phases).toContain("synthesizer")
    expect(phases).toContain("evaluator")

    expect(result.styleSamples).toHaveLength(1)
    expect(result.playbooks).toHaveLength(1)
    expect(result.entities).toHaveLength(1)
    expect(result.entities[0].name).toBe("ProjectX")
    expect(result.chunkEntityTags["c2"]).toEqual(["ProjectX"])
    expect(result.synthesizedDrafts).toHaveLength(2)
    expect(result.evaluations["tmp_0"].qualityScore).toBe(0.8)
    expect(result.voiceSummary).toBe("Concise.")
  })

  it("returns empty output when chunk pool is empty", async () => {
    // Knowledge / style / playbook short-circuit before calling the LLM,
    // so only the synthesizer + evaluator calls are needed.
    const llm = queuedLlm([
      // Synthesizer
      `{ "character": null, "skills": [] }`,
      // Evaluator (no drafts → short-circuit; we still queue an empty resp
      // for safety in case the agent is ever changed to call when empty).
      `{ "evaluations": [] }`,
    ])
    const result = await runOrchestrator({
      llm,
      profile: emptyProfile(),
      chunks: [],
    })
    expect(result.styleSamples).toEqual([])
    expect(result.playbooks).toEqual([])
    expect(result.entities).toEqual([])
    expect(result.synthesizedDrafts).toEqual([])
  })

  it("dedupes entities by lowercase name across knowledge batches", async () => {
    const chunks = Array.from({ length: 250 }, (_, i) => makeChunk(`c${i}`))
    const llm = queuedLlm([
      // First knowledge batch (100 chunks)
      `{ "entities": [{"name": "Alice", "aliases": [], "role": "person", "firstSeenChunkId": "c0"}], "perChunk": [] }`,
      // Second knowledge batch (100 chunks)
      `{ "entities": [{"name": "alice", "aliases": ["alice@x.com"], "role": "person", "firstSeenChunkId": "c100"}], "perChunk": [] }`,
      // Third knowledge batch (50 chunks)
      `{ "entities": [{"name": "ALICE", "aliases": ["小爱"], "role": "person", "firstSeenChunkId": "c200"}], "perChunk": [] }`,
      // Style / playbook / synth / eval
      `{ "samples": [] }`,
      `{ "playbooks": [] }`,
      `{ "character": null, "skills": [] }`,
      `{ "evaluations": [] }`,
    ])
    const result = await runOrchestrator({ llm, profile: emptyProfile(), chunks })
    expect(result.entities).toHaveLength(1)
    expect(result.entities[0].aliases.sort()).toEqual(["alice@x.com", "小爱"].sort())
  })

  it("keeps same-name entities with different roles distinct (T2.5)", async () => {
    const chunks = [makeChunk("c1"), makeChunk("c2"), makeChunk("c3"), makeChunk("c4")]
    const llm = queuedLlm([
      `{ "entities": [
          {"name":"Phoenix","aliases":[],"role":"person","firstSeenChunkId":"c1"},
          {"name":"Phoenix","aliases":[],"role":"project","firstSeenChunkId":"c2"}
        ], "perChunk": [] }`,
      `{ "samples": [] }`,
      `{ "playbooks": [] }`,
      `{ "character": null, "skills": [] }`,
      `{ "evaluations": [] }`,
    ])
    const result = await runOrchestrator({ llm, profile: emptyProfile(), chunks })
    const phoenixes = result.entities.filter((e) => e.name === "Phoenix")
    expect(phoenixes).toHaveLength(2)
    expect(phoenixes.map((e) => e.role).sort()).toEqual(["person", "project"])
  })

  it("throws SynthesizerError when the synthesizer output is unparseable (T2.1)", async () => {
    // 4 chunks → exactly one call per agent in pipeline order (knowledge,
    // style, playbook, synthesizer); the synth call gets unparseable output.
    const chunks = [makeChunk("c1"), makeChunk("c2"), makeChunk("c3"), makeChunk("c4")]
    const llm = queuedLlm([
      `{ "entities": [], "perChunk": [] }`, // knowledge
      `{ "samples": [] }`, // style
      `{ "playbooks": [] }`, // playbook
      `the provider returned prose, not JSON`, // synthesizer → parse throws
    ])
    await expect(runOrchestrator({ llm, profile: emptyProfile(), chunks })).rejects.toThrow(
      SynthesizerError
    )
  })

  it("throws SynthesizerError (not hang) when the synthesizer times out (T2.1)", async () => {
    const chunks = [makeChunk("c1"), makeChunk("c2"), makeChunk("c3"), makeChunk("c4")]
    let call = 0
    const fast = [`{ "entities": [], "perChunk": [] }`, `{ "samples": [] }`, `{ "playbooks": [] }`]
    const llm: LlmClient = {
      complete: jest.fn(async () => {
        if (call < fast.length) return fast[call++]
        // The 4th call is the synthesizer — hang forever so the deadline fires.
        return new Promise<string>(() => {})
      }),
    }
    await expect(
      runOrchestrator({ llm, profile: emptyProfile(), chunks, agentTimeoutMs: 40 })
    ).rejects.toThrow(SynthesizerError)
  })
})
