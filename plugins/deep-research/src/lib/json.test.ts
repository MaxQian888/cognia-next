import { extractJson, tryExtractJson } from "./json"

describe("extractJson", () => {
  it("parses a fenced ```json block", () => {
    const text = 'Here you go:\n```json\n{"action":"search","queries":["a","b"]}\n```\nDone.'
    expect(extractJson(text)).toEqual({ action: "search", queries: ["a", "b"] })
  })

  it("parses a bare fenced ``` block", () => {
    const text = "```\n[1, 2, 3]\n```"
    expect(extractJson(text)).toEqual([1, 2, 3])
  })

  it("extracts the first balanced object when not fenced", () => {
    const text = 'prefix {"done": true, "reason": "found it"} trailing junk }'
    expect(extractJson(text)).toEqual({ done: true, reason: "found it" })
  })

  it("extracts a balanced array", () => {
    expect(extractJson('noise ["x","y"] more')).toEqual(["x", "y"])
  })

  it("ignores braces inside string literals", () => {
    const text = '{"text":"a } b { c","n":1}'
    expect(extractJson(text)).toEqual({ text: "a } b { c", n: 1 })
  })

  it("handles escaped quotes inside strings", () => {
    const text = '{"q":"say \\"hi\\" now"}'
    expect(extractJson(text)).toEqual({ q: 'say "hi" now' })
  })

  it("falls back to parsing the whole trimmed string", () => {
    expect(extractJson("  42  ")).toBe(42)
  })

  it("prefers the balanced span when the fenced block is invalid JSON", () => {
    const text = '```json\nnot json at all\n```\n{"ok":true}'
    expect(extractJson(text)).toEqual({ ok: true })
  })

  it("throws when there is no JSON", () => {
    expect(() => extractJson("just some prose with no json")).toThrow()
  })
})

describe("tryExtractJson", () => {
  it("returns the parsed value on success", () => {
    expect(tryExtractJson('{"a":1}', { a: 0 })).toEqual({ a: 1 })
  })

  it("returns the fallback on failure", () => {
    expect(tryExtractJson("nope", { a: 0 })).toEqual({ a: 0 })
  })
})
