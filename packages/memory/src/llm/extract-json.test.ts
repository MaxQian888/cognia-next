import { extractJson } from "./extract-json"

describe("extractJson", () => {
  it("parses a bare JSON object", () => {
    expect(extractJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 })
  })

  it("parses a bare JSON array", () => {
    expect(extractJson<number[]>("[1,2,3]")).toEqual([1, 2, 3])
  })

  it("strips leading prose and trailing commentary", () => {
    expect(extractJson<{ ok: boolean }>('Sure! {"ok":true} — hope that helps.')).toEqual({
      ok: true,
    })
  })

  it("prefers a fenced ```json block", () => {
    const text = 'Here you go:\n```json\n{"n": 42}\n```\nDone.'
    expect(extractJson<{ n: number }>(text)).toEqual({ n: 42 })
  })

  it("handles a fenced block without the json language tag", () => {
    expect(extractJson<{ x: string }>('```\n{"x":"y"}\n```')).toEqual({ x: "y" })
  })

  it("respects braces inside string literals", () => {
    expect(extractJson<{ s: string }>('{"s":"a } b { c"}')).toEqual({ s: "a } b { c" })
  })

  it("respects escaped quotes inside strings", () => {
    expect(extractJson<{ s: string }>('{"s":"he said \\"hi\\""}')).toEqual({ s: 'he said "hi"' })
  })

  it("throws when no JSON is present", () => {
    expect(() => extractJson("no json here")).toThrow(/no JSON object or array/)
  })

  it("throws on an unterminated span", () => {
    expect(() => extractJson('{"a":1')).toThrow(/unterminated JSON span/)
  })
})
