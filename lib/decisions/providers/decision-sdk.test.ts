// Exercise real SDK serialization and validation at the injected fetch boundary.
jest.unmock("ai")

import type { PlatformFetch } from "@/lib/network/platform-fetch"
import type { DecisionHttpPresetId, DecisionRequest, DecisionSettings } from "@/types/decisions"
import { decideWithSdk } from "./decision-sdk"
import { DECISION_HTTP_PRESETS, resolveDecisionEndpoint } from "../presets"

const nativePresets = ["typesafe", "openrouter", "bocha", "vercel", "zen"] as const
const languagePresets = ["openai", "anthropic", "google"] as const
const sdkPresets = [...nativePresets, ...languagePresets, "gateway"] as const
const request: DecisionRequest = {
  state: { post: "Good morning!" },
  questions: {
    greeting: { type: "noul", instructions: "Is this a greeting?" },
    tone: {
      type: "choice",
      instructions: "Choose the tone.",
      criteria: { friendly: "Friendly", formal: "Formal" },
    },
    warmth: {
      type: "score",
      instructions: "Rate the warmth.",
      criteria: ["Cold", "Neutral", "Warm"],
    },
  },
}

function endpoint(preset: DecisionHttpPresetId, overrides: Partial<DecisionSettings["http"]> = {}) {
  const resolved = resolveDecisionEndpoint({ preset, ...overrides })
  if (!resolved.ok) throw new Error(`Invalid fixture endpoint: ${resolved.reason}`)
  return resolved
}

function transport(body: unknown) {
  return jest.fn<ReturnType<PlatformFetch>, Parameters<PlatformFetch>>(
    async () =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
  )
}

function nativeResponse() {
  return {
    model: "resolved-jev",
    answers: {
      greeting: { type: "noul", noul: 0.8 },
      tone: {
        type: "choice",
        choice: "friendly",
        probabilities: { friendly: 0.7, formal: 0.3 },
        confidence: 0.92,
      },
      warmth: {
        type: "score",
        score: 1,
        probabilities: { "0": 0.25, "1": 0.5, "2": 0.25 },
        confidence: 0.84,
      },
    },
    usage: { input_tokens: 24, output_tokens: 6 },
  }
}

function languageResponse(preset: (typeof languagePresets)[number], text: string) {
  switch (preset) {
    case "openai":
      return {
        id: "resp_decision",
        model: "resolved-openai",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            id: "msg_decision",
            content: [{ type: "output_text", text, annotations: [] }],
          },
        ],
        usage: { input_tokens: 24, output_tokens: 6 },
      }
    case "anthropic":
      return {
        type: "message",
        id: "msg_decision",
        model: "resolved-anthropic",
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 24, output_tokens: 6 },
      }
    case "google":
      return {
        candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 24, candidatesTokenCount: 6, totalTokenCount: 30 },
      }
  }
}

function call(
  preset: DecisionHttpPresetId,
  fetch: PlatformFetch,
  signal = new AbortController().signal
) {
  return decideWithSdk(request, endpoint(preset), "test-key", fetch, signal)
}

describe("native TypeSafe SDK adapters", () => {
  it.each(nativePresets)(
    "preserves %s probabilities, confidence, rounding and resolved model",
    async (preset) => {
      const fetch = transport(nativeResponse())
      const result = await call(preset, fetch)
      expect(result).toMatchObject({
        ok: true,
        answers: nativeResponse().answers,
        routing: { model: "resolved-jev" },
        usage: { inputTokens: 24, outputTokens: 6, totalTokens: 30 },
        rounding: { probabilityDecimals: 2, scoreDecimals: 2 },
        probabilityKind: "native",
      })
      expect(fetch).toHaveBeenCalledTimes(1)
      const [url, init] = fetch.mock.calls[0]
      expect(url).toBe(DECISION_HTTP_PRESETS[preset].url)
      expect(init?.method).toBe("POST")
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key")
      expect(JSON.parse(init?.body as string)).toEqual({
        model: DECISION_HTTP_PRESETS[preset].defaultModel,
        ...request,
      })
      if (preset === "openrouter") {
        expect(new Headers(init?.headers).get("http-referer")).toBe("https://cognia.cn")
        expect(new Headers(init?.headers).get("x-title")).toBe("Cognia")
      }
    }
  )

  it("uses the exact overridden endpoint without appending systemone", async () => {
    const fetch = transport(nativeResponse())
    const url = "https://custom.example.test/decision?deployment=one"
    await decideWithSdk(
      request,
      endpoint("typesafe", { url, model: "custom-jev" }),
      "custom-key",
      fetch,
      new AbortController().signal
    )
    expect(fetch.mock.calls[0][0]).toBe(url)
    const init = fetch.mock.calls[0][1]
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer custom-key")
    expect(JSON.parse(init?.body as string).model).toBe("custom-jev")
    expect(new Headers(init?.headers).has("http-referer")).toBe(false)
  })

  it.each([
    ["malformed", { answers: { greeting: { type: "noul", noul: "yes" } } }],
    [
      "out of range",
      {
        ...nativeResponse(),
        answers: { ...nativeResponse().answers, greeting: { type: "noul", noul: 2 } },
      },
    ],
    ["incomplete", { answers: { greeting: { type: "noul", noul: 0.8 } } }],
  ])("rejects %s native output", async (_label, body) => {
    const fetch = transport(body)
    await expect(call("typesafe", fetch)).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe("language-model SDK adapters", () => {
  it.each(languagePresets)("uses an overridden %s API base URL and model", async (preset) => {
    const values = { q0: 0.8, q1: "c0", q2: 1 }
    const response = languageResponse(preset, JSON.stringify(values))
    // Anthropic models without native structured output use its JSON response tool.
    const fetch = transport(
      preset === "anthropic"
        ? {
            ...response,
            content: [{ type: "tool_use", id: "tool_json", name: "json", input: values }],
            stop_reason: "tool_use",
          }
        : response
    )
    await decideWithSdk(
      request,
      endpoint(preset, { url: "https://proxy.example.test/api", model: "custom-model" }),
      "proxy-key",
      fetch,
      new AbortController().signal
    )
    const [url, init] = fetch.mock.calls[0]
    const path =
      preset === "openai"
        ? "responses"
        : preset === "anthropic"
          ? "messages"
          : "models/custom-model:generateContent"
    expect(url).toBe(`https://proxy.example.test/api/${path}`)
    const header =
      preset === "openai"
        ? "authorization"
        : preset === "anthropic"
          ? "x-api-key"
          : "x-goog-api-key"
    expect(new Headers(init?.headers).get(header)).toBe(
      preset === "openai" ? "Bearer proxy-key" : "proxy-key"
    )
    if (preset !== "google") expect(JSON.parse(init?.body as string).model).toBe("custom-model")
  })

  it.each(languagePresets)(
    "uses %s structured output without inventing confidence or distributions",
    async (preset) => {
      const fetch = transport(
        languageResponse(preset, JSON.stringify({ q0: 0.8, q1: "c0", q2: 1.5 }))
      )
      const result = await call(preset, fetch)
      expect(result).toMatchObject({
        ok: true,
        answers: {
          greeting: { type: "noul", noul: 0.8 },
          tone: { type: "choice", choice: "friendly" },
          warmth: { type: "score", score: 1.5 },
        },
        usage: { inputTokens: 24, outputTokens: 6, totalTokens: 30 },
        probabilityKind: "estimated",
      })
      if (!result.ok) throw new Error("Expected a decision")
      expect(result.answers.tone).not.toHaveProperty("confidence")
      expect(result.answers.tone).not.toHaveProperty("probabilities")
      expect(result.answers.warmth).not.toHaveProperty("confidence")
      expect(result.answers.warmth).not.toHaveProperty("probabilities")
      expect(fetch).toHaveBeenCalledTimes(1)
      const [url, init] = fetch.mock.calls[0]
      const headers = new Headers(init?.headers)
      if (preset === "openai") {
        expect(url).toBe("https://api.openai.com/v1/responses")
        expect(headers.get("authorization")).toBe("Bearer test-key")
        expect(result.routing).toEqual({ model: "resolved-openai" })
      } else if (preset === "anthropic") {
        expect(url).toBe("https://api.anthropic.com/v1/messages")
        expect(headers.get("x-api-key")).toBe("test-key")
        expect(result.routing).toEqual({ model: "resolved-anthropic" })
      } else {
        expect(url).toBe(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
        )
        expect(headers.get("x-goog-api-key")).toBe("test-key")
      }
      expect(init?.body).toContain("Good morning!")
      expect(init?.body).toContain("q0")
      expect(init?.body).toContain("c0")
    }
  )

  describe.each(languagePresets)("%s output validation", (preset) => {
    it.each([
      ["malformed JSON", "not-json"],
      ["out of range probability", JSON.stringify({ q0: 1.1, q1: "c0", q2: 1 })],
      ["unknown choice", JSON.stringify({ q0: 0.8, q1: "c8", q2: 1 })],
      ["out of range score", JSON.stringify({ q0: 0.8, q1: "c0", q2: 3 })],
      ["incomplete answers", JSON.stringify({ q0: 0.8, q1: "c0" })],
    ])("rejects %s", async (_label, output) => {
      const fetch = transport(languageResponse(preset, output))
      await expect(call(preset, fetch)).rejects.toThrow()
      expect(fetch).toHaveBeenCalledTimes(1)
    })
  })
})

describe("AI Gateway SDK adapter", () => {
  it("sends decision-model requests and retains returned native metadata", async () => {
    const fetch = transport({
      model: "resolved-gateway",
      answers: {
        greeting: { type: "boolean", probability: 0.8 },
        tone: { type: "choice", choice: "friendly" },
        warmth: { type: "score", score: 1.5 },
      },
      usage: { inputTokens: 24, outputTokens: 6 },
      rounding: { probabilityDecimals: 2, scoreDecimals: 2 },
    })
    const result = await call("gateway", fetch)
    expect(result).toMatchObject({
      ok: true,
      answers: {
        greeting: { type: "noul", noul: 0.8 },
        tone: { type: "choice", choice: "friendly" },
        warmth: { type: "score", score: 1.5 },
      },
      routing: { model: "resolved-gateway" },
      usage: { inputTokens: 24, outputTokens: 6, totalTokens: 30 },
      rounding: { probabilityDecimals: 2, scoreDecimals: 2 },
      probabilityKind: "unknown",
    })
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe("https://ai-gateway.vercel.sh/v4/ai/decision-model")
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer test-key")
    expect(headers.get("ai-model-id")).toBe(DECISION_HTTP_PRESETS.gateway.defaultModel)
    expect(headers.get("ai-decision-model-specification-version")).toBe("4")
    expect(JSON.parse(init?.body as string)).toMatchObject({
      state: request.state,
      questions: { greeting: { type: "boolean", instructions: "Is this a greeting?" } },
    })
  })
})

it.each(sdkPresets)("does not call %s when already aborted", async (preset) => {
  const fetch = transport({})
  const controller = new AbortController()
  controller.abort()
  await expect(call(preset, fetch, controller.signal)).rejects.toThrow()
  expect(fetch).not.toHaveBeenCalled()
})

// The shared postflight gate intentionally omits phone-shaped strings to avoid
// false positives. Phone redaction is covered by the runDecision transport test.
it.each(["person@example.com", "sk-proj-abcdefghijklmnopqrstuv123456"])(
  "blocks unredacted data at the adapter boundary: %s",
  async (personalData) => {
    const fetch = transport(nativeResponse())
    await expect(
      decideWithSdk(
        { ...request, state: { contact: personalData } },
        endpoint("typesafe"),
        "test-key",
        fetch,
        new AbortController().signal
      )
    ).resolves.toMatchObject({ ok: false, error: { kind: "pii" } })
    expect(fetch).not.toHaveBeenCalled()
  }
)

it("also blocks unredacted question instructions", async () => {
  const fetch = transport(nativeResponse())
  await expect(
    decideWithSdk(
      {
        ...request,
        questions: {
          greeting: { type: "noul", instructions: "Is person@example.com greeting me?" },
        },
      },
      endpoint("typesafe"),
      "test-key",
      fetch,
      new AbortController().signal
    )
  ).resolves.toMatchObject({ ok: false, error: { kind: "pii" } })
  expect(fetch).not.toHaveBeenCalled()
})
