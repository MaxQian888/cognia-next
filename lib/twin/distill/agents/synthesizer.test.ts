import { runSynthesizer } from "./synthesizer"
import type { LlmClient } from "../llm"
import type { Playbook, ProfileEntity, StyleSample, TwinChunk, TwinProfile } from "@/types/twin"

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

function makeProfile(overrides: Partial<TwinProfile> = {}): TwinProfile {
  return {
    id: "twin_alice",
    twinId: "twin_alice",
    styleSamples: [],
    playbooks: [],
    entities: [],
    decisions: [],
    voiceSummary: "",
    updatedAt: 1,
    ...overrides,
  }
}

function styleSample(label: string, summary: string): StyleSample {
  return {
    id: `ss_${label}`,
    contextLabel: label,
    original: "verbatim",
    summary,
    sourceChunkId: "c1",
    tone: ["professional"],
    addedAt: 1,
    addedBy: "distill",
  }
}

function playbook(id: string, title: string, confidence: number): Playbook {
  return {
    id,
    title,
    trigger: "x",
    steps: [{ order: 1, action: "step" }],
    examples: [],
    confidence,
  }
}

function entity(name: string, role: ProfileEntity["role"]): ProfileEntity {
  return { name, aliases: [], role, firstSeenChunkId: "c1" }
}

function mockLlm(response: string): LlmClient {
  return { complete: jest.fn(async () => response) }
}

describe("runSynthesizer", () => {
  it("returns a Character draft when the LLM provides one", async () => {
    const llm = mockLlm(`{
      "character": {
        "name": "Alice's Twin",
        "description": "Her PR-review style",
        "systemPrompt": "Be Alice. Be terse.",
        "voiceSummary": "Terse, code-first."
      },
      "skills": []
    }`)
    const result = await runSynthesizer(llm, {
      profile: makeProfile({
        styleSamples: [styleSample("a", "summary a")],
        playbooks: [playbook("pb_1", "Triage", 0.8)],
      }),
      recentChunks: [makeChunk("c1", "x")],
    })

    expect(result.drafts).toHaveLength(1)
    const c = result.drafts[0]
    expect(c.payload.kind).toBe("character")
    if (c.payload.kind === "character") {
      expect(c.payload.data.name).toBe("Alice's Twin")
      expect(c.payload.data.systemPrompt).toBe("Be Alice. Be terse.")
    }
    expect(c.rationale).toContain("1 style samples")
    expect(c.rationale).toContain("1 playbooks")
    expect(result.voiceSummary).toBe("Terse, code-first.")
  })

  it("falls back the character name to 'Twin of <twinId>' when the LLM omits it", async () => {
    const llm = mockLlm(`{
      "character": {"systemPrompt": "stay terse"}
    }`)
    const result = await runSynthesizer(llm, {
      profile: makeProfile(),
      recentChunks: [],
    })
    expect(result.drafts).toHaveLength(1)
    const c = result.drafts[0]
    if (c.payload.kind === "character") {
      expect(c.payload.data.name).toBe("Twin of twin_alice")
      expect(c.payload.data.systemPrompt).toBe("stay terse")
    }
  })

  it("uses an empty systemPrompt when none is supplied", async () => {
    const llm = mockLlm(`{"character": {"name": "X"}}`)
    const result = await runSynthesizer(llm, {
      profile: makeProfile(),
      recentChunks: [],
    })
    if (result.drafts[0].payload.kind === "character") {
      expect(result.drafts[0].payload.data.systemPrompt).toBe("")
    }
  })

  it("trims a whitespace-only character name (treats as missing)", async () => {
    const llm = mockLlm(`{"character": {"name": "   "}}`)
    const result = await runSynthesizer(llm, {
      profile: makeProfile({ twinId: "twin_alice", id: "twin_alice" }),
      recentChunks: [],
    })
    if (result.drafts[0].payload.kind === "character") {
      expect(result.drafts[0].payload.data.name).toBe("Twin of twin_alice")
    }
  })

  it("emits one Skill draft per valid `skills[]` row and propagates sourcePlaybookId", async () => {
    const llm = mockLlm(`{
      "skills": [
        {
          "name": "Triage Skill",
          "description": "for triage",
          "content": "## How to triage\\n1. ack\\n2. route",
          "sourcePlaybookId": "pb_triage",
          "rationale": "from 4 examples"
        },
        {
          "name": "  Standup Skill  ",
          "content": "## Standup template"
        }
      ]
    }`)
    const result = await runSynthesizer(llm, {
      profile: makeProfile(),
      recentChunks: [],
    })
    expect(result.drafts.map((d) => d.payload.kind)).toEqual(["skill", "skill"])

    const first = result.drafts[0]
    expect(first.sourcePlaybookId).toBe("pb_triage")
    expect(first.rationale).toBe("from 4 examples")
    if (first.payload.kind === "skill") {
      expect(first.payload.data.name).toBe("Triage Skill")
      expect(first.payload.sourcePlaybookId).toBe("pb_triage")
    }

    const second = result.drafts[1]
    if (second.payload.kind === "skill") {
      expect(second.payload.data.name).toBe("Standup Skill")
    }
    expect(second.rationale).toBe("Derived from a high-confidence playbook.")
    expect(second.sourcePlaybookId).toBeUndefined()
  })

  it("drops skill rows missing `name` or `content`", async () => {
    const llm = mockLlm(`{
      "skills": [
        {"name": "no content"},
        {"content": "no name"},
        {"name": "good", "content": "ok"}
      ]
    }`)
    const result = await runSynthesizer(llm, {
      profile: makeProfile(),
      recentChunks: [],
    })
    expect(result.drafts).toHaveLength(1)
    if (result.drafts[0].payload.kind === "skill") {
      expect(result.drafts[0].payload.data.name).toBe("good")
    }
  })

  it("treats a non-array `skills` as empty", async () => {
    const llm = mockLlm(`{"skills": "oops"}`)
    const result = await runSynthesizer(llm, {
      profile: makeProfile(),
      recentChunks: [],
    })
    expect(result.drafts).toEqual([])
  })

  it("preserves the existing voiceSummary when the LLM doesn't override it", async () => {
    const llm = mockLlm(`{"character": {"name": "X"}}`)
    const result = await runSynthesizer(llm, {
      profile: makeProfile({ voiceSummary: "Existing voice" }),
      recentChunks: [],
    })
    expect(result.voiceSummary).toBe("Existing voice")
  })

  it("formats the profile prompt with sections only for non-empty arrays", async () => {
    const completeMock = jest.fn(async (_prompt: string) => `{}`)
    await runSynthesizer(
      { complete: completeMock },
      {
        profile: makeProfile({
          voiceSummary: "Calm and direct.",
          styleSamples: [styleSample("a", "s a"), styleSample("b", "s b")],
          playbooks: [playbook("pb_1", "Triage", 0.8), playbook("pb_2", "Standup", 0.6)],
          entities: [entity("Alice", "person"), entity("Phoenix", "project")],
        }),
        recentChunks: [makeChunk("c1", "x"), makeChunk("c2", "y")],
      }
    )
    const promptArg = completeMock.mock.calls[0]?.[0] ?? ""
    expect(promptArg).toContain("Voice summary: Calm and direct.")
    expect(promptArg).toContain("Style samples (2)")
    expect(promptArg).toContain("Playbooks (2)")
    expect(promptArg).toContain("[pb_1] Triage (confidence=0.80)")
    expect(promptArg).toContain("Entities (2)")
    expect(promptArg).toContain("- person: Alice")
    expect(promptArg).toContain("- project: Phoenix")
    expect(promptArg).toContain("[c1]")
    expect(promptArg).toContain("[c2]")
  })

  it("caps recent chunks at 30 in the prompt", async () => {
    const completeMock = jest.fn(async (_prompt: string) => `{}`)
    const chunks = Array.from({ length: 50 }, (_, i) => makeChunk(`c${i}`, `body ${i}`))
    await runSynthesizer(
      { complete: completeMock },
      { profile: makeProfile(), recentChunks: chunks }
    )
    const promptArg = completeMock.mock.calls[0]?.[0] ?? ""
    expect(promptArg).toContain("[c29]")
    expect(promptArg).not.toContain("[c30]")
  })

  it("limits style-sample listing to first 5 and entity listing to first 20", async () => {
    const completeMock = jest.fn(async (_prompt: string) => `{}`)
    const samples = Array.from({ length: 8 }, (_, i) => styleSample(`s${i}`, `summary-${i}`))
    const entities = Array.from({ length: 30 }, (_, i) => entity(`e${i}`, "concept"))
    await runSynthesizer(
      { complete: completeMock },
      { profile: makeProfile({ styleSamples: samples, entities }), recentChunks: [] }
    )
    const promptArg = completeMock.mock.calls[0]?.[0] ?? ""
    expect(promptArg).toContain("- s0: summary-0")
    expect(promptArg).toContain("- s4: summary-4")
    expect(promptArg).not.toContain("- s5: summary-5")
    expect(promptArg).toContain("- concept: e19")
    expect(promptArg).not.toContain("- concept: e20")
  })

  it("emits no Character draft when the LLM omits it", async () => {
    const llm = mockLlm(`{"skills": [{"name": "S", "content": "c"}]}`)
    const result = await runSynthesizer(llm, {
      profile: makeProfile(),
      recentChunks: [],
    })
    expect(result.drafts.map((d) => d.payload.kind)).toEqual(["skill"])
  })
})
