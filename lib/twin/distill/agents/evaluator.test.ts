import { runEvaluator } from "./evaluator"
import type { LlmClient } from "../llm"
import type { TwinDraft, TwinDraftPayload } from "@/types/twin"

function makeDraft(id: string, payload: TwinDraftPayload): TwinDraft {
  return {
    id,
    twinId: "twin_alice",
    jobId: "twj_distill",
    kind: payload.kind,
    payload,
    provenance: { chunkIds: ["c1", "c2"], rationale: "test" },
    status: "pending",
    createdAt: 1,
  }
}

function mockLlm(response: string): LlmClient {
  return { complete: jest.fn(async () => response) }
}

describe("runEvaluator", () => {
  it("returns an empty map when there are no drafts", async () => {
    const llm = mockLlm("{}")
    const result = await runEvaluator(llm, { drafts: [] })
    expect(result.evaluations).toEqual({})
    expect(llm.complete).not.toHaveBeenCalled()
  })

  it("indexes evaluations by draftId and clamps qualityScore into [0,1]", async () => {
    const drafts = [
      makeDraft("d1", {
        kind: "character",
        data: { name: "Alice Twin", systemPrompt: "Be Alice." },
      }),
      makeDraft("d2", { kind: "skill", data: { name: "PR review", content: "..." } }),
    ]
    const llm = mockLlm(`{
      "evaluations": [
        {"draftId": "d1", "qualityScore": 1.5, "concerns": ["too long"], "suggestions": []},
        {"draftId": "d2", "qualityScore": -0.2, "concerns": [], "suggestions": ["add example"]}
      ]
    }`)

    const result = await runEvaluator(llm, { drafts })

    expect(Object.keys(result.evaluations).sort()).toEqual(["d1", "d2"])
    expect(result.evaluations.d1.qualityScore).toBe(1)
    expect(result.evaluations.d1.concerns).toEqual(["too long"])
    expect(result.evaluations.d2.qualityScore).toBe(0)
    expect(result.evaluations.d2.suggestions).toEqual(["add example"])
  })

  it("falls back to qualityScore=0.5 when the field is missing or wrong type", async () => {
    const drafts = [makeDraft("d1", { kind: "character", data: { name: "x" } })]
    const llm = mockLlm(`{
      "evaluations": [{"draftId": "d1", "qualityScore": "high", "concerns": [], "suggestions": []}]
    }`)
    const result = await runEvaluator(llm, { drafts })
    expect(result.evaluations.d1.qualityScore).toBe(0.5)
  })

  it("drops evaluations with no draftId", async () => {
    const drafts = [makeDraft("d1", { kind: "character", data: { name: "x" } })]
    const llm = mockLlm(`{
      "evaluations": [
        {"qualityScore": 0.9, "concerns": [], "suggestions": []},
        {"draftId": "d1", "qualityScore": 0.7, "concerns": [], "suggestions": []}
      ]
    }`)
    const result = await runEvaluator(llm, { drafts })
    expect(Object.keys(result.evaluations)).toEqual(["d1"])
  })

  it("filters non-string entries out of concerns/suggestions", async () => {
    const drafts = [makeDraft("d1", { kind: "character", data: { name: "x" } })]
    const llm = mockLlm(`{
      "evaluations": [{
        "draftId": "d1",
        "qualityScore": 0.5,
        "concerns": ["valid", 42, null, "also valid"],
        "suggestions": [{"obj": "no"}, "good idea"]
      }]
    }`)
    const result = await runEvaluator(llm, { drafts })
    expect(result.evaluations.d1.concerns).toEqual(["valid", "also valid"])
    expect(result.evaluations.d1.suggestions).toEqual(["good idea"])
  })

  it("treats a non-array `evaluations` field as empty", async () => {
    const drafts = [makeDraft("d1", { kind: "character", data: { name: "x" } })]
    const llm = mockLlm(`{"evaluations": "oops"}`)
    const result = await runEvaluator(llm, { drafts })
    expect(result.evaluations).toEqual({})
  })

  it("returns empty arrays for missing concerns/suggestions fields", async () => {
    const drafts = [makeDraft("d1", { kind: "character", data: { name: "x" } })]
    const llm = mockLlm(`{"evaluations": [{"draftId": "d1", "qualityScore": 0.6}]}`)
    const result = await runEvaluator(llm, { drafts })
    expect(result.evaluations.d1.concerns).toEqual([])
    expect(result.evaluations.d1.suggestions).toEqual([])
  })

  it("derives the prompt body from each draft's payload (name + systemPrompt or content)", async () => {
    const drafts = [
      makeDraft("d1", {
        kind: "character",
        data: { name: "Alice", systemPrompt: "Be Alice in all interactions." },
      }),
      makeDraft("d2", {
        kind: "skill",
        data: { name: "Triage", content: "Step 1: ack\nStep 2: route" },
      }),
      makeDraft("d3", { kind: "character", data: {} }),
      makeDraft("d4", { kind: "skill", data: {} }),
    ]
    const completeMock = jest.fn(async (_prompt: string) => `{"evaluations": []}`)
    await runEvaluator({ complete: completeMock }, { drafts })
    const promptArg = completeMock.mock.calls[0]?.[0] ?? ""
    expect(promptArg).toContain("[d1]")
    expect(promptArg).toContain("Title: Alice")
    expect(promptArg).toContain("Be Alice in all interactions.")
    expect(promptArg).toContain("[d2]")
    expect(promptArg).toContain("Title: Triage")
    expect(promptArg).toContain("Step 1: ack")
    expect(promptArg).toContain("Title: Character draft") // d3 fallback
    expect(promptArg).toContain("Title: Skill draft") // d4 fallback
  })

  it("truncates long bodies to 1500 chars when assembling the prompt", async () => {
    const longBody = "A".repeat(3000)
    const drafts = [
      makeDraft("d1", { kind: "character", data: { name: "x", systemPrompt: longBody } }),
    ]
    const completeMock = jest.fn(async (_prompt: string) => `{"evaluations": []}`)
    await runEvaluator({ complete: completeMock }, { drafts })
    const promptArg = completeMock.mock.calls[0]?.[0] ?? ""
    // The 1501st A must not be present.
    expect(promptArg).toContain("A".repeat(1500))
    expect(promptArg).not.toContain("A".repeat(1501))
  })
})
