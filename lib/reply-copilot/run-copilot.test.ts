jest.mock("@/lib/decisions/host-registry", () => ({ getDecisionRegistry: jest.fn() }))
jest.mock("@/lib/decisions/config", () => ({ loadDecisionSettings: jest.fn() }))
jest.mock("@/lib/decisions/run-decision", () => ({ runDecision: jest.fn() }))

import type { LlmClient } from "@/lib/twin/distill/llm"
import type { DecisionRequest, DecisionResult } from "@/types/decisions"
import type { CopilotTranscript } from "./build-state"
import type { CopilotKnowledge } from "./knowledge"
import { UNSPECIFIED_RELATIONSHIP, runCopilot, type CopilotRunDeps } from "./run-copilot"

const transcript: CopilotTranscript = {
  turns: [
    { from: "me", text: "开会记得带电脑" },
    { from: "other", text: "你又忘了？" },
  ],
  latestFrom: "other",
  latestOtherSender: null,
  isGroup: false,
}

const knowledge: CopilotKnowledge = {
  relationship: "",
  background: "About this contact: dislikes long messages",
  contactId: null,
  contactName: null,
  hasNote: true,
  memoryLines: 0,
  memorySkipped: "disabled",
}

const client = {} as LlmClient

const judgeAnswers = {
  true_intent: {
    type: "choice" as const,
    choice: "confirm_you_care",
    confidence: 0.6,
    probabilities: { confirm_you_care: 0.6 },
  },
  danger_level: { type: "score" as const, score: 4, levels: 10, confidence: 0.4 },
}

function ok(answers: Record<string, unknown>, extra: Partial<DecisionResult> = {}): DecisionResult {
  return {
    ok: true,
    providerId: "laya:laya-local",
    answers,
    latencyMs: 60,
    ...extra,
  } as DecisionResult
}

function deps(overrides: Partial<CopilotRunDeps> = {}) {
  const decide = jest.fn(
    async (request: DecisionRequest, _options?: unknown): Promise<DecisionResult> =>
      "best_reply" in request.questions
        ? ok({
            best_reply: {
              type: "choice",
              choice: "reply_b",
              confidence: 0.5,
              probabilities: { reply_a: 0.2, reply_b: 0.7, reply_c: 0.1 },
            },
          })
        : ok(judgeAnswers)
  )
  const draft = jest.fn(async () => ({
    kind: "drafts" as const,
    candidates: ["没忘", "我查一下", "嗯"],
  }))
  const d: CopilotRunDeps = {
    decide,
    draft,
    selectedProvider: async () => ({
      id: "laya:laya-local",
      limits: { headTokens: 192 },
      validated: true,
    }),
    ...overrides,
  }
  return { d, decide, draft }
}

describe("runCopilot", () => {
  it("judges, drafts and ranks with the compact set for a local provider", async () => {
    const { d, decide } = deps()
    const result = await runCopilot({ transcript, knowledge, instructions: "", client }, d)
    expect(result.variant).toBe("compact")
    expect(result.judge).toMatchObject({
      kind: "ok",
      providerId: "laya:laya-local",
      judgment: { intent: { key: "confirm_you_care" }, danger: { level: 4 } },
      truncated: false,
      backgroundDropped: false,
    })
    expect(result.drafts).toMatchObject({
      kind: "ok",
      ranked: true,
      candidates: [{ text: "我查一下", probability: 0.7 }, { text: "没忘" }, { text: "嗯" }],
    })
    const [judgeRequest, options] = decide.mock.calls[0]
    expect(options).toEqual({ providerId: "laya:laya-local" })
    expect(judgeRequest.stateTrim).toEqual(["chat", "messages"])
    expect(judgeRequest.state).toMatchObject({
      chat: { relationship: UNSPECIFIED_RELATIONSHIP, latest_from: "other" },
      background: knowledge.background,
    })
  })

  it("labels the no-provider state and still returns unranked drafts", async () => {
    const { d, decide } = deps({ selectedProvider: async () => null })
    const result = await runCopilot({ transcript, knowledge, instructions: "", client }, d)
    expect(result.judge).toEqual({ kind: "unavailable", reason: "no_provider" })
    expect(result.drafts).toMatchObject({ kind: "ok", ranked: false, rankSkipped: "no_provider" })
    expect(result.variant).toBe("full")
    expect(decide).not.toHaveBeenCalled()
  })

  it("neither judges nor ranks on a provider not validated for this question set", async () => {
    const { d, decide } = deps({
      selectedProvider: async () => ({
        id: "laya:laya-local",
        limits: { headTokens: 192 },
        validated: false,
      }),
    })
    const result = await runCopilot({ transcript, knowledge, instructions: "", client }, d)
    expect(result.judge).toEqual({ kind: "unavailable", reason: "not_validated" })
    expect(result.drafts).toMatchObject({ kind: "ok", ranked: false, rankSkipped: "not_validated" })
    expect(decide).not.toHaveBeenCalled()
  })

  it("retries once without background when a strict endpoint rejects it", async () => {
    const decide = jest
      .fn<Promise<DecisionResult>, [DecisionRequest]>()
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "http_status", message: "400", status: 400 },
      })
      .mockResolvedValue(ok(judgeAnswers))
    const { d } = deps({ decide, draft: async () => ({ kind: "skipped", reason: "no-output" }) })
    const result = await runCopilot({ transcript, knowledge, instructions: "", client }, d)
    expect(result.judge).toMatchObject({ kind: "ok", backgroundDropped: true })
    expect(decide.mock.calls[1][0].state).not.toHaveProperty("background")
    expect(result.drafts).toEqual({ kind: "skipped", reason: "no-output" })
  })

  it("keeps stages independent: failed judge with drafts, failed draft with a judgment", async () => {
    const failing = deps({
      decide: async () => ({
        ok: false,
        error: { kind: "provider_unavailable", message: "loading" },
      }),
    })
    const a = await runCopilot({ transcript, knowledge, instructions: "", client }, failing.d)
    expect(a.judge).toEqual({ kind: "unavailable", reason: "provider_unavailable" })
    expect(a.drafts).toMatchObject({ kind: "ok", ranked: false, rankError: "provider_unavailable" })

    const broken = deps({ draft: async () => Promise.reject(new Error("model down")) })
    const b = await runCopilot({ transcript, knowledge, instructions: "", client }, broken.d)
    expect(b.judge.kind).toBe("ok")
    expect(b.drafts).toEqual({ kind: "failed" })

    const garbled = deps({ decide: async () => ok({ unasked: { noul: 1 } }) })
    const c = await runCopilot({ transcript, knowledge, instructions: "", client }, garbled.d)
    expect(c.judge).toEqual({ kind: "failed", reason: "provider_error" })
  })

  it("skips drafting without a model and ranking with a single draft", async () => {
    const noModel = await runCopilot(
      { transcript, knowledge, instructions: "", client: null },
      deps().d
    )
    expect(noModel.drafts).toEqual({ kind: "skipped", reason: "no-model" })
    const single = deps({ draft: async () => ({ kind: "drafts", candidates: ["嗯"] }) })
    const one = await runCopilot({ transcript, knowledge, instructions: "", client }, single.d)
    expect(one.drafts).toMatchObject({
      kind: "ok",
      ranked: false,
      rankSkipped: "single_candidate",
      candidates: [{ text: "嗯" }],
    })
    expect(single.decide).toHaveBeenCalledTimes(1) // judge only
  })

  it("flags a truncated read", async () => {
    const { d } = deps({ decide: async () => ok(judgeAnswers, { stateTruncated: true }) })
    const result = await runCopilot({ transcript, knowledge, instructions: "", client: null }, d)
    expect(result.judge).toMatchObject({ kind: "ok", truncated: true })
  })

  it("propagates an abort", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      runCopilot(
        { transcript, knowledge, instructions: "", client, signal: controller.signal },
        deps().d
      )
    ).rejects.toThrow()
  })
})
