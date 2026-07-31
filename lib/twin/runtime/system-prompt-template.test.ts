/**
 * Coverage for `system-prompt-template.ts`. Pure assembly so the tests
 * focus on segment ordering, optional-section behaviour, truncation
 * rules, and metadata payload.
 */

import { applySystemPromptTemplate } from "./system-prompt-template"
import type { Playbook, ProfileEntity, StyleSample, TwinChunk } from "@/types/twin"

function makeChunk(id: string, content = "the chunk body"): TwinChunk {
  return {
    id,
    twinId: "twin_a",
    sourceId: "src_1",
    content,
    contentRedacted: content,
    charStart: 0,
    charEnd: content.length,
    vectorBackend: "qdrant",
    vectorCollection: "c",
    vectorDocId: `vec_${id}`,
    strategy: "paragraph",
    tokenCount: 1,
    metadata: {},
    createdAt: 1,
  }
}

function makeSample(id: string, label: string, original: string, tone: string[] = []): StyleSample {
  return {
    id,
    contextLabel: label,
    original,
    summary: original.slice(0, 30),
    sourceChunkId: "c1",
    tone,
    addedAt: 1,
    addedBy: "distill",
  }
}

function makePlaybook(overrides: Partial<Playbook> = {}): Playbook {
  return {
    id: "pb_1",
    title: "Handle escalation",
    trigger: "a customer escalates",
    steps: [
      { order: 1, action: "acknowledge quickly" },
      { order: 2, action: "loop in the lead" },
    ],
    examples: [],
    confidence: 0.8,
    ...overrides,
  }
}

describe("applySystemPromptTemplate", () => {
  it("emits only the identity block when no other sections are populated", () => {
    const out = applySystemPromptTemplate({
      twinName: "Alice",
      entities: [],
      retrievedChunks: [],
      styleSamples: [],
    })
    expect(out.systemPrompt).toContain("You are Alice.")
    expect(out.systemPrompt).not.toContain("## Relevant historical material")
    expect(out.systemPrompt).not.toContain("## Style examples")
    expect(out.metadata.twinName).toBe("Alice")
    expect(out.metadata.retrievedChunkIds).toEqual([])
    expect(out.metadata.styleSampleIds).toEqual([])
  })

  it("places the original character prompt first, before identity", () => {
    const out = applySystemPromptTemplate({
      baseSystemPrompt: "ALPHA",
      twinName: "Alice",
      entities: [],
      retrievedChunks: [],
      styleSamples: [],
    })
    const alphaIdx = out.systemPrompt.indexOf("ALPHA")
    const identityIdx = out.systemPrompt.indexOf("You are Alice.")
    expect(alphaIdx).toBeGreaterThanOrEqual(0)
    expect(alphaIdx).toBeLessThan(identityIdx)
  })

  it("renders entity dictionary with role priority + max-shown cap", () => {
    const entities: ProfileEntity[] = [
      { name: "X-service", aliases: ["x-svc"], role: "system", firstSeenChunkId: "c1" },
      { name: "Bob", aliases: [], role: "person", firstSeenChunkId: "c1" },
      { name: "ProjectX", aliases: [], role: "project", firstSeenChunkId: "c1" },
      { name: "concept-1", aliases: [], role: "concept", firstSeenChunkId: "c1" },
      { name: "concept-2", aliases: [], role: "concept", firstSeenChunkId: "c1" },
    ]
    const out = applySystemPromptTemplate({
      twinName: "Alice",
      entities,
      retrievedChunks: [],
      styleSamples: [],
      maxEntitiesShown: 3,
    })
    expect(out.systemPrompt).toMatch(/Person: Bob[\s\S]*Project: ProjectX[\s\S]*System: X-service/)
    // Max 3 entries, so concept entries are dropped.
    expect(out.systemPrompt).not.toContain("concept-1")
  })

  it("truncates a long voice summary with an ellipsis", () => {
    const long = "x".repeat(500)
    const out = applySystemPromptTemplate({
      twinName: "Alice",
      voiceSummary: long,
      entities: [],
      retrievedChunks: [],
      styleSamples: [],
      maxVoiceSummary: 100,
    })
    expect(out.systemPrompt).toContain("…")
    expect(out.systemPrompt).not.toContain("x".repeat(101))
  })

  it("emits retrieved chunks with score and source title", () => {
    const out = applySystemPromptTemplate({
      twinName: "Alice",
      entities: [],
      retrievedChunks: [
        { chunk: makeChunk("c1", "first body"), score: 0.92, sourceTitle: "Onboarding doc" },
        { chunk: makeChunk("c2", "second body"), score: 0.81 },
      ],
      styleSamples: [],
    })
    expect(out.systemPrompt).toContain("## Relevant historical material")
    expect(out.systemPrompt).toContain("Onboarding doc (score 0.92)")
    expect(out.systemPrompt).toContain("Unknown source")
    expect(out.metadata.retrievedChunkIds).toEqual(["c1", "c2"])
  })

  it("emits style samples with tone tags", () => {
    const out = applySystemPromptTemplate({
      twinName: "Alice",
      entities: [],
      retrievedChunks: [],
      styleSamples: [
        makeSample("ss_1", "rejection", "Sorry, can't do that.", ["concise", "polite"]),
        makeSample("ss_2", "approval", "Yes — happy to help."),
      ],
    })
    expect(out.systemPrompt).toContain("## Style examples")
    expect(out.systemPrompt).toContain("Sample 1 — rejection [concise, polite]")
    expect(out.systemPrompt).toContain("Sample 2 — approval")
    expect(out.metadata.styleSampleIds).toEqual(["ss_1", "ss_2"])
  })

  it("omits empty optional sections so headings don't dangle", () => {
    const out = applySystemPromptTemplate({
      twinName: "Alice",
      voiceSummary: "concise",
      entities: [],
      retrievedChunks: [],
      styleSamples: [],
    })
    expect(out.systemPrompt).toContain("Voice and tone:")
    expect(out.systemPrompt).not.toMatch(/People, teams[\s\S]*\n\n$/)
  })

  it("renders playbooks as 'When …: steps' lines in the stable segment", () => {
    const out = applySystemPromptTemplate({
      twinName: "Alice",
      entities: [],
      retrievedChunks: [],
      styleSamples: [],
      playbooks: [makePlaybook()],
    })
    expect(out.systemPrompt).toContain("## How you typically handle situations")
    expect(out.systemPrompt).toContain(
      "When a customer escalates: acknowledge quickly → loop in the lead"
    )
    // Per-profile → stable, never the per-turn dynamic segment.
    expect(out.cacheSegments.stable).toContain("## How you typically handle situations")
    expect(out.cacheSegments.dynamic).not.toContain("## How you typically handle situations")
  })

  it("skips playbooks already promoted into a Skill", () => {
    const out = applySystemPromptTemplate({
      twinName: "Alice",
      entities: [],
      retrievedChunks: [],
      styleSamples: [],
      playbooks: [
        makePlaybook({ id: "pb_a", trigger: "kept" }),
        makePlaybook({ id: "pb_b", trigger: "promoted away", promotedToSkillId: "skill_1" }),
      ],
    })
    expect(out.systemPrompt).toContain("When kept:")
    expect(out.systemPrompt).not.toContain("promoted away")
  })

  it("orders playbooks by confidence desc and caps to maxPlaybooksShown", () => {
    const out = applySystemPromptTemplate({
      twinName: "Alice",
      entities: [],
      retrievedChunks: [],
      styleSamples: [],
      maxPlaybooksShown: 2,
      playbooks: [
        makePlaybook({ id: "p1", trigger: "low", confidence: 0.1 }),
        makePlaybook({ id: "p2", trigger: "high", confidence: 0.9 }),
        makePlaybook({ id: "p3", trigger: "mid", confidence: 0.5 }),
      ],
    })
    const high = out.systemPrompt.indexOf("When high:")
    const mid = out.systemPrompt.indexOf("When mid:")
    expect(high).toBeGreaterThanOrEqual(0)
    expect(mid).toBeGreaterThan(high)
    // Lowest-confidence entry dropped by the cap.
    expect(out.systemPrompt).not.toContain("When low:")
  })

  it("emits no playbook heading when all entries are filtered out", () => {
    const out = applySystemPromptTemplate({
      twinName: "Alice",
      entities: [],
      retrievedChunks: [],
      styleSamples: [],
      playbooks: [makePlaybook({ promotedToSkillId: "skill_1" })],
    })
    expect(out.systemPrompt).not.toContain("## How you typically handle situations")
  })

  it("keeps the cacheSegments invariant intact with playbooks present", () => {
    const out = applySystemPromptTemplate({
      baseSystemPrompt: "BASE",
      twinName: "Alice",
      entities: [],
      retrievedChunks: [{ chunk: makeChunk("k1"), score: 0.9, sourceTitle: "Doc" }],
      styleSamples: [],
      playbooks: [makePlaybook()],
    })
    expect([out.cacheSegments.stable, out.cacheSegments.dynamic].join("\n\n---\n\n")).toBe(
      out.systemPrompt
    )
  })

  it("splits cacheSegments at the stable/dynamic boundary", () => {
    const out = applySystemPromptTemplate({
      baseSystemPrompt: "BASE",
      twinName: "Alice",
      entities: [],
      retrievedChunks: [{ chunk: makeChunk("k1"), score: 0.9, sourceTitle: "Doc" }],
      styleSamples: [makeSample("ss_1", "rejection", "No thanks.")],
    })
    // Stable: sections 1-2 only.
    expect(out.cacheSegments.stable).toContain("BASE")
    expect(out.cacheSegments.stable).toContain("You are Alice.")
    expect(out.cacheSegments.stable).not.toContain("## Relevant historical material")
    expect(out.cacheSegments.stable).not.toContain("## Style examples")
    // Dynamic: sections 3-4 only.
    expect(out.cacheSegments.dynamic).toContain("## Relevant historical material")
    expect(out.cacheSegments.dynamic).toContain("## Style examples")
    expect(out.cacheSegments.dynamic).not.toContain("You are Alice.")
    // Recombining the segments reproduces the full prompt exactly.
    expect([out.cacheSegments.stable, out.cacheSegments.dynamic].join("\n\n---\n\n")).toBe(
      out.systemPrompt
    )
  })

  it("leaves cacheSegments.dynamic empty when there is no per-turn material", () => {
    const out = applySystemPromptTemplate({
      twinName: "Alice",
      entities: [],
      retrievedChunks: [],
      styleSamples: [],
    })
    expect(out.cacheSegments.dynamic).toBe("")
    expect(out.cacheSegments.stable).toBe(out.systemPrompt)
  })
})
