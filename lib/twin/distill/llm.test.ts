/**
 * Coverage for `llm.ts`:
 *   - `extractJson` — the JSON-from-LLM-prose extractor.
 *   - `createLlmClient` provider dispatch — verifies each branch builds
 *     without throwing and that the back-compat alias still resolves.
 *
 * The full agent-side flow (a mocked `LlmClient` driving the distill
 * sub-agents) is covered separately by the agent tests; here we only
 * pin the parser + the client-factory dispatch.
 */

import { extractJson, createLlmClient, createAnthropicLlmClient, type LlmConfig } from "./llm"

describe("extractJson", () => {
  it("parses a bare JSON object", () => {
    const result = extractJson<{ a: number }>('{"a": 1}')
    expect(result).toEqual({ a: 1 })
  })

  it("parses a bare JSON array", () => {
    const result = extractJson<number[]>("[1, 2, 3]")
    expect(result).toEqual([1, 2, 3])
  })

  it("strips a leading fenced ```json block", () => {
    const text = '```json\n{"answer": 42}\n```'
    expect(extractJson<{ answer: number }>(text)).toEqual({ answer: 42 })
  })

  it("strips a leading ``` block (no language)", () => {
    const text = '```\n{"ok": true}\n```'
    expect(extractJson<{ ok: boolean }>(text)).toEqual({ ok: true })
  })

  it("ignores leading prose before a JSON object", () => {
    const text = `Sure, here's the result:\n{"a": 1, "b": "two"}`
    expect(extractJson<{ a: number; b: string }>(text)).toEqual({ a: 1, b: "two" })
  })

  it("ignores trailing prose after a JSON object", () => {
    const text = `{"a": 1}\n\nLet me know if you'd like me to refine.`
    expect(extractJson<{ a: number }>(text)).toEqual({ a: 1 })
  })

  it("respects nested braces inside string values", () => {
    const text = `{"snippet": "function f() { return {a:1}; }", "name": "f"}`
    const result = extractJson<{ snippet: string; name: string }>(text)
    expect(result.name).toBe("f")
    expect(result.snippet).toContain("return {a:1}")
  })

  it("respects escaped quotes inside strings", () => {
    const text = `{"q": "say \\"hi\\"", "ok": true}`
    expect(extractJson<{ q: string; ok: boolean }>(text)).toEqual({
      q: 'say "hi"',
      ok: true,
    })
  })

  it("throws when no JSON is present at all", () => {
    expect(() => extractJson("plain prose, no braces here")).toThrow(/no JSON object or array/)
  })

  it("throws on an unterminated JSON span", () => {
    expect(() => extractJson('{"a": 1, "b": ')).toThrow(/unterminated/)
  })
})

describe("createLlmClient", () => {
  // Each provider branch returns an object with `.complete(...)`. The
  // underlying SDK is loaded lazily, so just constructing the client must
  // never throw — that's the contract the workbench depends on so a
  // mis-configured provider surfaces the error at send time, not at
  // module load.
  const baseConfig = (provider: LlmConfig["provider"]): LlmConfig => ({
    provider,
    model: `${provider}-test-model`,
    apiKey: "test-key",
  })

  it("constructs an Anthropic client without throwing", () => {
    const client = createLlmClient(baseConfig("anthropic"))
    expect(typeof client.complete).toBe("function")
  })

  it("constructs an OpenAI client without throwing", () => {
    const client = createLlmClient(baseConfig("openai"))
    expect(typeof client.complete).toBe("function")
  })

  it("constructs a Google client without throwing", () => {
    const client = createLlmClient(baseConfig("google"))
    expect(typeof client.complete).toBe("function")
  })

  it("constructs a Mistral client without throwing", () => {
    const client = createLlmClient(baseConfig("mistral"))
    expect(typeof client.complete).toBe("function")
  })

  it("constructs a Cohere client without throwing", () => {
    const client = createLlmClient(baseConfig("cohere"))
    expect(typeof client.complete).toBe("function")
  })

  it("surfaces an unsupported-provider error on first complete() call", async () => {
    const client = createLlmClient({
      ...baseConfig("openai"),
      provider: "made-up-provider" as LlmConfig["provider"],
    })
    await expect(client.complete("hi")).rejects.toThrow(/unsupported provider/i)
  })

  it("createAnthropicLlmClient is the same factory for back-compat", () => {
    expect(createAnthropicLlmClient).toBe(createLlmClient)
  })
})
