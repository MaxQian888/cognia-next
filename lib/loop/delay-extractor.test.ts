import { parseLoopTrailer } from "./delay-extractor"

describe("parseLoopTrailer", () => {
  it("parses a continue trailer with delay + reason", () => {
    const out = parseLoopTrailer(
      'Did the work.\n{"continue": true, "delaySeconds": 300, "reason": "build running"}'
    )
    expect(out).toEqual({ continue: true, delayMs: 300_000, reason: "build running" })
  })

  it("parses a completion trailer", () => {
    const out = parseLoopTrailer('All done.\n{"continue": false, "reason": "report delivered"}')
    expect(out).toEqual({ continue: false, reason: "report delivered" })
  })

  it("parses a fenced trailer", () => {
    const out = parseLoopTrailer('```json\n{"continue": true, "delaySeconds": 60}\n```')
    expect(out).toEqual({ continue: true, delayMs: 60_000 })
  })

  it("skips an unrelated earlier JSON object and finds the trailer", () => {
    const text = 'Result: {"items": [1, 2]}\n\n{"continue": true, "delaySeconds": 120}'
    expect(parseLoopTrailer(text)).toEqual({ continue: true, delayMs: 120_000 })
  })

  it("returns null when no JSON is present (fail-OPEN)", () => {
    expect(parseLoopTrailer("just prose, no trailer")).toBeNull()
  })

  it("returns null when the JSON lacks a boolean continue", () => {
    expect(parseLoopTrailer('{"delaySeconds": 60}')).toBeNull()
    expect(parseLoopTrailer('{"continue": "yes"}')).toBeNull()
  })

  it("omits delayMs when delaySeconds is missing or malformed", () => {
    expect(parseLoopTrailer('{"continue": true}')).toEqual({ continue: true })
    expect(parseLoopTrailer('{"continue": true, "delaySeconds": "soon"}')).toEqual({
      continue: true,
    })
  })

  it("trims and drops empty reasons", () => {
    expect(parseLoopTrailer('{"continue": true, "delaySeconds": 60, "reason": "  "}')).toEqual({
      continue: true,
      delayMs: 60_000,
    })
  })

  it("never throws on arrays or broken JSON", () => {
    expect(parseLoopTrailer("[1, 2, 3]")).toBeNull()
    expect(parseLoopTrailer('{"continue": tru')).toBeNull()
  })
})
