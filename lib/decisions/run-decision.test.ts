jest.mock("@/lib/decisions/host-registry", () => ({ getDecisionRegistry: jest.fn() }))
jest.mock("@/lib/decisions/config", () => ({ loadDecisionSettings: jest.fn() }))

import type { DecisionProvider, DecisionProviderResponse, DecisionRequest } from "@/types/decisions"
import { createDecisionRegistry } from "./registry"
import { redactDecisionRequest, runDecision, type RunDecisionDeps } from "./run-decision"

const request: DecisionRequest = {
  state: { chat: { messages: [{ from: "other", text: "call me at 13812345678" }] } },
  questions: {
    tense: { type: "noul", instructions: "Is there tension?" },
    intent: {
      type: "choice",
      instructions: "Intent?",
      criteria: { chat: "light", ask: "wants help" },
    },
  },
  stateTrim: ["chat", "messages"],
}

function provider(
  decide: DecisionProvider["decide"],
  extra: Partial<DecisionProvider> = {}
): DecisionProvider {
  return {
    id: "p:laya",
    label: "Laya",
    pluginId: "p",
    locality: "local",
    calibrated: true,
    decide,
    ...extra,
  }
}

function deps(p: DecisionProvider | null, providerId?: string): RunDecisionDeps {
  const registry = createDecisionRegistry()
  if (p) registry.register(p)
  return { registry: () => registry, loadSettings: async () => ({ providerId }) }
}

const okAnswers = {
  tense: { noul: 0.7 },
  intent: { choice: "ask", probabilities: { chat: 0.3, ask: 0.7 } },
}

describe("runDecision", () => {
  it("answers through the provider selected in settings", async () => {
    const decide = jest.fn(async (): Promise<DecisionProviderResponse> => ({
      ok: true,
      answers: okAnswers,
      latencyMs: 61.4,
      routing: { model: "multilingual", reason: "han" },
      stateTrimmed: 3,
    }))
    const result = await runDecision(request, {}, deps(provider(decide), "p:laya"))
    expect(result).toEqual({
      ok: true,
      providerId: "p:laya",
      answers: {
        tense: { type: "noul", noul: 0.7 },
        intent: {
          type: "choice",
          choice: "ask",
          probabilities: { chat: 0.3, ask: 0.7 },
          confidence: 0.7,
        },
      },
      latencyMs: 61,
      routing: { model: "multilingual", reason: "han" },
      stateTrimmed: 3,
      redactions: 1,
    })
  })

  it("sends a redacted request, keeps stateTrim, and never leaks the raw value", async () => {
    const decide = jest.fn(
      async (_request: DecisionRequest): Promise<DecisionProviderResponse> => ({
        ok: true,
        answers: okAnswers,
      })
    )
    await runDecision(request, {}, deps(provider(decide), "p:laya"))
    const sent = decide.mock.calls[0][0]
    expect(JSON.stringify(sent)).not.toContain("13812345678")
    expect(JSON.stringify(sent)).toMatch(/<PHONE_\d{3,}>/)
    expect(sent.stateTrim).toEqual(["chat", "messages"])
  })

  it("prefers an explicit provider id over settings", async () => {
    const decide = jest.fn(async (): Promise<DecisionProviderResponse> => ({
      ok: true,
      answers: okAnswers,
    }))
    const result = await runDecision(
      request,
      { providerId: "p:laya" },
      deps(provider(decide), "other")
    )
    expect(result.ok).toBe(true)
  })

  it("types every refusal before calling the provider", async () => {
    const decide = jest.fn()
    expect(
      await runDecision({ state: "", questions: {} }, {}, deps(provider(decide), "p:laya"))
    ).toMatchObject({
      ok: false,
      error: { kind: "invalid_request" },
    })
    expect(await runDecision(request, {}, deps(provider(decide)))).toMatchObject({
      error: { kind: "no_provider", message: "no decision provider is selected" },
    })
    expect(await runDecision(request, {}, deps(null, "p:gone"))).toMatchObject({
      providerId: "p:gone",
      error: { kind: "no_provider" },
    })
    expect(
      await runDecision(request, { callerPluginId: "p" }, deps(provider(decide), "p:laya"))
    ).toMatchObject({ error: { kind: "recursive_provider" } })
    expect(decide).not.toHaveBeenCalled()
  })

  it("maps provider error envelopes onto host kinds", async () => {
    const cases: Array<[unknown, string]> = [
      [{ kind: "not_ready", message: "loading" }, "provider_unavailable"],
      [{ kind: "invalid_question", message: "bad" }, "invalid_request"],
      [{ kind: "predict_failed", message: "boom" }, "provider_error"],
      [{ kind: "http_status", message: "401", status: 401 }, "http_status"],
      [{ kind: "weird", message: "?" }, "provider_error"],
    ]
    for (const [error, kind] of cases) {
      const p = provider(async () => ({ ok: false, error }) as DecisionProviderResponse)
      const result = await runDecision(request, {}, deps(p, "p:laya"))
      expect(result).toMatchObject({ ok: false, error: { kind } })
    }
    const withStatus = await runDecision(
      request,
      {},
      deps(
        provider(async () => ({
          ok: false,
          error: { kind: "http_status", message: "x", status: 429 },
        })),
        "p:laya"
      )
    )
    expect(withStatus).toMatchObject({ error: { status: 429 } })
  })

  it("treats throws, malformed replies and empty answers as provider errors", async () => {
    for (const decide of [
      async () => {
        throw new Error("python-backed provider failed: boom")
      },
      async () => "nope" as unknown as DecisionProviderResponse,
      async () => ({ ok: true, answers: { unasked: { noul: 1 } } }) as DecisionProviderResponse,
    ]) {
      const result = await runDecision(request, {}, deps(provider(decide), "p:laya"))
      expect(result).toMatchObject({ ok: false, error: { kind: "provider_error" } })
    }
  })

  it("bounds a provider that never answers", async () => {
    const p = provider(() => new Promise<DecisionProviderResponse>(() => {}))
    const result = await runDecision(request, { timeoutMs: 10 }, deps(p, "p:laya"))
    expect(result).toMatchObject({ error: { kind: "timeout" } })
  })

  it("stops waiting when the caller aborts", async () => {
    const p = provider(() => new Promise<DecisionProviderResponse>(() => {}))
    const controller = new AbortController()
    const pending = runDecision(request, { signal: controller.signal }, deps(p, "p:laya"))
    controller.abort()
    await expect(pending).resolves.toMatchObject({ error: { kind: "aborted" } })
    const already = new AbortController()
    already.abort()
    await expect(
      runDecision(request, { signal: already.signal }, deps(p, "p:laya"))
    ).resolves.toMatchObject({ error: { kind: "aborted" } })
  })
})

describe("redactDecisionRequest", () => {
  it("redacts values across state and question text but never keys", () => {
    const { request: out, redactions } = redactDecisionRequest({
      state: { "a@b.co": "mail a@b.co", list: ["x@y.io", 3, null] },
      questions: {
        rank: {
          type: "choice",
          instructions: "Which reply? ping ops@corp.com",
          criteria: { reply_a: "email me: me@home.org", reply_b: "ok" },
        },
        yes: { type: "noul", instructions: "?", criteria: { true: "t@t.io" } },
        lvl: { type: "score", instructions: "?", criteria: ["a", "b"] },
      },
    })
    const text = JSON.stringify(out)
    for (const raw of ["mail a@b.co", "x@y.io", "ops@corp.com", "me@home.org", "t@t.io"]) {
      expect(text).not.toContain(raw)
    }
    expect(Object.keys(out.state as object)).toContain("a@b.co")
    expect(Object.keys((out.questions.rank as { criteria: object }).criteria)).toEqual([
      "reply_a",
      "reply_b",
    ])
    expect(redactions).toBe(5)
  })
})
