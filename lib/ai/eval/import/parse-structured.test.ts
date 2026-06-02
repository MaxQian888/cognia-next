import { parseStructured } from "./parse-structured"

describe("parseStructured", () => {
  it("parses JSONL with a union of columns", () => {
    const out = parseStructured('{"a":1}\n{"a":2,"b":3}', "jsonl")
    expect(out.columns).toEqual(["a", "b"])
    expect(out.rows).toEqual([{ a: 1 }, { a: 2, b: 3 }])
  })

  it("parses a JSON array", () => {
    expect(parseStructured('[{"x":1},{"x":2}]', "json").rows).toEqual([{ x: 1 }, { x: 2 }])
  })

  it("unwraps {rows:[...]} / {data:[...]} / {tests:[...]} envelopes", () => {
    expect(parseStructured('{"rows":[{"x":1}]}', "json").rows).toEqual([{ x: 1 }])
    expect(parseStructured('{"data":[{"y":2}]}', "json").rows).toEqual([{ y: 2 }])
    expect(parseStructured('{"tests":[{"z":3}]}', "json").rows).toEqual([{ z: 3 }])
  })

  it("treats a single JSON object as one row", () => {
    expect(parseStructured('{"x":1}', "json").rows).toEqual([{ x: 1 }])
  })

  it("parses a YAML array", () => {
    const out = parseStructured("- q: hi\n  a: yo\n- q: foo\n  a: bar", "yaml")
    expect(out.columns).toEqual(["q", "a"])
    expect(out.rows).toEqual([
      { q: "hi", a: "yo" },
      { q: "foo", a: "bar" },
    ])
  })

  it("returns empty on blank input", () => {
    expect(parseStructured("", "json")).toEqual({ columns: [], rows: [] })
    expect(parseStructured("  ", "jsonl")).toEqual({ columns: [], rows: [] })
  })

  it("skips blank lines in JSONL", () => {
    const out = parseStructured('{"a":1}\n\n{"a":2}\n', "jsonl")
    expect(out.rows).toHaveLength(2)
  })
})
