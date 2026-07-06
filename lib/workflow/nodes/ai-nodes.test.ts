// Theme B — AI-native node executor behavior (structured output, classifier
// routing, real embeddings w/ fallback, typed extraction).

// Mock the embedding module so ai.embed's real path is deterministic; the
// dynamic import inside the executor resolves to this mock.
const generateEmbeddingMock = jest.fn(async () => ({
  embedding: [0.1, 0.2, 0.3],
  model: "text-embedding-3-small",
  provider: "openai",
}))
jest.mock("@cognia/vector/embedding", () => ({
  generateEmbedding: (...args: unknown[]) => generateEmbeddingMock(...(args as [])),
}))

// Mock createLlmClient (real-LLM path) while keeping the real extractJson.
const completeMock = jest.fn(async (..._args: unknown[]) => "stub")
const createLlmClientMock = jest.fn(() => ({
  complete: (...args: unknown[]) => completeMock(...args),
  getUsageSnapshot: () => ({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
}))
jest.mock("@/lib/twin/distill/llm", () => {
  const actual = jest.requireActual("@/lib/twin/distill/llm")
  return {
    ...actual,
    createLlmClient: (...args: unknown[]) => createLlmClientMock(...(args as [])),
  }
})

import "@/lib/workflow/nodes/built-ins"
import { getExecutor } from "@/lib/workflow/nodes/registry"
import type { StepExecutionContext } from "@/types/workflow/visual"

function makeCtx(params: Record<string, unknown>): StepExecutionContext {
  return {
    runId: "r",
    workflowId: "w",
    stepId: "s",
    params,
    upstream: {},
    trigger: { workflowId: "w", kind: "trigger.manual", payload: {}, originAt: 0 },
    signal: new AbortController().signal,
    log: () => {},
    resolveSecret: async () => undefined,
  }
}

async function run(
  kind: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const reg = getExecutor(kind as never, 1)
  if (!reg) throw new Error(`no executor for ${kind}`)
  const result = await reg.execute(makeCtx(params))
  return result.output as Record<string, unknown>
}

beforeEach(() => {
  generateEmbeddingMock.mockClear()
  completeMock.mockClear()
  createLlmClientMock.mockClear()
  createLlmClientMock.mockImplementation(() => ({
    complete: (...args: unknown[]) => completeMock(...args),
    getUsageSnapshot: () => ({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
  }))
})

describe("B1 — ai.prompt structured output", () => {
  it("text mode (stub) returns a completion and NO structured field", async () => {
    const out = await run("ai.prompt", { userPrompt: "hi" })
    expect(out.completion).toBe("[ai.prompt stub] hi")
    expect(out).not.toHaveProperty("structured")
  })

  it("json mode (stub) yields a parseable empty object", async () => {
    const out = await run("ai.prompt", { userPrompt: "hi", responseFormat: "json" })
    expect(out.structured).toEqual({})
    expect(out).not.toHaveProperty("parseError")
  })

  it("json mode (real client) parses the completion into structured output", async () => {
    completeMock.mockResolvedValueOnce('Here you go:\n```json\n{"title":"hi","score":5}\n```')
    const out = await run("ai.prompt", {
      provider: "openai",
      model: "gpt",
      apiKey: "k",
      userPrompt: "x",
      responseFormat: "json",
      jsonSchema: '{ "title": "string", "score": "number" }',
    })
    expect(out.structured).toEqual({ title: "hi", score: 5 })
  })

  it("real client path forwards provider protocol metadata", async () => {
    const headers = { "HTTP-Referer": "https://cognia.local", "X-Title": "Cognia" }
    await run("ai.prompt", {
      provider: "openrouter",
      model: "openai/gpt-4.1-mini",
      apiKey: "k",
      baseURL: "https://openrouter.ai/api/v1",
      apiFlavor: "chat",
      headers,
      userPrompt: "x",
    })

    expect(createLlmClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openrouter",
        model: "openai/gpt-4.1-mini",
        apiKey: "k",
        baseURL: "https://openrouter.ai/api/v1",
        apiFlavor: "chat",
        headers,
      })
    )
  })

  it("json mode surfaces parseError when the model returns no JSON", async () => {
    completeMock.mockResolvedValueOnce("sorry, no json here")
    const out = await run("ai.prompt", {
      provider: "openai",
      model: "gpt",
      apiKey: "k",
      userPrompt: "x",
      responseFormat: "json",
    })
    expect(out.structured).toBeNull()
    expect(typeof out.parseError).toBe("string")
  })

  const outputSchema = {
    type: "object",
    properties: { title: { type: "string" }, score: { type: "number" } },
    required: ["title", "score"],
  }

  it("typed output: real call validates the structured result", async () => {
    completeMock.mockResolvedValueOnce('{"title":"hi","score":5}')
    const out = await run("ai.prompt", {
      provider: "openai",
      model: "gpt",
      apiKey: "k",
      userPrompt: "x",
      responseFormat: "json",
      outputSchema,
    })
    expect(out.structured).toEqual({ title: "hi", score: 5 })
    expect(out.schemaValid).toBe(true)
  })

  it("typed output: auto-fixes once then succeeds", async () => {
    completeMock
      .mockResolvedValueOnce('{"title":"hi"}') // missing score
      .mockResolvedValueOnce('{"title":"hi","score":7}')
    const out = await run("ai.prompt", {
      provider: "openai",
      model: "gpt",
      apiKey: "k",
      userPrompt: "x",
      responseFormat: "json",
      outputSchema,
    })
    expect(out.schemaValid).toBe(true)
    expect(completeMock).toHaveBeenCalledTimes(2)
    expect(completeMock.mock.calls[1][0]).toMatch(/score/)
  })

  it("typed output: throws after the retry when unmet (fail default)", async () => {
    completeMock.mockResolvedValue('{"title":"hi"}')
    const reg = getExecutor("ai.prompt" as never, 1)!
    await expect(
      reg.execute(
        makeCtx({
          provider: "openai",
          model: "gpt",
          apiKey: "k",
          userPrompt: "x",
          responseFormat: "json",
          outputSchema,
        })
      )
    ).rejects.toThrow(/did not satisfy/)
    expect(completeMock).toHaveBeenCalledTimes(2)
  })

  it("typed output: soft mode keeps the unvalidated value", async () => {
    completeMock.mockResolvedValue('{"title":"hi"}')
    const out = await run("ai.prompt", {
      provider: "openai",
      model: "gpt",
      apiKey: "k",
      userPrompt: "x",
      responseFormat: "json",
      outputSchema,
      onSchemaViolation: "soft",
    })
    expect(out.schemaValid).toBe(false)
    expect(out.structured).toEqual({ title: "hi" })
  })

  it("typed output: stub path stays soft so pre-credential runs survive", async () => {
    const out = await run("ai.prompt", {
      userPrompt: "hi",
      responseFormat: "json",
      outputSchema,
    })
    // Stub returns {} which violates the schema, but must NOT throw.
    expect(out.structured).toEqual({})
    expect(out.schemaValid).toBe(false)
  })
})

describe("B2 — ai.classify routing", () => {
  it("emits a decision equal to the chosen label so labeled edges route", async () => {
    const out = await run("ai.classify", {
      input: "this ticket is urgent",
      labels: ["urgent", "normal"],
    })
    expect(out.label).toBe("urgent")
    // Returned at the result level — assert via the full result.
    const reg = getExecutor("ai.classify" as never, 1)!
    const full = await reg.execute(
      makeCtx({ input: "this is urgent", labels: ["urgent", "normal"] })
    )
    expect(full.decision).toBe("urgent")
  })

  it("forwards explicit provider protocol metadata to ai.prompt v2", async () => {
    const headers = { "HTTP-Referer": "https://cognia.local", "X-Title": "Cognia" }
    await run("ai.classify", {
      provider: "openrouter",
      model: "openai/gpt-4.1-mini",
      apiKey: "k",
      baseURL: "https://openrouter.ai/api/v1",
      apiFlavor: "chat",
      headers,
      input: "this ticket is urgent",
      labels: ["urgent", "normal"],
    })

    expect(createLlmClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openrouter",
        model: "openai/gpt-4.1-mini",
        apiKey: "k",
        baseURL: "https://openrouter.ai/api/v1",
        apiFlavor: "chat",
        headers,
      })
    )
  })
})

describe("B3 — ai.embed semantic + fallback", () => {
  it("falls back to the deterministic hash when no provider is set", async () => {
    const out = await run("ai.embed", { input: "hello", dimension: 64 })
    expect(out.kind).toBe("deterministic-hash")
    expect((out.vector as number[]).length).toBe(64)
    expect(generateEmbeddingMock).not.toHaveBeenCalled()
  })

  it("uses the real embedder when provider + model are configured", async () => {
    const out = await run("ai.embed", {
      input: "hello",
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "k",
    })
    expect(out.kind).toBe("semantic")
    expect(out.vector).toEqual([0.1, 0.2, 0.3])
    expect(generateEmbeddingMock).toHaveBeenCalledTimes(1)
  })

  it("falls back to hash when the real embedder throws", async () => {
    generateEmbeddingMock.mockRejectedValueOnce(new Error("provider down"))
    const out = await run("ai.embed", {
      input: "hello",
      dimension: 32,
      provider: "openai",
      model: "m",
      apiKey: "k",
    })
    expect(out.kind).toBe("deterministic-hash")
    expect((out.vector as number[]).length).toBe(32)
  })
})

describe("B4 — ai.extract typed parameter extraction", () => {
  it("parses, coerces types, and reports valid when required fields present", async () => {
    completeMock.mockResolvedValueOnce('{"name":"Bob","amount":"42"}')
    const out = await run("ai.extract", {
      provider: "openai",
      model: "gpt",
      apiKey: "k",
      input: "Bob spent 42",
      schema: { name: "string", amount: "number" },
      required: ["name", "amount"],
    })
    expect(out.extracted).toEqual({ name: "Bob", amount: 42 })
    expect(out.missing).toEqual([])
    expect(out.valid).toBe(true)
  })

  it("forwards explicit provider protocol metadata to ai.prompt v2", async () => {
    completeMock.mockResolvedValueOnce('{"name":"Bob"}')
    const headers = { "HTTP-Referer": "https://cognia.local", "X-Title": "Cognia" }
    await run("ai.extract", {
      provider: "openrouter",
      model: "openai/gpt-4.1-mini",
      apiKey: "k",
      baseURL: "https://openrouter.ai/api/v1",
      apiFlavor: "chat",
      headers,
      input: "Bob",
      schema: { name: "string" },
    })

    expect(createLlmClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openrouter",
        model: "openai/gpt-4.1-mini",
        apiKey: "k",
        baseURL: "https://openrouter.ai/api/v1",
        apiFlavor: "chat",
        headers,
      })
    )
  })

  it("coerces boolean / string / number fields per the schema hints", async () => {
    completeMock.mockResolvedValueOnce('{"flag":"true","name":123,"amount":"7","note":null}')
    const out = await run("ai.extract", {
      provider: "openai",
      model: "gpt",
      apiKey: "k",
      input: "x",
      schema: { flag: "boolean", name: "string", amount: "number", note: "string" },
    })
    expect(out.extracted).toEqual({ flag: true, name: "123", amount: 7, note: null })
  })

  it("reports missing required fields and valid=false", async () => {
    completeMock.mockResolvedValueOnce('{"name":"Bob"}')
    const out = await run("ai.extract", {
      provider: "openai",
      model: "gpt",
      apiKey: "k",
      input: "Bob",
      schema: { name: "string", amount: "number" },
      required: ["name", "amount"],
    })
    expect(out.missing).toEqual(["amount"])
    expect(out.valid).toBe(false)
  })

  it("surfaces a parseError (and valid=false) when the model returns no JSON", async () => {
    const out = await run("ai.extract", {
      input: "Bob spent 42",
      schema: { name: "string" },
    })
    expect(out.extracted).toBeNull()
    expect(typeof out.parseError).toBe("string")
    expect(out.valid).toBe(false)
  })
})
