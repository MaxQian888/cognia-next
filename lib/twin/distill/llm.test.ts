/**
 * Coverage for `llm.ts:extractJson` — the JSON-from-LLM-prose extractor.
 * `createAnthropicLlmClient` is exercised end-to-end via the agent tests
 * with a mock client; here we only verify the parser handles the messy
 * shapes real models emit.
 */

import { extractJson } from "./llm"

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
